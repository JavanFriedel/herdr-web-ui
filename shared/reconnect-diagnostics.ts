import { TIMING_STAGES, type TimingStage } from "./timing.ts";

export const SLOW_RECONNECT_MS = 5000;
export const RECONNECT_REPORT_EVENTS = 64;
export const RECONNECT_REPORT_BYTES = 32 * 1024;
export const DIAGNOSTIC_STAGES = [
  "page.load", "page.resume", "page.hidden", "network.online",
  "ws.wake", "ws.connect", "ws.snapshot", "ws.probe", "ws.probe-timeout", "ws.connect-timeout",
  "ws.backoff", "ws.close", "ws.no-ping", "ws.attach", "ws.first-output", "ws.input-ready",
  "ws.output-stopped", "ws.probe-paused", "ws.probe-restarted",
  "history.queue", "history.read", "history.chunk", "history.gap", "history.prepare",
  "chat.commit", "chat.next-frame", "chat.cached", "http.headers", "http.body", "http.json",
  "http.timeout", "http.no-server-timing", "http.no-remote-timing",
] as const;
export type DiagnosticStage = typeof DIAGNOSTIC_STAGES[number];
export type DiagnosticOutcome = "pending" | "ok" | "error" | "cancelled";
export interface DiagnosticEvent {
  id: number;
  stage: DiagnosticStage | TimingStage;
  clock: "browser" | "server" | "remote";
  start_ms: number;
  duration_ms: number;
  outcome: DiagnosticOutcome;
  target?: string;
  route?: string;
  status?: number;
  parent?: number;
}
export interface ReconnectReport {
  /** Random per load/resume episode, never a device or session identifier. */
  id: string;
  reason: "load" | "resume" | "online";
  trigger: "slow" | "timeout" | "recovered";
  elapsed_ms: number;
  events: DiagnosticEvent[];
}
export interface ReconnectLogEntry extends ReconnectReport { recorded_at: string }

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const count = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value < 1_000_000_000;
const milliseconds = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 300_000;
const only = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).every((key) => keys.includes(key));

/** Strict allowlist: a submitted error, URL, prompt or credential can never enter the log. */
export function parseReconnectReport(value: unknown): ReconnectReport | null {
  if (!object(value) || !only(value, ["id", "reason", "trigger", "elapsed_ms", "events"])) return null;
  if (typeof value.id !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value.id)) return null;
  if (typeof value.reason !== "string" || !["load", "resume", "online"].includes(value.reason) || typeof value.trigger !== "string" || !["slow", "timeout", "recovered"].includes(value.trigger) || !milliseconds(value.elapsed_ms)) return null;
  if (!Array.isArray(value.events) || value.events.length === 0 || value.events.length > RECONNECT_REPORT_EVENTS) return null;
  for (const event of value.events) {
    if (!object(event) || !only(event, ["id", "stage", "clock", "start_ms", "duration_ms", "outcome", "target", "route", "status", "parent"])) return null;
    if (!count(event.id) || ![...DIAGNOSTIC_STAGES, ...TIMING_STAGES].includes(event.stage as DiagnosticStage | TimingStage)) return null;
    if (typeof event.clock !== "string" || !["browser", "server", "remote"].includes(event.clock) || typeof event.outcome !== "string" || !["pending", "ok", "error", "cancelled"].includes(event.outcome)) return null;
    if (!milliseconds(event.start_ms) || !milliseconds(event.duration_ms)) return null;
    if (event.target !== undefined && (typeof event.target !== "string" || !/^target-(?:[1-9]\d{0,2}|other)$/.test(event.target))) return null;
    if (event.route !== undefined && (typeof event.route !== "string" || !["health", "session", "machines", "pane/conversation", "pane/read", "pane/commands", "pane/prompt"].includes(event.route))) return null;
    if (event.status !== undefined && (typeof event.status !== "number" || !Number.isInteger(event.status) || event.status < 0 || event.status > 65535)) return null;
    if (event.parent !== undefined && !count(event.parent)) return null;
  }
  return value as unknown as ReconnectReport;
}
