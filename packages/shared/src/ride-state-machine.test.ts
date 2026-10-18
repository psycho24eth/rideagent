import { describe, expect, it } from "vitest";

import type { Ride } from "./rides.js";
import {
  InvalidRideTransitionError,
  transitionRide,
} from "./ride-state-machine.js";

const baseRide: Ride = {
  id: "ride-1",
  riderId: "rider-1",
  pickup: { label: "Origin" },
  dropoff: { label: "Destination" },
  vehicleType: "cab",
  status: "requested",
  version: 0,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const context = (eventId: string, reason?: string) => ({
  eventId,
  occurredAt: "2026-01-01T00:01:00.000Z",
  actor: { id: "system-1", role: "system" as const },
  ...(reason ? { reason } : {}),
});

describe("ride state machine", () => {
  it("supports the full happy path and emits an auditable event per transition", () => {
    const statuses = [
      "quoted",
      "booked",
      "driver_assigned",
      "arriving",
      "arrived",
      "in_trip",
      "completed",
    ] as const;
    let ride = baseRide;

    for (const [index, status] of statuses.entries()) {
      const result = transitionRide(ride, status, context(`event-${index + 1}`));
      expect(result.event).toMatchObject({
        type: "ride.status_changed",
        rideId: "ride-1",
        from: ride.status,
        to: status,
        previousVersion: ride.version,
        nextVersion: ride.version + 1,
      });
      ride = result.ride;
    }

    expect(ride.status).toBe("completed");
    expect(ride.version).toBe(7);
    expect(baseRide.status).toBe("requested");
    expect(baseRide.version).toBe(0);
  });

  it("throws a typed error for invalid transitions", () => {
    expect(() => transitionRide(baseRide, "in_trip", context("event-invalid"))).toThrow(
      InvalidRideTransitionError,
    );

    try {
      transitionRide(baseRide, "in_trip", context("event-invalid"));
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidRideTransitionError);
      expect(error).toMatchObject({
        code: "INVALID_RIDE_TRANSITION",
        rideId: "ride-1",
        from: "requested",
        to: "in_trip",
      });
    }
  });

  it.each(["completed", "cancelled", "failed"] as const)(
    "protects terminal state %s from further transitions",
    (terminalStatus) => {
      const terminalRide = { ...baseRide, status: terminalStatus, version: 3 };
      expect(() => transitionRide(terminalRide, "requested", context("event-terminal"))).toThrow(
        InvalidRideTransitionError,
      );
    },
  );

  it.each([
    "requested",
    "quoted",
    "booked",
    "driver_assigned",
    "arriving",
    "arrived",
    "in_trip",
  ] as const)("allows cancellation from active state %s", (status) => {
    const result = transitionRide(
      { ...baseRide, status },
      "cancelled",
      context(`event-cancel-${status}`, "rider cancelled"),
    );
    expect(result.ride.status).toBe("cancelled");
    expect(result.event.reason).toBe("rider cancelled");
  });

  it.each([
    "requested",
    "quoted",
    "booked",
    "driver_assigned",
    "arriving",
    "arrived",
    "in_trip",
  ] as const)("allows failure from active state %s", (status) => {
    const result = transitionRide(
      { ...baseRide, status },
      "failed",
      context(`event-fail-${status}`, "dispatch failed"),
    );
    expect(result.ride.status).toBe("failed");
    expect(result.event.reason).toBe("dispatch failed");
  });
});
