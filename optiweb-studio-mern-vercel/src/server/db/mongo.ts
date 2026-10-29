import mongoose from "mongoose";

type Cache = { connection: typeof mongoose | null; promise: Promise<typeof mongoose> | null };
const globalCache = globalThis as typeof globalThis & { __optiwebMongo?: Cache };
const cache: Cache = (globalCache.__optiwebMongo ??= { connection: null, promise: null });

/** Reuse connections across warm serverless invocations. */
export async function connectMongo(): Promise<typeof mongoose> {
  const uri = process.env.MONGODB_URI ?? process.env.MONGO_URL;
  if (!uri) throw new Error("MONGODB_URI is not configured.");
  if (cache.connection?.connection.readyState === 1) return cache.connection;
  if (!cache.promise) {
    cache.promise = mongoose.connect(uri, {
      maxPoolSize: Number(process.env.OW_MONGO_POOL_MAX ?? 3),
      serverSelectionTimeoutMS: Number(process.env.OW_MONGO_TIMEOUT_MS ?? 5000),
      autoIndex: true,
    });
  }
  try {
    cache.connection = await cache.promise;
    return cache.connection;
  } catch (error) {
    cache.promise = null;
    throw error;
  }
}

export async function probeMongo(): Promise<{ connected: boolean; latencyMs: number | null; error?: string }> {
  const started = Date.now();
  try {
    await connectMongo();
    await mongoose.connection.db?.admin().ping();
    return { connected: true, latencyMs: Date.now() - started };
  } catch (error) {
    return { connected: false, latencyMs: null, error: (process.env.MONGODB_URI ?? process.env.MONGO_URL) ? "MongoDB connection failed." : "MONGODB_URI is not configured." };
  }
}
