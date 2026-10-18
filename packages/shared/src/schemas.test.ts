import { describe, expect, it } from "vitest";

import { locationSchema, rideRequestSchema } from "./schemas.js";

describe("shared input schemas", () => {
  it("accepts a coordinate-backed ride request", () => {
    const parsed = rideRequestSchema.parse({
      riderId: "rider-1",
      pickup: { coordinates: { latitude: 12.97, longitude: 77.59 } },
      dropoff: { address: "Central Station" },
      vehicleType: "cab",
      requestedAt: "2026-01-01T00:00:00.000Z",
    });

    expect(parsed.vehicleType).toBe("cab");
  });

  it("rejects invalid coordinates and empty locations", () => {
    expect(
      locationSchema.safeParse({ coordinates: { latitude: 91, longitude: 0 } }).success,
    ).toBe(false);
    expect(locationSchema.safeParse({}).success).toBe(false);
  });
});
