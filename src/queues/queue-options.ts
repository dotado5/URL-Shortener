import type { JobsOptions } from 'bullmq';

/**
 * Section 23 retry and retention policy, shared by every producer.
 * Failed jobs are kept for 7 days so they can be inspected; completed ones briefly, mainly so
 * BullMQ can deduplicate an accidental double-enqueue of the same jobId.
 */
export const DEFAULT_JOB_OPTIONS: JobsOptions = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 1_000 },
  removeOnComplete: { age: 3_600, count: 1_000 },
  removeOnFail: { age: 7 * 24 * 3_600 },
};

/** Connection options for producers: fail fast, never queue behind a dead connection. */
export function producerConnection(redisUrl: string, commandTimeoutMs: number) {
  return {
    url: redisUrl,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    commandTimeout: commandTimeoutMs,
    connectTimeout: 2_000,
    retryStrategy: (times: number) => Math.min(times * 100, 2_000),
    connectionName: 'url-shortener-producer',
  };
}

/** Connection options for workers: BullMQ requires maxRetriesPerRequest null for blocking reads. */
export function workerConnection(redisUrl: string) {
  return {
    url: redisUrl,
    maxRetriesPerRequest: null,
    retryStrategy: (times: number) => Math.min(times * 200, 5_000),
    connectionName: 'url-shortener-worker',
  };
}
