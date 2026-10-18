import { StatusBar } from "expo-status-bar";
import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Linking,
  Modal,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from "react-native";
import { api, API_BASE_URL, ApiError } from "./src/api";
import { DEFAULT_RULES, demoChat, demoLiveForRide, INITIAL_ACTIVITY, INITIAL_MESSAGES } from "./src/fixtures";
import type {
  ActivityItem,
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
} from "./src/types";

type Tab = "assistant" | "activity" | "rules";
type ConnectionMode = "connecting" | "live" | "demo";

const LIVE_POLL_INTERVAL_MS = 5_000;
const MAX_LIVE_POLLS = 60;
const ACTIVE_RIDE_STATUSES: RideStatus[] = ["booked", "driver_assigned", "arriving", "arrived", "in_trip"];
const TERMINAL_RIDE_STATUSES: RideStatus[] = ["completed", "cancelled", "failed"];

const colors = {
  bg: "#171614",
  panel: "#211f1c",
  panelStrong: "#292622",
  panelSoft: "#24221f",
  border: "#3b3731",
  text: "#f7f1e8",
  muted: "#a49d92",
  faint: "#777168",
  accent: "#e2b478",
  accentSoft: "#443427",
  success: "#9bc7a4",
  danger: "#e68f82",
  blue: "#9fc0d0",
  purple: "#c3a9dc",
};

const money = (minor?: number) => (minor === undefined ? "—" : `₹${(minor / 100).toFixed(2)}`);
const minutes = (seconds?: number) => (seconds === undefined ? "—" : `${Math.ceil(seconds / 60)} min`);
const timeLabel = () => new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
const readableProvider = (provider?: string) => provider === "mock" ? "MockProvider" : provider || "Provider";
const statusText = (status: RideStatus) => status.replaceAll("_", " ");

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

function errorText(error: unknown) {
  if (error instanceof ApiError && error.status === 0) {
    return `Cannot reach Lexar AI API at ${API_BASE_URL}. Check that the API is running, then reconnect.`;
  }
  return error instanceof Error ? error.message : "Something went wrong. Try again.";
}

function isActiveRideStatus(status?: RideStatus) {
  return Boolean(status && ACTIVE_RIDE_STATUSES.includes(status));
}

