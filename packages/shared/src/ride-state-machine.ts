import type { RideTransitionContext, RideTransitionEvent } from "./events.js";
import type { Ride } from "./rides.js";
import type { RideStatus } from "./ride-status.js";

export const RIDE_TRANSITIONS: Readonly<Record<RideStatus, readonly RideStatus[]>> = {
  requested: ["quoted", "cancelled", "failed"],
  quoted: ["booked", "cancelled", "failed"],
  booked: ["driver_assigned", "cancelled", "failed"],
  driver_assigned: ["arriving", "cancelled", "failed"],
  arriving: ["arrived", "cancelled", "failed"],
  arrived: ["in_trip", "cancelled", "failed"],
  in_trip: ["completed", "cancelled", "failed"],
  completed: [],
  cancelled: [],
  failed: [],
};

export class InvalidRideTransitionError extends Error {
  readonly code = "INVALID_RIDE_TRANSITION" as const;
  readonly rideId: string;
  readonly from: RideStatus;
  readonly to: RideStatus;

  constructor(rideId: string, from: RideStatus, to: RideStatus) {
    super(`Invalid ride transition for ${rideId}: ${from} -> ${to}`);
    this.name = "InvalidRideTransitionError";
    this.rideId = rideId;
    this.from = from;
    this.to = to;
  }
}

export interface RideTransitionResult {
  ride: Ride;
  event: RideTransitionEvent;
}

export function canTransition(from: RideStatus, to: RideStatus): boolean {
  return RIDE_TRANSITIONS[from].includes(to);
}

export const isValidRideTransition = canTransition;

export function transitionRide(
  ride: Ride,
  to: RideStatus,
  context: RideTransitionContext,
): RideTransitionResult {
  if (!canTransition(ride.status, to)) {
    throw new InvalidRideTransitionError(ride.id, ride.status, to);
  }

  const previousVersion = ride.version;
  const nextVersion = previousVersion + 1;
  const nextRide: Ride = {
    ...ride,
    status: to,
    version: nextVersion,
    updatedAt: context.occurredAt,
  };
  const event: RideTransitionEvent = {
    eventId: context.eventId,
    type: "ride.status_changed",
    rideId: ride.id,
    from: ride.status,
    to,
    previousVersion,
    nextVersion,
    occurredAt: context.occurredAt,
    ...(context.actor ? { actor: context.actor } : {}),
    ...(context.reason ? { reason: context.reason } : {}),
  };

  return { ride: nextRide, event };
}
