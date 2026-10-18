import { useEffect, useId, useMemo, useRef, useState } from "react";
import { api, API_BASE_URL, ApiError } from "./api";
import {
  DEFAULT_RULES,
  DEMO_DROPOFF,
  DEMO_PICKUP,
  DEMO_QUICK_PROMPTS,
  DEMO_RIDE,
  DEMO_ROUTE,
  demoChat,
  demoLiveForRide,
  INITIAL_MESSAGES,
} from "./fixtures";
import type {
  AssistantAction,
  AssistantBlock,
  AssistantLiveRideBlock,
  ChatMessage,
  ChatResponse,
  Coordinates,
  Preference,
  Ride,
  RideLiveTelemetry,
  RideStatus,
  Rules,
} from "./types";

type ConnectionMode = "connecting" | "live" | "demo";

const LIVE_POLL_INTERVAL_MS = 5_000;
const MAX_LIVE_POLLS = 60;
const ACTIVE_RIDE_STATUSES: RideStatus[] = ["booked", "driver_assigned", "arriving", "arrived", "in_trip"];
const TERMINAL_RIDE_STATUSES: RideStatus[] = ["completed", "cancelled", "failed"];

const isActiveRideStatus = (status?: RideStatus) => Boolean(status && ACTIVE_RIDE_STATUSES.includes(status));
const isTerminalRideStatus = (status?: RideStatus) => Boolean(status && TERMINAL_RIDE_STATUSES.includes(status));

const money = (minor?: number, currency = "INR") => {
  if (minor === undefined) return "—";
  return currency === "INR" ? `₹${(minor / 100).toFixed(2)}` : `${currency} ${(minor / 100).toFixed(2)}`;
};

const minutes = (seconds?: number) => (seconds === undefined ? "—" : `${Math.ceil(seconds / 60)} min`);
const statusText = (status: string) => status.replace(/_/g, " ");
const timeLabel = () => new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
const readableProvider = (provider?: string) => (provider === "mock" ? "MockProvider" : provider || "Provider");

