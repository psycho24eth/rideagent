import { describe, expect, it } from "vitest";
import { MockProvider } from "./mock-provider.js";

const request = {
  requestId: "request-001",
  riderId: "rider-001",
  pickup: { label: "Start", coordinates: { latitude: 12.97, longitude: 77.59 } },
  dropoff: { label: "End", coordinates: { latitude: 12.98, longitude: 77.60 } },
  vehicleType: "cab" as const,
};

describe("MockProvider", () => {
  it("returns stable, provider-compatible quotes", async () => {
    const provider = new MockProvider();
      const first = await provider.getQuotes(request);
      const second = await provider.getQuotes(request);

    expect(first).toEqual(second);
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({
      id: expect.stringMatching(/^mock-quote-/),
      rideRequestId: "request-001",
      providerId: "mock",
      amountMinor: expect.any(Number),
      currency: "INR",
    });
  });

  it("books and deterministically progresses a ride", async () => {
    const provider = new MockProvider();
    const quote = (await provider.getQuotes(request))[0];
    const booked = await provider.book(quote);

    expect(booked.status.status).toBe("booked");
    expect((await provider.track(booked.providerRideId)).status).toBe("driver_assigned");
    expect((await provider.track(booked.providerRideId)).status).toBe("arriving");
    expect((await provider.track(booked.providerRideId)).status).toBe("arrived");
    expect((await provider.track(booked.providerRideId)).status).toBe("in_trip");
    expect((await provider.track(booked.providerRideId)).status).toBe("completed");
    expect((await provider.track(booked.providerRideId)).status).toBe("completed");
  });

  it("supports cancellation and keeps it terminal", async () => {
    const provider = new MockProvider();
    const quote = (await provider.getQuotes(request))[0];
    const booked = await provider.book(quote);

    const cancelled = await provider.cancel(booked.providerRideId, "rider changed plans");
    expect(cancelled.status).toBe("cancelled");
    expect((await provider.track(booked.providerRideId)).status).toBe("cancelled");
    expect(await provider.cancel(booked.providerRideId, "same reason")).toEqual(cancelled);
  });
});
