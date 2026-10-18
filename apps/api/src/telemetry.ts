import type { Coordinates, Location } from "@rideagent/shared";
import type { ProviderRideStatus } from "@rideagent/providers";
import type { Clock, RideLiveTelemetry, StoredRide, TrafficLevel } from "./types.js";

export const DELHI_AIRPORT_PICKUP: Coordinates = { latitude: 28.6139, longitude: 77.209 };
export const DELHI_AIRPORT_DROPOFF: Coordinates = { latitude: 28.5562, longitude: 77.1 };

export interface TelemetryService {
  get(rideId: string): RideLiveTelemetry | undefined;
  ensure(ride: StoredRide): RideLiveTelemetry | undefined;
  update(ride: StoredRide, providerStatus: ProviderRideStatus): RideLiveTelemetry | undefined;
}

interface TelemetryProfile {
  level: TrafficLevel;
  delayMinutes: number;
  etaMinutes: number;
  routePosition: number;
}

function endpoint(location: Location | undefined, fallback: Coordinates): Coordinates {
  return location?.coordinates ? { ...location.coordinates } : { ...fallback };
}

function interpolate(start: Coordinates, end: Coordinates, position: number): Coordinates {
  return {
    latitude: start.latitude + (end.latitude - start.latitude) * position,
    longitude: start.longitude + (end.longitude - start.longitude) * position,
  };
}

export function demoRouteCoordinates(ride: Pick<StoredRide, "pickup" | "dropoff">): Coordinates[] {
  const pickup = endpoint(ride.pickup, DELHI_AIRPORT_PICKUP);
  const dropoff = endpoint(ride.dropoff, DELHI_AIRPORT_DROPOFF);
  return [
    pickup,
    interpolate(pickup, dropoff, 0.25),
    interpolate(pickup, dropoff, 0.5),
    interpolate(pickup, dropoff, 0.75),
    dropoff,
  ];
}

function profileFor(status: StoredRide["status"]): TelemetryProfile {
  switch (status) {
    case "driver_assigned":
      return { level: "moderate", delayMinutes: 6, etaMinutes: 11, routePosition: 0.25 };
    case "arriving":
      return { level: "heavy", delayMinutes: 9, etaMinutes: 6, routePosition: 0.5 };
    case "arrived":
      return { level: "heavy", delayMinutes: 9, etaMinutes: 0, routePosition: 0.5 };
    case "in_trip":
      return { level: "light", delayMinutes: 2, etaMinutes: 5, routePosition: 0.75 };
    case "completed":
      return { level: "light", delayMinutes: 0, etaMinutes: 0, routePosition: 1 };
    case "cancelled":
    case "failed":
      return { level: "light", delayMinutes: 0, etaMinutes: 0, routePosition: 0 };
    case "booked":
    case "requested":
    case "quoted":
    default:
      return { level: "moderate", delayMinutes: 5, etaMinutes: 15, routePosition: 0 };
  }
}

export function demoTrafficForStatus(status: StoredRide["status"]): Pick<TelemetryProfile, "level" | "delayMinutes" | "etaMinutes"> {
  const profile = profileFor(status);
  return {
    level: profile.level,
    delayMinutes: profile.delayMinutes,
    etaMinutes: profile.etaMinutes,
  };
}

/**
 * Deterministic, clearly-labelled telemetry for the local MockProvider.
 * This service deliberately does not represent a live map or traffic feed.
 */
export class DemoTelemetryService implements TelemetryService {
  private readonly telemetry = new Map<string, RideLiveTelemetry>();

  constructor(private readonly clock: Clock) {}

  get(rideId: string): RideLiveTelemetry | undefined {
    const value = this.telemetry.get(rideId);
    return value ? structuredClone(value) : undefined;
  }

  ensure(ride: StoredRide): RideLiveTelemetry | undefined {
    if (!this.isDemoRide(ride) || !this.isLiveStatus(ride.status)) return undefined;
    const existing = this.get(ride.id);
    if (existing) return existing;
    return this.update(ride, {
      providerRideId: ride.providerRideId ?? ride.id,
      status: ride.status,
      updatedAt: this.clock.now(),
      ...(ride.driverId ? { driverId: ride.driverId } : {}),
      ...(ride.vehicleId ? { vehicleId: ride.vehicleId } : {}),
    });
  }

  update(ride: StoredRide, providerStatus: ProviderRideStatus): RideLiveTelemetry | undefined {
    if (!this.isDemoRide(ride) || !this.isLiveStatus(providerStatus.status)) return undefined;

    const pickup = endpoint(ride.pickup, DELHI_AIRPORT_PICKUP);
    const dropoff = endpoint(ride.dropoff, DELHI_AIRPORT_DROPOFF);
    const routeCoordinates = demoRouteCoordinates(ride);
    const profile = profileFor(providerStatus.status);
    const value: RideLiveTelemetry = {
      type: "ride.live",
      rideId: ride.id,
      status: providerStatus.status,
      source: "mock",
      isDemo: true,
      label: "Demo data",
      pickup,
      dropoff,
      routeCoordinates,
      traffic: {
        level: profile.level,
        delayMinutes: profile.delayMinutes,
      },
      driverLocation: interpolate(pickup, dropoff, profile.routePosition),
      ...(providerStatus.driverId || ride.driverId ? { driverId: providerStatus.driverId ?? ride.driverId } : {}),
      ...(providerStatus.vehicleId || ride.vehicleId ? { vehicleId: providerStatus.vehicleId ?? ride.vehicleId } : {}),
      etaMinutes: profile.etaMinutes,
      lastUpdatedAt: this.clock.now(),
    };
    this.telemetry.set(ride.id, value);
    return structuredClone(value);
  }

  private isDemoRide(ride: Pick<StoredRide, "quote" | "providerRideId">): boolean {
    return ride.quote?.providerId === "mock" || ride.providerRideId?.startsWith("mock-") === true;
  }

  private isLiveStatus(status: StoredRide["status"]): boolean {
    return status !== "requested" && status !== "quoted";
  }
}
