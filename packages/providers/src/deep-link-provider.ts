import type { Location, Quote, VehicleType } from "../../shared/src/index.js";
import {
  HumanActionRequiredProviderError,
  UnsupportedProviderOperationError,
} from "./provider-error.js";
import type {
  BookedRide,
  ProviderCapabilities,
  ProviderRideStatus,
  QuoteRequest,
  RideProvider,
} from "./types.js";

const DEEP_LINK_TIMESTAMP = "2025-01-01T00:00:00.000Z";
const DEFAULT_VEHICLE_TYPE: VehicleType = "cab";

export interface DeepLinkProviderOptions {
  /** An HTTPS landing page or app deep-link base. */
  baseUrl?: string;
}

function stableId(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `deep-link-quote-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function locationValue(location: Location): string {
  return JSON.stringify(location);
}

/** A deterministic quote adapter that hands booking off to a human. */
export class DeepLinkProvider implements RideProvider {
  readonly name = "deep-link";
  private readonly baseUrl: string;
  private readonly providerCapabilities: ProviderCapabilities = {
    quoting: true,
    booking: false,
    tracking: false,
    cancellation: false,
    supportedVehicleTypes: ["bike", "auto", "cab"],
  };

  constructor(options: DeepLinkProviderOptions = {}) {
    this.baseUrl = options.baseUrl ?? "https://rideagent.example/ride";
  }

  capabilities(): ProviderCapabilities {
    return this.providerCapabilities;
  }

  async getQuotes(request: QuoteRequest): Promise<Quote[]> {
    const vehicleType = request.vehicleType ?? DEFAULT_VEHICLE_TYPE;
    const query = new URLSearchParams({
      requestId: request.requestId,
      pickup: locationValue(request.pickup),
      dropoff: locationValue(request.dropoff),
      vehicleType,
    });
    const deepLink = `${this.baseUrl}?${query.toString()}`;
    const quoteId = stableId(`${request.requestId}|${deepLink}`);

    return [{
      id: quoteId,
      rideRequestId: request.requestId,
      providerId: this.name,
      vehicleType,
      amountMinor: 0,
      currency: "INR",
      estimatedDistanceMeters: 0,
      estimatedDurationSeconds: 0,
      expiresAt: "2025-01-01T00:10:00.000Z",
      createdAt: DEEP_LINK_TIMESTAMP,
      deepLink,
    }];
  }

  async book(quote: Quote): Promise<BookedRide> {
    if (!quote.deepLink) {
      throw new Error("Deep-link quote is missing its action URL");
    }
    throw new HumanActionRequiredProviderError(this.name, quote.deepLink);
  }

  async track(_providerRideId: string): Promise<ProviderRideStatus> {
    throw new UnsupportedProviderOperationError(this.name, "tracking");
  }

  async cancel(_providerRideId: string, _reason?: string): Promise<ProviderRideStatus> {
    throw new UnsupportedProviderOperationError(this.name, "cancellation");
  }
}
