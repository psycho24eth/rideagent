import { describe, expect, it, vi } from "vitest";
import { BullMQTrackingQueue, createTrackingQueueFromEnv, trackingJobPayloadSchema } from "./jobs.js";
import { InMemoryStore } from "./store.js";
import type { StoredRide } from "./types.js";

const ride: StoredRide = {
  id: "ride-1",
  riderId: "user-1",
  pickup: { label: "Home" },
  dropoff: { label: "Airport" },
  vehicleType: "cab",
  status: "booked",
  version: 2,
  providerRideId: "provider-ride-1",
  createdAt: "2025-01-01T12:00:00.000Z",
  updatedAt: "2025-01-01T12:00:00.000Z",
};

describe("tracking jobs", () => {
  it("does not create a Redis queue when REDIS_URL is absent", () => {
    expect(createTrackingQueueFromEnv({ env: {}, store: new InMemoryStore() })).toBeUndefined();
  });

  it("validates a payload containing only ride and user ownership", () => {
    expect(trackingJobPayloadSchema.parse({ rideId: "ride-1", userId: "user-1" })).toEqual({
      rideId: "ride-1",
      userId: "user-1",
    });
    expect(() => trackingJobPayloadSchema.parse({ rideId: "ride-1", userId: "user-1", providerToken: "secret" })).toThrow();
  });

  it("does not enqueue missing, foreign, or terminal rides", async () => {
    const store = new InMemoryStore();
    store.saveRide(ride);
    const add = vi.fn().mockResolvedValue({ id: "job-1" });
    const queue = new BullMQTrackingQueue({
      redisUrl: "redis://unused",
      store,
      queue: { add, close: vi.fn().mockResolvedValue(undefined) },
    });

    await queue.enqueueTracking(ride.id, ride.riderId);
    await queue.enqueueTracking(ride.id, "another-user");
    await queue.enqueueTracking("missing", ride.riderId);
    store.saveRide({ ...ride, status: "completed" });
    await queue.enqueueTracking(ride.id, ride.riderId);

    expect(add).toHaveBeenCalledTimes(1);
    expect(add).toHaveBeenCalledWith("track-ride", { rideId: ride.id, userId: ride.riderId }, expect.objectContaining({
      attempts: 5,
      backoff: { type: "exponential", delay: 1_000 },
    }));
  });
});
