import type { Location } from "../../shared/src/index.js";
import { DeepLinkProvider } from "./deep-link-provider.js";
import { MockProvider } from "./mock-provider.js";
import type { RideProvider } from "./types.js";

export interface RegionLocation extends Location {
  country?: string;
  city?: string;
}

export interface ProviderRegistration {
  country: string;
  city: string;
  provider: RideProvider;
}

export interface ProviderRegistry {
  register(registration: ProviderRegistration): void;
  providersFor(location: RegionLocation): readonly RideProvider[];
  registrations(): readonly ProviderRegistration[];
}

const COUNTRY_ALIASES: Readonly<Record<string, string>> = {
  in: "india",
  ind: "india",
  india: "india",
};

function normalized(value: string | undefined): string | undefined {
  return value?.trim().toLowerCase();
}

function normalizedCountry(value: string | undefined): string | undefined {
  const country = normalized(value);
  return country ? COUNTRY_ALIASES[country] ?? country : undefined;
}

function locationRegion(location: Location): { country?: string; city?: string } {
  const regional = location as RegionLocation;
  return {
    country: normalizedCountry(regional.country),
    city: normalized(regional.city),
  };
}

/** Registry and lookup seam for adding regions without changing planner code. */
export class RegionRouter implements ProviderRegistry {
  private readonly entries: ProviderRegistration[] = [];

  constructor(registrations: readonly ProviderRegistration[] = []) {
    registrations.forEach((registration) => this.register(registration));
  }

  register(registration: ProviderRegistration): void {
    this.entries.push({
      ...registration,
      country: normalizedCountry(registration.country) ?? registration.country,
      city: normalized(registration.city) ?? registration.city,
    });
  }

  providersFor(location: RegionLocation): readonly RideProvider[] {
    const region = locationRegion(location);
    if (!region.country || !region.city) {
      return [];
    }
    return this.entries
      .filter((entry) => entry.country === region.country && entry.city === region.city)
      .map((entry) => entry.provider);
  }

  registrations(): readonly ProviderRegistration[] {
    return this.entries.slice();
  }
}

export interface DefaultRegionRouterOptions {
  providers?: readonly RideProvider[];
}

/** Delhi is the first registered region; callers can add adapters through providers. */
export function createDefaultRegionRouter(options: DefaultRegionRouterOptions = {}): RegionRouter {
  const providers = options.providers ?? [new MockProvider(), new DeepLinkProvider()];
  return new RegionRouter(providers.map((provider) => ({
    country: "India",
    city: "Delhi",
    provider,
  })));
}
