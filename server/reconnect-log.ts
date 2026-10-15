import { mkdirSync, readFileSync, statSync, writeFileSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { RECONNECT_REPORT_BYTES, SLOW_RECONNECT_MS, parseReconnectReport, type ReconnectLogEntry, type ReconnectReport } from "../shared/reconnect-diagnostics.ts";
import { badRequest, jsonResponse } from "./http.ts";
import { sameOrigin } from "./machine-security.ts";

const LOG_BYTES = 256 * 1024;
const LOG_RECORDS = 32;
const RATE_LIMIT = 30;

/** Local diagnostic log, not telemetry. Atomic writes, a fixed byte/count cap and a global write budget. */
export class ReconnectLog {
  private entries: ReconnectLogEntry[] | undefined;
  private recent: number[] = [];
  readonly file: string;
  constructor(stateDir: string, private readonly now = () => Date.now()) { this.file = join(stateDir, "logs", "reconnect.json"); }

  list(): ReconnectLogEntry[] {
    if (this.entries !== undefined) return this.entries;
    const entries: ReconnectLogEntry[] = [];
    try {
      if (statSync(this.file).size > LOG_BYTES) throw new Error("Reconnect log exceeds its byte limit");
      const stored: unknown = JSON.parse(readFileSync(this.file, "utf8"));
      if (Array.isArray(stored)) for (const item of stored.slice(-LOG_RECORDS)) {
        if (item && typeof item === "object" && typeof item.recorded_at === "string" && /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(item.recorded_at)) {
          const { recorded_at, ...value } = item;
          const report = parseReconnectReport(value);
          if (report) entries.push({ ...report, recorded_at });
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    this.entries = entries;
    return entries;
  }

  record(report: ReconnectReport): "saved" | "duplicate" | "limited" {
    const now = this.now();
    const entries = this.list();
    if (entries.some((entry) => entry.id === report.id && entry.trigger === report.trigger)) return "duplicate";
    this.recent = this.recent.filter((time) => now - time < 60_000);
    if (this.recent.length >= RATE_LIMIT) return "limited";
    const next = [...entries.slice(-(LOG_RECORDS - 1)), { ...report, recorded_at: new Date(now).toISOString() }];
    let text = JSON.stringify(next);
    while (Buffer.byteLength(text) > LOG_BYTES && next.length > 1) { next.shift(); text = JSON.stringify(next); }
    const directory = dirname(this.file);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const temporary = `${this.file}.${process.pid}.tmp`;
    try { writeFileSync(temporary, text, { mode: 0o600 }); renameSync(temporary, this.file); }
    finally { rmSync(temporary, { force: true }); }
    this.entries = next; this.recent.push(now);
    return "saved";
  }
}

/** Called behind createServer's existing authentication and read-only gates. */
export async function handleReconnectLog(request: Request, log: ReconnectLog): Promise<Response> {
  if (!sameOrigin(request)) return jsonResponse({ error: { code: "invalid_origin", message: "Read diagnostics from this app" } }, 403);
  if (request.method === "GET") return jsonResponse({ slow_ms: SLOW_RECONNECT_MS, records: log.list() }, 200, { "cache-control": "no-store" });
  if (request.method !== "POST") return badRequest("method_not_allowed", "Use GET or POST");
  if (request.headers.get("x-herdr-machine") !== "1") return jsonResponse({ error: { code: "invalid_diagnostic_request", message: "Use diagnostics from this app" } }, 403);
  if (!request.body) return badRequest("invalid_body", "Expected a timing report");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = []; let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      bytes += value.byteLength;
      if (bytes > RECONNECT_REPORT_BYTES) { await reader.cancel(); return jsonResponse({ error: { code: "too_large", message: "Timing report is too large" } }, 413); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  let report: ReconnectReport | null;
  try { report = parseReconnectReport(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
  catch { return badRequest("invalid_json", "Expected a JSON timing report"); }
  if (!report) return badRequest("invalid_body", "Expected allowlisted timing fields only");
  const result = log.record(report);
  if (result === "limited") return jsonResponse({ error: { code: "rate_limited", message: "Too many timing reports" } }, 429);
  return jsonResponse({ ok: true }, 200, { "cache-control": "no-store" });
}