function isTerminalRideStatus(status?: RideStatus) {
  return Boolean(status && TERMINAL_RIDE_STATUSES.includes(status));
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
  const start = pickup ?? { latitude: 28.6139, longitude: 77.209 };
  const end = dropoff ?? { latitude: 28.5562, longitude: 77.1 };
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
        currency: "INR",
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

export default function App() {
  const [tab, setTab] = useState<Tab>("assistant");
  const [mode, setMode] = useState<ConnectionMode>("connecting");
  const [error, setError] = useState("");
  const [rules, setRules] = useState<Rules>(DEFAULT_RULES);
  const [draftRules, setDraftRules] = useState<Rules>(DEFAULT_RULES);
  const [rulesLoading, setRulesLoading] = useState(true);
  const [rulesSaving, setRulesSaving] = useState(false);
  const [rulesSaved, setRulesSaved] = useState(false);
  const [rulesOpen, setRulesOpen] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>(INITIAL_MESSAGES);
  const [activity, setActivity] = useState<ActivityItem[]>(INITIAL_ACTIVITY);
  const [recommendation, setRecommendation] = useState<Ride | undefined>();
  const [activeRide, setActiveRide] = useState<Ride | undefined>();
  const [liveTelemetry, setLiveTelemetry] = useState<RideLiveTelemetry | undefined>();
  const [composer, setComposer] = useState("");
  const [chatLoading, setChatLoading] = useState(false);
  const [cancelLoading, setCancelLoading] = useState(false);
  const [cancelConfirm, setCancelConfirm] = useState(false);
  const [liveRefreshNonce, setLiveRefreshNonce] = useState(0);
  const liveTelemetryRef = useRef<RideLiveTelemetry>();

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
          setError(`${errorText(saveError)} · Demo mode is active. Tap Reconnect to try again.`);
        }
      } else {
        setMode("demo");
        setError(`${errorText(requestError)} · Demo mode is active. Tap Reconnect to try again.`);
      }
    } finally {
      setRulesLoading(false);
    }
  }

  useEffect(() => {
    void loadRules();
  }, []);

  useEffect(() => {
    if (!activeRide || isTerminalRideStatus(activeRide.status)) return;
    let cancelled = false;
    let pollCount = 0;
    let timer: ReturnType<typeof setInterval> | undefined;

    const poll = async () => {
      if (cancelled || pollCount >= MAX_LIVE_POLLS) {
        if (timer) clearInterval(timer);
        return;
      }
      pollCount += 1;
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
        if (!cancelled) setError(`${errorText(requestError)} Live tracking is paused. Tap Reconnect to resume.`);
      }
    };

    void poll();
    timer = setInterval(() => { void poll(); }, LIVE_POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
  }, [activeRide?.id, mode, liveRefreshNonce]);

  const visibleActivity = useMemo(() => activity.slice(0, 8), [activity]);

  function addActivity(item: Omit<ActivityItem, "id" | "time">) {
    setActivity((current) => [{ ...item, id: `${item.kind}-${Date.now()}`, time: `Today, ${timeLabel()}` }, ...current]);
  }

  function appendAssistantBlocks(blocks: AssistantBlock[]) {
    setMessages((current) => [...current, {
      id: createMessageId("assistant"),
      role: "assistant",
      blocks,
      timestamp: timeLabel(),
      createdAt: new Date().toISOString(),
    }]);
  }

  function handleChatResponse(response: ChatResponse) {
    const blocks = fallbackBlocks(response);
    setMessages((current) => [...current, {
      id: createMessageId("assistant"),
      role: "assistant",
      blocks,
      timestamp: timeLabel(),
      createdAt: new Date().toISOString(),
    }]);

    const ride = response.ride;
    const quote = response.quote ?? ride?.quote;
    if (ride && (ride.status === "quoted" || (quote && !isActiveRideStatus(ride.status)))) {
      setRecommendation({ ...ride, quote: quote ?? ride.quote });
      addActivity({ kind: "decision", label: "Recommendation ready", detail: `${readableProvider(quote?.providerId)} · ${money(quote?.amountMinor)} · ${minutes(quote?.estimatedDurationSeconds)}`, tone: "success" });
    }
    if (ride && isActiveRideStatus(ride.status)) {
      setRecommendation(undefined);
      const liveBlock = blocks.find((block): block is AssistantLiveRideBlock => block.type === "live_ride");
      const nextRide = liveBlock ? { ...ride, status: liveBlock.telemetry.status, driverId: liveBlock.telemetry.driverId ?? ride.driverId, vehicleId: liveBlock.telemetry.vehicleId ?? ride.vehicleId, updatedAt: liveBlock.telemetry.lastUpdatedAt } : ride;
      setActiveRide(nextRide);
      if (liveBlock) {
        liveTelemetryRef.current = liveBlock.telemetry;
        setLiveTelemetry(liveBlock.telemetry);
      }
      addActivity({ kind: "ride", label: "Ride booked", detail: `${ride.dropoff.label || "Destination"} · ${ride.driverId || "Driver assigned"}`, tone: "success" });
    }
  }

  async function sendMessage(messageOverride?: string) {
    const message = (messageOverride ?? composer).trim();
    if (!message || chatLoading) return;
    setComposer("");
    setMessages((current) => [...current, { id: createMessageId("user"), role: "user", text: message, timestamp: timeLabel(), createdAt: new Date().toISOString() }]);
    setChatLoading(true);
    setError("");
    try {
      const response = mode === "demo" ? demoChat(message, Boolean(recommendation)) : await api.chat(message);
      if (mode !== "demo") setMode("live");
      handleChatResponse(response);
    } catch (requestError: unknown) {
      setMode("demo");
      setError(`${errorText(requestError)} · Demo mode is active. Tap Reconnect to try again.`);
      handleChatResponse(demoChat(message, Boolean(recommendation)));
    } finally {
      setChatLoading(false);
    }
  }

  function applyLiveTelemetry(telemetry: RideLiveTelemetry) {
    const previous = liveTelemetryRef.current;
    liveTelemetryRef.current = telemetry;
    setLiveTelemetry(telemetry);
    setActiveRide((current) => current && current.id === telemetry.rideId ? {
      ...current,
      status: telemetry.status,
      driverId: telemetry.driverId ?? current.driverId,
      vehicleId: telemetry.vehicleId ?? current.vehicleId,
      updatedAt: telemetry.lastUpdatedAt,
    } : current);

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
      if (statusChanged) {
        return [...current, {
          id: createMessageId("live"),
          role: "assistant",
          blocks: liveUpdateBlocks(telemetry),
          timestamp: timeLabel(),
          createdAt: new Date().toISOString(),
        }];
      }
      if (messageIndex === -1) {
        return [...current, { id: createMessageId("live"), role: "assistant", blocks: liveUpdateBlocks(telemetry), timestamp: timeLabel(), createdAt: new Date().toISOString() }];
      }

      return current.map((message, index) => {
        if (index !== messageIndex || !message.blocks) return message;
        return {
          ...message,
          blocks: message.blocks.map((block) => {
            if (block.type === "live_ride" && block.telemetry.rideId === telemetry.rideId) return { type: "live_ride", telemetry, text: liveRideText(telemetry) };
            if (block.type === "traffic") return { ...block, level: telemetry.traffic.level, delayMinutes: telemetry.traffic.delayMinutes, text: trafficText(telemetry.traffic.level, telemetry.traffic.delayMinutes), lastUpdatedAt: telemetry.lastUpdatedAt, source: telemetry.source, label: telemetry.label };
            return block;
          }),
          timestamp: timeLabel(),
          createdAt: new Date().toISOString(),
        };
      });
    });

    if (previous && previous.status !== telemetry.status) {
      addActivity({ kind: "ride", label: "Ride status updated", detail: `${statusText(telemetry.status)} · ETA ${telemetry.etaMinutes} min`, tone: telemetry.status === "completed" ? "success" : "muted" });
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
      addActivity({ kind: "decision", label: "Rules updated", detail: `${saved.bookingMode === "ask_before_booking" ? "Ask before booking" : "Auto-book within my rules"} · ${money(saved.perRideCapMinor)} cap`, tone: "success" });
      setTimeout(() => setRulesSaved(false), 1800);
    } catch (requestError: unknown) {
      setMode("demo");
      setError(`${errorText(requestError)} · Rules saved locally in Demo mode.`);
      const saved = { ...draftRules, updatedAt: new Date().toISOString() };
      setRules(saved);
      setRulesSaved(true);
    } finally {
      setRulesSaving(false);
    }
  }

  function refreshRide() {
    if (!activeRide) return;
    setError("");
    setLiveRefreshNonce((current) => current + 1);
  }

  async function cancelRide() {
    if (!activeRide) return;
    setCancelLoading(true);
    setError("");
    try {
      const result = mode === "demo"
        ? { ride: { ...activeRide, status: "cancelled" as const, updatedAt: "2026-10-17T08:15:00.000Z" } }
        : await api.cancelRide(activeRide.id);
      const cancelledTelemetry = liveTelemetry && liveTelemetry.rideId === activeRide.id
        ? { ...liveTelemetry, status: "cancelled" as const, etaMinutes: 0, lastUpdatedAt: result.ride.updatedAt }
        : undefined;
      if (cancelledTelemetry) applyLiveTelemetry(cancelledTelemetry);
      setActiveRide(undefined);
      setLiveTelemetry(undefined);
      liveTelemetryRef.current = undefined;
      setRecommendation(undefined);
      setCancelConfirm(false);
      appendAssistantBlocks([
        { type: "text", text: "Your ride has been cancelled. I won’t make any further changes." },
        { type: "progress", status: "complete", text: "Ride cancelled" },
      ]);
      addActivity({ kind: "ride", label: "Ride cancelled", detail: activeRide.dropoff.label || "Destination", tone: "warning" });
      if (result.ride.status !== "cancelled") setError("The API returned an unexpected ride state.");
    } catch (requestError: unknown) {
      setError(errorText(requestError));
    } finally {
      setCancelLoading(false);
    }
  }

  async function openProvider(action: AssistantAction) {
    if (!action.href) {
      Alert.alert("Provider handoff", "This provider does not have a handoff link in the demo.");
      return;
    }
    try {
      await Linking.openURL(action.href);
    } catch (requestError: unknown) {
      setError(`Could not open the provider handoff. ${errorText(requestError)}`);
    }
  }

  function handleAction(action: AssistantAction) {
    if (action.id === "confirm_booking") void sendMessage(action.value || "Yes, book it");
    if (action.id === "reject_recommendation") void sendMessage(action.value || "No, not this one");
    if (action.id === "open_provider") void openProvider(action);
  }

  function renderMain() {
    if (tab === "activity") return <ActivityView items={visibleActivity} />;
    if (tab === "rules") return <RulesView rules={rules} loading={rulesLoading} onEdit={() => { setDraftRules(rules); setRulesOpen(true); }} />;
    return (
      <AssistantView
        messages={messages}
        hasRecommendation={Boolean(recommendation)}
        hasActiveRide={Boolean(activeRide)}
        composer={composer}
        loading={chatLoading}
        cancelConfirm={cancelConfirm}
        cancelLoading={cancelLoading}
        activeRideId={activeRide?.id}
        onComposerChange={setComposer}
        onSend={() => void sendMessage()}
        onQuickAction={(value) => void sendMessage(value)}
        onAction={handleAction}
        onCancelRequest={() => setCancelConfirm(true)}
        onCancelConfirm={() => void cancelRide()}
        onCancelDismiss={() => setCancelConfirm(false)}
        onShare={() => void Share.share({ message: `Lexar AI trip to ${activeRide?.dropoff.label || "your destination"}. Driver: ${activeRide?.driverId || "assigned"}. OTP: ${activeRide ? getOtp(activeRide.id) : "—"}.` })}
        onRefresh={refreshRide}
      />
    );
  }

  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar style="light" />
      <KeyboardAvoidingView style={styles.root} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <Header mode={mode} onRules={() => { setDraftRules(rules); setRulesOpen(true); }} />
        <View style={styles.content}>{renderMain()}</View>
        <TabBar active={tab} onChange={setTab} />
        {error ? (
          <View accessibilityRole="alert" style={styles.errorBanner}>
            <Text style={styles.errorText}>!</Text>
            <Text style={styles.errorCopy}>{error}</Text>
            <Pressable accessibilityRole="button" onPress={() => void loadRules()} style={styles.reconnectButton}><Text style={styles.reconnectText}>Reconnect</Text></Pressable>
            <Pressable accessibilityRole="button" onPress={() => setError("")} style={styles.errorDismissButton}><Text style={styles.errorDismiss}>×</Text></Pressable>
          </View>
        ) : null}
      </KeyboardAvoidingView>
      <RulesSheet
        visible={rulesOpen}
        draft={draftRules}
        saving={rulesSaving}
        saved={rulesSaved}
        onChange={setDraftRules}
        onSave={() => void saveRules()}
        onClose={() => setRulesOpen(false)}
      />
    </SafeAreaView>
  );
}

function Header({ mode, onRules }: { mode: ConnectionMode; onRules: () => void }) {
  const label = mode === "live" ? "LIVE API" : mode === "demo" ? "DEMO MODE" : "CONNECTING";
  return (
    <View style={styles.header}>
      <View style={styles.brandRow}><View style={styles.brandMark}><Text style={styles.brandMarkText}>✦</Text></View><View><Text style={styles.eyebrow}>PERSONAL ASSISTANT</Text><Text style={styles.title}>Lexar AI</Text></View></View>
      <View style={styles.headerActions}><View style={[styles.modePill, mode === "demo" && styles.modePillDemo]}><View style={[styles.modeDot, mode === "live" ? styles.modeDotLive : mode === "demo" ? styles.modeDotDemo : styles.modeDotConnecting]} /><Text style={styles.modeText}>{label}</Text></View><Pressable accessibilityRole="button" accessibilityLabel="Open rules" onPress={onRules} style={styles.iconButton}><Text style={styles.iconText}>⚙</Text></Pressable></View>
    </View>
  );
}

function AssistantView(props: {
  messages: ChatMessage[];
  hasRecommendation: boolean;
  hasActiveRide: boolean;
  composer: string;
  loading: boolean;
  cancelConfirm: boolean;
  cancelLoading: boolean;
  activeRideId?: string;
  onComposerChange: (value: string) => void;
  onSend: () => void;
  onQuickAction: (value: string) => void;
  onAction: (action: AssistantAction) => void;
  onCancelRequest: () => void;
  onCancelConfirm: () => void;
  onCancelDismiss: () => void;
  onShare: () => void;
  onRefresh: () => void;
}) {
  return (
    <View style={styles.flex}>
      <ScrollView contentContainerStyle={styles.chatContent} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
        <View style={styles.todayRow}><View style={styles.todayLine} /><Text style={styles.todayText}>TODAY</Text><View style={styles.todayLine} /></View>
        {props.messages.map((message) => <Message key={message.id} message={message} activeRideId={props.activeRideId} cancelConfirm={props.cancelConfirm} cancelLoading={props.cancelLoading} onAction={props.onAction} onCancelRequest={props.onCancelRequest} onCancelConfirm={props.onCancelConfirm} onCancelDismiss={props.onCancelDismiss} onShare={props.onShare} onRefresh={props.onRefresh} />)}
        {!props.hasRecommendation && !props.hasActiveRide ? <QuickActions onAction={props.onQuickAction} /> : null}
        {props.loading ? <View style={styles.typing}><ActivityIndicator size="small" color={colors.accent} /><Text style={styles.typingText}>Lexar AI is thinking…</Text></View> : null}
      </ScrollView>
      <Composer value={props.composer} loading={props.loading} onChange={props.onComposerChange} onSend={props.onSend} />
    </View>
  );
}

