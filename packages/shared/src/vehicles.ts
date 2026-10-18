export const VEHICLE_TYPES = ["bike", "auto", "cab"] as const;
export type VehicleType = (typeof VEHICLE_TYPES)[number];

export interface Vehicle {
  id: string;
  type: VehicleType;
  make?: string;
  model?: string;
  color?: string;
  licensePlate?: string;
  capacity: number;
}
