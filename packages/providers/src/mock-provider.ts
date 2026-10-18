import type { Quote, RideStatus, VehicleType } from "../../shared/src/index.js";
import type {
  BookedRide,
  ProviderCapabilities,
  ProviderRideStatus,
  QuoteRequest,
  RideProvider,
} from "./types.js";

const MOCK_TIMESTAMP = "2025-01-01T00:00:00.000Z";
const DEFAULT_VEHICLE_TYPE: VehicleType = "cab";
const TRACKING_SEQUENCE: readonly RideStatus[] = [
  "booked",
  "driver_assigned",
  "arriving",
  "arrived",
  "in_trip",
  "completed",
];

type MockBookedRide = BookedRide & { trackingIndex: number };

function stableId(prefix: string, value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `${prefix}-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function quoteFingerprint(request: QuoteRequest): string {
  return JSON.stringify({
    requestId: request.requestId,
    riderId: request.riderId,
    pickup: request.pickup,
    dropoff: request.dropoff,
    vehicleType: request.vehicleType ?? DEFAULT_VEHICLE_TYPE,
  });
}

export class MockProvider implements RideProvider {
  readonly name = "mock";
  private readonly providerCapabilities: ProviderCapabilities = {
    quoting: true,
    booking: true,
    tracking: true,
    cancellation: true,
    supportedVehicleTypes: ["bike", "auto", "cab"],
  };

  private readonly bookedRides = new Map<string, MockBookedRide>();

  capabilities(): ProviderCapabilities {
    return this.providerCapabilities;
  }

  async getQuotes(request: QuoteRequest): Promise<Quote[]> {
    const vehicleType = request.vehicleType ?? DEFAULT_VEHICLE_TYPE;
    if (!this.providerCapabilities.supportedVehicleTypes.includes(vehicleType)) {
      throw new Error(`Mock provider does not support vehicle type: ${vehicleType}`);
    }

    const fingerprint = quoteFingerprint(request);
    const quoteId = stableId("mock-quote", fingerprint);
    const amountMinor = 23800 + (fingerprint.length % 7) * 250;

    return [{
      id: quoteId,
      rideRequestId: request.requestId,
      providerId: this.name,
      vehicleType,
      amountMinor,
      currency: "INR",
      estimatedDistanceMeters: 5200,
      estimatedDurationSeconds: 900,
      expiresAt: "2025-01-01T00:10:00.000Z",
      createdAt: MOCK_TIMESTAMP,
    }];
  }

  async book(quote: Quote): Promise<BookedRide> {
    const providerRideId = stableId("mock-ride", quote.id);
    const existing = this.bookedRides.get(providerRideId);
    if (existing) {
      return this.publicRide(existing);
    }

    const initialStatus = this.statusFor(providerRideId, "booked", MOCK_TIMESTAMP);
    const bookedRide: MockBookedRide = {
      providerRideId,
      quoteId: quote.id,
      requestId: quote.rideRequestId,
      status: initialStatus,
      bookedAt: MOCK_TIMESTAMP,
      trackingIndex: 0,
    };
    this.bookedRides.set(providerRideId, bookedRide);
    return this.publicRide(bookedRide);
  }

  async track(providerRideId: string): Promise<ProviderRideStatus> {
    const ride = this.requireRide(providerRideId);
    if (ride.status.status === "cancelled" || ride.status.status === "completed") {
      return { ...ride.status };
    }

    const nextIndex = Math.min(ride.trackingIndex + 1, TRACKING_SEQUENCE.length - 1);
    ride.trackingIndex = nextIndex;
    ride.status = this.statusFor(
      providerRideId,
      TRACKING_SEQUENCE[nextIndex],
      MOCK_TIMESTAMP,
    );
    return { ...ride.status };
  }

  async cancel(providerRideId: string, reason?: string): Promise<ProviderRideStatus> {
    const ride = this.requireRide(providerRideId);
    if (ride.status.status === "completed") {
      throw new Error("Cannot cancel a completed ride");
    }
    if (ride.status.status !== "cancelled") {
      ride.status = this.statusFor(providerRideId, "cancelled", MOCK_TIMESTAMP);
      ride.cancellation = { cancelledAt: MOCK_TIMESTAMP, reason };
    }
    return { ...ride.status };
  }

  /** Advance a booked ride without relying on wall-clock time. */
  advance(providerRideId: string): Promise<ProviderRideStatus> {
    return this.track(providerRideId);
  }

  private requireRide(providerRideId: string): MockBookedRide {
    const ride = this.bookedRides.get(providerRideId);
    if (!ride) {
      throw new Error(`Unknown mock ride: ${providerRideId}`);
    }
    return ride;
  }

  private statusFor(
    providerRideId: string,
    status: RideStatus,
    updatedAt: string,
  ): ProviderRideStatus {
    return {
      providerRideId,
      status,
      updatedAt,
      ...(status !== "cancelled" && status !== "completed"
        ? { driverId: "mock-driver-001", vehicleId: "mock-vehicle-001" }
        : {}),
    };
  }

  private publicRide(ride: MockBookedRide): BookedRide {
    return {
      providerRideId: ride.providerRideId,
      quoteId: ride.quoteId,
      requestId: ride.requestId,
      status: { ...ride.status },
      bookedAt: ride.bookedAt,
      ...(ride.cancellation ? { cancellation: { ...ride.cancellation } } : {}),
    };
  }
}