function Message(props: {
  message: ChatMessage;
  activeRideId?: string;
  cancelConfirm: boolean;
  cancelLoading: boolean;
  onAction: (action: AssistantAction) => void;
  onCancelRequest: () => void;
  onCancelConfirm: () => void;
  onCancelDismiss: () => void;
  onShare: () => void;
  onRefresh: () => void;
}) {
  const { message } = props;
  const assistant = message.role === "assistant";
  if (!assistant) return <View style={[styles.messageRow, styles.messageRowUser]}><View style={[styles.messageBubble, styles.userBubble]}><Text style={styles.messageText}>{message.text}</Text></View>{message.timestamp ? <Text style={styles.messageTime}>{message.timestamp}</Text> : null}</View>;

  if (!message.blocks?.length) return <View style={styles.messageRow}><View style={[styles.messageBubble, styles.assistantBubble]}><Text style={styles.messageText}>{message.text}</Text></View>{message.timestamp ? <Text style={styles.messageTime}>{message.timestamp}</Text> : null}</View>;
  return <View style={styles.assistantMessageGroup}>{message.blocks.map((block, index) => <BlockRenderer key={`${message.id}-${block.type}-${index}`} block={block} messageCreatedAt={message.createdAt} activeRideId={props.activeRideId} cancelConfirm={props.cancelConfirm} cancelLoading={props.cancelLoading} onAction={props.onAction} onCancelRequest={props.onCancelRequest} onCancelConfirm={props.onCancelConfirm} onCancelDismiss={props.onCancelDismiss} onShare={props.onShare} onRefresh={props.onRefresh} />)}{message.timestamp ? <Text style={styles.messageTime}>{message.timestamp}</Text> : null}</View>;
}

function BlockRenderer(props: {
  block: AssistantBlock;
  messageCreatedAt?: string;
  activeRideId?: string;
  cancelConfirm: boolean;
  cancelLoading: boolean;
  onAction: (action: AssistantAction) => void;
  onCancelRequest: () => void;
  onCancelConfirm: () => void;
  onCancelDismiss: () => void;
  onShare: () => void;
  onRefresh: () => void;
}) {
  const { block } = props;
  switch (block.type) {
    case "text":
      return <View style={[styles.messageBubble, styles.assistantBubble]}><Text style={styles.messageText}>{block.text}</Text></View>;
    case "progress":
      return <ProgressCard block={block} />;
    case "route":
      return <RouteCard block={block} messageCreatedAt={props.messageCreatedAt} />;
    case "traffic":
      return <TrafficCard block={block} />;
    case "quote":
      return <QuoteCard block={block} messageCreatedAt={props.messageCreatedAt} />;
    case "booking_confirmation":
      return <BookingConfirmationCard block={block} messageCreatedAt={props.messageCreatedAt} />;
    case "live_ride":
      return <LiveRideCard block={block} isCurrent={block.telemetry.rideId === props.activeRideId} cancelConfirm={props.cancelConfirm} cancelLoading={props.cancelLoading} onCancelRequest={props.onCancelRequest} onCancelConfirm={props.onCancelConfirm} onCancelDismiss={props.onCancelDismiss} onShare={props.onShare} onRefresh={props.onRefresh} />;
    case "actions":
      return <ActionsCard actions={block.actions} onAction={props.onAction} />;
  }
}

function SourceBadge({ source, label, isDemo }: { source?: string; label?: string; isDemo?: boolean }) {
  return <View style={styles.sourceBadge}><View style={styles.sourceDot} /><Text style={styles.sourceText}>{sourceLabel(source, label, isDemo)}</Text></View>;
}

function ProgressCard({ block }: { block: Extract<AssistantBlock, { type: "progress" }> }) {
  const attention = block.status === "attention";
  return <View style={[styles.progressCard, attention && styles.progressAttention]}><View style={[styles.progressIcon, block.status === "complete" && styles.progressIconComplete]}><Text style={styles.progressIconText}>{block.status === "complete" ? "✓" : attention ? "!" : "•"}</Text></View><View style={styles.progressCopy}><Text style={styles.progressTitle}>{block.text}</Text><Text style={styles.progressStatus}>{attention ? "ACTION NEEDED" : block.status === "complete" ? "COMPLETE" : "IN PROGRESS"}</Text></View></View>;
}

function RouteCard({ block, messageCreatedAt }: { block: Extract<AssistantBlock, { type: "route" }>; messageCreatedAt?: string }) {
  return <View style={styles.routeCard}><View style={styles.cardTop}><View style={styles.cardHeading}><Text style={styles.sectionLabel}>ROUTE</Text><Text style={styles.cardTitle}>{block.title}</Text></View><SourceBadge source={block.source} label={block.label} isDemo={block.isDemo} /></View><RouteMapSurface coordinates={block.coordinates} pickup={block.pickup.coordinates} dropoff={block.dropoff.coordinates} pickupLabel={block.pickup.label || "Pickup"} dropoffLabel={block.dropoff.label || "Destination"} /><View style={styles.routeEndpoints}><View style={styles.endpoint}><View style={[styles.endpointDot, styles.endpointPickup]} /><View><Text style={styles.endpointLabel}>PICKUP</Text><Text style={styles.endpointText}>{block.pickup.label || block.pickup.address || "Current location"}</Text></View></View><View style={styles.endpoint}><View style={[styles.endpointDot, styles.endpointDropoff]} /><View><Text style={styles.endpointLabel}>DROP-OFF</Text><Text style={styles.endpointText}>{block.dropoff.label || block.dropoff.address || "Destination"}</Text></View></View></View><Text style={styles.updatedText}>Updated {formatUpdatedAt(block.lastUpdatedAt || messageCreatedAt)}</Text></View>;
}

function TrafficCard({ block }: { block: Extract<AssistantBlock, { type: "traffic" }> }) {
  const trafficColor = block.level === "heavy" ? colors.danger : block.level === "moderate" ? colors.accent : colors.success;
  return <View style={styles.trafficCard}><View style={styles.cardTop}><View><Text style={styles.sectionLabel}>TRAFFIC</Text><Text style={[styles.trafficLevel, { color: trafficColor }]}>{block.level.toUpperCase()}</Text></View><SourceBadge source={block.source} label={block.label} isDemo={block.isDemo} /></View><Text style={styles.trafficCopy}>{block.text}</Text><View style={styles.trafficFooter}><View style={styles.delayPill}><Text style={[styles.delayText, { color: trafficColor }]}>{block.delayMinutes === 0 ? "No added delay" : `+${block.delayMinutes} min delay`}</Text></View><Text style={styles.updatedText}>Updated {formatUpdatedAt(block.lastUpdatedAt)}</Text></View></View>;
}

function QuoteCard({ block, messageCreatedAt }: { block: Extract<AssistantBlock, { type: "quote" }>; messageCreatedAt?: string }) {
  const demo = block.isDemo || block.source === "demo" || /demo|mock/i.test(block.providerLabel);
  return <View style={styles.quoteCard}><View style={styles.cardTop}><View><Text style={styles.sectionLabel}>PROVIDER QUOTE</Text><Text style={styles.providerName}>{block.providerLabel || readableProvider(block.providerId)}</Text></View><SourceBadge source={demo ? "demo" : "provider"} label={demo ? "Demo data" : "Provider source"} isDemo={demo} /></View><View style={styles.quoteMetrics}><View style={styles.quoteMetric}><Text style={styles.quoteValue}>{money(block.amountMinor)}</Text><Text style={styles.quoteLabel}>estimated fare</Text></View><View style={styles.quoteMetric}><Text style={styles.quoteValue}>{block.estimatedDurationMinutes} min</Text><Text style={styles.quoteLabel}>ETA</Text></View><View style={styles.quoteMetric}><Text style={styles.quoteValue}>{block.quote.vehicleType.toUpperCase()}</Text><Text style={styles.quoteLabel}>vehicle</Text></View></View><Text style={styles.quoteCopy}>{block.humanActionRequired ? "Provider handoff required — I have not booked this ride." : "Balanced for your saved preference and inside your saved ride rules."}</Text><Text style={styles.updatedText}>Updated {formatUpdatedAt(block.lastUpdatedAt || block.quote.createdAt || messageCreatedAt)}</Text></View>;
}

