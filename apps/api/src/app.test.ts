import { describe, expect, it, beforeEach } from "vitest";
import { DeepLinkProvider, MockProvider, RegionRouter, type BookedRide, type ProviderRideStatus, type QuoteRequest, type RideProvider } from "@rideagent/providers";
import type { Quote } from "@rideagent/shared";
import { buildApp, type BuiltApp } from "./app.js";
import type { Clock } from "./types.js";

const fixedClock: Clock = { now: () => "2025-01-01T12:00:00.000Z" };

class CountingProvider implements RideProvider {
  readonly inner = new MockProvider();
  readonly name = this.inner.name;
  bookCalls = 0;
  trackCalls = 0;
  cancelCalls = 0;

  capabilities() { return this.inner.capabilities(); }
  getQuotes(request: QuoteRequest): Promise<Quote[]> { return this.inner.getQuotes(request); }
  async book(quote: Quote): Promise<BookedRide> { this.bookCalls += 1; return this.inner.book(quote); }
  async track(providerRideId: string): Promise<ProviderRideStatus> { this.trackCalls += 1; return this.inner.track(providerRideId); }
  async cancel(providerRideId: string, reason?: string): Promise<ProviderRideStatus> { this.cancelCalls += 1; return this.inner.cancel(providerRideId, reason); }
}

async function configure(app: BuiltApp, bookingMode: "ask_before_booking" | "auto_book_within_rules" = "ask_before_booking", overrides: Record<string, unknown> = {}) {
  return app.inject({
    method: "PUT",
    url: "/v1/rules",
    payload: {
      perRideCapMinor: 50_000,
      dailySpendCapMinor: 100_000,
      preferredProviders: ["mock"],
      preferredVehicleType: "cab",
      preference: "balanced",
      bookingMode,
      ...overrides,
    },
  });
}

async function requestRide(app: BuiltApp, message = "I need a ride to the airport") {
  return app.inject({ method: "POST", url: "/v1/chat", payload: { message, pickup: { label: "Home" } } });
}

