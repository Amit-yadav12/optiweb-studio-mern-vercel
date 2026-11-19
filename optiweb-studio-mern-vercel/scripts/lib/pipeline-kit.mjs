/**
 * Shared setup for tests of the direct-upload pipeline.
 *
 * Storage is the local disk driver in a temporary directory. The database is
 * a real MongoDB server when MONGODB_URI is set, and the in-memory stand-in
 * otherwise. With the stand-in, a passing run shows that the application logic
 * is right; only a run against MongoDB shows that MongoDB accepts the queries.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { crc32 } from "node:zlib";
import sharp from "sharp";

/** A valid PNG of exactly `bytes` bytes: a small image padded with an ancillary chunk that decoders skip. */
export async function pngOfSize(bytes, { width = 64, height = 48, color = { r: 30, g: 120, b: 200 } } = {}) {
  const base = await sharp({ create: { width, height, channels: 3, background: color } }).png().toBuffer();
  const padding = bytes - base.length - 12;
  if (padding < 0) throw new Error(`pngOfSize: ${bytes} bytes is smaller than the image itself (${base.length + 12})`);
  const type = Buffer.from("prVt", "latin1");
  const data = Buffer.alloc(padding, 0x61);
  const chunk = Buffer.alloc(12 + padding);
  chunk.writeUInt32BE(padding, 0);
  type.copy(chunk, 4);
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(Buffer.concat([type, data])) >>> 0, 8 + padding);
  // The IEND chunk is the last 12 bytes of every PNG.
  return Buffer.concat([base.subarray(0, base.length - 12), chunk, base.subarray(base.length - 12)]);
}

/** A photo-like JPEG: a colour gradient with noise, so that it does not compress to nothing. */
export async function photoJpeg(width, height, { quality = 82, sigma = 14 } = {}) {
  const gradient = await sharp({ create: { width: 32, height: 32, channels: 3, background: { r: 40, g: 110, b: 200 } } })
    .composite([{ input: Buffer.from('<svg width="32" height="32"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#f4c542"/><stop offset="1" stop-color="#1b3a6b"/></linearGradient></defs><rect width="32" height="32" fill="url(#g)"/></svg>') }])
    .resize(width, height, { kernel: "cubic" })
    .raw()
    .toBuffer();
  return sharp({ create: { width, height, channels: 3, noise: { type: "gaussian", mean: 128, sigma } } })
    .composite([{ input: gradient, raw: { width, height, channels: 3 }, blend: "soft-light" }])
    .jpeg({ quality })
    .toBuffer();
}

/** A PNG with real transparency: an opaque disc on a fully transparent background. */
export async function transparentPng(size = 96) {
  const svg = `<svg width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg"><circle cx="${size / 2}" cy="${size / 2}" r="${size / 3}" fill="#e2452f"/></svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

/** An animated GIF with `frames` frames. */
export async function animatedGif(frames = 3, size = 40) {
  const colors = [{ r: 220, g: 40, b: 40 }, { r: 40, g: 180, b: 60 }, { r: 40, g: 80, b: 220 }, { r: 230, g: 200, b: 40 }];
  const images = await Promise.all(Array.from({ length: frames }, (_, index) => sharp({ create: { width: size, height: size, channels: 3, background: colors[index % colors.length] } }).png().toBuffer()));
  return sharp(images, { join: { animated: true } }).gif({ delay: 80 }).toBuffer();
}

/**
 * Points the server at a temporary storage directory and at the right
 * database, and returns handles for the test. Call it before importing the app.
 */
export async function preparePipelineEnvironment(overrides = {}) {
  const storageDir = await fs.mkdtemp(path.join(os.tmpdir(), "optiweb-objects-"));
  Object.assign(process.env, {
    OW_STORAGE_DRIVER: "local",
    OW_LOCAL_STORAGE_DIR: storageDir,
    OW_JOB_TRIGGER: "manual",
    ...overrides,
  });
  delete process.env.BLOB_READ_WRITE_TOKEN;

  const uri = process.env.MONGODB_URI ?? process.env.MONGO_URL;
  let database = "in-memory stand-in (application logic only; not MongoDB)";
  let cleanupDatabase = async () => {};
  const { setPipelineStoreForTests, pipelineStore } = await import("../../src/server/pipeline/store.ts");
  if (uri) {
    // Destructive: the test drops its database. Refuse anything that is not a throwaway database.
    const name = /^mongodb(?:\+srv)?:\/\/[^/]+\/([^?]*)/.exec(uri)?.[1] ?? "";
    if (!/^optiweb_(ci|test)_/.test(name)) {
      console.error(`Refusing to run: the database name must start with optiweb_ci_ or optiweb_test_ (got "${name || "none"}").`);
      process.exit(2);
    }
    database = `MongoDB (${name})`;
    const { connectMongo, disconnectMongo } = await import("../../src/server/db/mongo.ts");
    cleanupDatabase = async () => {
      const client = await connectMongo();
      await client.connection.db.dropDatabase();
      await disconnectMongo();
    };
  } else {
    const { createMemoryPipelineStore } = await import("./memory-pipeline-store.mjs");
    setPipelineStoreForTests(createMemoryPipelineStore());
  }
  const store = await pipelineStore();
  /** Whether a storage object exists on disk. */
  const objectExists = (objectPath) => fs.stat(path.join(storageDir, objectPath)).then((info) => info.isFile(), () => false);
  /** Every stored object, as paths relative to the storage root (metadata files excluded). */
  async function listObjects() {
    const found = [];
    async function walk(dir) {
      for (const entry of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) await walk(full);
        else if (!entry.name.endsWith(".meta.json")) found.push(path.relative(storageDir, full));
      }
    }
    await walk(storageDir);
    return found.sort();
  }
  return {
    usingMongo: Boolean(uri),
    database,
    store,
    storageDir,
    objectExists,
    listObjects,
    async close() {
      await cleanupDatabase();
      await fs.rm(storageDir, { recursive: true, force: true });
    },
  };
}