function BookingConfirmationCard({ block, messageCreatedAt }: { block: Extract<AssistantBlock, { type: "booking_confirmation" }>; messageCreatedAt?: string }) {
  return <View style={styles.bookingCard}><View style={styles.bookingIcon}><Text style={styles.bookingIconText}>✓</Text></View><View style={styles.bookingCopy}><View style={styles.cardTop}><View><Text style={styles.sectionLabel}>BOOKING CONFIRMED</Text><Text style={styles.bookingTitle}>{readableProvider(block.providerId)}</Text></View><SourceBadge source={block.source} isDemo={block.isDemo} /></View><Text style={styles.bookingMessage}>{block.text}</Text><View style={styles.bookingMeta}><Text style={styles.bookingStatus}>{statusText(block.status).toUpperCase()}</Text><Text style={styles.updatedText}>Updated {formatUpdatedAt(block.lastUpdatedAt || messageCreatedAt)}</Text></View></View></View>;
}

function LiveRideCard(props: {
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
  const { block } = props;
  const { telemetry } = block;
  const terminal = isTerminalRideStatus(telemetry.status);
  const status = telemetry.status === "in_trip" ? "IN TRIP" : telemetry.status === "arrived" ? "ARRIVED" : telemetry.status === "driver_assigned" ? "DRIVER ASSIGNED" : telemetry.status === "completed" ? "COMPLETE" : telemetry.status === "cancelled" ? "CANCELLED" : "DRIVER ARRIVING";
  return <View style={[styles.liveCard, terminal && styles.liveCardTerminal]}><View style={styles.cardTop}><View><Text style={styles.sectionLabel}>LIVE RIDE</Text><Text style={styles.cardTitle}>{status}</Text></View><View style={styles.liveHeaderActions}><SourceBadge source={telemetry.source} label={telemetry.label} isDemo={telemetry.isDemo} />{props.isCurrent ? <Pressable accessibilityRole="button" onPress={props.onRefresh} style={styles.refreshButton}><Text style={styles.refreshText}>↻</Text></Pressable> : null}</View></View><RouteMapSurface coordinates={telemetry.routeCoordinates} pickup={telemetry.pickup} dropoff={telemetry.dropoff} driverLocation={telemetry.driverLocation} pickupLabel="Pickup" dropoffLabel="Destination" /><View style={styles.rideStatusRow}><View style={styles.statusIcon}><Text style={styles.statusIconText}>{terminal ? "✓" : "↗"}</Text></View><View style={styles.rideStatusCopy}><Text style={styles.rideStatus}>{block.text}</Text><Text style={styles.rideEta}>{telemetry.etaMinutes === 0 ? "At pickup or destination" : `ETA ${telemetry.etaMinutes} min`}</Text></View><View style={styles.pulse}><View style={[styles.pulseDot, terminal && styles.pulseDotTerminal]} /></View></View><View style={styles.driverGrid}><View><Text style={styles.detailLabel}>DRIVER</Text><Text style={styles.detailValue}>{telemetry.driverId || "Assigned"}</Text></View><View style={styles.vehicleColumn}><Text style={styles.detailLabel}>VEHICLE</Text><Text style={styles.detailValue}>{telemetry.vehicleId || "Vehicle assigned"}</Text></View><View><Text style={styles.detailLabel}>OTP</Text><Text style={styles.otpValue}>{getOtp(telemetry.rideId)}</Text></View></View>{props.isCurrent && !terminal && props.cancelConfirm ? <View style={styles.cancelPrompt}><Text style={styles.cancelTitle}>Cancel this ride?</Text><Text style={styles.cancelCopy}>Your driver may already be en route.</Text><View style={styles.buttonRow}><Pressable accessibilityRole="button" onPress={props.onCancelDismiss} style={styles.secondaryButton}><Text style={styles.secondaryButtonText}>Keep ride</Text></Pressable><Pressable accessibilityRole="button" disabled={props.cancelLoading} onPress={props.onCancelConfirm} style={styles.dangerButton}><Text style={styles.primaryButtonText}>{props.cancelLoading ? "Cancelling…" : "Yes, cancel"}</Text></Pressable></View></View> : props.isCurrent && !terminal ? <View style={styles.buttonRow}><Pressable accessibilityRole="button" onPress={props.onCancelRequest} style={styles.cancelButton}><Text style={styles.cancelButtonText}>Cancel ride</Text></Pressable><Pressable accessibilityRole="button" onPress={props.onShare} style={styles.shareButton}><Text style={styles.shareButtonText}>Share trip</Text></Pressable></View> : null}<Text style={styles.updatedText}>Updated {formatUpdatedAt(telemetry.lastUpdatedAt)}</Text></View>;
}

function ActionsCard({ actions, onAction }: { actions: AssistantAction[]; onAction: (action: AssistantAction) => void }) {
  return <View style={styles.actionsCard}>{actions.map((action) => <Pressable key={`${action.id}-${action.label}`} accessibilityRole="button" onPress={() => onAction(action)} style={[styles.actionButton, action.id === "confirm_booking" || action.id === "open_provider" ? styles.primaryButton : styles.secondaryButton]}><Text style={action.id === "confirm_booking" || action.id === "open_provider" ? styles.primaryButtonText : styles.secondaryButtonText}>{action.label}</Text>{action.id === "open_provider" ? <Text style={styles.primaryArrow}>↗</Text> : null}</Pressable>)}</View>;
}

function RouteMapSurface({ coordinates, pickup, dropoff, driverLocation, pickupLabel, dropoffLabel }: { coordinates: Coordinates[]; pickup?: Coordinates; dropoff?: Coordinates; driverLocation?: Coordinates; pickupLabel: string; dropoffLabel: string }) {
  const { width: windowWidth } = useWindowDimensions();
  const mapWidth = Math.max(240, Math.min(windowWidth - 72, 430));
  const height = 154;
  const allCoordinates = [...coordinates, ...(pickup ? [pickup] : []), ...(dropoff ? [dropoff] : []), ...(driverLocation ? [driverLocation] : [])];
  const lats = allCoordinates.map((coordinate) => coordinate.latitude);
  const lons = allCoordinates.map((coordinate) => coordinate.longitude);
  const minLat = Math.min(...lats);
  const maxLat = Math.max(...lats);
  const minLon = Math.min(...lons);
  const maxLon = Math.max(...lons);
  const latRange = Math.max(maxLat - minLat, 0.001);
  const lonRange = Math.max(maxLon - minLon, 0.001);
  const point = (coordinate: Coordinates) => ({ x: 18 + ((coordinate.longitude - minLon) / lonRange) * (mapWidth - 36), y: 18 + (1 - (coordinate.latitude - minLat) / latRange) * (height - 36) });
  const routePoints = coordinates.map(point);
  const pickupPoint = point(pickup ?? coordinates[0]);
  const dropoffPoint = point(dropoff ?? coordinates[coordinates.length - 1]);
  const driverPoint = driverLocation ? point(driverLocation) : undefined;
  return <View style={[styles.mapSurface, { width: mapWidth, height }]}><View style={styles.mapGridVerticalOne} /><View style={styles.mapGridVerticalTwo} /><View style={styles.mapGridHorizontalOne} /><View style={styles.mapGridHorizontalTwo} />{routePoints.slice(0, -1).map((from, index) => { const to = routePoints[index + 1]; const dx = to.x - from.x; const dy = to.y - from.y; const length = Math.sqrt(dx * dx + dy * dy); const angle = Math.atan2(dy, dx) * 180 / Math.PI; return <View key={`segment-${index}`} style={[styles.routeSegment, { left: from.x, top: from.y, width: length, transform: [{ rotate: `${angle}deg` }] }]} />; })}<View style={[styles.mapMarker, styles.pickupMarker, { left: pickupPoint.x - 6, top: pickupPoint.y - 6 }]} /><View style={[styles.mapMarker, styles.dropoffMarker, { left: dropoffPoint.x - 7, top: dropoffPoint.y - 7 }]} />{driverPoint ? <View style={[styles.driverMarker, { left: driverPoint.x - 9, top: driverPoint.y - 9 }]}><Text style={styles.driverMarkerText}>↗</Text></View> : null}<View style={[styles.mapLabel, { left: Math.max(8, Math.min(mapWidth - 90, pickupPoint.x - 8)), top: Math.max(5, pickupPoint.y - 27) }]}><Text style={styles.mapLabelText}>{pickupLabel}</Text></View><View style={[styles.mapLabel, { left: Math.max(8, Math.min(mapWidth - 105, dropoffPoint.x - 12)), top: Math.min(height - 24, dropoffPoint.y + 10) }]}><Text style={styles.mapLabelText}>{dropoffLabel}</Text></View><View style={styles.mapScale}><View style={styles.mapScaleLine} /><Text style={styles.mapScaleText}>DEMO ROUTE</Text></View></View>;
}

function QuickActions({ onAction }: { onAction: (value: string) => void }) { return <View style={styles.quickBlock}><Text style={styles.sectionLabel}>QUICK ACTIONS</Text><View style={styles.quickRow}><QuickAction label="Airport" icon="✈" onPress={() => onAction("Take me to the airport")} /><QuickAction label="Home" icon="⌂" onPress={() => onAction("Take me home")} /><QuickAction label="Saved places" icon="☆" onPress={() => onAction("Show my saved places")} /></View></View>; }
function QuickAction({ label, icon, onPress }: { label: string; icon: string; onPress: () => void }) { return <Pressable accessibilityRole="button" onPress={onPress} style={styles.quickAction}><Text style={styles.quickIcon}>{icon}</Text><Text style={styles.quickLabel}>{label}</Text></Pressable>; }

function Composer({ value, loading, onChange, onSend }: { value: string; loading: boolean; onChange: (value: string) => void; onSend: () => void }) { return <View style={styles.composerWrap}><View style={styles.composer}><TextInput accessibilityLabel="Message Lexar AI" value={value} onChangeText={onChange} onSubmitEditing={onSend} placeholder="Ask for a ride…" placeholderTextColor={colors.faint} style={styles.input} returnKeyType="send" editable={!loading} /><Pressable accessibilityRole="button" accessibilityLabel="Voice input placeholder" onPress={() => Alert.alert("Voice input", "Voice capture is coming next. Type your request for now.")} style={styles.voiceButton}><Text style={styles.voiceIcon}>◉</Text></Pressable><Pressable accessibilityRole="button" accessibilityLabel="Send message" disabled={!value.trim() || loading} onPress={onSend} style={[styles.sendButton, (!value.trim() || loading) && styles.sendButtonDisabled]}><Text style={styles.sendIcon}>↑</Text></Pressable></View><Text style={styles.composerHint}>Lexar AI compares, recommends, and books within your rules.</Text></View>; }

function ActivityView({ items }: { items: ActivityItem[] }) { return <ScrollView contentContainerStyle={styles.pageContent} showsVerticalScrollIndicator={false}><View style={styles.pageIntro}><Text style={styles.pageKicker}>HISTORY</Text><Text style={styles.pageTitle}>Activity</Text><Text style={styles.pageSubtitle}>A transparent record of decisions and ride updates. Internal planning stays out of the conversation.</Text></View>{items.length ? <View style={styles.historyList}>{items.map((item) => <View key={item.id} style={styles.historyItem}><View style={[styles.historyIcon, item.tone === "warning" && styles.historyIconWarning]}><Text style={styles.historyIconText}>{item.kind === "ride" ? "↗" : item.kind === "decision" ? "◇" : "·"}</Text></View><View style={styles.historyCopy}><Text style={styles.historyLabel}>{item.label}</Text><Text style={styles.historyDetail}>{item.detail}</Text><Text style={styles.historyTime}>{item.time}</Text></View><Text style={[styles.historyTone, item.tone === "warning" && styles.warningText]}>{item.tone === "success" ? "✓" : item.tone === "warning" ? "!" : ""}</Text></View>)}</View> : <View style={styles.emptyState}><Text style={styles.emptyIcon}>◇</Text><Text style={styles.emptyTitle}>No activity yet</Text><Text style={styles.emptyCopy}>Your ride decisions and bookings will appear here.</Text></View>}</ScrollView>; }

function RulesView({ rules, loading, onEdit }: { rules: Rules; loading: boolean; onEdit: () => void }) { return <ScrollView contentContainerStyle={styles.pageContent} showsVerticalScrollIndicator={false}><View style={styles.pageIntro}><Text style={styles.pageKicker}>CONTROL CENTER</Text><Text style={styles.pageTitle}>Your rules</Text><Text style={styles.pageSubtitle}>Lexar AI will always explain itself before it acts.</Text></View>{loading ? <View style={styles.loadingState}><ActivityIndicator color={colors.accent} /><Text style={styles.mutedText}>Loading your rules…</Text></View> : <><View style={styles.rulesHero}><Text style={styles.sectionLabel}>BOOKING MODE</Text><Text style={styles.rulesHeroTitle}>{rules.bookingMode === "ask_before_booking" ? "Ask before booking" : "Auto-book within my rules"}</Text><Text style={styles.rulesHeroCopy}>{rules.bookingMode === "ask_before_booking" ? "You’ll see the recommendation and confirm every ride." : "Lexar AI can book automatically when every limit is met."}</Text></View><View style={styles.ruleGrid}><RuleMetric label="Per-ride cap" value={money(rules.perRideCapMinor)} /><RuleMetric label="Daily cap" value={money(rules.dailySpendCapMinor)} /><RuleMetric label="Preference" value={rules.preference} /></View><View style={styles.providerSummary}><Text style={styles.sectionLabel}>PREFERRED PROVIDERS</Text><View style={styles.chipRow}>{rules.preferredProviders.map((provider) => <View key={provider} style={styles.providerChip}><Text style={styles.providerChipText}>{provider}</Text></View>)}</View></View><Pressable accessibilityRole="button" onPress={onEdit} style={styles.editRulesButton}><Text style={styles.editRulesText}>Edit rules</Text><Text style={styles.editRulesArrow}>→</Text></Pressable></>}</ScrollView>; }
function RuleMetric({ label, value }: { label: string; value: string }) { return <View style={styles.ruleMetric}><Text style={styles.detailLabel}>{label}</Text><Text style={styles.ruleMetricValue}>{value}</Text></View>; }

function RulesSheet({ visible, draft, saving, saved, onChange, onSave, onClose }: { visible: boolean; draft: Rules; saving: boolean; saved: boolean; onChange: (rules: Rules) => void; onSave: () => void; onClose: () => void }) {
  const set = <K extends keyof Rules>(key: K, value: Rules[K]) => onChange({ ...draft, [key]: value });
  const toggleProvider = (provider: string) => set("preferredProviders", draft.preferredProviders.includes(provider) ? draft.preferredProviders.filter((item) => item !== provider) : [...draft.preferredProviders, provider]);
  return <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}><View style={styles.modalBackdrop}><View style={styles.sheet}><View style={styles.sheetHandle} /><View style={styles.sheetHeader}><View><Text style={styles.pageKicker}>PERSONALIZATION</Text><Text style={styles.sheetTitle}>Ride rules</Text></View><Pressable accessibilityRole="button" onPress={onClose} style={styles.closeButton}><Text style={styles.closeText}>×</Text></Pressable></View><ScrollView contentContainerStyle={styles.sheetContent} keyboardShouldPersistTaps="handled"><Text style={styles.fieldLabel}>BOOKING MODE</Text><View style={styles.segmented}><Segment active={draft.bookingMode === "ask_before_booking"} label="Ask before booking" onPress={() => set("bookingMode", "ask_before_booking")} /><Segment active={draft.bookingMode === "auto_book_within_rules"} label="Auto-book within my rules" onPress={() => set("bookingMode", "auto_book_within_rules")} /></View><Text style={styles.fieldLabel}>SPEND LIMITS</Text><View style={styles.inputGrid}><LabeledInput label="Per-ride cap" value={String(draft.perRideCapMinor / 100)} prefix="₹" onChange={(value) => set("perRideCapMinor", Math.max(0, Math.round(Number(value.replace(/[^0-9.]/g, "")) * 100) || 0))} /><LabeledInput label="Daily cap" value={String(draft.dailySpendCapMinor / 100)} prefix="₹" onChange={(value) => set("dailySpendCapMinor", Math.max(0, Math.round(Number(value.replace(/[^0-9.]/g, "")) * 100) || 0))} /></View><Text style={styles.fieldLabel}>PREFERENCE</Text><View style={styles.chipRow}>{(["balanced", "cost", "speed"] as Preference[]).map((preference) => <Pressable key={preference} accessibilityRole="button" onPress={() => set("preference", preference)} style={[styles.preferenceChip, draft.preference === preference && styles.preferenceChipActive]}><Text style={[styles.preferenceText, draft.preference === preference && styles.preferenceTextActive]}>{preference === "balanced" ? "Balanced" : preference === "cost" ? "Lowest cost" : "Fastest"}</Text></Pressable>)}</View><Text style={styles.fieldLabel}>PREFERRED PROVIDERS</Text><View style={styles.chipRow}>{["Lyft", "Uber", "Ola", "Rapido"].map((provider) => <Pressable key={provider} accessibilityRole="button" onPress={() => toggleProvider(provider)} style={[styles.preferenceChip, draft.preferredProviders.includes(provider) && styles.preferenceChipActive]}><Text style={[styles.preferenceText, draft.preferredProviders.includes(provider) && styles.preferenceTextActive]}>{provider}</Text></Pressable>)}</View><Pressable accessibilityRole="button" disabled={saving} onPress={onSave} style={styles.saveRulesButton}><Text style={styles.saveRulesText}>{saving ? "Saving…" : saved ? "Saved ✓" : "Save rules"}</Text></Pressable></ScrollView></View></View></Modal>;
}
function Segment({ active, label, onPress }: { active: boolean; label: string; onPress: () => void }) { return <Pressable accessibilityRole="button" onPress={onPress} style={[styles.segment, active && styles.segmentActive]}><Text style={[styles.segmentText, active && styles.segmentTextActive]}>{label}</Text></Pressable>; }
function LabeledInput({ label, value, prefix, onChange }: { label: string; value: string; prefix: string; onChange: (value: string) => void }) { return <View style={styles.labeledInput}><Text style={styles.inputLabel}>{label}</Text><View style={styles.moneyInput}><Text style={styles.inputPrefix}>{prefix}</Text><TextInput accessibilityLabel={label} keyboardType="decimal-pad" value={value} onChangeText={onChange} style={styles.moneyTextInput} /></View></View>; }

