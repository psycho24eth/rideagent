import { Queue, type JobsOptions } from "bullmq";
import { Redis } from "ioredis";
import { isTerminalRideStatus } from "@rideagent/shared";
import { z } from "zod";
import type { RideRepository, TrackingJobQueue } from "./types.js";

export const TRACKING_QUEUE_NAME = "rideagent-tracking";

export const trackingJobPayloadSchema = z
  .object({
    rideId: z.string().trim().min(1),
    userId: z.string().trim().min(1),
  })
  .strict();

export type TrackingJobPayload = z.infer<typeof trackingJobPayloadSchema>;

export interface TrackingQueueClient {
  add(name: string, data: TrackingJobPayload, options: JobsOptions): Promise<unknown>;
  close(): Promise<void>;
}

export interface BullMQTrackingQueueOptions {
  redisUrl: string;
  store: RideRepository;
  queueName?: string;
  queue?: TrackingQueueClient;
}

export class BullMQTrackingQueue implements TrackingJobQueue {
  private readonly queue: TrackingQueueClient;
  private readonly connection?: Redis;

  constructor(options: BullMQTrackingQueueOptions) {
    const redisUrl = options.redisUrl.trim();
    if (!redisUrl) throw new Error("REDIS_URL is required to create the tracking queue.");

    if (options.queue) {
      this.queue = options.queue;
    } else {
      this.connection = new Redis(redisUrl, { maxRetriesPerRequest: null });
      this.queue = new Queue<TrackingJobPayload>(options.queueName ?? TRACKING_QUEUE_NAME, {
        connection: this.connection,
      });
    }

    this.store = options.store;
  }

  private readonly store: RideRepository;

  async enqueueTracking(rideId: string, userId: string): Promise<unknown> {
    const payload = trackingJobPayloadSchema.parse({ rideId, userId });
    const ride = this.store.getRide(payload.rideId);
    if (!ride || ride.riderId !== payload.userId || isTerminalRideStatus(ride.status)) return undefined;

    return this.queue.add("track-ride", payload, {
      jobId: `track:${payload.rideId}:${Date.now()}`,
      attempts: 5,
      backoff: { type: "exponential", delay: 1_000 },
      removeOnComplete: { age: 3_600, count: 100 },
      removeOnFail: { age: 86_400, count: 1_000 },
    });
  }

  async close(): Promise<void> {
    await this.queue.close();
    if (this.connection) await this.connection.quit();
  }
}

export interface CreateTrackingQueueOptions {
  env?: NodeJS.ProcessEnv;
  store: RideRepository;
}

export function createTrackingQueueFromEnv(options: CreateTrackingQueueOptions): BullMQTrackingQueue | undefined {
  const redisUrl = (options.env ?? process.env).REDIS_URL?.trim();
  if (!redisUrl) return undefined;
  return new BullMQTrackingQueue({ redisUrl, store: options.store });
}
