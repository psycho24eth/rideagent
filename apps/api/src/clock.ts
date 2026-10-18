import type { Clock } from "./types.js";

export const systemClock: Clock = { now: () => new Date().toISOString() };
