import { describe, expect, it } from "vitest";
import type { BecknOperation, BecknRequest, BecknResponse, BecknTransport } from "./beckn-ondc-provider.js";
import { BecknOndcProvider } from "./beckn-ondc-provider.js";
import { ProviderError } from "./provider-error.js";

const request = {
  requestId: "request-001",
  riderId: "rider-001",
  pickup: { label: "Start", coordinates: { latitude: 28.6139, longitude: 77.209 } },
  dropoff: { label: "End", coordinates: { latitude: 28.5355, longitude: 77.391 } },
  vehicleType: "cab" as const,
};

describe("BecknOndcProvider", () => {
  it("maps provider calls to correlated Beckn operations", async () => {
    const calls: Array<{ operation: BecknOperation; request: BecknRequest }> = [];
    const transport: BecknTransport = {
      async send(operation, payload): Promise<BecknResponse> {
        calls.push({ operation, request: payload });
        return {
          context: {
            message_id: payload.context.message_id,
            transaction_id: payload.context.transaction_id,
          },
          message: operation === "search"
            ? { quotes: [{ id: "item-1", amountMinor: 12500, vehicleType: "cab" }] }
            : operation === "confirm"
              ? { order: { id: "order-1" }, status: "booked" }
              : {},
        };
      },
    };
    const provider = new BecknOndcProvider({
      sandboxUrl: "https://sandbox.example.test",
      subscriberId: "subscriber.example.test",
      subscriberUri: "https://subscriber.example.test/callback",
      transport,
    });

    const quotes = await provider.getQuotes(request);
    const booked = await provider.book(quotes[0]);
    await provider.status(booked.providerRideId);
    await provider.track(booked.providerRideId);
    await provider.cancel(booked.providerRideId, "rider request");

    expect(calls.map(({ operation }) => operation)).toEqual([
      "search", "select", "init", "confirm", "status", "track", "cancel",
    ]);
    expect(calls[0].request.context).toMatchObject({
      action: "search",
      country: "IND",
      city: "std:011",
      domain: "ONDC:TRV11",
    });
    expect(calls[0].request.message).toEqual({
      intent: {
        fulfillment: {
          start: { location: { gps: "28.6139,77.209", address: "Start" } },
          end: { location: { gps: "28.5355,77.391", address: "End" } },
        },
      },
    });
    expect(booked.providerRideId).toBe("order-1");
  });

  it("rejects a callback with the wrong correlation ids", async () => {
    const provider = new BecknOndcProvider({
      sandboxUrl: "https://sandbox.example.test",
      subscriberId: "subscriber.example.test",
      subscriberUri: "https://subscriber.example.test/callback",
      transport: {
        async send(_operation, payload) {
          return {
            context: {
              message_id: "wrong-message",
              transaction_id: payload.context.transaction_id,
            },
          };
        },
      },
    });

    await expect(provider.search(request)).rejects.toMatchObject({ code: "correlation_mismatch" });
  });
});

describe("BecknOndcProvider configuration", () => {
  it("throws a typed error when sandbox credentials are absent", () => {
    expect(() => BecknOndcProvider.fromEnv({})).toThrowError(
      expect.objectContaining<Partial<ProviderError>>({
        code: "configuration_missing",
        provider: "beckn-ondc",
      }),
    );
  });

  it("never attempts a network call without an injected transport", async () => {
    const provider = new BecknOndcProvider({
      sandboxUrl: "https://sandbox.example.test",
      subscriberId: "subscriber.example.test",
      subscriberUri: "https://subscriber.example.test/callback",
    });

    await expect(provider.search(request)).rejects.toMatchObject({
      code: "transport_not_configured",
    });
  });
});
