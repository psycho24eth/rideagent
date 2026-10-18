import { PrismaClient } from "@prisma/client";
import { InMemoryStore } from "./store.js";
import { PrismaRepository } from "./prisma-store.js";
import type { RideRepository } from "./types.js";

export interface StoreFactoryOptions {
  env?: NodeJS.ProcessEnv;
  prismaClient?: PrismaClient;
}

/**
 * Select the runtime repository without connecting to a database during
 * construction. The API entry point explicitly hydrates a Prisma repository
 * before serving requests; tests can select either branch without a live DB.
 */
export function createStoreFromEnv(options: StoreFactoryOptions = {}): RideRepository {
  const env = options.env ?? process.env;
  // Demo is the safe default; production persistence is opt-in.
  const demoMode = env.DEMO_MODE?.trim().toLowerCase() !== "false";

  if (demoMode || !env.DATABASE_URL) return new InMemoryStore();

  const prisma = options.prismaClient ?? new PrismaClient({
    datasources: { db: { url: env.DATABASE_URL } },
  });
  return new PrismaRepository(prisma);
}
