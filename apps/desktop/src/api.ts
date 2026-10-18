import type { ChatResponse, LiveRideResponse, Ride, Rules, AssistantBlock } from "./types";

const configuredBaseUrl = (import.meta.env.VITE_API_BASE_URL as string | undefined)?.trim();
export const API_BASE_URL = (configuredBaseUrl || "/api").replace(/\/$/, "");
export const DEMO_USER = "demo-user";

export class ApiError extends Error {
  status: number;
  code?: string;

  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

type ApiEnvelope = {
  error?: string;
  message?: string;
  assistantMessage?: string;
};

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}${path}`, {
      ...init,
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "X-Demo-User": DEMO_USER,
        ...(init.headers ?? {}),
      },
    });
  } catch (error) {
    throw new ApiError(error instanceof Error ? error.message : "Network request failed", 0, "network_error");
  }

  const body = (await response.json().catch(() => null)) as (T & ApiEnvelope) | null;
  if (!response.ok) {
    throw new ApiError(
      body?.message || body?.assistantMessage || body?.error || `Request failed (${response.status})`,
      response.status,
      body?.error,
    );
  }
  return body as T;
}

export const api = {
  getRules: () => request<Rules>("/v1/rules"),
  saveRules: (rules: Omit<Rules, "userId" | "updatedAt">) =>
    request<Rules>("/v1/rules", { method: "PUT", body: JSON.stringify(rules) }),
  chat: (message: string) => request<ChatResponse>("/v1/chat", { method: "POST", body: JSON.stringify({ message }) }),
  getRide: (id: string) => request<Ride>(`/v1/rides/${encodeURIComponent(id)}`),
  getLive: (id: string) => request<LiveRideResponse>(`/v1/rides/${encodeURIComponent(id)}/live`),
  track: (id: string) => request<{ assistantMessage?: string; blocks?: AssistantBlock[]; ride: Ride }>(`/v1/rides/${encodeURIComponent(id)}/track`),
  cancelRide: (id: string, reason = "Cancelled from the RideAgent desktop preview") =>
    request<{ ride: Ride }>(`/v1/rides/${encodeURIComponent(id)}/cancel`, {
      method: "POST",
      body: JSON.stringify({ reason }),
    }),
};
