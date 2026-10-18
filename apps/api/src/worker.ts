import { Worker, type Job } from "bullmq";
import { Redis } from "ioredis";
import { isTerminalRideStatus } from "@rideagent/shared";
import { buildApp } from "./app.js";
import { createStoreFromEnv } from "./store-factory.js";
import { PrismaRepository } from "./prisma-store.js";
import { trackingJobPayloadSchema, TRACKING_QUEUE_NAME, type TrackingJobPayload } from "./jobs.js";
import type { RideRepository } from "./types.js";
import type { TrackingService } from "./tracking.js";

export interface TrackingProcessorDependencies {
  tracking: TrackingService;
  store: RideRepository;
}

export interface TrackingJobLike {
  data: unknown;
}

export function createTrackingProcessor({ tracking, store }: TrackingProcessorDependencies) {
  return async (job: TrackingJobLike) => {
    const payload = trackingJobPayloadSchema.parse(job.data);
    const ride = store.getRide(payload.rideId);
    if (!ride || ride.riderId !== payload.userId || isTerminalRideStatus(ride.status)) {
      return { skipped: true, rideId: payload.rideId };
    }

    return tracking.track(payload.rideId, payload.userId);
  };
}

export interface StartWorkerOptions extends TrackingProcessorDependencies {
  redisUrl?: string;
  queueName?: string;
  concurrency?: number;
  connection?: Redis;
}

export function startWorker(options: StartWorkerOptions): Worker<TrackingJobPayload> {
  const redisUrl = options.redisUrl?.trim();
  if (!redisUrl && !options.connection) throw new Error("REDIS_URL is required to start the tracking worker.");

  const connection = options.connection ?? new Redis(redisUrl as string, { maxRetriesPerRequest: null });
  const processor = createTrackingProcessor(options);
  const worker = new Worker<TrackingJobPayload>(
    options.queueName ?? TRACKING_QUEUE_NAME,
    async (job: Job<TrackingJobPayload>) => processor(job),
    { connection, concurrency: options.concurrency ?? 1 },
  );

  if (!options.connection) {
    worker.once("closed", () => {
      void connection.quit();
    });
  }
  return worker;
}

export async function runWorkerFromEnv(): Promise<Worker<TrackingJobPayload> | undefined> {
  const redisUrl = process.env.REDIS_URL?.trim();
  if (!redisUrl) {
    console.warn("REDIS_URL is not configured; tracking worker is disabled.");
    return undefined;
  }

  const store = createStoreFromEnv();
  if (store instanceof PrismaRepository) await store.initialize();

  const app = buildApp({ store });
  const worker = startWorker({ tracking: app.demo.tracking, store, redisUrl });
  worker.on("error", (error) => console.error("RideAgent tracking worker error", error));

  const shutdown = async () => {
    await worker.close();
    if (store instanceof PrismaRepository) await store.flush();
  };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());

  return worker;
}

if (process.argv[1] && process.argv[1].endsWith("worker.ts")) {
  await runWorkerFromEnv();
}
