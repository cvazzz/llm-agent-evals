import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface Turn {
  user: string;
  assistant: string;
}
export interface UserMemory {
  facts: string[];
  history: Turn[];
}

const USER_RE = /^[A-Za-z0-9_-]{1,64}$/;
export const isValidUserId = (u: unknown): u is string => typeof u === 'string' && USER_RE.test(u);

const REMEMBER_RE = /^\s*(?:please\s+)?(?:remember|recuerda)(?:\s+that|\s+que)?[\s:,]+(.{3,200}?)\s*[.!]?\s*$/i;
export const extractFact = (message: string): string | null => REMEMBER_RE.exec(message)?.[1] ?? null;

/** Per-user JSON files: facts the user asked us to remember plus the last few turns. */
export class MemoryStore {
  constructor(
    private dir: string,
    private maxTurns = 6,
    private maxFacts = 20,
  ) {
    mkdirSync(dir, { recursive: true });
  }

  private file(userId: string): string {
    if (!isValidUserId(userId)) throw new Error('invalid user id');
    return join(this.dir, `${userId}.json`);
  }

  load(userId: string): UserMemory {
    const f = this.file(userId);
    if (!existsSync(f)) return { facts: [], history: [] };
    try {
      const m = JSON.parse(readFileSync(f, 'utf8'));
      return { facts: Array.isArray(m.facts) ? m.facts : [], history: Array.isArray(m.history) ? m.history : [] };
    } catch {
      return { facts: [], history: [] }; // corrupt file: start clean rather than crash
    }
  }

  private save(userId: string, m: UserMemory): void {
    const f = this.file(userId);
    const tmp = `${f}.tmp`;
    writeFileSync(tmp, JSON.stringify(m, null, 2));
    renameSync(tmp, f);
  }

  addFact(userId: string, fact: string): void {
    const m = this.load(userId);
    if (!m.facts.includes(fact)) m.facts.push(fact);
    m.facts = m.facts.slice(-this.maxFacts);
    this.save(userId, m);
  }

  appendTurn(userId: string, turn: Turn): void {
    const m = this.load(userId);
    m.history.push({ user: turn.user.slice(0, 2000), assistant: turn.assistant.slice(0, 2000) });
    m.history = m.history.slice(-this.maxTurns);
    this.save(userId, m);
  }
}
