export type BookingMode = "ask_before_booking" | "auto_book_within_rules";
export type Preference = "cost" | "speed" | "balanced";
export type VehicleType = "cab" | "bike" | "auto";
export type RideStatus =
  | "requested"
  | "quoted"
  | "booked"
  | "driver_assigned"
  | "arriving"
  | "arrived"
  | "in_trip"
  | "completed"
  | "cancelled"
  | "failed";

export type Coordinates = {
  latitude: number;
  longitude: number;
};

export type Location = {
  label?: string;
  address?: string;
  coordinates?: Coordinates;
};

export type Rules = {
  userId: string;
  bookingMode: BookingMode;
  perRideCapMinor: number;
  dailySpendCapMinor: number;
  preferredProviders: string[];
  preferredVehicleType?: VehicleType;
  preference: Preference;
  updatedAt: string;
};

export type Quote = {
  id: string;
  rideRequestId: string;
  providerId: string;
  vehicleType: VehicleType;
  amountMinor: number;
  currency: string;
  estimatedDistanceMeters: number;
  estimatedDurationSeconds: number;
  expiresAt: string;
  createdAt: string;
  deepLink?: string;
  humanActionRequired?: boolean;
};

export type Ride = {
  id: string;
  riderId: string;
  pickup: Location;
  dropoff: Location;
  vehicleType: VehicleType;
  status: RideStatus;
  version: number;
  quote?: Quote;
  driverId?: string;
  vehicleId?: string;
  createdAt: string;
  updatedAt: string;
};

export type TrafficLevel = "light" | "moderate" | "heavy";

export type RideLiveTelemetry = {
  type: "ride.live";
  rideId: string;
  status: RideStatus;
  source: string;
  isDemo?: boolean;
  label?: string;
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
};

export type LiveRideResponse = RideLiveTelemetry & {
  event?: {
    type: "ride.live_update";
    rideId: string;
    userId: string;
    status: RideStatus;
    version: number;
    occurredAt: string;
    telemetry: RideLiveTelemetry;
  };
};

export type AssistantTextBlock = { type: "text"; text: string };
export type AssistantProgressBlock = {
  type: "progress";
  status: "in_progress" | "complete" | "attention";
  text: string;
};
export type AssistantRouteBlock = {
  type: "route";
  title: string;
  pickup: Location;
  dropoff: Location;
  coordinates: Coordinates[];
  source: string;
  isDemo?: boolean;
  label?: string;
  lastUpdatedAt?: string;
};
export type AssistantTrafficBlock = {
  type: "traffic";
  level: TrafficLevel;
  delayMinutes: number;
  text: string;
  source: string;
  isDemo?: boolean;
  label?: string;
  lastUpdatedAt: string;
};
export type AssistantQuoteBlock = {
  type: "quote";
  quote: Quote;
  providerId: string;
  providerLabel: string;
  amountMinor: number;
  currency: string;
  estimatedDurationMinutes: number;
  humanActionRequired: boolean;
  source?: string;
  isDemo?: boolean;
  lastUpdatedAt?: string;
};
export type AssistantBookingConfirmationBlock = {
  type: "booking_confirmation";
  rideId: string;
  providerId: string;
  status: RideStatus;
  text: string;
  source: string;
  isDemo: boolean;
  lastUpdatedAt?: string;
};
export type AssistantLiveRideBlock = {
  type: "live_ride";
  telemetry: RideLiveTelemetry;
  text: string;
};
export type AssistantAction = {
  id: "confirm_booking" | "reject_recommendation" | "open_provider";
  label: string;
  value?: string;
  href?: string;
};
export type AssistantActionsBlock = { type: "actions"; actions: AssistantAction[] };

export type AssistantBlock =
  | AssistantTextBlock
  | AssistantProgressBlock
  | AssistantRouteBlock
  | AssistantTrafficBlock
  | AssistantQuoteBlock
  | AssistantBookingConfirmationBlock
  | AssistantLiveRideBlock
  | AssistantActionsBlock;

export type ChatResponse = {
  assistantMessage: string;
  blocks?: AssistantBlock[];
  ride?: Ride;
  quote?: Quote;
  quotes?: Quote[];
};

export type ChatMessage = {
  id: string;
  role: "assistant" | "user";
  text?: string;
  blocks?: AssistantBlock[];
  timestamp: string;
  createdAt: string;
};
