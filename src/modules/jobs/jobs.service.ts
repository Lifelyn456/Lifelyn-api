import { Injectable, OnModuleDestroy, ServiceUnavailableException } from "@nestjs/common";
import { Queue } from "bullmq";
import { Redis } from "ioredis";

export const QUEUES = ["record-ingest", "record-reindex", "integrity-check", "stellar-submit", "stellar-confirm", "fhir-import", "cleanup-expired-links"] as const;
type QueueName = (typeof QUEUES)[number];

@Injectable()
export class JobsService implements OnModuleDestroy {
  private redis?: Redis;
  private readonly queues = new Map<string, Queue>();
  private queue(name: QueueName) {
    const url = process.env.REDIS_URL;
    if (!url) throw new ServiceUnavailableException("Background jobs are not configured.");
    this.redis ??= new Redis(url, { maxRetriesPerRequest: null, enableReadyCheck: true });
    let queue = this.queues.get(name);
    if (!queue) {
      queue = new Queue(name, { connection: this.redis, defaultJobOptions: { attempts: 5, backoff: { type: "exponential", delay: 1_000 }, removeOnComplete: 1_000, removeOnFail: false } });
      this.queues.set(name, queue);
    }
    return queue;
  }
  async add(name: QueueName, data: Record<string, unknown>, idempotencyKey: string) {
    return this.queue(name).add(name, { ...data, idempotencyKey }, { jobId: idempotencyKey });
  }
  async onModuleDestroy() {
    await Promise.all([...this.queues.values()].map((queue) => queue.close()));
    await this.redis?.quit();
  }
}
