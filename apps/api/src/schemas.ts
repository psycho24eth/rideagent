import { z } from "zod";
import { locationSchema, quoteSchema, RIDE_STATUSES, VEHICLE_TYPES, userRulesSchema } from "@rideagent/shared";
import { BOOKING_MODES } from "./types.js";

export const demoRulesSchema = userRulesSchema.extend({
  bookingMode: z.enum(BOOKING_MODES),
});

export const rulesPayloadSchema = z.object({
  perRideCapMinor: z.number().int().nonnegative(),
  dailySpendCapMinor: z.number().int().nonnegative(),
  preferredProviders: z.array(z.string().trim().min(1)),
  preferredVehicleType: z.enum(VEHICLE_TYPES).optional(),
  preference: z.enum(["cost", "speed", "balanced"]),
  bookingMode: z.enum(BOOKING_MODES),
});

export const regionLocationSchema = z.intersection(
  locationSchema,
  z.object({
    country: z.string().trim().min(1).optional(),
    city: z.string().trim().min(1).optional(),
  }),
);

export const chatPayloadSchema = z.object({
  message: z.string().trim().min(1).max(2_000),
  pickup: regionLocationSchema.optional(),
});

export const plannerActionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("request_ride"), destination: z.object({ label: z.string().trim().min(1).max(200) }) }),
  z.object({ kind: z.literal("confirm") }),
  z.object({ kind: z.literal("reject") }),
  z.object({ kind: z.literal("unclear") }),
]);

export const cancelPayloadSchema = z.object({ reason: z.string().trim().min(1).max(300).optional() }).default({});

export const providerBookedRideSchema = z.object({
  providerRideId: z.string().trim().min(1),
  quoteId: z.string().trim().min(1),
  requestId: z.string().trim().min(1),
  status: z.object({
    providerRideId: z.string().trim().min(1),
    status: z.enum(RIDE_STATUSES),
    updatedAt: z.string().datetime({ offset: true }),
    driverId: z.string().trim().min(1).optional(),
    vehicleId: z.string().trim().min(1).optional(),
  }),
  bookedAt: z.string().datetime({ offset: true }),
});

export const providerStatusSchema = providerBookedRideSchema.shape.status;

export const validatedQuoteSchema = quoteSchema;

export type RulesPayload = z.infer<typeof rulesPayloadSchema>;
export type ChatPayload = z.infer<typeof chatPayloadSchema>;
