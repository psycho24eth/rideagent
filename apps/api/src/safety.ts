import type { Quote } from "@rideagent/shared";
import type { Clock } from "./types.js";
import type { DemoRules, RideRepository } from "./types.js";

export class SafetyViolation extends Error {
  readonly code: "RULES_REQUIRED" | "PER_RIDE_CAP" | "DAILY_CAP" | "INVALID_RULES";

  constructor(code: SafetyViolation["code"], message: string) {
    super(message);
    this.name = "SafetyViolation";
    this.code = code;
  }
}

export class SafetyService {
  constructor(private readonly store: RideRepository, private readonly clock: Clock) {}

  requireRules(userId: string): DemoRules {
    const rules = this.store.getRules(userId);
    if (!rules || rules.perRideCapMinor < 0 || rules.dailySpendCapMinor < 0) {
      throw new SafetyViolation("RULES_REQUIRED", "Set your Lexar AI rules before requesting or booking a ride.");
    }
    return rules;
  }

  validateQuote(userId: string, quote: Quote): DemoRules {
    const rules = this.requireRules(userId);
    if (quote.amountMinor > rules.perRideCapMinor) {
      throw new SafetyViolation("PER_RIDE_CAP", "This quote is above your per-ride cap, so I will not book it.");
    }
    const day = this.clock.now().slice(0, 10);
    const spentToday = this.store
      .listRides(userId)
      .filter((ride) => ride.status !== "cancelled" && ride.status !== "failed" && ride.createdAt.slice(0, 10) === day)
      .reduce((total, ride) => total + (ride.quote?.amountMinor ?? 0), 0);
    if (spentToday + quote.amountMinor > rules.dailySpendCapMinor) {
      throw new SafetyViolation("DAILY_CAP", "Booking this ride would exceed your daily spend cap.");
    }
    return rules;
  }
}