function formatUpdatedAt(value?: string) {
  if (!value) return "just now";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "just now";
  return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function getOtp(rideId: string) {
  const digits = rideId.split("").reduce((sum, char) => sum + char.charCodeAt(0), 0) % 9000 + 1000;
  return String(digits);
}

function sourceLabel(source?: string, label?: string, isDemo?: boolean) {
  const normalized = `${source ?? ""} ${label ?? ""}`.toLowerCase();
  if (isDemo || normalized.includes("demo") || normalized.includes("mock")) return "Demo data";
  if (label) return label;
  return source ? `${source} source` : "Provider source";
}

function liveRideText(telemetry: RideLiveTelemetry) {
  switch (telemetry.status) {
    case "driver_assigned":
      return "Your driver is assigned and heading to pickup.";
    case "arriving":
      return `Your driver is arriving; ETA ${telemetry.etaMinutes} minutes.`;
    case "arrived":
      return "Your driver has arrived at pickup.";
    case "in_trip":
      return `Your ride is in progress; ETA ${telemetry.etaMinutes} minutes to the destination.`;
    case "completed":
      return "You have arrived at your destination.";
    case "cancelled":
      return "This ride has been cancelled.";
    case "failed":
      return "Live tracking could not complete for this ride.";
    default:
      return `Ride status: ${statusText(telemetry.status)}.`;
  }
}

function interpolateRoute(pickup?: Coordinates, dropoff?: Coordinates): Coordinates[] {
  const start = pickup ?? DEMO_PICKUP;
  const end = dropoff ?? DEMO_DROPOFF;
  return [
    start,
    { latitude: start.latitude + (end.latitude - start.latitude) * 0.25, longitude: start.longitude + (end.longitude - start.longitude) * 0.25 },
    { latitude: start.latitude + (end.latitude - start.latitude) * 0.5, longitude: start.longitude + (end.longitude - start.longitude) * 0.5 },
    { latitude: start.latitude + (end.latitude - start.latitude) * 0.75, longitude: start.longitude + (end.longitude - start.longitude) * 0.75 },
    end,
  ];
}

function fallbackTraffic(status: RideStatus) {
  if (status === "arriving" || status === "arrived") return { level: "heavy" as const, delayMinutes: 9 };
  if (status === "in_trip") return { level: "light" as const, delayMinutes: 2 };
  return { level: "moderate" as const, delayMinutes: 5 };
}

function fallbackBlocks(response: ChatResponse): AssistantBlock[] {
  if (response.blocks?.length) return response.blocks;
  const textBlock: AssistantBlock = { type: "text", text: response.assistantMessage };
  if (!response.ride) return [textBlock];

  const quote = response.quote ?? response.ride.quote;
  if (quote && response.ride.status === "quoted") {
    const traffic = fallbackTraffic(response.ride.status);
    return [
      textBlock,
      { type: "progress", status: "complete", text: "Ride recommendation ready" },
      {
        type: "route",
        title: "Suggested route",
        pickup: response.ride.pickup,
        dropoff: response.ride.dropoff,
        coordinates: interpolateRoute(response.ride.pickup.coordinates, response.ride.dropoff.coordinates),
        source: "demo",
        isDemo: true,
        label: "Demo data",
        lastUpdatedAt: response.ride.updatedAt,
      },
      {
        type: "traffic",
        level: traffic.level,
        delayMinutes: traffic.delayMinutes,
        text: `Traffic is ${traffic.level}; about ${traffic.delayMinutes} minutes of delay are estimated.`,
        source: "provider",
        label: "Provider source",
        lastUpdatedAt: response.ride.updatedAt,
      },
      {
        type: "quote",
        quote,
        providerId: quote.providerId,
        providerLabel: readableProvider(quote.providerId),
        amountMinor: quote.amountMinor,
        currency: quote.currency,
        estimatedDurationMinutes: Math.ceil(quote.estimatedDurationSeconds / 60),
        humanActionRequired: quote.humanActionRequired === true,
        source: quote.providerId === "mock" ? "demo" : "provider",
        isDemo: quote.providerId === "mock",
        lastUpdatedAt: quote.createdAt,
      },
      {
        type: "actions",
        actions: quote.humanActionRequired
          ? [{ id: "open_provider", label: "Continue with provider", href: quote.deepLink }, { id: "reject_recommendation", label: "Not now", value: "no" }]
          : [{ id: "confirm_booking", label: "Confirm booking", value: "yes" }, { id: "reject_recommendation", label: "Not now", value: "no" }],
      },
    ];
  }

  return [
    textBlock,
    { type: "progress", status: isActiveRideStatus(response.ride.status) ? "complete" : "attention", text: isActiveRideStatus(response.ride.status) ? "Ride booked" : `Ride status: ${statusText(response.ride.status)}` },
    {
      type: "booking_confirmation",
      rideId: response.ride.id,
      providerId: response.ride.quote?.providerId ?? "provider",
      status: response.ride.status,
      text: response.assistantMessage,
      source: response.ride.quote?.providerId === "mock" ? "mock" : "provider",
      isDemo: response.ride.quote?.providerId === "mock",
      lastUpdatedAt: response.ride.updatedAt,
    },
  ];
}

function createMessageId(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function liveUpdateBlocks(telemetry: RideLiveTelemetry): AssistantBlock[] {
  return [
    { type: "text", text: liveRideText(telemetry) },
    { type: "progress", status: isTerminalRideStatus(telemetry.status) ? "complete" : "in_progress", text: telemetry.status === "completed" ? "Ride complete" : `Ride status: ${statusText(telemetry.status)}` },
    {
      type: "route",
      title: "Live route",
      pickup: { label: "Pickup", coordinates: telemetry.pickup },
      dropoff: { label: "Destination", coordinates: telemetry.dropoff },
      coordinates: telemetry.routeCoordinates,
      source: telemetry.source,
      isDemo: telemetry.isDemo,
      label: telemetry.label,
      lastUpdatedAt: telemetry.lastUpdatedAt,
    },
    {
      type: "traffic",
      level: telemetry.traffic.level,
      delayMinutes: telemetry.traffic.delayMinutes,
      text: telemetry.traffic.delayMinutes === 0 ? `Traffic is ${telemetry.traffic.level}; no added delay.` : `Traffic is ${telemetry.traffic.level}; about ${telemetry.traffic.delayMinutes} minutes of delay.`,
      source: telemetry.source,
      isDemo: telemetry.isDemo,
      label: telemetry.label,
      lastUpdatedAt: telemetry.lastUpdatedAt,
    },
    { type: "live_ride", telemetry, text: liveRideText(telemetry) },
  ];
}

function errorText(error: unknown) {
  if (error instanceof ApiError && error.status === 0) {
    return `Cannot reach the RideAgent API at ${API_BASE_URL}. Demo mode is active.`;
  }
  return error instanceof Error ? error.message : "Something went wrong. Try again.";
}

export default function App() {
  const [mode, setMode] = useState<ConnectionMode>("connecting");
  const [error, setError] = useState("");
  const [toast, setToast] = useState("");
  const [rules, setRules] = useState<Rules>(DEFAULT_RULES);
  const [draftRules, setDraftRules] = useState<Rules>(DEFAULT_RULES);
  const [rulesLoading, setRulesLoading] = useState(true);
  const [rulesSaving, setRulesSaving] = useState(false);
  const [rulesSaved, setRulesSaved] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>(INITIAL_MESSAGES);
  const [recommendation, setRecommendation] = useState<Ride | undefined>();
  const [activeRide, setActiveRide] = useState<Ride | undefined>();
  const [liveTelemetry, setLiveTelemetry] = useState<RideLiveTelemetry | undefined>();
  const [composer, setComposer] = useState("");
  const [chatLoading, setChatLoading] = useState(false);
  const [cancelLoading, setCancelLoading] = useState(false);
  const [cancelConfirm, setCancelConfirm] = useState(false);
  const liveTelemetryRef = useRef<RideLiveTelemetry>();
  const livePollCountRef = useRef(0);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout>>();

  const hasInlineAction = useMemo(() => Boolean(recommendation || activeRide), [recommendation, activeRide]);
  const latestLiveMessageId = useMemo(() => {
    if (!activeRide) return undefined;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (messages[index].blocks?.some((block) => block.type === "live_ride" && block.telemetry.rideId === activeRide.id)) return messages[index].id;
    }
    return undefined;
  }, [messages, activeRide?.id]);

  function showToast(message: string) {
    setToast(message);
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    toastTimerRef.current = setTimeout(() => setToast(""), 3_200);
  }

  async function loadRules() {
    setRulesLoading(true);
    setMode("connecting");
    setError("");
    try {
      const loaded = await api.getRules();
      setRules(loaded);
      setDraftRules(loaded);
      setMode("live");
    } catch (requestError: unknown) {
      if (requestError instanceof ApiError && requestError.status === 404) {
        try {
          const saved = await api.saveRules({
            bookingMode: DEFAULT_RULES.bookingMode,
            perRideCapMinor: DEFAULT_RULES.perRideCapMinor,
            dailySpendCapMinor: DEFAULT_RULES.dailySpendCapMinor,
            preferredProviders: DEFAULT_RULES.preferredProviders,
            preferredVehicleType: DEFAULT_RULES.preferredVehicleType,
            preference: DEFAULT_RULES.preference,
          });
          setRules(saved);
          setDraftRules(saved);
          setMode("live");
        } catch (saveError: unknown) {
          setMode("demo");
          setRules(DEFAULT_RULES);
          setDraftRules(DEFAULT_RULES);
          setError(`${errorText(saveError)} Try reconnecting when the API is available.`);
        }
      } else {
        setMode("demo");
        setRules(DEFAULT_RULES);
        setDraftRules(DEFAULT_RULES);
        setError(`${errorText(requestError)} Try reconnecting when the API is available.`);
      }
    } finally {
      setRulesLoading(false);
    }
  }

  useEffect(() => {
    void loadRules();
    return () => {
      if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    };
  }, []);

  useEffect(() => {
    if (!activeRide || isTerminalRideStatus(activeRide.status)) return;
    let cancelled = false;
    let pollCount = 0;
    let timer: ReturnType<typeof setInterval> | undefined;
    livePollCountRef.current = 0;

    const poll = async () => {
      if (cancelled || pollCount >= MAX_LIVE_POLLS) {
        if (timer) clearInterval(timer);
        return;
      }
      pollCount += 1;
      livePollCountRef.current = pollCount;
      if (mode === "demo") {
        const telemetry = demoLiveForRide(activeRide, pollCount - 1);
        if (!cancelled) applyLiveTelemetry(telemetry);
        if (isTerminalRideStatus(telemetry.status) && timer) clearInterval(timer);
        return;
      }
      try {
        const response = await api.getLive(activeRide.id);
        const telemetry = response.event?.telemetry ?? response;
        if (!cancelled) applyLiveTelemetry(telemetry);
        if (isTerminalRideStatus(telemetry.status) && timer) clearInterval(timer);
      } catch (requestError: unknown) {
        if (!cancelled) setError(`${errorText(requestError)} Live tracking is paused; use Refresh to try again.`);
      }
    };

    void poll();
    timer = setInterval(() => void poll(), LIVE_POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
  }, [activeRide?.id, mode]);

  function appendAssistantBlocks(blocks: AssistantBlock[]) {
    setMessages((current) => [
      ...current,
      {
        id: createMessageId("assistant"),
        role: "assistant",
        blocks,
        timestamp: timeLabel(),
        createdAt: new Date().toISOString(),
      },
    ]);
  }

  function addResponseMessage(response: ChatResponse) {
    const blocks = fallbackBlocks(response);
    appendAssistantBlocks(blocks);

    const ride = response.ride;
    const quote = response.quote ?? ride?.quote;
    if (ride && (ride.status === "quoted" || (quote && !isActiveRideStatus(ride.status)))) {
      setRecommendation({ ...ride, quote: quote ?? ride.quote });
    }
    if (ride && isActiveRideStatus(ride.status)) {
      setRecommendation(undefined);
      const liveBlock = blocks.find((block): block is AssistantLiveRideBlock => block.type === "live_ride");
      const nextRide = liveBlock
        ? { ...ride, status: liveBlock.telemetry.status, driverId: liveBlock.telemetry.driverId ?? ride.driverId, vehicleId: liveBlock.telemetry.vehicleId ?? ride.vehicleId, updatedAt: liveBlock.telemetry.lastUpdatedAt }
        : ride;
      setActiveRide(nextRide);
      if (liveBlock) {
        liveTelemetryRef.current = liveBlock.telemetry;
        setLiveTelemetry(liveBlock.telemetry);
      }
    }
  }

  async function sendMessage(messageOverride?: string) {
    const message = (messageOverride ?? composer).trim();
    if (!message || chatLoading) return;
    setComposer("");
    setMessages((current) => [
      ...current,
      { id: createMessageId("user"), role: "user", text: message, timestamp: timeLabel(), createdAt: new Date().toISOString() },
    ]);
    setChatLoading(true);
    setError("");
    try {
      const response = mode === "demo" ? demoChat(message, Boolean(recommendation)) : await api.chat(message);
      if (mode !== "demo") setMode("live");
      addResponseMessage(response);
    } catch (requestError: unknown) {
      setMode("demo");
      setError(`${errorText(requestError)} Try reconnecting when the API is available.`);
      addResponseMessage(demoChat(message, Boolean(recommendation)));
    } finally {
      setChatLoading(false);
    }
  }

  function applyLiveTelemetry(telemetry: RideLiveTelemetry) {
    const previous = liveTelemetryRef.current;
    liveTelemetryRef.current = telemetry;
    setLiveTelemetry(telemetry);
    setActiveRide((current) => current && current.id === telemetry.rideId
      ? { ...current, status: telemetry.status, driverId: telemetry.driverId ?? current.driverId, vehicleId: telemetry.vehicleId ?? current.vehicleId, updatedAt: telemetry.lastUpdatedAt }
      : current);

    setMessages((current) => {
      let messageIndex = -1;
      let previousBlock: AssistantLiveRideBlock | undefined;
      for (let index = current.length - 1; index >= 0; index -= 1) {
        const block = current[index].blocks?.find((candidate): candidate is AssistantLiveRideBlock => candidate.type === "live_ride" && candidate.telemetry.rideId === telemetry.rideId);
        if (block) {
          messageIndex = index;
          previousBlock = block;
          break;
        }
      }

      const statusChanged = Boolean(previousBlock && previousBlock.telemetry.status !== telemetry.status);
      if (messageIndex === -1 || statusChanged) {
        return [
          ...current,
          { id: createMessageId("live"), role: "assistant", blocks: liveUpdateBlocks(telemetry), timestamp: timeLabel(), createdAt: new Date().toISOString() },
        ];
      }

      return current.map((message, index) => {
        if (index !== messageIndex || !message.blocks) return message;
        return {
          ...message,
          blocks: message.blocks.map((block) => {
            if (block.type === "live_ride" && block.telemetry.rideId === telemetry.rideId) return { type: "live_ride", telemetry, text: liveRideText(telemetry) };
            if (block.type === "route") return { ...block, coordinates: telemetry.routeCoordinates, lastUpdatedAt: telemetry.lastUpdatedAt };
            if (block.type === "traffic") return { ...block, level: telemetry.traffic.level, delayMinutes: telemetry.traffic.delayMinutes, text: telemetry.traffic.delayMinutes === 0 ? `Traffic is ${telemetry.traffic.level}; no added delay.` : `Traffic is ${telemetry.traffic.level}; about ${telemetry.traffic.delayMinutes} minutes of delay.`, lastUpdatedAt: telemetry.lastUpdatedAt, source: telemetry.source, label: telemetry.label, isDemo: telemetry.isDemo };
            return block;
          }),
          timestamp: timeLabel(),
          createdAt: new Date().toISOString(),
        };
      });
    });

    if (previous && previous.status !== telemetry.status) {
      showToast(`Ride status updated · ${statusText(telemetry.status)}`);
    }
  }

  async function refreshRide() {
    if (!activeRide) return;
    setError("");
    setToast("Refreshing live status…");
    try {
      if (mode === "demo") {
        applyLiveTelemetry(demoLiveForRide(activeRide, Math.max(livePollCountRef.current, 1)));
        showToast("Demo tracking refreshed");
        return;
      }
      const response = await api.track(activeRide.id);
      if (response.ride) setActiveRide((current) => current ? { ...current, ...response.ride } : response.ride);
      const liveBlock = response.blocks?.find((block): block is AssistantLiveRideBlock => block.type === "live_ride");
      if (liveBlock) applyLiveTelemetry(liveBlock.telemetry);
      else if (response.blocks?.length) appendAssistantBlocks(response.blocks);
      else if (response.assistantMessage) appendAssistantBlocks([{ type: "text", text: response.assistantMessage }]);
      showToast("Live tracking refreshed");
    } catch (requestError: unknown) {
      setError(`${errorText(requestError)} Try again in a moment.`);
    }
  }

  async function cancelRide() {
    if (!activeRide) return;
    setCancelLoading(true);
    setError("");
    try {
      const result = mode === "demo"
        ? { ride: { ...activeRide, status: "cancelled" as const, updatedAt: new Date().toISOString() } }
        : await api.cancelRide(activeRide.id);
      setActiveRide(undefined);
      setLiveTelemetry(undefined);
      liveTelemetryRef.current = undefined;
      setRecommendation(undefined);
      setCancelConfirm(false);
      appendAssistantBlocks([
        { type: "text", text: "Your ride has been cancelled. I won’t make any further changes." },
        { type: "progress", status: "complete", text: "Ride cancelled" },
        {
          type: "booking_confirmation",
          rideId: result.ride.id,
          providerId: result.ride.quote?.providerId ?? "provider",
          status: "cancelled",
          text: "The ride is cancelled.",
          source: result.ride.quote?.providerId === "mock" ? "mock" : "provider",
          isDemo: result.ride.quote?.providerId === "mock" || mode === "demo",
          lastUpdatedAt: result.ride.updatedAt,
        },
      ]);
      showToast("Ride cancelled");
    } catch (requestError: unknown) {
      setError(errorText(requestError));
    } finally {
      setCancelLoading(false);
    }
  }

  async function saveRules() {
    setRulesSaving(true);
    setError("");
    try {
      const payload = {
        bookingMode: draftRules.bookingMode,
        perRideCapMinor: draftRules.perRideCapMinor,
        dailySpendCapMinor: draftRules.dailySpendCapMinor,
        preferredProviders: draftRules.preferredProviders,
        preferredVehicleType: draftRules.preferredVehicleType,
        preference: draftRules.preference,
      };
      const saved = mode === "demo" ? { ...draftRules, updatedAt: new Date().toISOString() } : await api.saveRules(payload);
      setRules(saved);
      setDraftRules(saved);
      setMode(mode === "demo" ? "demo" : "live");
      setRulesSaved(true);
      showToast("Rules saved");
      setTimeout(() => setRulesSaved(false), 1_800);
    } catch (requestError: unknown) {
      const saved = { ...draftRules, updatedAt: new Date().toISOString() };
      setMode("demo");
      setRules(saved);
      setDraftRules(saved);
      setRulesSaved(true);
      setError(`${errorText(requestError)} Rules are saved locally in Demo mode.`);
    } finally {
      setRulesSaving(false);
    }
  }

  async function shareRide() {
    if (!activeRide) return;
    let ride = activeRide;
    if (mode === "live") {
      try {
        ride = await api.getRide(activeRide.id);
        setActiveRide(ride);
      } catch {
        // Sharing a cached snapshot is still useful when the read endpoint is briefly unavailable.
      }
    }
    const shareText = `RideAgent trip to ${ride.dropoff.label || ride.dropoff.address || "your destination"}. Status: ${statusText(ride.status)}. Driver: ${ride.driverId || "assigned"}. OTP: ${getOtp(ride.id)}.`;
    try {
      if (navigator.share) {
        await navigator.share({ title: "RideAgent trip", text: shareText });
        showToast("Trip shared");
      } else if (navigator.clipboard) {
        await navigator.clipboard.writeText(shareText);
        showToast("Trip details copied");
      } else {
        showToast("Trip details ready to share");
      }
    } catch (shareError: unknown) {
      if (shareError instanceof DOMException && shareError.name === "AbortError") return;
      setError("Could not share the trip from this browser.");
    }
  }

  function openProvider(action: AssistantAction) {
    if (!action.href) {
      showToast("This provider has no handoff link in the demo.");
      return;
    }
    window.open(action.href, "_blank", "noopener,noreferrer");
  }

  function handleAction(action: AssistantAction) {
    if (action.id === "confirm_booking") void sendMessage(action.value || "Yes, book it");
    if (action.id === "reject_recommendation") void sendMessage(action.value || "No, not this one");
    if (action.id === "open_provider") openProvider(action);
  }

  return (
    <div className="app-shell">
      <Header mode={mode} onRules={() => { setDraftRules(rules); setSettingsOpen(true); }} />
      <main className="app-main">
        <section className="conversation" aria-label="RideAgent conversation">
          <div className="conversation-head">
            <div>
              <p className="overline">TODAY · DELHI</p>
              <h1>Your ride, handled.</h1>
            </div>
            <p className="conversation-note">One conversation for every ride.</p>
          </div>
          {error ? <ConnectionBanner message={error} onReconnect={() => void loadRules()} onDismiss={() => setError("")} /> : null}
          <div className="message-list">
            <div className="day-divider"><span /> <span>OCT 18, 2026</span> <span /></div>
            {messages.map((message) => (
              <Message
                key={message.id}
                message={message}
                activeRideId={activeRide?.id}
                isLatestLiveMessage={message.id === latestLiveMessageId}
                cancelConfirm={cancelConfirm}
                cancelLoading={cancelLoading}
                onAction={handleAction}
                onCancelRequest={() => setCancelConfirm(true)}
                onCancelConfirm={() => void cancelRide()}
                onCancelDismiss={() => setCancelConfirm(false)}
                onShare={() => void shareRide()}
                onRefresh={() => void refreshRide()}
              />
            ))}
            {!hasInlineAction && messages.length <= INITIAL_MESSAGES.length + 1 ? (
              <QuickPrompts onPrompt={(value) => void sendMessage(value)} />
            ) : null}
            {chatLoading ? <TypingIndicator /> : null}
          </div>
          <Composer value={composer} loading={chatLoading} onChange={setComposer} onSend={() => void sendMessage()} />
        </section>
      </main>
      <div className="app-footer">
        <span><span className="footer-dot" /> {mode === "live" ? "Connected to RideAgent API" : mode === "demo" ? "Demo mode · deterministic preview data" : "Connecting to RideAgent API"}</span>
        <span>Raw provider operations stay hidden.</span>
      </div>
      {toast ? <div className="toast" role="status">{toast}</div> : null}
      <SettingsPanel
        open={settingsOpen}
        mode={mode}
        loading={rulesLoading}
        saving={rulesSaving}
        saved={rulesSaved}
        draft={draftRules}
        onChange={setDraftRules}
        onSave={() => void saveRules()}
        onClose={() => setSettingsOpen(false)}
      />
    </div>
  );
}

function Header({ mode, onRules }: { mode: ConnectionMode; onRules: () => void }) {
  const label = mode === "live" ? "LIVE API" : mode === "demo" ? "DEMO MODE" : "CONNECTING";
  return (
    <header className="app-header">
      <div className="brand-lockup">
        <div className="brand-mark" aria-hidden="true">✦</div>
        <div><p className="brand-kicker">PERSONAL MOBILITY</p><p className="brand-name">RideAgent</p></div>
      </div>
      <div className="header-right">
        <div className={`mode-pill mode-${mode}`}><span className="mode-dot" /> {label}</div>
        <button className="icon-button" type="button" aria-label="Open ride rules" onClick={onRules}><span aria-hidden="true">⚙</span></button>
      </div>
    </header>
  );
}

function ConnectionBanner({ message, onReconnect, onDismiss }: { message: string; onReconnect: () => void; onDismiss: () => void }) {
  return (
    <div className="connection-banner" role="alert">
      <span className="banner-icon">!</span>
      <p>{message}</p>
      <button type="button" onClick={onReconnect}>Reconnect</button>
      <button className="banner-dismiss" type="button" aria-label="Dismiss message" onClick={onDismiss}>×</button>
    </div>
  );
}

function Message({
  message,
  activeRideId,
  isLatestLiveMessage,
  cancelConfirm,
  cancelLoading,
  onAction,
  onCancelRequest,
  onCancelConfirm,
  onCancelDismiss,
  onShare,
  onRefresh,
}: {
  message: ChatMessage;
  activeRideId?: string;
  isLatestLiveMessage: boolean;
  cancelConfirm: boolean;
  cancelLoading: boolean;
  onAction: (action: AssistantAction) => void;
  onCancelRequest: () => void;
  onCancelConfirm: () => void;
  onCancelDismiss: () => void;
  onShare: () => void;
  onRefresh: () => void;
}) {
  const assistant = message.role === "assistant";
  if (!assistant) {
    return <div className="message-row user-row"><div className="user-bubble">{message.text}</div><span className="message-time">{message.timestamp}</span></div>;
  }
  if (!message.blocks?.length) {
    return <div className="message-row assistant-row"><div className="assistant-bubble">{message.text}</div><span className="message-time">{message.timestamp}</span></div>;
  }
  return (
    <div className="assistant-group">
      {message.blocks.map((block, index) => (
        <BlockRenderer
          key={`${message.id}-${block.type}-${index}`}
          block={block}
          messageCreatedAt={message.createdAt}
          activeRideId={activeRideId}
          isLatestLiveMessage={isLatestLiveMessage}
          cancelConfirm={cancelConfirm}
          cancelLoading={cancelLoading}
          onAction={onAction}
          onCancelRequest={onCancelRequest}
          onCancelConfirm={onCancelConfirm}
          onCancelDismiss={onCancelDismiss}
          onShare={onShare}
          onRefresh={onRefresh}
        />
      ))}
      <span className="message-time assistant-time">{message.timestamp}</span>
    </div>
  );
}

function BlockRenderer({
  block,
  messageCreatedAt,
  activeRideId,
  isLatestLiveMessage,
  cancelConfirm,
  cancelLoading,
  onAction,
  onCancelRequest,
  onCancelConfirm,
  onCancelDismiss,
  onShare,
  onRefresh,
}: {
  block: AssistantBlock;
  messageCreatedAt?: string;
  activeRideId?: string;
  isLatestLiveMessage: boolean;
  cancelConfirm: boolean;
  cancelLoading: boolean;
  onAction: (action: AssistantAction) => void;
  onCancelRequest: () => void;
  onCancelConfirm: () => void;
  onCancelDismiss: () => void;
  onShare: () => void;
  onRefresh: () => void;
}) {
  switch (block.type) {
    case "text":
      return <div className="assistant-bubble">{block.text}</div>;
    case "progress":
      return <ProgressCard block={block} />;
    case "route":
      return <RouteCard block={block} messageCreatedAt={messageCreatedAt} />;
    case "traffic":
      return <TrafficCard block={block} />;
    case "quote":
      return <QuoteCard block={block} messageCreatedAt={messageCreatedAt} />;
    case "booking_confirmation":
      return <BookingConfirmationCard block={block} messageCreatedAt={messageCreatedAt} />;
    case "live_ride":
      return <LiveRideCard block={block} isCurrent={block.telemetry.rideId === activeRideId && isLatestLiveMessage} cancelConfirm={cancelConfirm} cancelLoading={cancelLoading} onCancelRequest={onCancelRequest} onCancelConfirm={onCancelConfirm} onCancelDismiss={onCancelDismiss} onShare={onShare} onRefresh={onRefresh} />;
    case "actions":
      return <ActionsCard actions={block.actions} onAction={onAction} />;
  }
}

function SourceBadge({ source, label, isDemo }: { source?: string; label?: string; isDemo?: boolean }) {
  const demo = sourceLabel(source, label, isDemo) === "Demo data";
  return <span className={`source-badge ${demo ? "source-demo" : ""}`}><span className="source-dot" />{sourceLabel(source, label, isDemo)}</span>;
}

function ProgressCard({ block }: { block: Extract<AssistantBlock, { type: "progress" }> }) {
  const attention = block.status === "attention";
  return (
    <div className={`progress-card ${attention ? "progress-attention" : ""}`}>
      <span className={`progress-icon ${block.status === "complete" ? "progress-complete" : ""}`}>{block.status === "complete" ? "✓" : attention ? "!" : "·"}</span>
      <span><strong>{block.text}</strong><small>{attention ? "ACTION NEEDED" : block.status === "complete" ? "COMPLETE" : "IN PROGRESS"}</small></span>
    </div>
  );
}

function RouteCard({ block, messageCreatedAt }: { block: Extract<AssistantBlock, { type: "route" }>; messageCreatedAt?: string }) {
  return (
    <div className="rich-card route-card">
      <CardHeader eyebrow="ROUTE" title={block.title} source={<SourceBadge source={block.source} label={block.label} isDemo={block.isDemo} />} />
      <RouteMapSurface coordinates={block.coordinates} pickup={block.pickup.coordinates} dropoff={block.dropoff.coordinates} pickupLabel={block.pickup.label || "Pickup"} dropoffLabel={block.dropoff.label || "Destination"} />
      <div className="route-endpoints">
        <Endpoint kind="pickup" label="PICKUP" value={block.pickup.label || block.pickup.address || "Current location"} />
        <Endpoint kind="dropoff" label="DROP-OFF" value={block.dropoff.label || block.dropoff.address || "Destination"} />
      </div>
      <UpdatedAt value={block.lastUpdatedAt || messageCreatedAt} />
    </div>
  );
}

function TrafficCard({ block }: { block: Extract<AssistantBlock, { type: "traffic" }> }) {
  const tone = block.level === "heavy" ? "danger" : block.level === "moderate" ? "accent" : "success";
  return (
    <div className="rich-card traffic-card">
      <div className="card-header"><div><p className="card-eyebrow">TRAFFIC CHECK</p><p className={`traffic-level traffic-${tone}`}>{block.level.toUpperCase()}</p></div><SourceBadge source={block.source} label={block.label} isDemo={block.isDemo} /></div>
      <p className="card-copy">{block.text}</p>
      <div className="traffic-footer"><span className={`delay-chip traffic-${tone}`}>{block.delayMinutes === 0 ? "No added delay" : `+${block.delayMinutes} min delay`}</span><UpdatedAt value={block.lastUpdatedAt} /></div>
    </div>
  );
}

function QuoteCard({ block, messageCreatedAt }: { block: Extract<AssistantBlock, { type: "quote" }>; messageCreatedAt?: string }) {
  const demo = block.isDemo || block.source === "demo" || /demo|mock/i.test(block.providerLabel);
  return (
    <div className="rich-card quote-card">
      <CardHeader eyebrow="PROVIDER QUOTE" title={block.providerLabel || readableProvider(block.providerId)} source={<SourceBadge source={demo ? "demo" : "provider"} label={demo ? "Demo data" : "Provider source"} isDemo={demo} />} />
      <div className="quote-metrics">
        <Metric value={money(block.amountMinor, block.currency)} label="ESTIMATED FARE" />
        <Metric value={`${block.estimatedDurationMinutes} min`} label="ETA" />
        <Metric value={block.quote.vehicleType.toUpperCase()} label="VEHICLE" />
      </div>
      <p className="quote-copy">{block.humanActionRequired ? "Provider handoff required — I have not booked this ride." : "Balanced for your saved preference and inside your saved ride rules."}</p>
      <UpdatedAt value={block.lastUpdatedAt || block.quote.createdAt || messageCreatedAt} />
    </div>
  );
}

function BookingConfirmationCard({ block, messageCreatedAt }: { block: Extract<AssistantBlock, { type: "booking_confirmation" }>; messageCreatedAt?: string }) {
  return (
    <div className="booking-card rich-card">
      <span className="booking-check">✓</span>
      <div className="booking-card-main">
        <div className="card-header"><div><p className="card-eyebrow">BOOKING CONFIRMED</p><p className="booking-title">{readableProvider(block.providerId)}</p></div><SourceBadge source={block.source} isDemo={block.isDemo} /></div>
        <p className="card-copy">{block.text}</p>
        <div className="booking-footer"><span className="status-chip">{statusText(block.status).toUpperCase()}</span><UpdatedAt value={block.lastUpdatedAt || messageCreatedAt} /></div>
      </div>
    </div>
  );
}

function LiveRideCard({
  block,
  isCurrent,
  cancelConfirm,
  cancelLoading,
  onCancelRequest,
  onCancelConfirm,
  onCancelDismiss,
  onShare,
  onRefresh,
}: {
  block: AssistantLiveRideBlock;
  isCurrent: boolean;
  cancelConfirm: boolean;
  cancelLoading: boolean;
  onCancelRequest: () => void;
  onCancelConfirm: () => void;
  onCancelDismiss: () => void;
  onShare: () => void;
  onRefresh: () => void;
}) {
  const telemetry = block.telemetry;
  const terminal = isTerminalRideStatus(telemetry.status);
  const status = telemetry.status === "in_trip" ? "IN TRIP" : telemetry.status === "arrived" ? "ARRIVED" : telemetry.status === "driver_assigned" ? "DRIVER ASSIGNED" : telemetry.status === "completed" ? "COMPLETE" : telemetry.status === "cancelled" ? "CANCELLED" : "DRIVER ARRIVING";
  return (
    <div className={`rich-card live-card ${terminal ? "live-card-terminal" : ""}`}>
      <div className="card-header">
        <div><p className="card-eyebrow">LIVE RIDE</p><p className="live-title">{status}</p></div>
        <div className="live-header-actions"><SourceBadge source={telemetry.source} label={telemetry.label} isDemo={telemetry.isDemo} />{isCurrent ? <button className="round-button" type="button" aria-label="Refresh tracking" onClick={onRefresh}>↻</button> : null}</div>
      </div>
      <RouteMapSurface coordinates={telemetry.routeCoordinates} pickup={telemetry.pickup} dropoff={telemetry.dropoff} driverLocation={telemetry.driverLocation} pickupLabel="Pickup" dropoffLabel="Destination" />
      <div className="ride-status-row"><span className={`ride-status-icon ${terminal ? "terminal-icon" : ""}`}>{terminal ? "✓" : "↗"}</span><div><p className="ride-status-copy">{block.text}</p><p className="ride-eta">{telemetry.etaMinutes === 0 ? "At pickup or destination" : `ETA ${telemetry.etaMinutes} min`}</p></div><span className={`live-pulse ${terminal ? "pulse-terminal" : ""}`} /></div>
      <div className="driver-grid"><DriverDetail label="DRIVER" value={telemetry.driverId || "Assigned"} /><DriverDetail label="VEHICLE" value={telemetry.vehicleId || "Vehicle assigned"} /><DriverDetail label="OTP" value={getOtp(telemetry.rideId)} emphasis /></div>
      {isCurrent && !terminal && cancelConfirm ? <div className="cancel-prompt"><strong>Cancel this ride?</strong><span>Your driver may already be en route.</span><div className="inline-actions"><button className="button button-danger" type="button" onClick={onCancelConfirm} disabled={cancelLoading}>{cancelLoading ? "Cancelling…" : "Cancel ride"}</button><button className="button button-ghost" type="button" onClick={onCancelDismiss}>Keep ride</button></div></div> : null}
      {isCurrent ? <div className="live-actions"><button className="button button-outline" type="button" onClick={onShare}>Share trip</button>{!terminal ? <button className="button button-ghost danger-text" type="button" onClick={onCancelRequest}>Cancel ride</button> : null}</div> : null}
      <UpdatedAt value={telemetry.lastUpdatedAt} />
    </div>
  );
}

function ActionsCard({ actions, onAction }: { actions: AssistantAction[]; onAction: (action: AssistantAction) => void }) {
  return <div className="action-card">{actions.map((action) => <button key={`${action.id}-${action.label}`} className={`button ${action.id === "confirm_booking" || action.id === "open_provider" ? "button-primary" : "button-secondary"}`} type="button" onClick={() => onAction(action)}>{action.label}{action.id === "open_provider" ? <span>↗</span> : null}</button>)}</div>;
}

function CardHeader({ eyebrow, title, source }: { eyebrow: string; title: string; source: React.ReactNode }) {
  return <div className="card-header"><div><p className="card-eyebrow">{eyebrow}</p><p className="card-title">{title}</p></div>{source}</div>;
}

function Endpoint({ kind, label, value }: { kind: "pickup" | "dropoff"; label: string; value: string }) {
  return <div className="endpoint"><span className={`endpoint-dot endpoint-${kind}`} /><div><p>{label}</p><strong>{value}</strong></div></div>;
}

function Metric({ value, label }: { value: string; label: string }) {
  return <div className="metric"><strong>{value}</strong><span>{label}</span></div>;
}

function DriverDetail({ label, value, emphasis }: { label: string; value: string; emphasis?: boolean }) {
  return <div className="driver-detail"><span>{label}</span><strong className={emphasis ? "otp-value" : ""}>{value}</strong></div>;
}

function UpdatedAt({ value }: { value?: string }) {
  return <span className="updated-at">Updated {formatUpdatedAt(value)}</span>;
}

function RouteMapSurface({ coordinates, pickup, dropoff, driverLocation, pickupLabel, dropoffLabel }: { coordinates: Coordinates[]; pickup?: Coordinates; dropoff?: Coordinates; driverLocation?: Coordinates; pickupLabel: string; dropoffLabel: string }) {
  const rawId = useId();
  const patternId = `route-grid-${rawId.replace(/:/g, "")}`;
  const points = coordinates.length > 1 ? coordinates : interpolateRoute(pickup, dropoff);
  const allCoordinates = [...points, ...(pickup ? [pickup] : []), ...(dropoff ? [dropoff] : []), ...(driverLocation ? [driverLocation] : [])];
  const minLat = Math.min(...allCoordinates.map((item) => item.latitude));
  const maxLat = Math.max(...allCoordinates.map((item) => item.latitude));
  const minLon = Math.min(...allCoordinates.map((item) => item.longitude));
  const maxLon = Math.max(...allCoordinates.map((item) => item.longitude));
  const latRange = Math.max(maxLat - minLat, 0.001);
  const lonRange = Math.max(maxLon - minLon, 0.001);
  const point = (coordinate: Coordinates) => ({ x: 30 + ((coordinate.longitude - minLon) / lonRange) * 580, y: 26 + (1 - (coordinate.latitude - minLat) / latRange) * 148 });
  const routePoints = points.map(point);
  const pickupPoint = point(pickup ?? points[0]);
  const dropoffPoint = point(dropoff ?? points[points.length - 1]);
  const driverPoint = driverLocation ? point(driverLocation) : undefined;
  const path = routePoints.map((item, index) => `${index === 0 ? "M" : "L"} ${item.x.toFixed(1)} ${item.y.toFixed(1)}`).join(" ");

  return (
    <div className="map-surface" aria-label="Stylized demo route map">
      <svg viewBox="0 0 640 210" role="img" aria-label={`${pickupLabel} to ${dropoffLabel}`}>
        <defs><pattern id={patternId} width="32" height="32" patternUnits="userSpaceOnUse"><path d="M 32 0 L 0 0 0 32" fill="none" stroke="rgba(255,255,255,.055)" strokeWidth="1" /></pattern></defs>
        <rect width="640" height="210" fill={`url(#${patternId})`} />
        <path d="M0 168 C120 124 148 168 254 118 S430 42 640 72" className="map-road map-road-secondary" />
        <path d="M-20 54 C100 94 190 32 302 78 S480 178 660 134" className="map-road map-road-secondary" />
        <path d={path} className="route-halo" />
        <path d={path} className="route-line" />
        <circle cx={pickupPoint.x} cy={pickupPoint.y} r="7" className="map-marker pickup-marker" />
        <circle cx={dropoffPoint.x} cy={dropoffPoint.y} r="9" className="map-marker dropoff-marker" />
        {driverPoint ? <g className="driver-marker" transform={`translate(${driverPoint.x} ${driverPoint.y})`}><circle r="13" /><path d="M-4 3 L0 -6 L6 5 L1 3 L-4 3Z" /></g> : null}
        <g className="map-label" transform={`translate(${Math.max(18, pickupPoint.x - 12)} ${Math.max(22, pickupPoint.y - 20)})`}><rect width="86" height="23" rx="11" /><text x="43" y="15">{pickupLabel}</text></g>
        <g className="map-label map-label-destination" transform={`translate(${Math.min(526, Math.max(18, dropoffPoint.x - 26))} ${Math.min(183, dropoffPoint.y + 12)})`}><rect width="108" height="23" rx="11" /><text x="54" y="15">{dropoffLabel}</text></g>
        <g className="map-legend" transform="translate(28 178)"><circle cx="5" cy="5" r="4" /><text x="16" y="9">DEMO ROUTE</text></g>
      </svg>
      <div className="map-meta"><span><span className="map-meta-dot" /> Mock map surface</span><span>Traffic refreshed with ride status</span></div>
    </div>
  );
}

function QuickPrompts({ onPrompt }: { onPrompt: (value: string) => void }) {
  return <div className="quick-prompts"><p className="card-eyebrow">TRY A REQUEST</p><div>{DEMO_QUICK_PROMPTS.map((prompt) => <button key={prompt.label} type="button" onClick={() => onPrompt(prompt.value)}><span>{prompt.label}</span><span>↗</span></button>)}</div></div>;
}

function TypingIndicator() {
  return <div className="typing-indicator"><span className="typing-dots"><i /><i /><i /></span><span>RideAgent is comparing options…</span></div>;
}

function Composer({ value, loading, onChange, onSend }: { value: string; loading: boolean; onChange: (value: string) => void; onSend: () => void }) {
  return (
    <div className="composer-wrap">
      <div className="composer">
        <textarea aria-label="Message RideAgent" value={value} onChange={(event) => onChange(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); onSend(); } }} placeholder="Ask for a ride…" rows={1} disabled={loading} />
        <span className="composer-hint">↵ send</span>
        <button className="send-button" type="button" aria-label="Send message" disabled={!value.trim() || loading} onClick={onSend}>↑</button>
      </div>
      <p>RideAgent compares, recommends, and books within your saved rules.</p>
    </div>
  );
}

