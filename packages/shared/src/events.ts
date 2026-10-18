import type { RideStatus } from "./ride-status.js";

export interface TransitionActor {
  id: string;
  role: "rider" | "driver" | "operator" | "system";
}

export interface RideTransitionContext {
  eventId: string;
  occurredAt: string;
  actor?: TransitionActor;
  reason?: string;
}

export interface RideTransitionEvent {
  eventId: string;
  type: "ride.status_changed";
  rideId: string;
  from: RideStatus;
  to: RideStatus;
  previousVersion: number;
  nextVersion: number;
  occurredAt: string;
  actor?: TransitionActor;
  reason?: string;
}

export type RideEvent = RideTransitionEvent;
