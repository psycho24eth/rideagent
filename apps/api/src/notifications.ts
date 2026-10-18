import type { NormalizedRideLiveUpdateEvent, NormalizedRideSnapshot, NotificationSink, RideLiveTelemetry, RideUpdateNotification, StoredRide } from "./types.js";

export function normalizeRideSnapshot(ride: StoredRide): NormalizedRideSnapshot {
  return {
    type: "ride.snapshot",
    rideId: ride.id,
    userId: ride.riderId,
    status: ride.status,
    version: ride.version,
    updatedAt: ride.updatedAt,
    ride: structuredClone(ride),
  };
}

export function normalizeRideLiveUpdate(ride: StoredRide, telemetry: RideLiveTelemetry): NormalizedRideLiveUpdateEvent {
  return {
    type: "ride.live_update",
    rideId: ride.id,
    userId: ride.riderId,
    status: ride.status,
    version: ride.version,
    occurredAt: telemetry.lastUpdatedAt,
    telemetry: structuredClone(telemetry),
  };
}

export class InMemoryNotificationSink implements NotificationSink {
  private readonly entries: RideUpdateNotification[] = [];

  notify(notification: RideUpdateNotification): void {
    this.entries.push(structuredClone(notification));
  }

  send(notification: RideUpdateNotification): void {
    this.notify(notification);
  }

  list(): RideUpdateNotification[] {
    return this.entries.map((notification) => structuredClone(notification));
  }

  get notifications(): RideUpdateNotification[] {
    return this.list();
  }

  clear(): void {
    this.entries.length = 0;
  }
}
