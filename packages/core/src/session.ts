export interface SessionEntry {
  /** Claude Agent SDK 的 session_id，用于 resume */
  claudeSessionId: string;
  updatedAt: number;
}

export interface SessionStore {
  get(sessionId: string): Promise<SessionEntry | null>;
  set(sessionId: string, entry: SessionEntry): Promise<void>;
  delete(sessionId: string): Promise<void>;
}

/**
 * 基于内存的 Session 存储，支持 TTL 自动过期。
 * 生产环境可替换为 Redis 实现。
 */
export class MemorySessionStore implements SessionStore {
  private readonly store = new Map<string, SessionEntry>();
  private readonly ttlMs: number;

  constructor(ttlMs = 30 * 60 * 1000) {
    this.ttlMs = ttlMs;

    const timer = setInterval(() => this.evictExpired(), 60_000);
    // 不阻止进程退出
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if (typeof (timer as any)?.unref === 'function') (timer as any).unref();
  }

  async get(sessionId: string): Promise<SessionEntry | null> {
    const entry = this.store.get(sessionId);
    if (!entry) return null;
    if (Date.now() - entry.updatedAt > this.ttlMs) {
      this.store.delete(sessionId);
      return null;
    }
    return entry;
  }

  async set(sessionId: string, entry: SessionEntry): Promise<void> {
    this.store.set(sessionId, entry);
  }

  async delete(sessionId: string): Promise<void> {
    this.store.delete(sessionId);
  }

  private evictExpired(): void {
    const now = Date.now();
    for (const [key, entry] of this.store) {
      if (now - entry.updatedAt > this.ttlMs) {
        this.store.delete(key);
      }
    }
  }
}
