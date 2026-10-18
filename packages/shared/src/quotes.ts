import type { VehicleType } from "./vehicles.js";

export interface Quote {
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
}
