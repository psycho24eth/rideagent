export interface Coordinates {
  latitude: number;
  longitude: number;
}

export interface Location {
  label?: string;
  address?: string;
  coordinates?: Coordinates;
}

export type RideEndpoint = "pickup" | "dropoff";