function TabBar({ active, onChange }: { active: Tab; onChange: (tab: Tab) => void }) { return <View style={styles.tabBar}><TabButton active={active === "assistant"} label="Assistant" icon="✦" onPress={() => onChange("assistant")} /><TabButton active={active === "activity"} label="Activity" icon="◌" onPress={() => onChange("activity")} /><TabButton active={active === "rules"} label="Rules" icon="⚙" onPress={() => onChange("rules")} /></View>; }
function TabButton({ active, label, icon, onPress }: { active: boolean; label: string; icon: string; onPress: () => void }) { return <Pressable accessibilityRole="tab" accessibilityState={{ selected: active }} onPress={onPress} style={styles.tabButton}><Text style={[styles.tabIcon, active && styles.tabIconActive]}>{icon}</Text><Text style={[styles.tabLabel, active && styles.tabLabelActive]}>{label}</Text>{active ? <View style={styles.tabActiveLine} /> : null}</Pressable>; }

function liveUpdateBlocks(telemetry: RideLiveTelemetry): AssistantBlock[] {
  return [
    { type: "text", text: liveRideText(telemetry) },
    { type: "progress", status: isTerminalRideStatus(telemetry.status) ? "complete" : "in_progress", text: telemetry.status === "completed" ? "Ride complete" : `Ride status: ${statusText(telemetry.status)}` },
    { type: "traffic", level: telemetry.traffic.level, delayMinutes: telemetry.traffic.delayMinutes, text: trafficText(telemetry.traffic.level, telemetry.traffic.delayMinutes), source: telemetry.source, label: telemetry.label, isDemo: telemetry.isDemo, lastUpdatedAt: telemetry.lastUpdatedAt },
    { type: "live_ride", telemetry, text: liveRideText(telemetry) },
  ];
}

