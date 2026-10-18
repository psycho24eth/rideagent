import { describe, expect, it } from "vitest";
import { createDefaultRegionRouter, RegionRouter } from "./region-router.js";
import { MockProvider } from "./mock-provider.js";
import { DeepLinkProvider } from "./deep-link-provider.js";

describe("RegionRouter", () => {
  it("routes Delhi, India to the default provider adapters", () => {
    const router = createDefaultRegionRouter();
    const providers = router.providersFor({ country: "IN", city: "Delhi", label: "Connaught Place" });

    expect(providers.map((provider) => provider.name)).toEqual(["mock", "deep-link"]);
  });

  it("supports additive registrations without planner changes", () => {
    const mock = new MockProvider();
    const deepLink = new DeepLinkProvider();
    const router = new RegionRouter([
      { country: "India", city: "Delhi", provider: mock },
      { country: "India", city: "Mumbai", provider: deepLink },
    ]);

    expect(router.providersFor({ country: "india", city: "delhi" })).toEqual([mock]);
    expect(router.providersFor({ country: "India", city: "Bengaluru" })).toEqual([]);
  });
});
