import type { Location, Quote, RideStatus, VehicleType } from "../../shared/src/index.js";
import {
  ProviderConfigurationError,
  ProviderError,
  UnsupportedProviderOperationError,
} from "./provider-error.js";
import type {
  BookedRide,
  ProviderCapabilities,
  ProviderRideStatus,
  QuoteRequest,
  RideProvider,
} from "./types.js";

export type BecknOperation = "search" | "select" | "init" | "confirm" | "status" | "track" | "cancel";

export interface BecknContext {
  domain: string;
  country: string;
  city: string;
  action: BecknOperation;
  core_version: string;
  transaction_id: string;
  message_id: string;
  bpp_id?: string;
  bpp_uri?: string;
  timestamp: string;
}

export interface BecknRequest {
  context: BecknContext;
  message: Readonly<Record<string, unknown>>;
}

export interface BecknResponse {
  context?: Partial<BecknContext> & { message_id?: string; transaction_id?: string };
  message?: Readonly<Record<string, unknown>>;
}

/** Inject a network, queue, or callback-aware test transport; no default network exists. */
export interface BecknTransport {
  send(operation: BecknOperation, request: BecknRequest): Promise<BecknResponse>;
}

export interface BecknOndcConfig {
  sandboxUrl: string;
  subscriberId: string;
  subscriberUri: string;
  country?: string;
  city?: string;
  domain?: string;
  coreVersion?: string;
  transport?: BecknTransport;
  clock?: () => string;
}

export type BecknOndcConfigInput = Partial<BecknOndcConfig>;

const BECKN_TIMESTAMP = "2025-01-01T00:00:00.000Z";
const DEFAULT_DOMAIN = "ONDC:TRV11";
const DEFAULT_COUNTRY = "IND";
const DEFAULT_CITY = "std:011";
const DEFAULT_CORE_VERSION = "1.2.0";

function runtimeEnv(): Readonly<Record<string, string | undefined>> {
  const processLike = (globalThis as {
    process?: { env?: Readonly<Record<string, string | undefined>> };
  }).process;
  return processLike?.env ?? {};
}

export function becknConfigFromEnv(
  env: Readonly<Record<string, string | undefined>> = runtimeEnv(),
): BecknOndcConfigInput {
  return {
    sandboxUrl: env.BECKN_SANDBOX_URL ?? env.ONDC_SANDBOX_URL,
    subscriberId: env.BECKN_SUBSCRIBER_ID ?? env.ONDC_SUBSCRIBER_ID,
    subscriberUri: env.BECKN_SUBSCRIBER_URI ?? env.ONDC_SUBSCRIBER_URI,
    country: env.BECKN_COUNTRY ?? env.ONDC_COUNTRY,
    city: env.BECKN_CITY ?? env.ONDC_CITY,
    domain: env.BECKN_DOMAIN ?? env.ONDC_DOMAIN,
    coreVersion: env.BECKN_CORE_VERSION ?? env.ONDC_CORE_VERSION,
  };
}

export class BecknOndcProvider implements RideProvider {
  readonly name = "beckn-ondc";
  private readonly config: BecknOndcConfig;
  private readonly providerCapabilities: ProviderCapabilities = {
    quoting: true,
    booking: true,
    tracking: true,
    cancellation: true,
    supportedVehicleTypes: ["bike", "auto", "cab"],
  };
  private readonly quoteRequests = new Map<string, QuoteRequest>();

  constructor(config: BecknOndcConfigInput) {
    const missing = ["sandboxUrl", "subscriberId", "subscriberUri"].filter(
      (key) => !config[key as keyof BecknOndcConfig],
    );
    if (missing.length > 0) {
      throw new ProviderConfigurationError(this.name, missing);
    }
    this.config = {
      sandboxUrl: config.sandboxUrl!,
      subscriberId: config.subscriberId!,
      subscriberUri: config.subscriberUri!,
      country: config.country ?? DEFAULT_COUNTRY,
      city: config.city ?? DEFAULT_CITY,
      domain: config.domain ?? DEFAULT_DOMAIN,
      coreVersion: config.coreVersion ?? DEFAULT_CORE_VERSION,
      transport: config.transport,
      clock: config.clock ?? (() => BECKN_TIMESTAMP),
    };
  }

