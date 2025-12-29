import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { env } from '../config/env.js';

// Redis connection
const redis = new Redis(env.REDIS_URL, {
  maxRetriesPerRequest: null,
});

// Ingest queue for pipeline jobs
export const ingestQueue = new Queue('ingest', {
  connection: redis,
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 1000,
    },
    removeOnComplete: 100,
    removeOnFail: 50,
  },
});

// Job types
export interface IngestUrlJob {
  type: 'ingest_url';
  sourceId: string;
  orgId: string;
  pocketId: string;
  url: string;
}

export interface IngestFileJob {
  type: 'ingest_file';
  sourceId: string;
  orgId: string;
  pocketId: string;
  storagePath: string;
  mimeType: string;
}

export type IngestJob = IngestUrlJob | IngestFileJob;

// Helper to enqueue jobs
export async function enqueueIngestUrl(
  sourceId: string,
  orgId: string,
  pocketId: string,
  url: string
): Promise<void> {
  await ingestQueue.add('ingest_url', {
    type: 'ingest_url',
    sourceId,
    orgId,
    pocketId,
    url,
  } satisfies IngestUrlJob);
}

export async function enqueueIngestFile(
  sourceId: string,
  orgId: string,
  pocketId: string,
  storagePath: string,
  mimeType: string
): Promise<void> {
  await ingestQueue.add('ingest_file', {
    type: 'ingest_file',
    sourceId,
    orgId,
    pocketId,
    storagePath,
    mimeType,
  } satisfies IngestFileJob);
}

// Reprocess source
export async function enqueueReprocess(
  sourceId: string,
  orgId: string,
  pocketId: string,
  type: 'url' | 'file',
  urlOrPath: string,
  mimeType?: string
): Promise<void> {
  if (type === 'url') {
    await enqueueIngestUrl(sourceId, orgId, pocketId, urlOrPath);
  } else {
    await enqueueIngestFile(sourceId, orgId, pocketId, urlOrPath, mimeType || 'application/octet-stream');
  }
}

export { redis };
