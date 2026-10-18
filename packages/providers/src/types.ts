import type {
  Location,
  Quote,
  RideStatus,
  VehicleType,
} from "../../shared/src/index.js";

export interface QuoteRequest {
  requestId: string;
  riderId: string;
  pickup: Location;
  dropoff: Location;
  vehicleType?: VehicleType;
  requestedAt?: string;
}

export interface ProviderCapabilities {
  quoting: boolean;
  booking: boolean;
  tracking: boolean;
  cancellation: boolean;
  supportedVehicleTypes: readonly VehicleType[];
}

export interface ProviderRideStatus {
  providerRideId: string;
  status: RideStatus;
  updatedAt: string;
  driverId?: string;
  vehicleId?: string;
}

export interface BookedRide {
  providerRideId: string;
  quoteId: string;
  requestId: string;
  status: ProviderRideStatus;
  bookedAt: string;
  cancellation?: {
    cancelledAt: string;
    reason?: string;
  };
}

export interface RideProvider {
  readonly name: string;
  capabilities(): ProviderCapabilities;

  getQuotes(request: QuoteRequest): Promise<Quote[]>;
  book(quote: Quote): Promise<BookedRide>;
  track(providerRideId: string): Promise<ProviderRideStatus>;
  cancel(providerRideId: string, reason?: string): Promise<ProviderRideStatus>;
}