  static fromEnv(
    env: Readonly<Record<string, string | undefined>> = runtimeEnv(),
    overrides: BecknOndcConfigInput = {},
  ): BecknOndcProvider {
    return new BecknOndcProvider({ ...becknConfigFromEnv(env), ...overrides });
  }

  capabilities(): ProviderCapabilities {
    return this.providerCapabilities;
  }

  async getQuotes(request: QuoteRequest): Promise<Quote[]> {
    const response = await this.search(request);
    const message = response.message ?? {};
    const rawQuotes = Array.isArray(message.quotes)
      ? message.quotes
      : this.catalogQuotes(message.catalog);
    const quotes = rawQuotes.map((raw, index) => this.quoteFromResponse(raw, request, index));
    quotes.forEach((quote) => this.quoteRequests.set(quote.id, request));
    return quotes;
  }

  async book(quote: Quote): Promise<BookedRide> {
    const request = this.quoteRequests.get(quote.id);
    const transactionId = this.transactionId(quote.rideRequestId);
    await this.select(quote, transactionId);
    await this.init(quote, transactionId);
    const response = await this.confirm(quote, transactionId);
    const providerRideId = this.orderId(response) ?? `beckn-ride-${quote.id}`;
    const status = this.statusFrom(providerRideId, response, "booked");
    return {
      providerRideId,
      quoteId: quote.id,
      requestId: request?.requestId ?? quote.rideRequestId,
      status,
      bookedAt: this.config.clock!(),
    };
  }

  async search(request: QuoteRequest): Promise<BecknResponse> {
    return this.send("search", request.requestId, {
      intent: {
        fulfillment: {
          start: { location: this.locationPayload(request.pickup) },
          end: { location: this.locationPayload(request.dropoff) },
        },
      },
    });
  }

  async select(quote: Quote, transactionId = this.transactionId(quote.rideRequestId)): Promise<BecknResponse> {
    return this.send("select", quote.rideRequestId, {
      order: { provider: { id: quote.providerId }, items: [{ id: quote.id }] },
    }, transactionId);
  }

  async init(quote: Quote, transactionId = this.transactionId(quote.rideRequestId)): Promise<BecknResponse> {
    return this.send("init", quote.rideRequestId, {
      order: { provider: { id: quote.providerId }, items: [{ id: quote.id }] },
    }, transactionId);
  }

  async confirm(quote: Quote, transactionId = this.transactionId(quote.rideRequestId)): Promise<BecknResponse> {
    return this.send("confirm", quote.rideRequestId, {
      order: { provider: { id: quote.providerId }, items: [{ id: quote.id }] },
    }, transactionId);
  }

  async status(providerRideId: string): Promise<BecknResponse> {
    return this.send("status", providerRideId, { order_id: providerRideId });
  }

  async track(providerRideId: string): Promise<ProviderRideStatus> {
    const response = await this.send("track", providerRideId, { order_id: providerRideId });
    return this.statusFrom(providerRideId, response, "booked");
  }

  async cancel(providerRideId: string, reason?: string): Promise<ProviderRideStatus> {
    const response = await this.send("cancel", providerRideId, {
      order_id: providerRideId,
      cancellation_reason: reason,
    });
    return this.statusFrom(providerRideId, response, "cancelled");
  }

