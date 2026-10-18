import { z } from "zod";

import { RIDE_STATUSES } from "./ride-status.js";
import { VEHICLE_TYPES } from "./vehicles.js";

export const coordinatesSchema = z.object({
  latitude: z.number().finite().min(-90).max(90),
  longitude: z.number().finite().min(-180).max(180),
});

export const locationSchema = z
  .object({
    label: z.string().trim().min(1).optional(),
    address: z.string().trim().min(1).optional(),
    coordinates: coordinatesSchema.optional(),
  })
  .refine(
    (location) => Boolean(location.label || location.address || location.coordinates),
    "A location needs a label, address, or coordinates",
  );

export const rideRequestSchema = z.object({
  riderId: z.string().trim().min(1),
  pickup: locationSchema,
  dropoff: locationSchema,
  vehicleType: z.enum(VEHICLE_TYPES).optional(),
  requestedAt: z.string().datetime({ offset: true }),
});

export const quoteSchema = z.object({
  id: z.string().trim().min(1),
  rideRequestId: z.string().trim().min(1),
  providerId: z.string().trim().min(1),
  vehicleType: z.enum(VEHICLE_TYPES),
  amountMinor: z.number().int().nonnegative(),
  currency: z.string().trim().length(3).toUpperCase(),
  estimatedDistanceMeters: z.number().finite().nonnegative(),
  estimatedDurationSeconds: z.number().int().nonnegative(),
  expiresAt: z.string().datetime({ offset: true }),
  createdAt: z.string().datetime({ offset: true }),
  deepLink: z.string().url().optional(),
});

export const userRulesSchema = z.object({
  userId: z.string().trim().min(1),
  perRideCapMinor: z.number().int().nonnegative(),
  dailySpendCapMinor: z.number().int().nonnegative(),
  preferredProviders: z.array(z.string().trim().min(1)),
  preferredVehicleType: z.enum(VEHICLE_TYPES).optional(),
  preference: z.enum(["cost", "speed", "balanced"]),
  updatedAt: z.string().datetime({ offset: true }),
});

export const rideTransitionSchema = z.object({
  rideId: z.string().trim().min(1),
  to: z.enum(RIDE_STATUSES),
  eventId: z.string().trim().min(1),
  occurredAt: z.string().datetime({ offset: true }),
  actor: z
    .object({
      id: z.string().trim().min(1),
      role: z.enum(["rider", "driver", "operator", "system"]),
    })
    .optional(),
  reason: z.string().trim().min(1).optional(),
});

export type RideRequestInput = z.infer<typeof rideRequestSchema>;
export type QuoteInput = z.infer<typeof quoteSchema>;
export type UserRulesInput = z.infer<typeof userRulesSchema>;
export type RideTransitionInput = z.infer<typeof rideTransitionSchema>;
