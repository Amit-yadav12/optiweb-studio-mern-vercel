/**
 * An in-memory stand-in for the pipeline's MongoDB collections, for tests on a
 * machine without a database.
 *
 * It implements the `DocCollection` contract from `src/server/pipeline/store.ts`
 * with the mingo query engine. It shows that the application logic is right.
 * It does not show that MongoDB accepts the same queries: the pipeline test
 * runs against a real MongoDB server in CI for that.
 */
import { setTimeout as delay } from "node:timers/promises";
import { Aggregator, Query } from "mingo";
import { update as applyUpdate } from "mingo/updater";

/**
 * Every operation first waits a random moment, as a network round trip does.
 * Each operation is still atomic, as it is in MongoDB, but operations of
 * requests that run at the same time interleave in a different order on every
 * run. Without this, concurrent requests would always run in the same order
 * and a race between them could never show.
 */
const roundTrip = () => delay(Math.random() * 3);

class DuplicateKeyError extends Error {
  constructor(id) {
    super(`E11000 duplicate key error: _id ${id}`);
    this.code = 11000;
  }
}

/** MongoDB's ordering for the value types the pipeline sorts by: missing and null first, then by value. */
function compare(a, b) {
  const rank = (value) => (value === undefined || value === null ? 0 : 1);
  if (rank(a) !== rank(b)) return rank(a) - rank(b);
  if (rank(a) === 0) return 0;
  const left = a instanceof Date ? a.getTime() : a;
  const right = b instanceof Date ? b.getTime() : b;
  return left < right ? -1 : left > right ? 1 : 0;
}

const valueAt = (doc, path) => path.split(".").reduce((value, key) => (value === null || value === undefined ? undefined : value[key]), doc);

function memoryCollection(latency = roundTrip) {
  const docs = new Map();
  const clone = (doc) => structuredClone(doc);

  function select(filter, options = {}) {
    const query = new Query(filter);
    let list = [...docs.values()].filter((doc) => query.test(doc));
    if (options.sort) {
      const keys = Object.entries(options.sort);
      list = list.sort((a, b) => {
        for (const [key, direction] of keys) {
          const order = compare(valueAt(a, key), valueAt(b, key));
          if (order !== 0) return order * direction;
        }
        return 0;
      });
    }
    if (options.skip) list = list.slice(options.skip);
    if (options.limit) list = list.slice(0, options.limit);
    return list;
  }

  /** Applies update operators in place. `$setOnInsert` only applies to a document that is being created. */
  function mutate(doc, update, inserting) {
    const { $setOnInsert, ...operators } = update;
    const before = JSON.stringify(doc);
    if (inserting && $setOnInsert) Object.assign(doc, clone($setOnInsert));
    if (Object.keys(operators).length > 0) applyUpdate(doc, clone(operators));
    return JSON.stringify(doc) !== before;
  }

  function upsertFrom(filter, update) {
    const keys = Object.keys(filter);
    if (keys.length !== 1 || keys[0] !== "_id" || typeof filter._id !== "string") throw new Error("memory store: upsert needs a filter of { _id } only");
    if (docs.has(filter._id)) throw new DuplicateKeyError(filter._id);
    const doc = { _id: filter._id };
    mutate(doc, update, true);
    docs.set(doc._id, doc);
    return doc;
  }

  return {
    async findOne(filter, options) {
      await latency();
      const [first] = select(filter, { sort: options?.sort, limit: 1 });
      return first ? clone(first) : null;
    },
    async find(filter, options) {
      await latency();
      return select(filter, options).map(clone);
    },
    async insertOne(doc) {
      await latency();
      if (docs.has(doc._id)) throw new DuplicateKeyError(doc._id);
      docs.set(doc._id, clone(doc));
    },
    async updateOne(filter, update, options) {
      await latency();
      const [target] = select(filter, { limit: 1 });
      if (!target) {
        if (!options?.upsert) return { matched: 0, modified: 0, upserted: false };
        upsertFrom(filter, update);
        return { matched: 0, modified: 0, upserted: true };
      }
      return { matched: 1, modified: mutate(target, update, false) ? 1 : 0, upserted: false };
    },
    async updateMany(filter, update) {
      await latency();
      const targets = select(filter);
      let modified = 0;
      for (const target of targets) if (mutate(target, update, false)) modified += 1;
      return { matched: targets.length, modified };
    },
    async findOneAndUpdate(filter, update, options) {
      await latency();
      const [target] = select(filter, { sort: options?.sort, limit: 1 });
      const returnAfter = (options?.returnDocument ?? "after") === "after";
      if (!target) {
        if (!options?.upsert) return null;
        const created = upsertFrom(filter, update);
        return returnAfter ? clone(created) : null;
      }
      const before = clone(target);
      mutate(target, update, false);
      return returnAfter ? clone(target) : before;
    },
    async deleteOne(filter) {
      await latency();
      const [target] = select(filter, { limit: 1 });
      if (!target) return 0;
      docs.delete(target._id);
      return 1;
    },
    async deleteMany(filter) {
      await latency();
      const targets = select(filter);
      for (const target of targets) docs.delete(target._id);
      return targets.length;
    },
    async countDocuments(filter) {
      await latency();
      return select(filter).length;
    },
    async aggregate(pipeline) {
      await latency();
      return new Aggregator(pipeline).run([...docs.values()].map(clone));
    },
    /** Test access: every document, unfiltered. */
    all: () => [...docs.values()].map(clone),
    clear: () => docs.clear(),
  };
}

export function createMemoryPipelineStore() {
  return {
    jobs: memoryCollection(),
    items: memoryCollection(),
    artifacts: memoryCollection(),
    usage: memoryCollection(),
    days: memoryCollection(),
    rate: memoryCollection(),
    slots: memoryCollection(),
  };
}