  private async send(
    operation: BecknOperation,
    correlationId: string,
    message: Readonly<Record<string, unknown>>,
    transactionId = this.transactionId(correlationId),
  ): Promise<BecknResponse> {
    if (!this.config.transport) {
      throw new ProviderError(this.name, "transport_not_configured", "No Beckn transport was injected.");
    }
    const request: BecknRequest = {
      context: {
        domain: this.config.domain!,
        country: this.config.country!,
        city: this.config.city!,
        action: operation,
        core_version: this.config.coreVersion!,
        transaction_id: transactionId,
        message_id: `${operation}-${correlationId}`,
        bpp_id: this.config.subscriberId,
        bpp_uri: this.config.subscriberUri,
        timestamp: this.config.clock!(),
      },
      message,
    };
    let response: BecknResponse;
    try {
      response = await this.config.transport.send(operation, request);
    } catch (error) {
      throw new ProviderError(this.name, "transport_error", "Beckn transport failed.", {
        cause: error instanceof Error ? error.message : String(error),
      });
    }
    const responseContext = response.context;
    if (
      responseContext &&
      (responseContext.message_id !== undefined &&
        responseContext.message_id !== request.context.message_id ||
        responseContext.transaction_id !== undefined &&
          responseContext.transaction_id !== request.context.transaction_id)
    ) {
      throw new ProviderError(this.name, "correlation_mismatch", "Beckn callback correlation did not match the request.");
    }
    return response;
  }

  private transactionId(correlationId: string): string {
    return `rideagent-${correlationId}`;
  }

  private locationPayload(location: Location): Readonly<Record<string, string | undefined>> {
    return {
      gps: location.coordinates
        ? `${location.coordinates.latitude},${location.coordinates.longitude}`
        : undefined,
      address: location.address ?? location.label,
    };
  }

  private catalogQuotes(catalog: unknown): readonly unknown[] {
    if (!catalog || typeof catalog !== "object") return [];
    const providers = (catalog as { providers?: unknown }).providers;
    if (!Array.isArray(providers)) return [];
    return providers.flatMap((provider) => {
      if (!provider || typeof provider !== "object") return [];
      const items = (provider as { items?: unknown }).items;
      return Array.isArray(items) ? items : [];
    });
  }

  private quoteFromResponse(raw: unknown, request: QuoteRequest, index: number): Quote {
    const value = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
    const itemId = typeof value.id === "string" ? value.id : `item-${index + 1}`;
    const amount = typeof value.amountMinor === "number"
      ? value.amountMinor
      : typeof value.price === "number" ? value.price : 0;
    const vehicleType = value.vehicleType === "bike" || value.vehicleType === "auto" || value.vehicleType === "cab"
      ? value.vehicleType
      : request.vehicleType ?? "cab";
    return {
      id: `beckn-quote-${itemId}`,
      rideRequestId: request.requestId,
      providerId: this.name,
      vehicleType,
      amountMinor: amount,
      currency: typeof value.currency === "string" ? value.currency : "INR",
      estimatedDistanceMeters: typeof value.estimatedDistanceMeters === "number" ? value.estimatedDistanceMeters : 0,
      estimatedDurationSeconds: typeof value.estimatedDurationSeconds === "number" ? value.estimatedDurationSeconds : 0,
      expiresAt: typeof value.expiresAt === "string" ? value.expiresAt : "2025-01-01T00:10:00.000Z",
      createdAt: this.config.clock!(),
    };
  }

  private orderId(response: BecknResponse): string | undefined {
    const message = response.message ?? {};
    const order = message.order;
    if (order && typeof order === "object" && typeof (order as { id?: unknown }).id === "string") {
      return (order as { id: string }).id;
    }
    return typeof message.order_id === "string" ? message.order_id : undefined;
  }

  private statusFrom(providerRideId: string, response: BecknResponse, fallback: RideStatus): ProviderRideStatus {
    const message = response.message ?? {};
    const rawStatus = message.status;
    const allowed: readonly RideStatus[] = ["requested", "quoted", "booked", "driver_assigned", "arriving", "arrived", "in_trip", "completed", "cancelled", "failed"];
    const status = typeof rawStatus === "string" && allowed.includes(rawStatus as RideStatus)
      ? rawStatus as RideStatus
      : fallback;
    return { providerRideId, status, updatedAt: this.config.clock!() };
  }
}
