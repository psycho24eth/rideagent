import { createServer } from "./app.js";
import { createTrackingQueueFromEnv } from "./jobs.js";
import { PrismaRepository } from "./prisma-store.js";
import { createStoreFromEnv } from "./store-factory.js";

const port = Number(process.env.PORT ?? 3000);
const store = createStoreFromEnv();
if (store instanceof PrismaRepository) await store.initialize();
const trackingQueue = createTrackingQueueFromEnv({ store });
const app = await createServer({ store, trackingQueue });
await app.listen({ port, host: "0.0.0.0" });
