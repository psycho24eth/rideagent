import type { Location, Quote } from "@rideagent/shared";
import type { ProviderRegistry, QuoteRequest, RegionLocation, RideProvider } from "@rideagent/providers";

export const DEFAULT_DEMO_REGION = {
  country: "India",
  city: "Delhi",
} as const;

export type QuoteOption = Quote & { humanActionRequired?: boolean };

/** Keep the existing demo payloads routable while allowing regional metadata. */
export function withDemoRegion(location: Location): RegionLocation {
  const regional = location as RegionLocation;
  return {
    ...location,
    country: regional.country ?? DEFAULT_DEMO_REGION.country,
    city: regional.city ?? DEFAULT_DEMO_REGION.city,
  };
}

export class ProviderUnavailableError extends Error {
  readonly code = "PROVIDER_UNAVAILABLE" as const;
  readonly providerId?: string;

  constructor(message: string, providerId?: string) {
    super(message);
    this.name = "ProviderUnavailableError";
    this.providerId = providerId;
  }
}

/** Resolves regional provider instances and owns quote ranking for the API. */
export class ProviderSelectionService {
  constructor(private readonly registry: ProviderRegistry) {}

  providersFor(location: Location): readonly RideProvider[] {
    return this.registry.providersFor(withDemoRegion(location));
  }

  private quotingProvidersFor(location: Location): readonly RideProvider[] {
    return this.providersFor(location).filter((provider) => provider.capabilities().quoting);
  }

  providerForQuote(quote: Pick<Quote, "providerId">, location: Location): RideProvider | undefined {
    return this.providersFor(location).find((provider) => provider.name === quote.providerId);
  }

  providerForRide(ride: { pickup: Location; quote?: Quote }): RideProvider | undefined {
    return ride.quote ? this.providerForQuote(ride.quote, ride.pickup) : undefined;
  }

  requireProvider(quote: Pick<Quote, "providerId">, location: Location): RideProvider {
    const provider = this.providerForQuote(quote, location);
    if (!provider) {
      throw new ProviderUnavailableError(
        `The ${quote.providerId} provider is not available for this ride.`,
        quote.providerId,
      );
    }
    return provider;
  }

  async getQuotes(request: QuoteRequest): Promise<Quote[]> {
    const providers = this.quotingProvidersFor(request.pickup);
    if (providers.length === 0) {
      throw new ProviderUnavailableError("No ride providers are available for this location.");
    }

    const results = await Promise.allSettled(
      providers.map((provider) => provider.getQuotes(request)),
    );
    const quotes: Quote[] = [];
    let firstError: unknown;

    for (const result of results) {
      if (result.status === "fulfilled") {
        quotes.push(...result.value);
      } else if (firstError === undefined) {
        firstError = result.reason;
      }
    }

    if (quotes.length > 0) return quotes;
    if (firstError !== undefined) throw firstError;
    throw new Error("No ride providers returned a quote.");
  }

  isHumanActionRequired(quote: Quote, location: Location): boolean {
    const provider = this.providerForQuote(quote, location);
    return Boolean(quote.deepLink) || provider?.capabilities().booking === false;
  }

  toQuoteOption(quote: Quote, location: Location): QuoteOption {
    return this.isHumanActionRequired(quote, location)
      ? { ...quote, humanActionRequired: true }
      : quote;
  }

  /** Prefer a bookable demo quote over a zero-fare human handoff quote. */
  selectQuote(quotes: readonly Quote[], location: Location): Quote | undefined {
    const bookable = quotes.filter(
      (quote) => !this.isHumanActionRequired(quote, location) && this.providerForQuote(quote, location),
    );
    return (
      bookable.find((quote) => quote.providerId === "mock") ??
      bookable[0] ??
      quotes.find((quote) => this.providerForQuote(quote, location)) ??
      quotes[0]
    );
  }
}
