export const USER_ROLES = ["rider", "driver", "operator"] as const;
export type UserRole = (typeof USER_ROLES)[number];

export const USER_STATUSES = ["active", "suspended", "deactivated"] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

export interface User {
  id: string;
  role: UserRole;
  status: UserStatus;
  displayName?: string;
}

export type RidePreference = "cost" | "speed" | "balanced";

export interface UserRules {
  userId: string;
  perRideCapMinor: number;
  dailySpendCapMinor: number;
  preferredProviders: readonly string[];
  preferredVehicleType?: import("./vehicles.js").VehicleType;
  preference: RidePreference;
  updatedAt: string;
}

export function canRequestRide(user: Pick<User, "role" | "status">): boolean {
  return user.role === "rider" && user.status === "active";
}

export function canAcceptRide(user: Pick<User, "role" | "status">): boolean {
  return user.role === "driver" && user.status === "active";
}

export function canOperateRides(user: Pick<User, "role" | "status">): boolean {
  return user.role === "operator" && user.status === "active";
}
