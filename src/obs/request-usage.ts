/** Completed calls only; payloads and transport credentials never enter this boundary. */
import { vgWrite } from "./vestigium.js";

export const REQUEST_EVENT = "anatomia request completed";
export type RequestTransport = "http" | "cli" | "mcp";
export interface RequestEvent {
  transport: RequestTransport;
  operation: string;
  caller: string;
  status: number;
  duration_ms: number;
}

export function callerLabel(value: string | undefined): string {
  return value && /^[a-z][a-z0-9_-]{0,47}$/i.test(value) ? value.toLowerCase() : "unknown";
}

export function recordRequest(event: RequestEvent): void {
  vgWrite("info", REQUEST_EVENT, { ...event });
}

/** Preserve both result and thrown error; instrumentation runs once on every completion. */
export async function observeRequest<T>(
  transport: RequestTransport, operation: string, run: () => Promise<T>,
  caller = process.env.ANATOMIA_CALLER,
  statusOf: (result: T) => number = () => 200,
  emit: (event: RequestEvent) => void = recordRequest,
  now: () => number = performance.now.bind(performance),
): Promise<T> {
  const start = now();
  let status = 500;
  try { const result = await run(); status = statusOf(result); return result; }
  finally {
    try { emit({ transport, operation, caller: callerLabel(caller), status, duration_ms: Math.max(0, now() - start) }); }
    catch { /* Optional logging must never alter a completed request. */ }
  }
}

/** Handler names are registered tool names; arguments are deliberately never inspected. */
export function observeToolHandlers<T extends object>(handlers: T): T {
  return new Proxy(handlers, {
    get(target, key, receiver) {
      const handler: unknown = Reflect.get(target, key, receiver);
      if (typeof handler !== "function" || typeof key !== "string") return handler;
      return (...args: unknown[]) => observeRequest("mcp", key, () => Promise.resolve(Reflect.apply(handler, target, args)));
    },
  });
}
