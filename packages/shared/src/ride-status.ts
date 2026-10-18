export const RIDE_STATUSES = [
  "requested",
  "quoted",
  "booked",
  "driver_assigned",
  "arriving",
  "arrived",
  "in_trip",
  "completed",
  "cancelled",
  "failed",
] as const;

export type RideStatus = (typeof RIDE_STATUSES)[number];

export const TERMINAL_RIDE_STATUSES = ["completed", "cancelled", "failed"] as const;
export type TerminalRideStatus = (typeof TERMINAL_RIDE_STATUSES)[number];

export function isTerminalRideStatus(status: RideStatus): status is TerminalRideStatus {
  return TERMINAL_RIDE_STATUSES.includes(status as TerminalRideStatus);
}
