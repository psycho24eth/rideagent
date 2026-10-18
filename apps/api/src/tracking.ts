import type { ProviderRideStatus, RideProvider } from "@rideagent/providers";
import { canTransition, transitionRide, type RideTransitionEvent } from "@rideagent/shared";
import { providerStatusSchema } from "./schemas.js";
import { ProviderSelectionService } from "./provider-selection.js";
import { liveRideText } from "./rich-output.js";
import type { Clock, NotificationSink, RideLiveTelemetry, RideRepository, RideUpdateNotification, StoredRide } from "./types.js";
import type { TelemetryService } from "./telemetry.js";

function stableId(prefix: string, value: string): string {
  let hash = 2166136261;
  for (const character of value) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return `${prefix}-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function withProviderDetails(ride: StoredRide, status: ProviderRideStatus): StoredRide {
  return {
    ...ride,
    ...(status.driverId ? { driverId: status.driverId } : {}),
    ...(status.vehicleId ? { vehicleId: status.vehicleId } : {}),
  };
}

function hasProviderDetailsChanged(before: StoredRide, after: StoredRide): boolean {
  return before.driverId !== after.driverId || before.vehicleId !== after.vehicleId;
}

export class TrackingError extends Error {
  readonly code: "RIDE_NOT_FOUND" | "PROVIDER_TRACK_FAILED" | "INVALID_PROVIDER_STATUS";

  constructor(code: TrackingError["code"], message: string) {
    super(message);
    this.name = "TrackingError";
    this.code = code;
  }
}

export interface TrackRideResult {
  ride: StoredRide;
  providerStatus: ProviderRideStatus;
  changed: boolean;
  event?: RideTransitionEvent;
  notification?: RideUpdateNotification;
  liveTelemetry?: RideLiveTelemetry;
  assistantMessage?: string;
}

export interface TrackingServiceDependencies {
  provider: RideProvider;
  providerSelection?: ProviderSelectionService;
  store: RideRepository;
  clock: Clock;
  notificationSink: NotificationSink;
  telemetry?: TelemetryService;
}

export class TrackingService {
  constructor(private readonly dependencies: TrackingServiceDependencies) {}

  async track(rideId: string, userId: string): Promise<TrackRideResult> {
    const { store, clock, notificationSink } = this.dependencies;
    const current = store.getRide(rideId);
    if (!current || current.riderId !== userId) {
      throw new TrackingError("RIDE_NOT_FOUND", "Ride not found.");
    }

    const provider = this.dependencies.providerSelection?.providerForRide(current) ??
      (this.dependencies.providerSelection ? undefined : this.dependencies.provider);
    if (!provider) {
      throw new TrackingError("PROVIDER_TRACK_FAILED", "The provider that booked this ride is no longer available.");
    }

    const previousTelemetry = this.dependencies.telemetry?.get(rideId);
    let providerStatus: ProviderRideStatus;
    try {
      providerStatus = providerStatusSchema.parse(await provider.track(current.providerRideId ?? current.id));
    } catch (error) {
      if (error instanceof TrackingError) throw error;
      throw new TrackingError(
        "PROVIDER_TRACK_FAILED",
        error instanceof Error ? error.message : "The ride provider could not return a status.",
      );
    }

    const withDetails = withProviderDetails(current, providerStatus);
    let nextRide = withDetails;
    let event: RideTransitionEvent | undefined;
    let changed = false;

    if (providerStatus.status !== current.status && canTransition(current.status, providerStatus.status)) {
      const transition = transitionRide(current, providerStatus.status, {
        eventId: stableId("event", `${current.id}:track:${current.version + 1}:${providerStatus.status}`),
        occurredAt: providerStatus.updatedAt || clock.now(),
        actor: { id: "rideagent", role: "system" },
        reason: `Provider ${provider.name} status update`,
      });
      nextRide = { ...transition.ride, ...withProviderDetails(transition.ride, providerStatus) };
      event = transition.event;
      changed = true;
    }

    const detailsChanged = hasProviderDetailsChanged(current, nextRide);
    if (changed || detailsChanged) {
      store.saveRide(nextRide);
    }

    if (event) {
      store.saveEvent(event);
    }

    const liveTelemetry = provider.name === "mock"
      ? this.dependencies.telemetry?.update(nextRide, providerStatus)
      : undefined;
    const assistantMessage = liveTelemetry
      ? trackingMessage(previousTelemetry, liveTelemetry)
      : undefined;

    let notification: RideUpdateNotification | undefined;
    if (changed || detailsChanged) {
      notification = {
        type: "ride.updated",
        notificationId: stableId("notification", `${nextRide.id}:${nextRide.version}:${providerStatus.status}`),
        rideId: nextRide.id,
        userId: nextRide.riderId,
        status: nextRide.status,
        version: nextRide.version,
        occurredAt: providerStatus.updatedAt,
        ride: structuredClone(nextRide),
        providerStatus: structuredClone(providerStatus),
        ...(event ? { event } : {}),
      };
      await notificationSink.notify(notification);
    }

    return {
      ride: nextRide,
      providerStatus,
      changed,
      ...(event ? { event } : {}),
      ...(notification ? { notification } : {}),
      ...(liveTelemetry ? { liveTelemetry } : {}),
      ...(assistantMessage ? { assistantMessage } : {}),
    };
  }

  trackRide(rideId: string, userId: string): Promise<TrackRideResult> {
    return this.track(rideId, userId);
  }
}

export { TrackingService as RideTrackingService };

function trackingMessage(
  previous: RideLiveTelemetry | undefined,
  current: RideLiveTelemetry,
): string {
  const statusMessage = liveRideText(current);
  const trafficChanged = previous && (
    previous.traffic.level !== current.traffic.level ||
    previous.traffic.delayMinutes !== current.traffic.delayMinutes
  );
  if (!trafficChanged) return statusMessage;
  const trafficMessage = current.traffic.delayMinutes === 0
    ? "Demo traffic is now light with no added delay."
    : `Demo traffic changed to ${current.traffic.level}, adding about ${current.traffic.delayMinutes} minutes.`;
  return `${statusMessage} ${trafficMessage}`;
}
