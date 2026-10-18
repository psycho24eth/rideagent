import { beforeEach, describe, expect, it } from "vitest";
import { MockProvider, type BookedRide, type ProviderRideStatus, type QuoteRequest, type RideProvider } from "@rideagent/providers";
import type { Quote } from "@rideagent/shared";
import { buildApp, type BuiltApp } from "./app.js";
import { InMemoryNotificationSink } from "./notifications.js";
import type { Clock } from "./types.js";

const fixedClock: Clock = { now: () => "2025-01-01T12:00:00.000Z" };

class TrackingProvider implements RideProvider {
  readonly inner = new MockProvider();
  readonly name = this.inner.name;
  trackCalls: string[] = [];

  capabilities() { return this.inner.capabilities(); }
  getQuotes(request: QuoteRequest): Promise<Quote[]> { return this.inner.getQuotes(request); }
  book(quote: Quote): Promise<BookedRide> { return this.inner.book(quote); }
  async track(providerRideId: string): Promise<ProviderRideStatus> {
    this.trackCalls.push(providerRideId);
    return this.inner.track(providerRideId);
  }
  cancel(providerRideId: string, reason?: string): Promise<ProviderRideStatus> { return this.inner.cancel(providerRideId, reason); }
}

async function configure(app: BuiltApp) {
  return app.inject({
    method: "PUT",
    url: "/v1/rules",
    payload: {
      perRideCapMinor: 50_000,
      dailySpendCapMinor: 100_000,
      preferredProviders: ["mock"],
      preferredVehicleType: "cab",
      preference: "balanced",
      bookingMode: "auto_book_within_rules",
    },
  });
}

async function bookRide(app: BuiltApp) {
  const response = await app.inject({
    method: "POST",
    url: "/v1/chat",
    payload: { message: "I need a ride to the airport", pickup: { label: "Home" } },
  });
  expect(response.statusCode).toBe(200);
  return response.json().ride as { id: string; providerRideId: string };
}

describe("Lexar AI Phase 3 tracking", () => {
  let provider: TrackingProvider;
  let app: BuiltApp;

  beforeEach(() => {
    provider = new TrackingProvider();
    app = buildApp({ provider, clock: fixedClock });
  });

  it("advances provider status through valid lifecycle transitions and persists events", async () => {
    await configure(app);
    const ride = await bookRide(app);

    const statuses: string[] = [];
    for (let index = 0; index < 5; index += 1) {
      const response = await app.inject({ method: "GET", url: `/v1/rides/${ride.id}/track` });
      expect(response.statusCode).toBe(200);
      statuses.push(response.json().ride.status);
    }

    expect(statuses).toEqual(["driver_assigned", "arriving", "arrived", "in_trip", "completed"]);
    expect(provider.trackCalls).toEqual([ride.providerRideId, ride.providerRideId, ride.providerRideId, ride.providerRideId, ride.providerRideId]);

    const events = await app.inject({ method: "GET", url: `/v1/rides/${ride.id}/events` });
    const transitions = events.json().events.filter((event: { type: string }) => event.type === "ride.status_changed");
    expect(transitions.map((event: { from: string; to: string }) => `${event.from}->${event.to}`)).toEqual([
      "requested->requested",
      "requested->quoted",
      "quoted->booked",
      "booked->driver_assigned",
      "driver_assigned->arriving",
      "arriving->arrived",
      "arrived->in_trip",
      "in_trip->completed",
    ]);
  });

  it("sends one normalized notification for each changed provider status", async () => {
    await configure(app);
    const ride = await bookRide(app);
    const sink = app.demo.notificationSink as InMemoryNotificationSink;

    await app.inject({ method: "GET", url: `/v1/rides/${ride.id}/track` });
    await app.inject({ method: "GET", url: `/v1/rides/${ride.id}/track` });
    const notifications = sink.notifications;

    expect(notifications).toHaveLength(2);
    expect(notifications[0]).toMatchObject({ type: "ride.updated", rideId: ride.id, status: "driver_assigned", version: 3 });
    expect(notifications[0].ride.status).toBe("driver_assigned");
    expect(notifications[0].providerStatus.status).toBe("driver_assigned");
    expect(notifications[1]).toMatchObject({ status: "arriving", version: 4 });
  });

  it("returns an ownership-protected, closing SSE snapshot", async () => {
    await configure(app);
    const ride = await bookRide(app);

    const forbidden = await app.inject({ method: "GET", url: `/v1/rides/${ride.id}/stream`, headers: { "x-demo-user": "another-user" } });
    expect(forbidden.statusCode).toBe(404);

    const response = await app.inject({ method: "GET", url: `/v1/rides/${ride.id}/stream` });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/event-stream");
    expect(response.body).toContain("event: ride.snapshot\n");
    expect(response.body).toContain(`\"rideId\":\"${ride.id}\"`);
    expect(response.body).toContain("\"status\":\"booked\"");
    expect(response.body.endsWith("\n\n")).toBe(true);
  });

  it("returns ownership-protected demo telemetry and advances it with tracking", async () => {
    await configure(app);
    const ride = await bookRide(app);

    const forbidden = await app.inject({ method: "GET", url: `/v1/rides/${ride.id}/live`, headers: { "x-demo-user": "another-user" } });
    expect(forbidden.statusCode).toBe(404);

    const initial = await app.inject({ method: "GET", url: `/v1/rides/${ride.id}/live` });
    expect(initial.statusCode).toBe(200);
    expect(initial.json()).toMatchObject({
      type: "ride.live",
      rideId: ride.id,
      source: "mock",
      isDemo: true,
      label: "Demo data",
      status: "booked",
      traffic: { level: "moderate", delayMinutes: 5 },
    });

    const tracked = await app.inject({ method: "GET", url: `/v1/rides/${ride.id}/track` });
    expect(tracked.statusCode).toBe(200);
    expect(tracked.json().assistantMessage).toContain("driver assigned");
    expect(tracked.json().blocks.find((block: { type: string }) => block.type === "live_ride").telemetry).toMatchObject({
      status: "driver_assigned",
      traffic: { delayMinutes: 6 },
    });

    const latest = await app.inject({ method: "GET", url: `/v1/rides/${ride.id}/live` });
    expect(latest.json().status).toBe("driver_assigned");
    expect(latest.json().driverLocation).not.toEqual(initial.json().driverLocation);
  });

  it("adds a normalized live update after the initial SSE snapshot", async () => {
    await configure(app);
    const ride = await bookRide(app);
    await app.inject({ method: "GET", url: `/v1/rides/${ride.id}/track` });

    const response = await app.inject({ method: "GET", url: `/v1/rides/${ride.id}/stream` });
    expect(response.body).toContain("event: ride.snapshot\n");
    expect(response.body).toContain("event: ride.live_update\n");
    expect(response.body).toContain('"source":"mock"');
    expect(response.body).toContain('"label":"Demo data"');
  });
});
