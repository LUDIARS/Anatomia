/**
 * Bounded Redis transport for serialized analysis results.
 * @spec Redis analysis result cache
 */
export interface RedisTextClient {
  connect(): Promise<unknown>;
  get(key: string): Promise<string | null>;
  set(key: string, value: string, options: { EX: number }): Promise<unknown>;
  disconnect(): Promise<unknown>;
  on(event: string, listener: () => void): unknown;
  ref(): void;
  unref(): void;
}

export interface ResultTextStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
}

/** The factory boundary keeps network I/O out of unit tests. */
export class RedisTextStore implements ResultTextStore {
  private connection?: Promise<RedisTextClient>;
  private active = 0;

  constructor(
    private readonly factory: () => Promise<RedisTextClient>,
    private readonly ttlSeconds = 3600,
    private readonly timeoutMs = 1000,
  ) {}

  private async run<T>(operation: (client: RedisTextClient) => Promise<T>): Promise<T> {
    this.active++;
    const connection = this.connection ??= this.factory().then(async (client) => {
      client.on("error", () => { /* command rejection is reported by the artifact owner */ });
      try { await client.connect(); return client; }
      catch (error) { await client.disconnect().catch(() => undefined); throw error; }
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    let client: RedisTextClient | undefined;
    let cancelled = false;
    try {
      return await Promise.race([
        (async () => { client = await connection; if (cancelled) throw new Error("Expired Redis operation"); client.ref(); return operation(client); })(),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Redis result cache timeout")), this.timeoutMs); }),
      ]);
    } catch {
      cancelled = true;
      if (this.connection === connection) this.connection = undefined;
      // Dispose this connection even if its asynchronous creation finishes late.
      void connection.then((c) => c.disconnect()).catch(() => undefined);
      throw new Error("Redis result cache unavailable");
    } finally {
      clearTimeout(timer);
      this.active--;
      if (this.active === 0) client?.unref();
    }
  }

  get(key: string): Promise<string | null> { return this.run((client) => client.get(key)); }
  async set(key: string, value: string): Promise<void> {
    await this.run((client) => client.set(key, value, { EX: this.ttlSeconds }));
  }
}

/** Separate opt-in from the LLM cache; never expose a credential-bearing URL. */
export function resolveResultRedis(env: NodeJS.ProcessEnv = process.env): ResultTextStore | undefined {
  const url = env.ANATOMIA_RESULT_CACHE_REDIS?.trim();
  if (!url) return undefined;
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new Error("Invalid ANATOMIA_RESULT_CACHE_REDIS"); }
  if (!["redis:", "rediss:"].includes(parsed.protocol)) throw new Error("Invalid ANATOMIA_RESULT_CACHE_REDIS protocol");
  const ttl = Number(env.ANATOMIA_RESULT_CACHE_TTL_SECONDS ?? 3600);
  if (!Number.isSafeInteger(ttl) || ttl <= 0) throw new Error("ANATOMIA_RESULT_CACHE_TTL_SECONDS must be a positive integer");
  return new RedisTextStore(async () => {
    const moduleName = "redis";
    const mod = await import(moduleName) as { createClient(options: unknown): RedisTextClient };
    return mod.createClient({ url, socket: { connectTimeout: 1000, reconnectStrategy: false }, disableOfflineQueue: true });
  }, ttl);
}