function SettingsPanel({
  open,
  mode,
  loading,
  saving,
  saved,
  draft,
  onChange,
  onSave,
  onClose,
}: {
  open: boolean;
  mode: ConnectionMode;
  loading: boolean;
  saving: boolean;
  saved: boolean;
  draft: Rules;
  onChange: (rules: Rules) => void;
  onSave: () => void;
  onClose: () => void;
}) {
  if (!open) return null;
  const set = <K extends keyof Rules>(key: K, value: Rules[K]) => onChange({ ...draft, [key]: value });
  const toggleProvider = (provider: string) => set("preferredProviders", draft.preferredProviders.includes(provider) ? draft.preferredProviders.filter((item) => item !== provider) : [...draft.preferredProviders, provider]);
  return (
    <div className="settings-overlay" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <aside className="settings-panel" role="dialog" aria-modal="true" aria-label="Ride rules">
        <div className="settings-header"><div><p className="overline">PERSONALIZATION</p><h2>Ride rules</h2></div><button type="button" className="icon-button close-settings" aria-label="Close ride rules" onClick={onClose}>×</button></div>
        <p className="settings-intro">RideAgent will explain itself before it acts. These controls stay local to this preview until saved.</p>
        {loading ? <div className="settings-loading">Loading your rules…</div> : <>
          <fieldset><legend>BOOKING MODE</legend><div className="segmented"><button type="button" className={draft.bookingMode === "ask_before_booking" ? "selected" : ""} onClick={() => set("bookingMode", "ask_before_booking")}>Ask before booking</button><button type="button" className={draft.bookingMode === "auto_book_within_rules" ? "selected" : ""} onClick={() => set("bookingMode", "auto_book_within_rules")}>Auto-book in rules</button></div></fieldset>
          <fieldset><legend>SPEND LIMITS</legend><div className="limit-grid"><label>Per-ride cap<div className="money-input"><span>₹</span><input inputMode="decimal" value={(draft.perRideCapMinor / 100).toFixed(2)} onChange={(event) => set("perRideCapMinor", Math.max(0, Math.round(Number(event.target.value.replace(/[^0-9.]/g, "")) * 100) || 0))} /></div></label><label>Daily cap<div className="money-input"><span>₹</span><input inputMode="decimal" value={(draft.dailySpendCapMinor / 100).toFixed(2)} onChange={(event) => set("dailySpendCapMinor", Math.max(0, Math.round(Number(event.target.value.replace(/[^0-9.]/g, "")) * 100) || 0))} /></div></label></div></fieldset>
          <fieldset><legend>OPTIMIZE FOR</legend><div className="preference-options">{(["balanced", "cost", "speed"] as Preference[]).map((preference) => <button key={preference} type="button" className={draft.preference === preference ? "selected" : ""} onClick={() => set("preference", preference)}>{preference === "balanced" ? "Balanced" : preference === "cost" ? "Lowest cost" : "Fastest"}</button>)}</div></fieldset>
          <fieldset><legend>PREFERRED PROVIDERS</legend><div className="provider-options">{["MockProvider", "Uber", "Ola", "Rapido"].map((provider) => <button key={provider} type="button" className={draft.preferredProviders.includes(provider) ? "selected" : ""} onClick={() => toggleProvider(provider)}><span>{draft.preferredProviders.includes(provider) ? "✓" : "+"}</span>{provider}</button>)}</div></fieldset>
          <div className="settings-source"><span className="settings-source-dot" /> {mode === "live" ? `Synced with ${API_BASE_URL}` : "Demo mode · saved locally"}</div>
          <button className="button button-primary settings-save" type="button" onClick={onSave} disabled={saving}>{saving ? "Saving…" : saved ? "Saved ✓" : "Save rules"}</button>
        </>}
      </aside>
    </div>
  );
}
