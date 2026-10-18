import { describe, expect, it } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { InMemoryStore } from "./store.js";
import { PrismaRepository } from "./prisma-store.js";
import { createStoreFromEnv } from "./store-factory.js";

describe("createStoreFromEnv", () => {
  it("keeps the in-memory store when demo mode is enabled", () => {
    const store = createStoreFromEnv({
      env: { DEMO_MODE: "true", DATABASE_URL: "postgresql://unused" },
      prismaClient: {} as PrismaClient,
    });

    expect(store).toBeInstanceOf(InMemoryStore);
  });

  it("selects Prisma without opening a database connection during construction", () => {
    const store = createStoreFromEnv({
      env: { DEMO_MODE: "false", DATABASE_URL: "postgresql://unused" },
      prismaClient: {} as PrismaClient,
    });

    expect(store).toBeInstanceOf(PrismaRepository);
  });

  it("falls back to the demo store when persistence is not configured", () => {
    const store = createStoreFromEnv({ env: { DEMO_MODE: "false" }, prismaClient: {} as PrismaClient });

    expect(store).toBeInstanceOf(InMemoryStore);
  });
});
