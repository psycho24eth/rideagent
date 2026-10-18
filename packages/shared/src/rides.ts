import type { Location } from "./locations.js";
import type { Quote } from "./quotes.js";
import type { RideStatus } from "./ride-status.js";
import type { VehicleType } from "./vehicles.js";

export interface RideRequest {
  riderId: string;
  pickup: Location;
  dropoff: Location;
  vehicleType?: VehicleType;
  requestedAt: string;
}

export interface Ride {
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
}
