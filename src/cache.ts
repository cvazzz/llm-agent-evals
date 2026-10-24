import { createHash } from 'node:crypto';

export interface CachedAnswer {
  text: string;
  tools: string[];
}

/** Small in-memory TTL cache with FIFO eviction. Not persisted, not shared across processes. */
export class AnswerCache {
  private map = new Map<string, { at: number; value: CachedAnswer }>();
  constructor(
    private ttlMs: number,
    private max = 500,
    private clock: () => number = Date.now,
  ) {}

  static key(parts: unknown[]): string {
    return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
  }

  get(key: string): CachedAnswer | undefined {
    const e = this.map.get(key);
    if (!e) return undefined;
    if (this.clock() - e.at > this.ttlMs) {
      this.map.delete(key);
      return undefined;
    }
    return e.value;
  }

  set(key: string, value: CachedAnswer): void {
    if (this.ttlMs <= 0) return;
    if (this.map.size >= this.max) this.map.delete(this.map.keys().next().value as string);
    this.map.set(key, { at: this.clock(), value });
  }

  clear(): void {
    this.map.clear();
  }

  get size(): number {
    return this.map.size;
  }
}
