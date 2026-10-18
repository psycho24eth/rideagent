import {
  Prisma,
  PrismaClient,
  type ActorRole as PrismaActorRole,
  type BookingMode as PrismaBookingMode,
  type RidePreference as PrismaRidePreference,
  type RideStatus as PrismaRideStatus,
  type ToolCallOutcome as PrismaToolCallOutcome,
  type VehicleType as PrismaVehicleType,
} from "@prisma/client";
import type { Location, Quote, RideEvent, RideStatus, VehicleType } from "@rideagent/shared";
import type { DemoRules, RideRepository, StoredEvent, StoredRide, ToolCallEvent } from "./types.js";

type DbQuoteRecord = {
  id: string;
  rideRequestId: string;
  providerId: string;
  vehicleType: string;
  amountMinor: number;
  currency: string;
  estimatedDistanceMeters: number;
  estimatedDurationSeconds: number;
  expiresAt: Date;
  deepLink: string | null;
  createdAt: Date;
};

type DbRideRecord = {
  id: string;
  riderId: string;
  pickup: Prisma.JsonValue;
  dropoff: Prisma.JsonValue;
  vehicleType: string;
  status: string;
  version: number;
  providerRideId: string | null;
  driverId: string | null;
  vehicleId: string | null;
  createdAt: Date;
  updatedAt: Date;
  selectedQuote: DbQuoteRecord | null;
};

type DbRuleRecord = {
  userId: string;
  perRideCapMinor: number;
  dailySpendCapMinor: number;
  preferredProviders: string[];
  preferredVehicleType: string | null;
  preference: string;
  bookingMode: string;
  updatedAt: Date;
};

type DbRideEventRecord = {
  id: string;
  rideId: string;
  fromStatus: string | null;
  toStatus: string | null;
  previousVersion: number | null;
  nextVersion: number | null;
  actorId: string | null;
  actorRole: string | null;
  reason: string | null;
  occurredAt: Date;
};

type DbDecisionRecord = {
  id: string;
  userId: string;
  rideId: string | null;
  decision: string;
  reason: string;
  occurredAt: Date;
};

type DbToolCallRecord = {
  id: string;
  userId: string;
  rideId: string | null;
  tool: string;
  arguments: Prisma.JsonValue;
  outcome: string;
  occurredAt: Date;
};

type DbPrismaClient = PrismaClient;