describe("Lexar AI Step 2 API", () => {
  let provider: CountingProvider;
  let app: BuiltApp;

  beforeEach(() => {
    provider = new CountingProvider();
    app = buildApp({ provider, clock: fixedClock });
  });

  it("requires rules before a ride request", async () => {
    const response = await requestRide(app);
    expect(response.statusCode).toBe(409);
    expect(response.json().error).toBe("rules_required");
  });

  it("asks before booking and supports chat/readback without calling book", async () => {
    await configure(app);
    const response = await requestRide(app);
    const body = response.json();
    expect(response.statusCode).toBe(200);
    expect(body.assistantMessage).toContain("Want me to proceed with the cab booking?");
    expect(provider.bookCalls).toBe(0);
    expect(body.ride.status).toBe("quoted");

    const ride = await app.inject({ method: "GET", url: `/v1/rides/${body.ride.id}` });
    const events = await app.inject({ method: "GET", url: `/v1/rides/${body.ride.id}/events` });
    expect(ride.json().status).toBe("quoted");
    expect(events.json().events.map((event: { type: string }) => event.type)).toContain("agent.decision");
  });

  it("returns safe rich recommendation blocks without exposing tool internals", async () => {
    await configure(app);
    const response = await requestRide(app);
    const body = response.json();

    expect(body.blocks.map((block: { type: string }) => block.type)).toEqual([
      "text",
      "progress",
      "route",
      "traffic",
      "quote",
      "actions",
    ]);
    expect(body.blocks.find((block: { type: string }) => block.type === "route")).toMatchObject({
      title: "Delhi airport demo route",
      isDemo: true,
      label: "Demo data",
      coordinates: expect.arrayContaining([{ latitude: 28.6139, longitude: 77.209 }]),
    });
    expect(body.blocks.find((block: { type: string }) => block.type === "traffic")).toMatchObject({
      source: "demo",
      isDemo: true,
      level: "moderate",
      delayMinutes: 5,
    });
    expect(body.blocks.find((block: { type: string }) => block.type === "quote")).toMatchObject({
      providerId: "mock",
      humanActionRequired: false,
    });
    expect(body.blocks.find((block: { type: string }) => block.type === "actions").actions).toEqual([
      { id: "confirm_booking", label: "Confirm booking", value: "yes" },
      { id: "reject_recommendation", label: "Not now", value: "no" },
    ]);
    expect(JSON.stringify(body.blocks)).not.toContain("tool_call");
  });

  it("collects registered provider quotes and ranks the bookable mock quote ahead of handoff", async () => {
    const deepLinkProvider = new DeepLinkProvider({ baseUrl: "https://example.test/ride" });
    app = buildApp({
      providerRegistry: new RegionRouter([
        { country: "India", city: "Delhi", provider: deepLinkProvider },
        { country: "India", city: "Delhi", provider },
      ]),
      clock: fixedClock,
    });
    await configure(app, "auto_book_within_rules");

    const response = await app.inject({
      method: "POST",
      url: "/v1/chat",
      payload: { message: "I need a ride to the airport", pickup: { label: "Home", country: "IN", city: "Delhi" } },
    });
    const body = response.json();

    expect(response.statusCode).toBe(200);
    expect(body.quotes.map((quote: { providerId: string }) => quote.providerId)).toEqual(["deep-link", "mock"]);
    expect(body.quotes.find((quote: { providerId: string }) => quote.providerId === "deep-link")).toMatchObject({
      humanActionRequired: true,
      deepLink: expect.stringContaining("https://example.test/ride"),
    });
    expect(body.quote.providerId).toBe("mock");
    expect(body.ride.status).toBe("booked");
    expect(provider.bookCalls).toBe(1);

    const tracked = await app.inject({ method: "GET", url: `/v1/rides/${body.ride.id}/track` });
    expect(tracked.statusCode).toBe(200);
    expect(provider.trackCalls).toBe(1);
    const cancelled = await app.inject({ method: "POST", url: `/v1/rides/${body.ride.id}/cancel`, payload: { reason: "Changed plans" } });
    expect(cancelled.statusCode).toBe(200);
    expect(provider.cancelCalls).toBe(1);
  });

  it("uses the deterministic mock provider as the default Delhi recommendation", async () => {
    app = buildApp({ clock: fixedClock });
    await configure(app);

    const response = await requestRide(app);
    const body = response.json();

    expect(response.statusCode).toBe(200);
    expect(body.quotes.map((quote: { providerId: string }) => quote.providerId)).toEqual(["mock", "deep-link"]);
    expect(body.quote.providerId).toBe("mock");
    expect(body.ride.status).toBe("quoted");
  });

  it("returns a safe human-action response when the selected provider is deep-link only", async () => {
    const deepLinkProvider = new DeepLinkProvider({ baseUrl: "https://example.test/ride" });
    app = buildApp({
      providerRegistry: new RegionRouter([{ country: "India", city: "Delhi", provider: deepLinkProvider }]),
      clock: fixedClock,
    });
    await configure(app);

    const recommendation = await requestRide(app);
    expect(recommendation.statusCode).toBe(200);
    expect(recommendation.json()).toMatchObject({
      humanActionRequired: true,
      quote: { providerId: "deep-link", humanActionRequired: true },
    });
    const deepLink = recommendation.json().quote.deepLink as string;

    const confirmation = await app.inject({ method: "POST", url: "/v1/chat", payload: { message: "Yes, proceed" } });
    expect(confirmation.statusCode).toBe(409);
    expect(confirmation.json()).toMatchObject({ error: "human_action_required", humanActionRequired: true, deepLink });
    expect(confirmation.json().blocks.find((block: { type: string }) => block.type === "progress").text).toContain("not booked");
    expect(confirmation.json().blocks.map((block: { type: string }) => block.type)).toContain("actions");

    const ride = await app.inject({ method: "GET", url: `/v1/rides/${recommendation.json().ride.id}` });
    expect(ride.json().status).toBe("quoted");
  });

  it("books after a positive confirmation", async () => {
    await configure(app);
    const recommendation = await requestRide(app);
    const response = await app.inject({ method: "POST", url: "/v1/chat", payload: { message: "Yes, proceed" } });
    expect(response.statusCode).toBe(200);
    expect(provider.bookCalls).toBe(1);
    expect(response.json().assistantMessage).toContain(`Ride id: ${recommendation.json().ride.id}`);
    expect(response.json().ride.status).toBe("booked");
    expect(response.json().blocks.map((block: { type: string }) => block.type)).toEqual([
      "text",
      "progress",
      "route",
      "traffic",
      "booking_confirmation",
      "live_ride",
    ]);
    expect(response.json().blocks.find((block: { type: string }) => block.type === "live_ride").telemetry).toMatchObject({
      source: "mock",
      isDemo: true,
      label: "Demo data",
      status: "booked",
    });
  });

  it("auto-books only when the saved rules allow it", async () => {
    await configure(app, "auto_book_within_rules");
    const response = await requestRide(app);
    expect(response.statusCode).toBe(200);
    expect(provider.bookCalls).toBe(1);
    expect(response.json().ride.status).toBe("booked");
    expect(response.json().blocks.map((block: { type: string }) => block.type)).toContain("booking_confirmation");
    expect(response.json().blocks.map((block: { type: string }) => block.type)).toContain("live_ride");
  });

  it("rejects an over-cap auto-booking", async () => {
    await configure(app, "auto_book_within_rules", { perRideCapMinor: 1 });
    const response = await requestRide(app);
    expect(response.statusCode).toBe(422);
    expect(response.json().error).toBe("per_ride_cap");
    expect(provider.bookCalls).toBe(0);
  });

  it("rejects a booking over the daily cap", async () => {
    await configure(app, "auto_book_within_rules", { dailySpendCapMinor: 1 });
    const response = await requestRide(app);
    expect(response.statusCode).toBe(422);
    expect(response.json().error).toBe("daily_cap");
    expect(provider.bookCalls).toBe(0);
  });

  it("does not book negative or unclear confirmations", async () => {
    await configure(app);
    await requestRide(app);
    const no = await app.inject({ method: "POST", url: "/v1/chat", payload: { message: "No, not now" } });
    expect(no.json().assistantMessage).toContain("won’t book");
    expect(provider.bookCalls).toBe(0);

    await requestRide(app, "Please take me to the airport terminal 2");
    const unclear = await app.inject({ method: "POST", url: "/v1/chat", payload: { message: "Maybe" } });
    expect(unclear.json().assistantMessage).toContain("reply yes");
    expect(provider.bookCalls).toBe(0);
  });

  it("cancels a booked ride and remains idempotent", async () => {
    await configure(app, "auto_book_within_rules");
    const booked = await requestRide(app);
    const first = await app.inject({ method: "POST", url: `/v1/rides/${booked.json().ride.id}/cancel`, payload: { reason: "Plans changed" } });
    const second = await app.inject({ method: "POST", url: `/v1/rides/${booked.json().ride.id}/cancel`, payload: {} });
    expect(first.statusCode).toBe(200);
    expect(first.json().ride.status).toBe("cancelled");
    expect(second.statusCode).toBe(200);
    expect(second.json().ride.status).toBe("cancelled");
    expect(provider.cancelCalls).toBe(1);
  });
});
