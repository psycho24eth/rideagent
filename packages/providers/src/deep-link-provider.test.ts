import { describe, expect, it } from "vitest";
import { DeepLinkProvider } from "./deep-link-provider.js";
import { HumanActionRequiredProviderError } from "./provider-error.js";

const request = {
  requestId: "request-001",
  riderId: "rider-001",
  pickup: { label: "Start", coordinates: { latitude: 28.6139, longitude: 77.209 } },
  dropoff: { label: "End", coordinates: { latitude: 28.5355, longitude: 77.391 } },
  vehicleType: "cab" as const,
};

describe("DeepLinkProvider", () => {
  it("returns a stable HTTPS action URL with encoded ride endpoints", async () => {
    const provider = new DeepLinkProvider({ baseUrl: "https://example.test/book" });
    const first = (await provider.getQuotes(request))[0];
    const second = (await provider.getQuotes(request))[0];

    expect(first).toEqual(second);
    expect(first.deepLink).toBeDefined();
    const url = new URL(first.deepLink!);
    expect(url.protocol).toBe("https:");
    expect(JSON.parse(url.searchParams.get("pickup")!)).toEqual(request.pickup);
    expect(JSON.parse(url.searchParams.get("dropoff")!)).toEqual(request.dropoff);
  });

  it("makes booking explicitly human-action-required", async () => {
    const provider = new DeepLinkProvider();
    const quote = (await provider.getQuotes(request))[0];

    await expect(provider.book(quote)).rejects.toMatchObject({
      code: "human_action_required",
      deepLink: quote.deepLink,
    } satisfies Partial<HumanActionRequiredProviderError>);
  });
});
