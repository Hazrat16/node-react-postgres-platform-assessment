import { Queue } from "bullmq";
import IORedis from "ioredis";

export const QUEUE_NAME = "item-events";

// BullMQ needs maxRetriesPerRequest: null on its connection.
export function createRedisConnection(redisUrl, opts = {}) {
  return new IORedis(redisUrl, { maxRetriesPerRequest: null, ...opts });
}

export function createQueue(connection) {
  const queue = new Queue(QUEUE_NAME, { connection });
  return {
    async enqueueItemCreated(item) {
      await queue.add("item-created", item, {
        attempts: 5,
        backoff: { type: "exponential", delay: 1000 },
        removeOnComplete: 100,
        removeOnFail: 500,
      });
    },
    close: () => queue.close(),
  };
}
