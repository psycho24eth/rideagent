import type { RideEvent } from "@rideagent/shared";
import type { AgentDecisionEvent, DemoRules, RideRepository, StoredEvent, StoredRide, ToolCallEvent } from "./types.js";

export class InMemoryStore implements RideRepository {
  private readonly rides = new Map<string, StoredRide>();
  private readonly events = new Map<string, StoredEvent[]>();
  private readonly rules = new Map<string, DemoRules>();
  private readonly pending = new Map<string, string>();

  saveRide(ride: StoredRide): void {
    this.rides.set(ride.id, ride);
  }

  getRide(id: string): StoredRide | undefined {
    const ride = this.rides.get(id);
    return ride ? structuredClone(ride) : undefined;
  }

  listRides(userId: string): StoredRide[] {
    return [...this.rides.values()].filter((ride) => ride.riderId === userId).map((ride) => structuredClone(ride));
  }

  saveEvent(event: StoredEvent): void {
    const rideId = "rideId" in event ? event.rideId : undefined;
    if (!rideId) return;
    const current = this.events.get(rideId) ?? [];
    current.push(structuredClone(event));
    this.events.set(rideId, current);
  }

  listEvents(rideId: string): StoredEvent[] {
    return (this.events.get(rideId) ?? []).map((event) => structuredClone(event));
  }

  saveRules(rules: DemoRules): void {
    this.rules.set(rules.userId, structuredClone(rules));
  }

  getRules(userId: string): DemoRules | undefined {
    const rules = this.rules.get(userId);
    return rules ? structuredClone(rules) : undefined;
  }

  setPendingRecommendation(userId: string, rideId: string): void {
    this.pending.set(userId, rideId);
  }

  getPendingRecommendation(userId: string): string | undefined {
    return this.pending.get(userId);
  }

  clearPendingRecommendation(userId: string): void {
    this.pending.delete(userId);
  }
}

export type PersistedTransition = RideEvent;
export type PersistedDecision = AgentDecisionEvent;
export type PersistedToolCall = ToolCallEvent;
