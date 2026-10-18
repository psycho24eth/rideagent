import { describe, expect, it, vi } from "vitest";
import { MockProvider } from "@rideagent/providers";
import { buildApp } from "./app.js";
import type { Clock } from "./types.js";

const fixedClock: Clock = { now: () => "2025-01-01T12:00:00.000Z" };

describe("booking tracking enqueue", () => {
  it("enqueues a tracking job after an auto-book succeeds when a queue is provided", async () => {
    const enqueueTracking = vi.fn().mockResolvedValue({ id: "tracking-job-1" });
    const app = buildApp({
      clock: fixedClock,
      provider: new MockProvider(),
      trackingQueue: { enqueueTracking },
    });

    await app.inject({
      method: "PUT",
      url: "/v1/rules",
      payload: {
        perRideCapMinor: 50_000,
        dailySpendCapMinor: 100_000,
        preferredProviders: ["mock"],
        preferredVehicleType: "cab",
        preference: "balanced",
        bookingMode: "auto_book_within_rules",
      },
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/chat",
      payload: { message: "I need a ride to the airport", pickup: { label: "Home" } },
    });

    expect(response.statusCode).toBe(200);
    expect(enqueueTracking).toHaveBeenCalledWith(response.json().ride.id, "demo-user");
  });
});
