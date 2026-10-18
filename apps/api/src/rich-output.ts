import { demoRouteCoordinates, demoTrafficForStatus } from "./telemetry.js";
import type {
  AssistantAction,
  AssistantActionsBlock,
  AssistantBlock,
  AssistantBookingConfirmationBlock,
  AssistantLiveRideBlock,
  AssistantProgressBlock,
  AssistantQuoteBlock,
  AssistantRouteBlock,
  AssistantTextBlock,
  AssistantTrafficBlock,
  RideLiveTelemetry,
  StoredRide,
  TrafficLevel,
} from "./types.js";
import type { QuoteOption } from "./provider-selection.js";

function trafficText(level: TrafficLevel, delayMinutes: number): string {
  if (delayMinutes === 0) return `Demo traffic is ${level}; no additional delay is estimated.`;
  return `Demo traffic is ${level}; about ${delayMinutes} minutes of delay are estimated.`;
}

export function routeBlock(ride: Pick<StoredRide, "pickup" | "dropoff">): AssistantRouteBlock {
  return {
    type: "route",
    title: "Delhi airport demo route",
    pickup: structuredClone(ride.pickup),
    dropoff: structuredClone(ride.dropoff),
    coordinates: demoRouteCoordinates(ride),
    source: "demo",
    isDemo: true,
    label: "Demo data",
  };
}

export function trafficBlock(
  ride: Pick<StoredRide, "status">,
  lastUpdatedAt: string,
  telemetry?: Pick<RideLiveTelemetry, "traffic">,
): AssistantTrafficBlock {
  const traffic = telemetry?.traffic ?? demoTrafficForStatus(ride.status);
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

export function quoteBlock(quote: QuoteOption): AssistantQuoteBlock {
  const humanActionRequired = quote.humanActionRequired === true;
  return {
    type: "quote",
    quote: structuredClone(quote),
    providerId: quote.providerId,
    providerLabel: quote.providerId === "mock" ? "MockProvider (demo)" : quote.providerId,
    amountMinor: quote.amountMinor,
    currency: quote.currency,
    estimatedDurationMinutes: Math.ceil(quote.estimatedDurationSeconds / 60),
    humanActionRequired,
  };
}

export function textBlock(text: string): AssistantTextBlock {
  return { type: "text", text };
}

export function progressBlock(
  text: string,
  status: AssistantProgressBlock["status"],
): AssistantProgressBlock {
  return { type: "progress", status, text };
}

export function actionsBlock(actions: AssistantAction[]): AssistantActionsBlock {
  return { type: "actions", actions };
}

export function liveRideBlock(telemetry: RideLiveTelemetry, text: string): AssistantLiveRideBlock {
  return { type: "live_ride", telemetry: structuredClone(telemetry), text };
}

export function bookingConfirmationBlock(
  ride: Pick<StoredRide, "id" | "status" | "quote">,
  text: string,
): AssistantBookingConfirmationBlock {
  const providerId = ride.quote?.providerId ?? "provider";
  return {
    type: "booking_confirmation",
    rideId: ride.id,
    providerId,
    status: ride.status,
    text,
    source: providerId === "mock" ? "mock" : "provider",
    isDemo: providerId === "mock",
  };
}

function recommendationActions(quote: QuoteOption): AssistantActionsBlock {
  const actions: AssistantAction[] = quote.humanActionRequired
    ? [
        {
          id: "open_provider",
          label: "Continue with provider",
          ...(quote.deepLink ? { href: quote.deepLink } : {}),
        },
        { id: "reject_recommendation", label: "Not now", value: "no" },
      ]
    : [
        { id: "confirm_booking", label: "Confirm booking", value: "yes" },
        { id: "reject_recommendation", label: "Not now", value: "no" },
      ];
  return actionsBlock(actions);
}

export function recommendationBlocks(
  ride: StoredRide,
  quote: QuoteOption,
  assistantMessage: string,
  occurredAt: string,
): AssistantBlock[] {
  return [
    textBlock(assistantMessage),
    progressBlock(quote.humanActionRequired ? "Action needed from you — I have not booked the ride" : "Ride recommendation ready", quote.humanActionRequired ? "attention" : "complete"),
    routeBlock(ride),
    trafficBlock(ride, occurredAt),
    quoteBlock(quote),
    recommendationActions(quote),
  ];
}

export function bookingBlocks(
  ride: StoredRide,
  telemetry: RideLiveTelemetry | undefined,
  assistantMessage: string,
  occurredAt: string,
): AssistantBlock[] {
  const blocks: AssistantBlock[] = [
    textBlock(assistantMessage),
    progressBlock("Ride booked", "complete"),
    routeBlock(ride),
    trafficBlock(ride, telemetry?.lastUpdatedAt ?? occurredAt, telemetry),
    bookingConfirmationBlock(ride, assistantMessage),
  ];
  if (telemetry) blocks.push(liveRideBlock(telemetry, liveRideText(telemetry)));
  return blocks;
}

export function trackingBlocks(
  ride: StoredRide,
  telemetry: RideLiveTelemetry | undefined,
  assistantMessage: string,
): AssistantBlock[] | undefined {
  if (!telemetry) return undefined;
  return [
    textBlock(assistantMessage),
    progressBlock(ride.status === "completed" ? "Ride complete" : `Ride status: ${ride.status.replaceAll("_", " ")}`, ride.status === "completed" ? "complete" : "in_progress"),
    routeBlock(ride),
    trafficBlock(ride, telemetry.lastUpdatedAt, telemetry),
    liveRideBlock(telemetry, liveRideText(telemetry)),
  ];
}

export function liveRideText(telemetry: RideLiveTelemetry): string {
  switch (telemetry.status) {
    case "driver_assigned":
      return "Demo driver assigned and heading to pickup.";
    case "arriving":
      return `Demo driver is arriving; ETA ${telemetry.etaMinutes} minutes.`;
    case "arrived":
      return "Demo driver has arrived at pickup.";
    case "in_trip":
      return `Demo ride is in progress; ETA ${telemetry.etaMinutes} minutes to the airport.`;
    case "completed":
      return "Demo ride complete — you have arrived at the airport.";
    case "cancelled":
      return "The demo ride is cancelled.";
    default:
      return `Demo ride status: ${telemetry.status.replaceAll("_", " ")}.`;
  }
}
