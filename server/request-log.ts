/**
 * A record of the requests that went wrong: every answer of 500 or more, and every answer slower
 * than `slowMs`, as one JSON line in `<stateDir>/logs/requests.log`. A failed herdr call answers
 * 502 (`connect_failed`, `timeout`) and is otherwise logged nowhere, so "the chat showed a 502"
 * could not be traced back to the call, the pane or the time. Successful, quick requests are not
 * written: the log stays about failures and is small enough to read.
 *
 * A line holds the time, status, method, path, the pane it was about (`pane_id` only: the rest of
 * the query, such as a file path, stays out), the duration and, for an error answer, the error
 * code and message from its JSON body (a herdr timeout names its method there).
 *
 * The file is rotated by size: past `maxBytes` it becomes `requests.log.1`, the older ones move up
 * one, and the oldest beyond `keep` is deleted, so the logs never take more than about
 * `maxBytes * (keep + 1)`. Writing never throws into a request: a log that cannot be written says
 * so once on stderr and stops trying until the server restarts.
 */

import { appendFileSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

export const REQUEST_LOG_MAX_BYTES = 1024 * 1024;
export const REQUEST_LOG_KEEP = 3;
export const SLOW_REQUEST_MS = 3_000;
const MESSAGE_MAX = 300;

export interface RequestLogOptions {
  dir: string;
  maxBytes?: number;
  keep?: number;
  /** a request at least this slow is written even when it succeeded; 0 writes failures only */
  slowMs?: number;
  now?: () => Date;
}

export interface RequestLogEntry {
  t: string;
  status: number;
  method: string;
  path: string;
  pane?: string;
  ms: number;
  slow?: true;
  code?: string;
  message?: string;
}

export interface RequestLog {
  readonly file: string;
  /** Writes the request if it failed or was slow; resolves once written (tests wait on it). */
  observe(request: Request, response: Response, ms: number): Promise<void>;
}

export function createRequestLog(options: RequestLogOptions): RequestLog {
  const maxBytes = options.maxBytes ?? REQUEST_LOG_MAX_BYTES;
  const keep = options.keep ?? REQUEST_LOG_KEEP;
  const slowMs = options.slowMs ?? SLOW_REQUEST_MS;
  const now = options.now ?? (() => new Date());
  const file = join(options.dir, "requests.log");
  let size: number | null = null;
  let broken = false;

  function rotate(): void {
    rmSync(`${file}.${keep}`, { force: true });
    for (let index = keep - 1; index >= 1; index--) {
      try { renameSync(`${file}.${index}`, `${file}.${index + 1}`); } catch { /* a gap in the series */ }
    }
    if (keep >= 1) renameSync(file, `${file}.1`);
    else rmSync(file, { force: true });
    size = 0;
  }

  function write(entry: RequestLogEntry): void {
    if (broken) return;
    try {
      if (size === null) {
        mkdirSync(options.dir, { recursive: true, mode: 0o700 });
        try { size = statSync(file).size; } catch { size = 0; }
      }
      const line = `${JSON.stringify(entry)}\n`;
      const bytes = Buffer.byteLength(line);
      if (size > 0 && size + bytes > maxBytes) rotate();
      appendFileSync(file, line, { mode: 0o600 });
      size += bytes;
    } catch (error) {
      broken = true;
      console.error(`request log ${file} cannot be written, so it stops: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return {
    file,
    async observe(request, response, ms) {
      const failed = response.status >= 500;
      const slow = slowMs > 0 && ms >= slowMs;
      if (!failed && !slow) return;
      const url = new URL(request.url);
      const entry: RequestLogEntry = {
        t: now().toISOString(),
        status: response.status,
        method: request.method,
        path: url.pathname,
        ms: Math.round(ms),
      };
      const pane = url.searchParams.get("pane_id");
      if (pane) entry.pane = pane;
      if (slow) entry.slow = true;
      if (failed) Object.assign(entry, await errorOf(response));
      write(entry);
    },
  };
}

/** The `{ error: { code, message } }` of an error answer, read from a copy so the client still gets the body. */
async function errorOf(response: Response): Promise<Pick<RequestLogEntry, "code" | "message">> {
  if (response.headers.has("content-encoding") || !response.headers.get("content-type")?.includes("json")) return {};
  try {
    const body = await response.clone().json() as { error?: { code?: unknown; message?: unknown } };
    const code = typeof body.error?.code === "string" ? body.error.code : undefined;
    const message = typeof body.error?.message === "string" ? body.error.message.slice(0, MESSAGE_MAX) : undefined;
    return { ...(code ? { code } : {}), ...(message ? { message } : {}) };
  } catch {
    return {};
  }
}

/** The request log the server's environment asks for: `HERDR_WEB_SLOW_REQUEST_MS` sets the slow threshold. */
export function requestLogFromEnv(stateDir: string, env: Record<string, string | undefined> = process.env): RequestLog {
  const raw = env["HERDR_WEB_SLOW_REQUEST_MS"]?.trim();
  const parsed = raw ? Number(raw) : Number.NaN;
  return createRequestLog({ dir: join(stateDir, "logs"), slowMs: Number.isFinite(parsed) && parsed >= 0 ? parsed : SLOW_REQUEST_MS });
}
