import type { ProviderRegistry, ProviderRideStatus, RideProvider } from "@rideagent/providers";
import type { Coordinates, Location, Quote, Ride, RideEvent, RideStatus, RideTransitionEvent, UserRules, VehicleType } from "@rideagent/shared";

export const BOOKING_MODES = ["ask_before_booking", "auto_book_within_rules"] as const;
export type BookingMode = (typeof BOOKING_MODES)[number];

export type DemoRules = UserRules & { bookingMode: BookingMode };

export interface StoredRide extends Ride {
  providerRideId?: string;
}

export const TRAFFIC_LEVELS = ["light", "moderate", "heavy"] as const;
export type TrafficLevel = (typeof TRAFFIC_LEVELS)[number];

export interface RideLiveTelemetry {
  type: "ride.live";
  rideId: string;
  status: RideStatus;
  source: "mock";
  isDemo: true;
  label: "Demo data";
  pickup: Coordinates;
  dropoff: Coordinates;
  routeCoordinates: Coordinates[];
  traffic: {
    level: TrafficLevel;
    delayMinutes: number;
  };
  driverLocation: Coordinates;
  driverId?: string;
  vehicleId?: string;
  etaMinutes: number;
  lastUpdatedAt: string;
}

export interface NormalizedRideLiveUpdateEvent {
  type: "ride.live_update";
  rideId: string;
  userId: string;
  status: RideStatus;
  version: number;
  occurredAt: string;
  telemetry: RideLiveTelemetry;
}

export interface AssistantTextBlock {
  type: "text";
  text: string;
}

export interface AssistantProgressBlock {
  type: "progress";
  status: "in_progress" | "complete" | "attention";
  text: string;
}

export interface AssistantRouteBlock {
  type: "route";
  title: string;
  pickup: Location;
  dropoff: Location;
  coordinates: Coordinates[];
  source: "demo";
  isDemo: true;
  label: "Demo data";
}

export interface AssistantTrafficBlock {
  type: "traffic";
  level: TrafficLevel;
  delayMinutes: number;
  text: string;
  source: "demo";
  isDemo: true;
  label: "Demo data";
  lastUpdatedAt: string;
}

export interface AssistantQuoteBlock {
  type: "quote";
  quote: Quote & { humanActionRequired?: boolean };
  providerId: string;
  providerLabel: string;
  amountMinor: number;
  currency: string;
  estimatedDurationMinutes: number;
  humanActionRequired: boolean;
}

export interface AssistantBookingConfirmationBlock {
  type: "booking_confirmation";
  rideId: string;
  providerId: string;
  status: RideStatus;
  text: string;
  source: "mock" | "provider";
  isDemo: boolean;
}

export interface AssistantLiveRideBlock {
  type: "live_ride";
  telemetry: RideLiveTelemetry;
  text: string;
}

export interface AssistantAction {
  id: "confirm_booking" | "reject_recommendation" | "open_provider";
  label: string;
  value?: string;
  href?: string;
}

export interface AssistantActionsBlock {
  type: "actions";
  actions: AssistantAction[];
}

export type AssistantBlock =
  | AssistantTextBlock
  | AssistantProgressBlock
  | AssistantRouteBlock
  | AssistantTrafficBlock
  | AssistantQuoteBlock
  | AssistantBookingConfirmationBlock
  | AssistantLiveRideBlock
  | AssistantActionsBlock;

export interface AssistantEvent {
  type: "assistant.block";
  eventId: string;
  occurredAt: string;
  block: AssistantBlock;
}

export type RichAssistantBlock = AssistantBlock;
export type RichAssistantEvent = AssistantEvent | NormalizedRideLiveUpdateEvent;

export interface AssistantChatResponse {
  assistantMessage: string;
  blocks?: AssistantBlock[];
  ride?: StoredRide;
  quote?: Quote & { humanActionRequired?: boolean };
  quotes?: Array<Quote & { humanActionRequired?: boolean }>;
}

export interface AgentDecisionEvent {
  eventId: string;
  type: "agent.decision";
  userId: string;
  rideId?: string;
  decision: string;
  reason: string;
  occurredAt: string;
}

export interface ToolCallEvent {
  eventId: string;
  type: "agent.tool_call";
  userId: string;
  rideId?: string;
  tool: string;
  arguments: unknown;
  outcome: "accepted" | "rejected";
  occurredAt: string;
}

export type StoredEvent = RideEvent | AgentDecisionEvent | ToolCallEvent;

export interface NormalizedRideSnapshot {
  type: "ride.snapshot";
  rideId: string;
  userId: string;
  status: RideStatus;
  version: number;
  updatedAt: string;
  ride: StoredRide;
}

export interface RideUpdateNotification {
  type: "ride.updated";
  notificationId: string;
  rideId: string;
  userId: string;
  status: RideStatus;
  version: number;
  occurredAt: string;
  ride: StoredRide;
  providerStatus: ProviderRideStatus;
  event?: RideTransitionEvent;
}

export interface NotificationSink {
  notify(notification: RideUpdateNotification): Promise<void> | void;
}

export interface Clock {
  now(): string;
}

export interface RideRepository {
  saveRide(ride: StoredRide): void;
  getRide(id: string): StoredRide | undefined;
  listRides(userId: string): StoredRide[];
  saveEvent(event: StoredEvent): void;
  listEvents(rideId: string): StoredEvent[];
  saveRules(rules: DemoRules): void;
  getRules(userId: string): DemoRules | undefined;
  setPendingRecommendation(userId: string, rideId: string): void;
  getPendingRecommendation(userId: string): string | undefined;
  clearPendingRecommendation(userId: string): void;
}

export interface TrackingJobQueue {
  enqueueTracking(rideId: string, userId: string): Promise<unknown>;
}

export interface AppDependencies {
  clock?: Clock;
  /** Legacy single-provider seam; retained for existing API consumers and tests. */
  provider?: RideProvider;
  providerRegistry?: ProviderRegistry;
  /** Alias accepted for callers that already model the dependency as a region router. */
  regionRouter?: ProviderRegistry;
  store?: RideRepository;
  planner?: PlannerModel;
  notificationSink?: NotificationSink;
  trackingQueue?: TrackingJobQueue;
  rateLimit?: { max: number; windowMs: number };
}

export interface PlannerInput {
  message: string;
  pickupProvided: boolean;
  hasPendingRecommendation: boolean;
}

export type PlannerAction =
  | { kind: "request_ride"; destination: { label: string } }
  | { kind: "confirm" }
  | { kind: "reject" }
  | { kind: "unclear" };

export interface PlannerModel {
  plan(input: PlannerInput): Promise<PlannerAction>;
}

export interface ProviderForApp {
  readonly provider: RideProvider;
}
