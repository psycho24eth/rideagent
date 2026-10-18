import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import {
  DeepLinkProvider,
  HumanActionRequiredProviderError,
  MockProvider,
  ProviderError,
  createDefaultRegionRouter,
  type ProviderRegistry,
  type ProviderRideStatus,
} from "@rideagent/providers";
import { locationSchema, transitionRide, type Location, type Quote, type Ride } from "@rideagent/shared";
import { systemClock } from "./clock.js";
import { DemoPlanner } from "./planner.js";
import { ProviderSelectionService, ProviderUnavailableError, type QuoteOption } from "./provider-selection.js";
import { DemoRateLimiter } from "./rate-limit.js";
import { cancelPayloadSchema, chatPayloadSchema, demoRulesSchema, plannerActionSchema, providerBookedRideSchema, providerStatusSchema, rulesPayloadSchema, validatedQuoteSchema } from "./schemas.js";
import { SafetyService, SafetyViolation } from "./safety.js";
import { InMemoryStore } from "./store.js";
import { InMemoryNotificationSink, normalizeRideLiveUpdate, normalizeRideSnapshot } from "./notifications.js";
import { TrackingService } from "./tracking.js";
import { DemoTelemetryService } from "./telemetry.js";
import { bookingBlocks, recommendationBlocks, trackingBlocks } from "./rich-output.js";
import type { AppDependencies, Clock, NotificationSink, RideRepository, StoredRide, TrackingJobQueue } from "./types.js";
import type { RideProvider } from "@rideagent/providers";
import { PrismaRepository } from "./prisma-store.js";
import { createStoreFromEnv } from "./store-factory.js";

const DEFAULT_USER = "demo-user";

function requestUser(request: FastifyRequest): string {
  const value = request.headers["x-demo-user"];
  return typeof value === "string" && value.trim() ? value.trim() : DEFAULT_USER;
}

function id(prefix: string, value: string): string {
  let hash = 0;
  for (const character of value) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return `${prefix}-${hash.toString(16).padStart(8, "0")}`;
}

function errorStatus(error: unknown): number {
  if (error instanceof SafetyViolation) return error.code === "RULES_REQUIRED" ? 409 : 422;
  if (error instanceof ProviderError && error.code === "human_action_required") return 409;
  if (error instanceof ProviderUnavailableError) return 409;
  return 400;
}

function apiErrorPayload(error: unknown, fallback: string): Record<string, unknown> {
  if (error instanceof SafetyViolation) {
    return { error: error.code.toLowerCase(), assistantMessage: error.message };
  }
  if (error instanceof HumanActionRequiredProviderError || (error instanceof ProviderError && error.code === "human_action_required")) {
    const deepLink = error instanceof HumanActionRequiredProviderError ? error.deepLink : error.details?.deepLink;
    return {
      error: "human_action_required",
      assistantMessage: error.message,
      humanActionRequired: true,
      ...(deepLink ? { deepLink } : {}),
    };
  }
  if (error instanceof ProviderUnavailableError) {
    return { error: "provider_unavailable", assistantMessage: error.message };
  }
  return { error: fallback, assistantMessage: error instanceof Error ? error.message : "I could not complete that ride request." };
}

function locationOrDefault(pickup?: Location): Location {
  return pickup ?? { label: "Current location" };
}

export interface BuiltApp extends FastifyInstance {
  demo: {
    store: RideRepository;
    provider: RideProvider;
    providerRegistry: ProviderRegistry;
    providerSelection: ProviderSelectionService;
    clock: Clock;
    notificationSink: NotificationSink;
    tracking: TrackingService;
    telemetry: DemoTelemetryService;
    trackingQueue?: TrackingJobQueue;
  };
}

async function enqueueTracking(queue: TrackingJobQueue | undefined, store: RideRepository, rideId: string, userId: string): Promise<void> {
  if (!queue) return;
  try {
    const flushableStore = store as RideRepository & { flush?: () => Promise<void> };
    await flushableStore.flush?.();
    await queue.enqueueTracking(rideId, userId);
  } catch (error) {
    // The booking has already been committed locally. A queue outage must not
    // turn a successful provider booking into a false booking failure response.
    console.error("Lexar AI could not enqueue tracking job", error);
  }
}