function jsonInput(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

function asDate(value: string): Date {
  return new Date(value);
}

function asStoredQuote(record: DbQuoteRecord): Quote {
  return {
    id: record.id,
    rideRequestId: record.rideRequestId,
    providerId: record.providerId,
    vehicleType: record.vehicleType as VehicleType,
    amountMinor: record.amountMinor,
    currency: record.currency,
    estimatedDistanceMeters: record.estimatedDistanceMeters,
    estimatedDurationSeconds: record.estimatedDurationSeconds,
    expiresAt: record.expiresAt.toISOString(),
    createdAt: record.createdAt.toISOString(),
    ...(record.deepLink ? { deepLink: record.deepLink } : {}),
  };
}

function asStoredRide(record: DbRideRecord): StoredRide {
  const quote = record.selectedQuote ? asStoredQuote(record.selectedQuote) : undefined;
  return {
    id: record.id,
    riderId: record.riderId,
    pickup: record.pickup as Location,
    dropoff: record.dropoff as Location,
    vehicleType: record.vehicleType as VehicleType,
    status: record.status as RideStatus,
    version: record.version,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
    ...(record.providerRideId ? { providerRideId: record.providerRideId } : {}),
    ...(record.driverId ? { driverId: record.driverId } : {}),
    ...(record.vehicleId ? { vehicleId: record.vehicleId } : {}),
    ...(quote ? { quote } : {}),
  };
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

/**
 * Prisma-backed implementation of the synchronous RideRepository contract.
 *
 * The API currently calls repository reads synchronously. This adapter keeps a
 * process-local, hydrated read-through cache for that contract and serializes
 * all writes to Prisma. The API entry point awaits initialize() before serving
 * traffic, so a non-demo process starts with durable state loaded.
 */
export class PrismaRepository implements RideRepository {
  private readonly rides = new Map<string, StoredRide>();
  private readonly events = new Map<string, StoredEvent[]>();
  private readonly rules = new Map<string, DemoRules>();
  private readonly pending = new Map<string, string>();
  private writeChain: Promise<void> = Promise.resolve();
  private initialization?: Promise<void>;

  constructor(private readonly prisma: DbPrismaClient) {}

  async initialize(): Promise<void> {
    if (!this.initialization) this.initialization = this.hydrate();
    await this.initialization;
  }

  async flush(): Promise<void> {
    await this.writeChain;
  }

  saveRide(ride: StoredRide): void {
    const existing = this.rides.get(ride.id);
    if (existing && existing.riderId !== ride.riderId) return;

    const snapshot = clone(ride);
    this.rides.set(ride.id, snapshot);
    this.enqueueWrite(() => this.persistRide(snapshot));
  }

  getRide(id: string): StoredRide | undefined {
    const ride = this.rides.get(id);
    return ride ? clone(ride) : undefined;
  }

  listRides(userId: string): StoredRide[] {
    return [...this.rides.values()]
      .filter((ride) => ride.riderId === userId)
      .map((ride) => clone(ride));
  }

  saveEvent(event: StoredEvent): void {
    const rideId = "rideId" in event ? event.rideId : undefined;
    if (!rideId) return;

    const ride = this.rides.get(rideId);
    if (!ride) return;
    if (event.type !== "ride.status_changed" && event.userId !== ride.riderId) return;

    const snapshot = clone(event);
    const current = this.events.get(rideId) ?? [];
    const existingIndex = current.findIndex((entry) => entry.eventId === snapshot.eventId);
    if (existingIndex >= 0) current[existingIndex] = snapshot;
    else current.push(snapshot);
    current.sort((left, right) => left.occurredAt.localeCompare(right.occurredAt));
    this.events.set(rideId, current);

    this.enqueueWrite(() => this.persistEvent(snapshot));
  }

  listEvents(rideId: string): StoredEvent[] {
    return (this.events.get(rideId) ?? []).map((event) => clone(event));
  }

  saveRules(rules: DemoRules): void {
    const snapshot = clone(rules);
    this.rules.set(rules.userId, snapshot);
    this.enqueueWrite(() => this.persistRules(snapshot));
  }

  getRules(userId: string): DemoRules | undefined {
    const rules = this.rules.get(userId);
    return rules ? clone(rules) : undefined;
  }

  setPendingRecommendation(userId: string, rideId: string): void {
    const ride = this.rides.get(rideId);
    if (ride && ride.riderId === userId) this.pending.set(userId, rideId);
  }

  getPendingRecommendation(userId: string): string | undefined {
    return this.pending.get(userId);
  }

  clearPendingRecommendation(userId: string): void {
    this.pending.delete(userId);
  }

  private enqueueWrite(operation: () => Promise<void>): void {
    this.writeChain = this.writeChain.catch(() => undefined).then(operation);
    void this.writeChain.catch(() => undefined);
  }

  private async hydrate(): Promise<void> {
    const [rideRows, ruleRows, eventRows, decisionRows, toolRows] = await Promise.all([
      this.prisma.ride.findMany({ include: { selectedQuote: true } }),
      this.prisma.userRules.findMany(),
      this.prisma.rideEvent.findMany({ orderBy: { occurredAt: "asc" } }),
      this.prisma.agentDecision.findMany({ orderBy: { occurredAt: "asc" } }),
      this.prisma.toolCallLog.findMany({ orderBy: { occurredAt: "asc" } }),
    ]);

    for (const row of rideRows as unknown as DbRideRecord[]) this.rides.set(row.id, asStoredRide(row));
    for (const row of ruleRows as unknown as DbRuleRecord[]) {
      this.rules.set(row.userId, {
        userId: row.userId,
        perRideCapMinor: row.perRideCapMinor,
        dailySpendCapMinor: row.dailySpendCapMinor,
        preferredProviders: [...row.preferredProviders],
        ...(row.preferredVehicleType ? { preferredVehicleType: row.preferredVehicleType as VehicleType } : {}),
        preference: row.preference as DemoRules["preference"],
        bookingMode: row.bookingMode as DemoRules["bookingMode"],
        updatedAt: row.updatedAt.toISOString(),
      });
    }

    for (const row of eventRows as unknown as DbRideEventRecord[]) {
      const ride = this.rides.get(row.rideId);
      if (!ride) continue;
      this.appendHydratedEvent(row.rideId, {
        eventId: row.id,
        type: "ride.status_changed",
        rideId: row.rideId,
        from: row.fromStatus as RideStatus,
        to: row.toStatus as RideStatus,
        previousVersion: row.previousVersion ?? 0,
        nextVersion: row.nextVersion ?? 0,
        occurredAt: row.occurredAt.toISOString(),
        ...(row.actorId && row.actorRole ? { actor: { id: row.actorId, role: row.actorRole as NonNullable<RideEvent["actor"]>["role"] } } : {}),
        ...(row.reason ? { reason: row.reason } : {}),
      });
    }

    for (const row of decisionRows as unknown as DbDecisionRecord[]) {
      if (row.rideId && !this.rides.has(row.rideId)) continue;
      if (!row.rideId) continue;
      this.appendHydratedEvent(row.rideId, {
        eventId: row.id,
        type: "agent.decision",
        userId: row.userId,
        rideId: row.rideId,
        decision: row.decision,
        reason: row.reason,
        occurredAt: row.occurredAt.toISOString(),
      });
    }

    for (const row of toolRows as unknown as DbToolCallRecord[]) {
      if (row.rideId && !this.rides.has(row.rideId)) continue;
      if (!row.rideId) continue;
      this.appendHydratedEvent(row.rideId, {
        eventId: row.id,
        type: "agent.tool_call",
        userId: row.userId,
        rideId: row.rideId,
        tool: row.tool,
        arguments: row.arguments,
        outcome: row.outcome as ToolCallEvent["outcome"],
        occurredAt: row.occurredAt.toISOString(),
      });
    }
  }

  private appendHydratedEvent(rideId: string, event: StoredEvent): void {
    const current = this.events.get(rideId) ?? [];
    current.push(event);
    current.sort((left, right) => left.occurredAt.localeCompare(right.occurredAt));
    this.events.set(rideId, current);
  }

  private async persistRide(ride: StoredRide): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await tx.user.upsert({
        where: { id: ride.riderId },
        update: {},
        create: { id: ride.riderId, role: "rider", status: "active" },
      });

      await tx.ride.upsert({
        where: { id: ride.id },
        create: {
          id: ride.id,
          riderId: ride.riderId,
          pickup: jsonInput(ride.pickup),
          dropoff: jsonInput(ride.dropoff),
          vehicleType: ride.vehicleType as PrismaVehicleType,
          status: ride.status as PrismaRideStatus,
          version: ride.version,
          providerRideId: ride.providerRideId ?? null,
          driverId: ride.driverId ?? null,
          vehicleId: ride.vehicleId ?? null,
          createdAt: asDate(ride.createdAt),
          updatedAt: asDate(ride.updatedAt),
        },
        update: {
          pickup: jsonInput(ride.pickup),
          dropoff: jsonInput(ride.dropoff),
          vehicleType: ride.vehicleType as PrismaVehicleType,
          status: ride.status as PrismaRideStatus,
          version: ride.version,
          providerRideId: ride.providerRideId ?? null,
          driverId: ride.driverId ?? null,
          vehicleId: ride.vehicleId ?? null,
          updatedAt: asDate(ride.updatedAt),
        },
      });

      if (ride.quote) {
        await tx.rideQuote.upsert({
          where: { id: ride.quote.id },
          create: {
            id: ride.quote.id,
            rideRequestId: ride.id,
            providerId: ride.quote.providerId,
            vehicleType: ride.quote.vehicleType as PrismaVehicleType,
            amountMinor: ride.quote.amountMinor,
            currency: ride.quote.currency,
            estimatedDistanceMeters: ride.quote.estimatedDistanceMeters,
            estimatedDurationSeconds: ride.quote.estimatedDurationSeconds,
            expiresAt: asDate(ride.quote.expiresAt),
            deepLink: ride.quote.deepLink ?? null,
            createdAt: asDate(ride.quote.createdAt),
          },
          update: {
            rideRequestId: ride.id,
            providerId: ride.quote.providerId,
            vehicleType: ride.quote.vehicleType as PrismaVehicleType,
            amountMinor: ride.quote.amountMinor,
            currency: ride.quote.currency,
            estimatedDistanceMeters: ride.quote.estimatedDistanceMeters,
            estimatedDurationSeconds: ride.quote.estimatedDurationSeconds,
            expiresAt: asDate(ride.quote.expiresAt),
            deepLink: ride.quote.deepLink ?? null,
          },
        });
      }

      await tx.ride.update({
        where: { id: ride.id },
        data: {
          selectedQuoteId: ride.quote?.id ?? null,
          quoteSnapshot: ride.quote ? jsonInput(ride.quote) : Prisma.DbNull,
          updatedAt: asDate(ride.updatedAt),
        },
      });
    });
  }

  private async persistRules(rules: DemoRules): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await tx.user.upsert({
        where: { id: rules.userId },
        update: {},
        create: { id: rules.userId, role: "rider", status: "active" },
      });
      await tx.userRules.upsert({
        where: { userId: rules.userId },
        create: {
          userId: rules.userId,
          perRideCapMinor: rules.perRideCapMinor,
          dailySpendCapMinor: rules.dailySpendCapMinor,
          preferredProviders: [...rules.preferredProviders],
          preferredVehicleType: rules.preferredVehicleType as PrismaVehicleType | undefined,
          preference: rules.preference as PrismaRidePreference,
          bookingMode: rules.bookingMode as PrismaBookingMode,
          updatedAt: asDate(rules.updatedAt),
        },
        update: {
          perRideCapMinor: rules.perRideCapMinor,
          dailySpendCapMinor: rules.dailySpendCapMinor,
          preferredProviders: [...rules.preferredProviders],
          preferredVehicleType: rules.preferredVehicleType as PrismaVehicleType | null,
          preference: rules.preference as PrismaRidePreference,
          bookingMode: rules.bookingMode as PrismaBookingMode,
          updatedAt: asDate(rules.updatedAt),
        },
      });
    });
  }

  private async persistEvent(event: StoredEvent): Promise<void> {
    const rideId = "rideId" in event ? event.rideId : undefined;
    if (!rideId) return;
    const ride = this.rides.get(rideId);
    if (!ride) return;

    if (event.type === "ride.status_changed") {
      await this.prisma.rideEvent.upsert({
        where: { id: event.eventId },
        create: {
          id: event.eventId,
          rideId: event.rideId,
          userId: ride.riderId,
          kind: "status_changed",
          fromStatus: event.from as PrismaRideStatus,
          toStatus: event.to as PrismaRideStatus,
          previousVersion: event.previousVersion,
          nextVersion: event.nextVersion,
          actorId: event.actor?.id ?? null,
          actorRole: event.actor?.role as PrismaActorRole | undefined,
          reason: event.reason ?? null,
          payload: jsonInput(event),
          occurredAt: asDate(event.occurredAt),
        },
        update: {
          fromStatus: event.from as PrismaRideStatus,
          toStatus: event.to as PrismaRideStatus,
          previousVersion: event.previousVersion,
          nextVersion: event.nextVersion,
          actorId: event.actor?.id ?? null,
          actorRole: event.actor?.role as PrismaActorRole | null,
          reason: event.reason ?? null,
          payload: jsonInput(event),
          occurredAt: asDate(event.occurredAt),
        },
      });
      return;
    }

    if (event.type === "agent.decision") {
      await this.prisma.agentDecision.upsert({
        where: { id: event.eventId },
        create: {
          id: event.eventId,
          userId: event.userId,
          rideId: event.rideId ?? null,
          decision: event.decision,
          reason: event.reason,
          occurredAt: asDate(event.occurredAt),
        },
        update: {
          userId: event.userId,
          rideId: event.rideId ?? null,
          decision: event.decision,
          reason: event.reason,
          occurredAt: asDate(event.occurredAt),
        },
      });
      return;
    }

    await this.prisma.toolCallLog.upsert({
      where: { id: event.eventId },
      create: {
        id: event.eventId,
        userId: event.userId,
        rideId: event.rideId ?? null,
        tool: event.tool,
        arguments: jsonInput(event.arguments),
        outcome: event.outcome as PrismaToolCallOutcome,
        occurredAt: asDate(event.occurredAt),
      },
      update: {
        userId: event.userId,
        rideId: event.rideId ?? null,
        tool: event.tool,
        arguments: jsonInput(event.arguments),
        outcome: event.outcome as PrismaToolCallOutcome,
        occurredAt: asDate(event.occurredAt),
      },
    });
  }
}

export type { DbPrismaClient };
