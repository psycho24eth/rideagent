import type {
  AssistantAction,
  AssistantBlock,
  ChatMessage,
  ChatResponse,
  Coordinates,
  Quote,
  Ride,
  RideLiveTelemetry,
  RideStatus,
  Rules,
} from "./types";

export const DEFAULT_RULES: Rules = {
  userId: "demo-user",
  bookingMode: "ask_before_booking",
  perRideCapMinor: 50_000,
  dailySpendCapMinor: 100_000,
  preferredProviders: ["ONDC", "Uber", "Rapido"],
  preferredVehicleType: "auto",
  preference: "speed",
  updatedAt: "2026-10-17T08:00:00.000Z",
};

export const DEMO_PICKUP: Coordinates = { latitude: 28.6139, longitude: 77.209 };
export const DEMO_DROPOFF: Coordinates = { latitude: 28.5562, longitude: 77.1 };
export const DEMO_ROUTE: Coordinates[] = [
  DEMO_PICKUP,
  { latitude: 28.5988, longitude: 77.1818 },
  { latitude: 28.585, longitude: 77.1545 },
  { latitude: 28.5706, longitude: 77.1272 },
  DEMO_DROPOFF,
];

const now = "2026-10-17T08:12:00.000Z";

export const DEMO_QUOTE: Quote = {
  id: "quote-demo-mock",
  rideRequestId: "ride-demo-airport",
  providerId: "mock",
  vehicleType: "auto",
  amountMinor: 25_300,
  currency: "INR",
  estimatedDistanceMeters: 12600,
  estimatedDurationSeconds: 42 * 60,
  expiresAt: "2026-10-17T08:22:00.000Z",
  createdAt: now,
};

export const DEMO_RIDE: Ride = {
  id: "ride-demo-airport",
  riderId: "demo-user",
  pickup: { label: "Current location", coordinates: DEMO_PICKUP },
  dropoff: { label: "Indira Gandhi International Airport", coordinates: DEMO_DROPOFF },
  vehicleType: "cab",
  status: "quoted",
  version: 1,
  quote: DEMO_QUOTE,
  createdAt: now,
  updatedAt: now,
};

export const INITIAL_MESSAGES: ChatMessage[] = [
  {
    id: "welcome",
    role: "assistant",
    text: "Good morning, Alex. Where are we heading?",
    timestamp: "8:12 AM",
    createdAt: now,
  },
  {
    id: "promise",
    role: "assistant",
    text: "I’ll compare your preferred providers, stay inside your saved rules, and ask before I book.",
    timestamp: "8:12 AM",
    createdAt: now,
  },
];

export const DEMO_QUICK_PROMPTS = [
  { label: "Airport", value: "Take me to the airport" },
  { label: "Home", value: "Take me home" },
  { label: "Office", value: "Take me to the office" },
];

function trafficForStatus(status: RideStatus) {
  if (status === "arriving" || status === "arrived") return { level: "heavy" as const, delayMinutes: 9 };
  if (status === "in_trip") return { level: "light" as const, delayMinutes: 2 };
  if (status === "completed") return { level: "light" as const, delayMinutes: 0 };
  return { level: "moderate" as const, delayMinutes: 5 };
}

function trafficText(level: string, delayMinutes: number) {
  return delayMinutes === 0
    ? `Demo traffic is ${level}; no additional delay is estimated.`
    : `Demo traffic is ${level}; about ${delayMinutes} minutes of delay are estimated.`;
}

function routeBlock(): AssistantBlock {
  return {
    type: "route",
    title: "Delhi airport demo route",
    pickup: DEMO_RIDE.pickup,
    dropoff: DEMO_RIDE.dropoff,
    coordinates: DEMO_ROUTE,
    source: "demo",
    isDemo: true,
    label: "Demo data",
    lastUpdatedAt: now,
  };
}

function trafficBlock(status: RideStatus, lastUpdatedAt = now): AssistantBlock {
  const traffic = trafficForStatus(status);
  return {
    type: "traffic",
    level: traffic.level,
    delayMinutes: traffic.delayMinutes,
    text: trafficText(traffic.level, traffic.delayMinutes),
    source: "demo",
    isDemo: true,
    label: "Demo data",
    lastUpdatedAt,
  };
}

function quoteBlock(): AssistantBlock {
  return {
    type: "quote",
    quote: DEMO_QUOTE,
    providerId: DEMO_QUOTE.providerId,
    providerLabel: "MockProvider · demo",
    amountMinor: DEMO_QUOTE.amountMinor,
    currency: DEMO_QUOTE.currency,
     estimatedDurationMinutes: 42,
    humanActionRequired: false,
    source: "demo",
    isDemo: true,
    lastUpdatedAt: DEMO_QUOTE.createdAt,
  };
}

function recommendationActions(): AssistantAction[] {
  return [
    { id: "confirm_booking", label: "Confirm booking", value: "yes" },
    { id: "reject_recommendation", label: "Not this one", value: "no" },
  ];
}