export function buildApp(dependencies: AppDependencies = {}): BuiltApp {
  const clock = dependencies.clock ?? systemClock;
  const store = dependencies.store ?? new InMemoryStore();
  const configuredProvider = dependencies.provider;
  const defaultProvider = configuredProvider ?? new MockProvider();
  const providerRegistry = dependencies.providerRegistry ?? dependencies.regionRouter ?? createDefaultRegionRouter({
    providers: configuredProvider ? [defaultProvider] : [defaultProvider, new DeepLinkProvider()],
  });
  const provider = configuredProvider ?? providerRegistry.registrations()[0]?.provider ?? defaultProvider;
  const providerSelection = new ProviderSelectionService(providerRegistry);
  const planner = dependencies.planner ?? new DemoPlanner();
  const notificationSink = dependencies.notificationSink ?? new InMemoryNotificationSink();
  const limiter = new DemoRateLimiter(dependencies.rateLimit?.max, dependencies.rateLimit?.windowMs);
  const safety = new SafetyService(store, clock);
  const telemetry = new DemoTelemetryService(clock);
  const tracking = new TrackingService({ provider, providerSelection, store, clock, notificationSink, telemetry });
  const app = Fastify({ logger: false }) as unknown as BuiltApp;
  app.demo = { store, provider, providerRegistry, providerSelection, clock, notificationSink, tracking, telemetry, trackingQueue: dependencies.trackingQueue };

  app.addHook("onRequest", async (request, reply) => {
    if (!limiter.check(request.ip)) return reply.code(429).send({ error: "rate_limited" });
  });

  app.get("/health", async () => ({ status: "ok", mode: "demo", service: "rideagent-api" }));

  app.get("/v1/rules", async (request, reply) => {
    const rules = store.getRules(requestUser(request));
    if (!rules) return reply.code(404).send({ error: "rules_not_configured" });
    return rules;
  });

  app.put("/v1/rules", async (request, reply) => {
    const parsed = rulesPayloadSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_rules", details: parsed.error.flatten() });
    const rules = demoRulesSchema.parse({ ...parsed.data, userId: requestUser(request), updatedAt: clock.now() });
    store.saveRules(rules);
    return reply.code(200).send(rules);
  });

  app.post("/v1/chat", async (request, reply) => {
    const parsed = chatPayloadSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_chat", details: parsed.error.flatten() });
    const userId = requestUser(request);
    const pendingRideId = store.getPendingRecommendation(userId);
    const plan = plannerActionSchema.parse(await planner.plan({ message: parsed.data.message, pickupProvided: Boolean(parsed.data.pickup), hasPendingRecommendation: Boolean(pendingRideId) }));

    if (plan.kind === "unclear") {
      return { assistantMessage: pendingRideId ? "Please reply yes to book this ride, or no to cancel the recommendation." : "Tell me that you need a ride to the airport, and I’ll get a quote." };
    }
    if (plan.kind === "reject") {
      if (pendingRideId) store.clearPendingRecommendation(userId);
      return { assistantMessage: "Understood — I won’t book anything." };
    }

    if (plan.kind === "confirm") {
      if (!pendingRideId) return { assistantMessage: "There is no pending ride recommendation to book." };
      const ride = store.getRide(pendingRideId);
      if (!ride?.quote) return { assistantMessage: "That recommendation is no longer available. Please request a fresh quote." };
      try {
        const rules = safety.validateQuote(userId, ride.quote);
        const selectedProvider = providerSelection.requireProvider(ride.quote, ride.pickup);
        const callAt = clock.now();
        store.saveEvent({ eventId: id("tool", `${ride.id}:book:${callAt}`), type: "agent.tool_call", userId, rideId: ride.id, tool: "book_ride", arguments: { quoteId: ride.quote.id }, outcome: "accepted", occurredAt: callAt });
        const booked = providerBookedRideSchema.parse(await selectedProvider.book(ride.quote));
        const transition = transitionRide(ride, "booked", { eventId: id("event", `${ride.id}:booked:${callAt}`), occurredAt: callAt, actor: { id: "rideagent", role: "system" }, reason: "User confirmed booking" });
         const bookedRide: StoredRide = { ...transition.ride, providerRideId: booked.providerRideId, driverId: booked.status.driverId, vehicleId: booked.status.vehicleId };
         store.saveRide(bookedRide);
        store.saveEvent(transition.event);
        store.saveEvent({ eventId: id("decision", `${ride.id}:confirmed:${callAt}`), type: "agent.decision", userId, rideId: ride.id, decision: "book", reason: `Confirmed within rules (${rules.bookingMode})`, occurredAt: callAt });
        store.clearPendingRecommendation(userId);
        const liveTelemetry = selectedProvider.name === "mock" ? telemetry.update(bookedRide, booked.status) : undefined;
        const assistantMessage = `Booked your cab. Ride id: ${ride.id}.`;
        await enqueueTracking(dependencies.trackingQueue, store, ride.id, userId);
        return {
          assistantMessage,
          ride: bookedRide,
          blocks: bookingBlocks(bookedRide, liveTelemetry, assistantMessage, callAt),
        };
      } catch (error) {
        store.saveEvent({ eventId: id("tool", `${ride.id}:book-rejected:${clock.now()}`), type: "agent.tool_call", userId, rideId: ride.id, tool: "book_ride", arguments: { quoteId: ride.quote.id }, outcome: "rejected", occurredAt: clock.now() });
        const payload: Record<string, unknown> = {
          ...apiErrorPayload(error, "booking_failed"),
          ...(error instanceof ProviderError && error.code === "human_action_required"
            ? { quote: providerSelection.toQuoteOption(ride.quote, ride.pickup) }
            : {}),
        };
        return reply.code(errorStatus(error)).send(
          error instanceof ProviderError && error.code === "human_action_required"
            ? {
                ...payload,
                blocks: recommendationBlocks(
                  ride,
                  providerSelection.toQuoteOption(ride.quote, ride.pickup),
                  String(payload.assistantMessage),
                  clock.now(),
                ),
              }
            : payload,
        );
      }
    }

    let quoteOptions: QuoteOption[] | undefined;
    let selectedQuoteOption: QuoteOption | undefined;
    let quotedRide: StoredRide | undefined;
    try {
      const rules = safety.requireRules(userId);
      const now = clock.now();
      const rideId = id("ride", `${userId}:${now}:${parsed.data.message}`);
      const requestData = {
        riderId: userId,
        pickup: locationOrDefault(parsed.data.pickup),
        dropoff: locationSchema.parse(plan.destination),
        vehicleType: rules.preferredVehicleType,
        requestedAt: now,
      };
      const initial: StoredRide = { id: rideId, ...requestData, vehicleType: requestData.vehicleType ?? "cab", status: "requested", version: 0, createdAt: now, updatedAt: now };
      store.saveRide(initial);
      store.saveEvent({ eventId: id("event", `${rideId}:requested`), type: "ride.status_changed", rideId, from: "requested", to: "requested", previousVersion: 0, nextVersion: 0, occurredAt: now, actor: { id: "rideagent", role: "system" }, reason: "Ride request received" });
      const quotes = validatedQuoteSchema.array().parse(await providerSelection.getQuotes({ requestId: rideId, riderId: userId, pickup: requestData.pickup, dropoff: requestData.dropoff, vehicleType: requestData.vehicleType, requestedAt: now }));
      quoteOptions = quotes.map((candidate) => providerSelection.toQuoteOption(candidate, requestData.pickup));
      const quote = providerSelection.selectQuote(quotes, requestData.pickup);
      if (!quote) throw new Error("No ride providers returned a quote.");
      selectedQuoteOption = providerSelection.toQuoteOption(quote, requestData.pickup);
      const quoted = transitionRide({ ...initial, quote }, "quoted", { eventId: id("event", `${rideId}:quoted`), occurredAt: clock.now(), actor: { id: "rideagent", role: "system" }, reason: "Provider quotes received" });
      quotedRide = quoted.ride;
      store.saveRide(quoted.ride);
      store.saveEvent(quoted.event);
      store.setPendingRecommendation(userId, rideId);
      store.saveEvent({ eventId: id("decision", `${rideId}:recommend`), type: "agent.decision", userId, rideId, decision: "recommend", reason: `${quote.providerId} quote ${quote.amountMinor} ${quote.currency}; preference ${rules.preference}`, occurredAt: clock.now() });
      if (rules.bookingMode === "auto_book_within_rules") {
        const checkedRules = safety.validateQuote(userId, quote);
        const selectedProvider = providerSelection.requireProvider(quote, requestData.pickup);
        const booked = providerBookedRideSchema.parse(await selectedProvider.book(quote));
        const bookedAt = clock.now();
        const transition = transitionRide(quoted.ride, "booked", { eventId: id("event", `${rideId}:auto-booked`), occurredAt: bookedAt, actor: { id: "rideagent", role: "system" }, reason: "Auto-booked within saved rules" });
         const bookedRide: StoredRide = { ...transition.ride, providerRideId: booked.providerRideId, driverId: booked.status.driverId, vehicleId: booked.status.vehicleId };
         store.saveRide(bookedRide);
         store.saveEvent(transition.event);
         store.saveEvent({ eventId: id("decision", `${rideId}:auto-book`), type: "agent.decision", userId, rideId, decision: "book", reason: `Auto-booked within rules (${checkedRules.bookingMode})`, occurredAt: bookedAt });
         store.clearPendingRecommendation(userId);
         const liveTelemetry = selectedProvider.name === "mock" ? telemetry.update(bookedRide, booked.status) : undefined;
         const assistantMessage = `Booked your cab automatically within your rules. Ride id: ${rideId}.`;
         await enqueueTracking(dependencies.trackingQueue, store, rideId, userId);
         return {
           assistantMessage,
           ride: bookedRide,
           quote: selectedQuoteOption,
           quotes: quoteOptions,
           blocks: bookingBlocks(bookedRide, liveTelemetry, assistantMessage, bookedAt),
         };
      }
      const humanActionRequired = selectedQuoteOption.humanActionRequired === true;
      const assistantMessage = humanActionRequired
        ? `I found a fallback from ${quote.providerId} that requires you to continue in the linked app or website.`
        : `I found a ${quote.vehicleType} from ${quote.providerId} for ${(quote.amountMinor / 100).toFixed(2)} ${quote.currency}, estimated at ${Math.ceil(quote.estimatedDurationSeconds / 60)} minutes. Want me to proceed with the cab booking?`;
      return {
        assistantMessage,
        ride: quoted.ride,
        quote: selectedQuoteOption,
        quotes: quoteOptions,
        blocks: recommendationBlocks(quoted.ride, selectedQuoteOption, assistantMessage, clock.now()),
        ...(humanActionRequired ? { humanActionRequired: true, ...(quote.deepLink ? { deepLink: quote.deepLink } : {}) } : {}),
      };
    } catch (error) {
      const payload: Record<string, unknown> = {
        ...apiErrorPayload(error, "quote_failed"),
        ...(quotedRide ? { ride: quotedRide } : {}),
        ...(selectedQuoteOption ? { quote: selectedQuoteOption } : {}),
        ...(quoteOptions ? { quotes: quoteOptions } : {}),
        ...(error instanceof ProviderError && error.code === "human_action_required"
          ? { humanActionRequired: true, ...(error instanceof HumanActionRequiredProviderError ? { deepLink: error.deepLink } : {}) }
          : {}),
      };
      if (error instanceof ProviderError && error.code === "human_action_required" && quotedRide && selectedQuoteOption) {
        payload.blocks = recommendationBlocks(
          quotedRide,
          selectedQuoteOption,
          String(payload.assistantMessage),
          clock.now(),
        );
      }
      return reply.code(errorStatus(error)).send(payload);
    }
  });

  app.get("/v1/rides/:id", async (request, reply) => {
    const ride = store.getRide((request.params as { id: string }).id);
    if (!ride || ride.riderId !== requestUser(request)) return reply.code(404).send({ error: "ride_not_found" });
    return ride;
  });

  app.get("/v1/rides/:id/events", async (request, reply) => {
    const ride = store.getRide((request.params as { id: string }).id);
    if (!ride || ride.riderId !== requestUser(request)) return reply.code(404).send({ error: "ride_not_found" });
    return { rideId: ride.id, events: store.listEvents(ride.id) };
  });

  app.get("/v1/rides/:id/track", async (request, reply) => {
    const rideId = (request.params as { id: string }).id;
    const userId = requestUser(request);
    const ride = store.getRide(rideId);
    if (!ride || ride.riderId !== userId) return reply.code(404).send({ error: "ride_not_found" });

    try {
      const result = await tracking.track(rideId, userId);
      const blocks = trackingBlocks(result.ride, result.liveTelemetry, result.assistantMessage ?? "Ride status updated.");
      return {
        ...result,
        ...(result.assistantMessage ? { assistantMessage: result.assistantMessage } : {}),
        ...(blocks ? { blocks } : {}),
      };
    } catch (error) {
      return reply.code(409).send({
        error: "tracking_failed",
        assistantMessage: "Live tracking is unavailable because this provider could not return a current update.",
        message: error instanceof Error ? error.message : "Could not refresh ride status.",
      });
    }
  });

  app.get("/v1/rides/:id/live", async (request, reply) => {
    const rideId = (request.params as { id: string }).id;
    const ride = store.getRide(rideId);
    if (!ride || ride.riderId !== requestUser(request)) return reply.code(404).send({ error: "ride_not_found" });

    const telemetrySnapshot = telemetry.ensure(ride);
    if (!telemetrySnapshot) return reply.code(404).send({ error: "live_telemetry_not_available" });
    return {
      ...telemetrySnapshot,
      event: normalizeRideLiveUpdate(ride, telemetrySnapshot),
    };
  });

  app.get("/v1/rides/:id/stream", async (request, reply) => {
    const ride = store.getRide((request.params as { id: string }).id);
    if (!ride || ride.riderId !== requestUser(request)) return reply.code(404).send({ error: "ride_not_found" });

    const snapshot = normalizeRideSnapshot(ride);
    const live = telemetry.ensure(ride);
    const snapshotBody = `id: ${ride.id}:${ride.version}\nevent: ride.snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`;
    const liveBody = live
      ? `id: ${ride.id}:${ride.version}:live\nevent: ride.live_update\ndata: ${JSON.stringify(normalizeRideLiveUpdate(ride, live))}\n\n`
      : "";
    reply
      .header("Cache-Control", "no-cache")
      .header("Connection", "keep-alive")
      .header("X-Accel-Buffering", "no")
      .type("text/event-stream");
    return reply.send(`${snapshotBody}${liveBody}`);
  });

  app.post("/v1/rides/:id/cancel", async (request, reply) => {
    const parsed = cancelPayloadSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "invalid_cancellation", details: parsed.error.flatten() });
    const rideId = (request.params as { id: string }).id;
    const ride = store.getRide(rideId);
    if (!ride || ride.riderId !== requestUser(request)) return reply.code(404).send({ error: "ride_not_found" });
    if (ride.status === "cancelled") return { ride };
    if (ride.status === "completed" || ride.status === "failed") return reply.code(409).send({ error: "ride_not_cancellable" });
    try {
      const providerRideId = ride.providerRideId ?? ride.id;
      const rideProvider = providerSelection.providerForRide(ride);
      if (ride.providerRideId && !rideProvider) {
        throw new ProviderUnavailableError("The provider that booked this ride is no longer available.", ride.quote?.providerId);
      }
      let providerStatus: ProviderRideStatus;
      if (rideProvider) {
        try {
          providerStatus = providerStatusSchema.parse(await rideProvider.cancel(providerRideId, parsed.data.reason));
        } catch (error) {
          // A quoted/requested ride has no provider reservation yet. Treat an
          // unsupported or unknown provider id as an idempotent local no-op.
          if (ride.providerRideId) throw error;
          providerStatus = { providerRideId, status: "cancelled" as const, updatedAt: clock.now() };
        }
      } else {
        providerStatus = { providerRideId, status: "cancelled" as const, updatedAt: clock.now() };
      }
      const now = clock.now();
      const transition = transitionRide(ride, "cancelled", { eventId: id("event", `${ride.id}:cancelled:${now}`), occurredAt: now, actor: { id: requestUser(request), role: "rider" }, reason: parsed.data.reason ?? "Cancelled by rider" });
      const cancelled: StoredRide = { ...transition.ride, driverId: providerStatus.driverId, vehicleId: providerStatus.vehicleId };
      store.saveRide(cancelled);
      store.saveEvent(transition.event);
      store.saveEvent({ eventId: id("tool", `${ride.id}:cancel:${now}`), type: "agent.tool_call", userId: requestUser(request), rideId: ride.id, tool: "cancel_ride", arguments: { reason: parsed.data.reason }, outcome: "accepted", occurredAt: now });
      store.clearPendingRecommendation(requestUser(request));
      if (rideProvider?.name === "mock") telemetry.update(cancelled, providerStatus);
      return { ride: cancelled };
    } catch (error) {
      return reply.code(409).send({ error: "cancellation_failed", message: error instanceof Error ? error.message : "Could not cancel ride." });
    }
  });

  return app;
}

export async function createServer(dependencies: AppDependencies = {}): Promise<BuiltApp> {
  const store = dependencies.store ?? createStoreFromEnv();
  if (store instanceof PrismaRepository) await store.initialize();
  return buildApp({ ...dependencies, store });
}
