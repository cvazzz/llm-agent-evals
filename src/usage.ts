import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

type Counts = Record<string, Record<string, number>>; // date -> user -> count

/** Daily per-user request counter persisted to a JSON file (UTC days). */
export class UsageCounter {
  private counts: Counts = {};
  constructor(
    private file: string,
    private limit: number,
    private clock: () => Date = () => new Date(),
  ) {
    mkdirSync(dirname(file), { recursive: true });
    if (existsSync(file)) {
      try {
        this.counts = JSON.parse(readFileSync(file, 'utf8'));
      } catch {
        this.counts = {};
      }
    }
  }

  private today(): string {
    return this.clock().toISOString().slice(0, 10);
  }

  used(user: string): number {
    return this.counts[this.today()]?.[user] ?? 0;
  }

  remaining(user: string): number {
    return Math.max(0, this.limit - this.used(user));
  }

  /** Returns false (and does not count) when the user is over the limit. */
  tryConsume(user: string): boolean {
    if (this.used(user) >= this.limit) return false;
    const d = this.today();
    // keep only today's bucket so the file does not grow forever
    this.counts = { [d]: { ...(this.counts[d] ?? {}), [user]: this.used(user) + 1 } };
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.counts));
    renameSync(tmp, this.file);
    return true;
  }
}