function liveText(telemetry: RideLiveTelemetry) {
  if (telemetry.status === "driver_assigned") return "Demo driver assigned and heading to pickup.";
  if (telemetry.status === "arriving") return `Demo driver is arriving; ETA ${telemetry.etaMinutes} minutes.`;
  if (telemetry.status === "arrived") return "Demo driver has arrived at pickup.";
  if (telemetry.status === "in_trip") return `Demo ride is in progress; ETA ${telemetry.etaMinutes} minutes to the airport.`;
  if (telemetry.status === "completed") return "Demo ride complete — you have arrived at the airport.";
  return `Demo ride status: ${telemetry.status.replace(/_/g, " ")}.`;
}

function demoTelemetry(ride: Ride, status: RideStatus, updateNumber: number): RideLiveTelemetry {
  const profiles = [
    { etaMinutes: 6, position: 0.5 },
    { etaMinutes: 0, position: 0.5 },
    { etaMinutes: 5, position: 0.75 },
    { etaMinutes: 0, position: 1 },
  ];
  const profile = profiles[Math.min(updateNumber, profiles.length - 1)] ?? profiles[0];
  const pickup = ride.pickup.coordinates ?? DEMO_PICKUP;
  const dropoff = ride.dropoff.coordinates ?? DEMO_DROPOFF;
  const driverLocation = {
    latitude: pickup.latitude + (dropoff.latitude - pickup.latitude) * profile.position,
    longitude: pickup.longitude + (dropoff.longitude - pickup.longitude) * profile.position,
  };
  return {
    type: "ride.live",
    rideId: ride.id,
    status,
    source: "mock",
    isDemo: true,
    label: "Demo data",
    pickup,
    dropoff,
    routeCoordinates: DEMO_ROUTE,
    traffic: trafficForStatus(status),
    driverLocation,
    driverId: ride.driverId ?? "Maya R.",
    vehicleId: ride.vehicleId ?? "Toyota Prius · 7KQW241",
    etaMinutes: profile.etaMinutes,
    lastUpdatedAt: new Date(Date.now() + updateNumber * 30_000).toISOString(),
  };
}

export function demoLiveForRide(ride: Ride, updateNumber: number): RideLiveTelemetry {
  const statuses: RideStatus[] = ["arriving", "arrived", "in_trip", "completed"];
  return demoTelemetry(ride, statuses[Math.min(Math.max(updateNumber, 0), statuses.length - 1)] ?? "arriving", updateNumber);
}

function recommendationBlocks(): AssistantBlock[] {
  return [
    { type: "text", text: "I found a balanced option inside your saved rules. Want me to proceed with the cab booking?" },
    { type: "progress", status: "complete", text: "Ride recommendation ready" },
    routeBlock(),
    trafficBlock("quoted"),
    quoteBlock(),
    { type: "actions", actions: recommendationActions() },
  ];
}

function bookingBlocks(ride: Ride): AssistantBlock[] {
  const telemetry = demoLiveForRide(ride, 0);
  return [
    { type: "text", text: "Booked your cab. Your demo driver is on the way to pickup." },
    { type: "progress", status: "complete", text: "Ride booked" },
    routeBlock(),
    trafficBlock(telemetry.status, telemetry.lastUpdatedAt),
    {
      type: "booking_confirmation",
      rideId: ride.id,
      providerId: ride.quote?.providerId ?? "mock",
      status: ride.status,
      text: "Your cab is booked and live tracking is ready.",
      source: "mock",
      isDemo: true,
      lastUpdatedAt: telemetry.lastUpdatedAt,
    },
    { type: "live_ride", telemetry, text: liveText(telemetry) },
  ];
}

export function demoChat(message: string, hasRecommendation: boolean): ChatResponse {
  const normalized = message.trim().toLowerCase();
  if (hasRecommendation && /^(yes|y|confirm|book|go|okay|ok|proceed)/.test(normalized)) {
    const ride: Ride = {
      ...DEMO_RIDE,
      status: "arriving",
      version: 2,
      driverId: "Maya R.",
      vehicleId: "Toyota Prius · 7KQW241",
      updatedAt: new Date().toISOString(),
    };
    return { assistantMessage: "Booked your cab. Your demo driver is on the way to pickup.", ride, blocks: bookingBlocks(ride) };
  }
  if (hasRecommendation && /^(no|n|cancel|not|skip)/.test(normalized)) {
    return {
      assistantMessage: "No problem — I won’t book anything. Tell me where you’d like to go next.",
      blocks: [
        { type: "text", text: "No problem — I won’t book anything. Tell me where you’d like to go next." },
        { type: "progress", status: "complete", text: "Recommendation dismissed" },
      ],
    };
  }
  if (/airport|terminal|fly|downtown|home|office/.test(normalized)) {
    return {
      assistantMessage: "I found a balanced option inside your saved rules. Want me to proceed with the cab booking?",
      ride: DEMO_RIDE,
      quote: DEMO_QUOTE,
      quotes: [DEMO_QUOTE],
      blocks: recommendationBlocks(),
    };
  }
  return {
    assistantMessage: "Tell me where you need to go — for example, ‘Take me to the airport’.",
    blocks: [{ type: "text", text: "Tell me where you need to go — for example, ‘Take me to the airport’." }],
  };
}