function trafficText(level: string, delayMinutes: number) {
  return delayMinutes === 0 ? `Traffic is ${level}; no additional delay is estimated.` : `Traffic is ${level}; about ${delayMinutes} minutes of delay are estimated.`;
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg }, root: { flex: 1, backgroundColor: colors.bg }, flex: { flex: 1 }, content: { flex: 1 },
  header: { minHeight: 78, paddingHorizontal: 20, paddingTop: 12, paddingBottom: 10, borderBottomWidth: 1, borderBottomColor: colors.border, flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  brandRow: { flexDirection: "row", alignItems: "center", gap: 10 }, brandMark: { width: 38, height: 38, borderRadius: 13, backgroundColor: colors.accent, alignItems: "center", justifyContent: "center" }, brandMarkText: { color: colors.bg, fontSize: 22 }, eyebrow: { color: colors.muted, fontSize: 9, fontWeight: "700", letterSpacing: 1.5 }, title: { color: colors.text, fontSize: 22, fontWeight: "800", letterSpacing: -0.5 }, headerActions: { flexDirection: "row", alignItems: "center", gap: 10 }, modePill: { borderWidth: 1, borderColor: colors.border, borderRadius: 20, paddingHorizontal: 9, minHeight: 28, flexDirection: "row", alignItems: "center", gap: 5 }, modePillDemo: { borderColor: colors.accent, backgroundColor: colors.accentSoft }, modeDot: { width: 6, height: 6, borderRadius: 4 }, modeDotLive: { backgroundColor: colors.success }, modeDotDemo: { backgroundColor: colors.accent }, modeDotConnecting: { backgroundColor: colors.blue }, modeText: { color: colors.muted, fontSize: 9, fontWeight: "800", letterSpacing: 0.7 }, iconButton: { minWidth: 44, minHeight: 44, alignItems: "center", justifyContent: "center" }, iconText: { color: colors.muted, fontSize: 18 },
  chatContent: { paddingHorizontal: 20, paddingTop: 22, paddingBottom: 18 }, todayRow: { flexDirection: "row", alignItems: "center", gap: 10, marginBottom: 18 }, todayLine: { height: 1, backgroundColor: colors.border, flex: 1 }, todayText: { color: colors.faint, fontSize: 9, fontWeight: "800", letterSpacing: 1.5 }, messageRow: { alignItems: "flex-start", marginBottom: 12 }, messageRowUser: { alignItems: "flex-end" }, assistantMessageGroup: { alignItems: "stretch", marginBottom: 12 }, messageBubble: { maxWidth: "88%", borderRadius: 18, paddingHorizontal: 15, paddingVertical: 12, marginBottom: 8 }, assistantBubble: { backgroundColor: colors.panel, borderTopLeftRadius: 5, borderWidth: 1, borderColor: colors.border, alignSelf: "flex-start" }, userBubble: { backgroundColor: colors.accent, borderTopRightRadius: 5 }, messageText: { color: colors.text, fontSize: 15, lineHeight: 21 }, messageTime: { color: colors.faint, fontSize: 10, marginTop: 1, marginHorizontal: 4, alignSelf: "flex-start" },
  progressCard: { flexDirection: "row", alignItems: "center", gap: 10, backgroundColor: colors.panelSoft, borderWidth: 1, borderColor: colors.border, borderRadius: 14, padding: 11, marginBottom: 9 }, progressAttention: { borderColor: colors.accent, backgroundColor: colors.accentSoft }, progressIcon: { width: 25, height: 25, borderRadius: 13, borderWidth: 1, borderColor: colors.accent, alignItems: "center", justifyContent: "center" }, progressIconComplete: { backgroundColor: "#314435", borderColor: colors.success }, progressIconText: { color: colors.accent, fontSize: 14, fontWeight: "900" }, progressCopy: { flex: 1 }, progressTitle: { color: colors.text, fontSize: 12, fontWeight: "800" }, progressStatus: { color: colors.faint, fontSize: 9, letterSpacing: 1, fontWeight: "800", marginTop: 3 },
  routeCard: { backgroundColor: colors.panelStrong, borderRadius: 18, borderWidth: 1, borderColor: colors.border, padding: 14, marginBottom: 9 }, cardTop: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start", gap: 10 }, cardHeading: { flex: 1 }, sectionLabel: { color: colors.faint, fontSize: 9, fontWeight: "800", letterSpacing: 1.4 }, cardTitle: { color: colors.text, fontSize: 18, fontWeight: "800", marginTop: 5, letterSpacing: -0.3 }, sourceBadge: { borderWidth: 1, borderColor: colors.border, borderRadius: 20, paddingHorizontal: 8, paddingVertical: 5, flexDirection: "row", alignItems: "center", gap: 5, maxWidth: 150 }, sourceDot: { width: 5, height: 5, borderRadius: 3, backgroundColor: colors.accent }, sourceText: { color: colors.muted, fontSize: 9, fontWeight: "800" }, mapSurface: { alignSelf: "center", marginTop: 13, borderRadius: 14, overflow: "hidden", backgroundColor: "#1b2929", borderWidth: 1, borderColor: "#34504d" }, mapGridVerticalOne: { position: "absolute", left: "25%", top: 0, bottom: 0, width: 1, backgroundColor: "rgba(155, 199, 164, 0.1)" }, mapGridVerticalTwo: { position: "absolute", left: "67%", top: 0, bottom: 0, width: 1, backgroundColor: "rgba(155, 199, 164, 0.1)" }, mapGridHorizontalOne: { position: "absolute", left: 0, right: 0, top: "33%", height: 1, backgroundColor: "rgba(155, 199, 164, 0.1)" }, mapGridHorizontalTwo: { position: "absolute", left: 0, right: 0, top: "70%", height: 1, backgroundColor: "rgba(155, 199, 164, 0.1)" }, routeSegment: { position: "absolute", height: 4, borderRadius: 2, backgroundColor: colors.accent }, mapMarker: { position: "absolute", borderRadius: 10, borderWidth: 2 }, pickupMarker: { width: 12, height: 12, backgroundColor: colors.success, borderColor: colors.bg }, dropoffMarker: { width: 14, height: 14, backgroundColor: colors.danger, borderColor: colors.bg }, driverMarker: { width: 18, height: 18, borderRadius: 10, backgroundColor: colors.accent, borderWidth: 2, borderColor: colors.bg, alignItems: "center", justifyContent: "center" }, driverMarkerText: { color: colors.bg, fontSize: 10, fontWeight: "900" }, mapLabel: { position: "absolute", backgroundColor: "rgba(23,22,20,0.83)", paddingHorizontal: 5, paddingVertical: 3, borderRadius: 5 }, mapLabelText: { color: colors.text, fontSize: 8, fontWeight: "700" }, mapScale: { position: "absolute", left: 9, bottom: 8, flexDirection: "row", alignItems: "center", gap: 5 }, mapScaleLine: { width: 20, height: 2, backgroundColor: colors.muted }, mapScaleText: { color: colors.faint, fontSize: 7, letterSpacing: 0.8, fontWeight: "800" }, routeEndpoints: { borderTopWidth: 1, borderTopColor: colors.border, marginTop: 13, paddingTop: 11, gap: 9 }, endpoint: { flexDirection: "row", alignItems: "center", gap: 9 }, endpointDot: { width: 8, height: 8, borderRadius: 4 }, endpointPickup: { backgroundColor: colors.success }, endpointDropoff: { backgroundColor: colors.danger }, endpointLabel: { color: colors.faint, fontSize: 8, fontWeight: "800", letterSpacing: 1 }, endpointText: { color: colors.text, fontSize: 12, marginTop: 2, fontWeight: "600" }, updatedText: { color: colors.faint, fontSize: 9, marginTop: 10 },
  trafficCard: { backgroundColor: colors.panel, borderWidth: 1, borderColor: colors.border, borderRadius: 16, padding: 14, marginBottom: 9 }, trafficLevel: { fontSize: 17, fontWeight: "900", marginTop: 5, letterSpacing: 0.8 }, trafficCopy: { color: colors.muted, fontSize: 12, lineHeight: 18, marginTop: 13 }, trafficFooter: { borderTopWidth: 1, borderTopColor: colors.border, paddingTop: 10, marginTop: 11, flexDirection: "row", justifyContent: "space-between", alignItems: "center" }, delayPill: { borderRadius: 12, backgroundColor: colors.panelSoft, paddingHorizontal: 8, paddingVertical: 5 }, delayText: { fontSize: 10, fontWeight: "800" },
  quoteCard: { backgroundColor: colors.panelStrong, borderRadius: 18, borderWidth: 1, borderColor: "#66513b", padding: 16, marginBottom: 9 }, providerName: { color: colors.text, fontSize: 18, fontWeight: "800", marginTop: 5 }, quoteMetrics: { flexDirection: "row", marginTop: 17, gap: 12 }, quoteMetric: { borderLeftWidth: 1, borderLeftColor: colors.border, paddingLeft: 12, minWidth: 70, flex: 1 }, quoteValue: { color: colors.text, fontSize: 16, fontWeight: "800" }, quoteLabel: { color: colors.faint, fontSize: 10, marginTop: 2 }, quoteCopy: { color: colors.muted, fontSize: 12, marginTop: 17, lineHeight: 18 }, actionsCard: { gap: 9, marginBottom: 9 }, buttonRow: { flexDirection: "row", gap: 9, marginTop: 14 }, actionButton: { minHeight: 46, paddingHorizontal: 13, borderRadius: 12, alignItems: "center", justifyContent: "center", flexDirection: "row", gap: 6 }, primaryButton: { flex: 1, backgroundColor: colors.accent }, primaryButtonText: { color: colors.bg, fontWeight: "800", fontSize: 13 }, primaryArrow: { color: colors.bg, fontSize: 17 }, secondaryButton: { flex: 1, borderWidth: 1, borderColor: colors.border }, secondaryButtonText: { color: colors.muted, fontSize: 12, fontWeight: "700" },
  bookingCard: { backgroundColor: "#202b24", borderRadius: 18, borderWidth: 1, borderColor: "#46634d", padding: 14, marginBottom: 9, flexDirection: "row", gap: 11 }, bookingIcon: { width: 31, height: 31, borderRadius: 16, backgroundColor: "#314435", alignItems: "center", justifyContent: "center" }, bookingIconText: { color: colors.success, fontWeight: "900" }, bookingCopy: { flex: 1 }, bookingTitle: { color: colors.text, fontSize: 17, fontWeight: "800", marginTop: 4 }, bookingMessage: { color: colors.muted, fontSize: 12, lineHeight: 18, marginTop: 10 }, bookingMeta: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginTop: 10 }, bookingStatus: { color: colors.success, fontSize: 9, fontWeight: "900", letterSpacing: 1 },
  liveCard: { backgroundColor: "#202b24", borderRadius: 18, borderWidth: 1, borderColor: "#46634d", padding: 16, marginBottom: 9 }, liveCardTerminal: { borderColor: colors.border, backgroundColor: colors.panel }, liveHeaderActions: { flexDirection: "row", alignItems: "center", gap: 5 }, refreshButton: { minWidth: 34, minHeight: 34, alignItems: "center", justifyContent: "center" }, refreshText: { color: colors.success, fontSize: 19, fontWeight: "700" }, rideStatusRow: { flexDirection: "row", alignItems: "center", marginTop: 14, gap: 10 }, statusIcon: { width: 38, height: 38, backgroundColor: "#314435", borderRadius: 12, alignItems: "center", justifyContent: "center" }, statusIconText: { color: colors.success, fontSize: 19 }, rideStatusCopy: { flex: 1 }, rideStatus: { color: colors.text, fontSize: 12, fontWeight: "800", lineHeight: 17 }, rideEta: { color: colors.muted, fontSize: 12, marginTop: 4 }, pulse: { width: 22, height: 22, borderRadius: 11, backgroundColor: "#314435", alignItems: "center", justifyContent: "center" }, pulseDot: { width: 7, height: 7, borderRadius: 5, backgroundColor: colors.success }, pulseDotTerminal: { backgroundColor: colors.faint }, driverGrid: { borderTopWidth: 1, borderBottomWidth: 1, borderColor: "#3b5140", marginTop: 14, paddingVertical: 13, flexDirection: "row", justifyContent: "space-between", gap: 8 }, vehicleColumn: { flex: 1 }, detailLabel: { color: colors.faint, fontSize: 9, fontWeight: "800", letterSpacing: 1.1 }, detailValue: { color: colors.text, fontSize: 12, fontWeight: "700", marginTop: 6 }, otpValue: { color: colors.accent, fontSize: 16, fontWeight: "900", letterSpacing: 2, marginTop: 4 }, cancelButton: { minHeight: 46, flex: 1, borderRadius: 12, borderWidth: 1, borderColor: "#81524b", alignItems: "center", justifyContent: "center" }, cancelButtonText: { color: colors.danger, fontSize: 12, fontWeight: "800" }, shareButton: { minHeight: 46, flex: 1, backgroundColor: "#314435", borderRadius: 12, alignItems: "center", justifyContent: "center" }, shareButtonText: { color: colors.success, fontSize: 12, fontWeight: "800" }, cancelPrompt: { marginTop: 14, padding: 12, borderRadius: 12, backgroundColor: "#332522", borderWidth: 1, borderColor: "#81524b" }, cancelTitle: { color: colors.text, fontSize: 13, fontWeight: "800" }, cancelCopy: { color: colors.muted, fontSize: 11, marginTop: 5 }, dangerButton: { minHeight: 42, flex: 1, borderRadius: 11, backgroundColor: colors.danger, alignItems: "center", justifyContent: "center" },
  quickBlock: { marginTop: 8 }, quickRow: { flexDirection: "row", gap: 9, marginTop: 10 }, quickAction: { minHeight: 72, flex: 1, borderRadius: 14, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.panel, justifyContent: "center", alignItems: "center", gap: 5 }, quickIcon: { color: colors.accent, fontSize: 18 }, quickLabel: { color: colors.muted, fontSize: 11, fontWeight: "700" }, typing: { flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 14 }, typingText: { color: colors.muted, fontSize: 12 }, composerWrap: { paddingHorizontal: 16, paddingTop: 10, paddingBottom: 9, borderTopWidth: 1, borderTopColor: colors.border, backgroundColor: colors.bg }, composer: { minHeight: 52, backgroundColor: colors.panel, borderRadius: 16, borderWidth: 1, borderColor: colors.border, flexDirection: "row", alignItems: "center", paddingLeft: 14, paddingRight: 5 }, input: { flex: 1, color: colors.text, fontSize: 15, minHeight: 44 }, voiceButton: { minWidth: 44, minHeight: 44, alignItems: "center", justifyContent: "center" }, voiceIcon: { color: colors.muted, fontSize: 17 }, sendButton: { width: 42, height: 42, borderRadius: 13, alignItems: "center", justifyContent: "center", backgroundColor: colors.accent }, sendButtonDisabled: { backgroundColor: colors.border }, sendIcon: { color: colors.bg, fontSize: 21, fontWeight: "800" }, composerHint: { color: colors.faint, fontSize: 10, marginTop: 7, marginLeft: 5 },
  tabBar: { height: 70, borderTopWidth: 1, borderTopColor: colors.border, backgroundColor: colors.bg, flexDirection: "row", justifyContent: "space-around" }, tabButton: { minWidth: 80, minHeight: 64, alignItems: "center", justifyContent: "center", position: "relative", gap: 3 }, tabIcon: { color: colors.faint, fontSize: 19 }, tabIconActive: { color: colors.accent }, tabLabel: { color: colors.faint, fontSize: 10, fontWeight: "700" }, tabLabelActive: { color: colors.text }, tabActiveLine: { position: "absolute", bottom: 0, height: 2, width: 30, backgroundColor: colors.accent, borderRadius: 2 }, errorBanner: { position: "absolute", left: 12, right: 12, bottom: 78, minHeight: 58, borderRadius: 14, paddingHorizontal: 10, paddingVertical: 8, backgroundColor: "#3a2521", borderWidth: 1, borderColor: "#87534b", flexDirection: "row", alignItems: "center", gap: 8 }, errorText: { width: 21, height: 21, borderRadius: 11, textAlign: "center", lineHeight: 21, backgroundColor: colors.danger, color: colors.bg, fontWeight: "900" }, errorCopy: { color: colors.text, fontSize: 11, flex: 1, lineHeight: 16 }, reconnectButton: { minHeight: 34, justifyContent: "center", paddingHorizontal: 5 }, reconnectText: { color: colors.accent, fontSize: 11, fontWeight: "800" }, errorDismissButton: { minWidth: 28, minHeight: 34, alignItems: "center", justifyContent: "center" }, errorDismiss: { color: colors.muted, fontSize: 20 },
  pageContent: { paddingHorizontal: 20, paddingTop: 26, paddingBottom: 36 }, pageIntro: { marginBottom: 22 }, pageKicker: { color: colors.accent, fontSize: 10, fontWeight: "800", letterSpacing: 1.7 }, pageTitle: { color: colors.text, fontSize: 31, fontWeight: "800", marginTop: 5, letterSpacing: -0.8 }, pageSubtitle: { color: colors.muted, fontSize: 14, lineHeight: 20, marginTop: 8, maxWidth: 340 }, historyList: { gap: 0 }, historyItem: { flexDirection: "row", gap: 12, paddingVertical: 15, borderTopWidth: 1, borderTopColor: colors.border }, historyIcon: { width: 36, height: 36, borderRadius: 12, backgroundColor: colors.accentSoft, alignItems: "center", justifyContent: "center" }, historyIconWarning: { backgroundColor: "#3a2521" }, historyIconText: { color: colors.accent, fontSize: 17 }, historyCopy: { flex: 1 }, historyLabel: { color: colors.text, fontSize: 14, fontWeight: "800" }, historyDetail: { color: colors.muted, fontSize: 12, marginTop: 4 }, historyTime: { color: colors.faint, fontSize: 10, marginTop: 6 }, historyTone: { color: colors.success, fontSize: 16, fontWeight: "800" }, warningText: { color: colors.danger }, emptyState: { alignItems: "center", paddingTop: 70 }, emptyIcon: { color: colors.accent, fontSize: 30 }, emptyTitle: { color: colors.text, fontSize: 16, fontWeight: "800", marginTop: 13 }, emptyCopy: { color: colors.muted, fontSize: 13, marginTop: 5, textAlign: "center" }, loadingState: { alignItems: "center", paddingTop: 50, gap: 13 }, mutedText: { color: colors.muted, fontSize: 13 }, rulesHero: { backgroundColor: colors.panelStrong, borderWidth: 1, borderColor: "#66513b", borderRadius: 17, padding: 17 }, rulesHeroTitle: { color: colors.text, fontSize: 18, fontWeight: "800", marginTop: 8 }, rulesHeroCopy: { color: colors.muted, fontSize: 13, lineHeight: 19, marginTop: 7 }, ruleGrid: { flexDirection: "row", gap: 9, marginTop: 12 }, ruleMetric: { flex: 1, backgroundColor: colors.panel, borderWidth: 1, borderColor: colors.border, borderRadius: 14, padding: 12, minHeight: 70 }, ruleMetricValue: { color: colors.text, fontSize: 14, fontWeight: "800", marginTop: 7 }, providerSummary: { marginTop: 18 }, chipRow: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 10 }, providerChip: { borderRadius: 20, backgroundColor: colors.accentSoft, paddingHorizontal: 12, paddingVertical: 7 }, providerChipText: { color: colors.accent, fontSize: 11, fontWeight: "700" }, editRulesButton: { minHeight: 50, borderRadius: 13, borderWidth: 1, borderColor: colors.border, marginTop: 19, alignItems: "center", justifyContent: "space-between", paddingHorizontal: 15, flexDirection: "row" }, editRulesText: { color: colors.text, fontSize: 13, fontWeight: "800" }, editRulesArrow: { color: colors.accent, fontSize: 20 },
  modalBackdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.62)", justifyContent: "flex-end" }, sheet: { maxHeight: "91%", backgroundColor: colors.panel, borderTopLeftRadius: 25, borderTopRightRadius: 25, borderTopWidth: 1, borderColor: colors.border }, sheetHandle: { width: 45, height: 4, borderRadius: 3, backgroundColor: colors.border, alignSelf: "center", marginTop: 10 }, sheetHeader: { paddingHorizontal: 20, paddingTop: 17, paddingBottom: 12, flexDirection: "row", alignItems: "center", justifyContent: "space-between" }, sheetTitle: { color: colors.text, fontSize: 25, fontWeight: "800", marginTop: 3 }, closeButton: { minWidth: 44, minHeight: 44, alignItems: "center", justifyContent: "center" }, closeText: { color: colors.muted, fontSize: 28, fontWeight: "300" }, sheetContent: { paddingHorizontal: 20, paddingBottom: 34 }, fieldLabel: { color: colors.faint, fontSize: 9, fontWeight: "800", letterSpacing: 1.3, marginTop: 16, marginBottom: 9 }, segmented: { gap: 8 }, segment: { minHeight: 47, borderRadius: 12, borderWidth: 1, borderColor: colors.border, paddingHorizontal: 13, justifyContent: "center" }, segmentActive: { borderColor: colors.accent, backgroundColor: colors.accentSoft }, segmentText: { color: colors.muted, fontSize: 13, fontWeight: "700" }, segmentTextActive: { color: colors.accent }, inputGrid: { flexDirection: "row", gap: 10 }, labeledInput: { flex: 1 }, inputLabel: { color: colors.muted, fontSize: 11, marginBottom: 6 }, moneyInput: { minHeight: 47, borderRadius: 12, borderWidth: 1, borderColor: colors.border, flexDirection: "row", alignItems: "center", paddingHorizontal: 12 }, inputPrefix: { color: colors.faint, fontSize: 15, marginRight: 4 }, moneyTextInput: { color: colors.text, fontSize: 15, flex: 1, minHeight: 44 }, preferenceChip: { minHeight: 44, borderRadius: 22, borderWidth: 1, borderColor: colors.border, paddingHorizontal: 14, alignItems: "center", justifyContent: "center" }, preferenceChipActive: { backgroundColor: colors.accentSoft, borderColor: colors.accent }, preferenceText: { color: colors.muted, fontSize: 12, fontWeight: "700" }, preferenceTextActive: { color: colors.accent }, saveRulesButton: { minHeight: 50, borderRadius: 13, backgroundColor: colors.accent, alignItems: "center", justifyContent: "center", marginTop: 28 }, saveRulesText: { color: colors.bg, fontSize: 13, fontWeight: "900" },
});
