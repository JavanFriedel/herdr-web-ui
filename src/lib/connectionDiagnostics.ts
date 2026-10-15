import { TIMING_HEADER, parseServerTiming, timingRoute, type ServerTiming } from "../../shared/timing.ts";
import { SLOW_RECONNECT_MS, RECONNECT_REPORT_EVENTS, type DiagnosticStage, type DiagnosticOutcome, type DiagnosticEvent, type ReconnectReport } from "../../shared/reconnect-diagnostics.ts";
export type { DiagnosticStage, DiagnosticOutcome, DiagnosticEvent } from "../../shared/reconnect-diagnostics.ts";
export interface DiagnosticTarget { machineId: string; paneId?: string }
export interface DiagnosticCapture {
  id: number;
  reason: ReconnectReport["reason"];
  events: DiagnosticEvent[];
  limited: boolean;
}
export interface DiagnosticSpan {
  child(stage: DiagnosticStage): DiagnosticSpan;
  end(outcome?: DiagnosticOutcome, status?: number): void;
  mark(stage: DiagnosticStage): void;
  server(entries: readonly ServerTiming[]): void;
}
const CAPTURES = 4;
const EVENTS = 1000;
const WINDOW_MS = 120_000;
const noop: DiagnosticSpan = { child: () => noop, end() {}, mark() {}, server() {} };
const BLOCKING = new Set<DiagnosticStage>(["ws.connect", "ws.snapshot", "ws.probe", "ws.input-ready", "history.queue", "history.read"]);
const RECOVERY = new Set<DiagnosticStage>(["ws.probe", "ws.input-ready", "chat.next-frame"]);

/** Small memory window; only threshold breaches and their recovery are logged locally. */
export class ConnectionDiagnostics {
  private enabled = false;
  private captures: DiagnosticCapture[] = [];
  private current?: { capture: DiagnosticCapture; start: number; aliases: Map<string, string> };
  private nextCapture = 1;
  private nextEvent = 1;
  private epoch = 0;
  private starts = new WeakMap<DiagnosticCapture, number>();
  private epochs = new WeakMap<DiagnosticCapture, number>();
  private episodes = new WeakMap<DiagnosticCapture, { id: string; sent: Set<ReconnectReport["trigger"]> }>();
  private deadlines = new Set<ReturnType<typeof setTimeout>>();
  constructor(private readonly now: () => number = () => performance.now(), private readonly report?: (report: ReconnectReport) => void) {}
  state(): { enabled: boolean; captures: readonly DiagnosticCapture[] } { return { enabled: this.enabled, captures: this.captures }; }
  setEnabled(enabled: boolean): void {
    if (this.enabled === enabled) return;
    if (!enabled) { this.cancelPending(); this.epoch++; }
    this.enabled = enabled;
    if (enabled) this.begin("load");
  }
  clear(): void { this.cancelPending(); this.epoch++; this.captures = []; this.current = undefined; if (this.enabled) this.begin("load"); }
  begin(reason: DiagnosticCapture["reason"]): void {
    if (!this.enabled) return;
    const capture: DiagnosticCapture = { id: this.nextCapture++, reason, events: [], limited: false };
    this.captures = [...this.captures.slice(-(CAPTURES - 1)), capture];
    this.current = { capture, start: this.now(), aliases: new Map() };
    this.starts.set(capture, this.current.start); this.epochs.set(capture, this.epoch);
    this.episodes.set(capture, { id: crypto.randomUUID(), sent: new Set() });
    this.mark(reason === "resume" ? "page.resume" : reason === "online" ? "network.online" : "page.load");
  }
  active(): boolean { return this.enabled && this.current !== undefined && this.now() - this.current.start <= WINDOW_MS && this.current.capture.events.length < EVENTS; }
  private cancelPending(): void {
    for (const deadline of this.deadlines) clearTimeout(deadline);
    this.deadlines.clear();
    for (const capture of this.captures) for (const event of capture.events) {
      if (event.outcome === "pending") { event.outcome = "cancelled"; event.duration_ms = this.now() - (this.starts.get(capture) ?? this.now()) - event.start_ms; }
    }
  }
  private alias(target: DiagnosticTarget | undefined): string | undefined {
    if (!target || !this.current) return undefined;
    const aliases = this.current.aliases;
    const key = `${target.machineId}\0${target.paneId ?? ""}`;
    if (!aliases.has(key) && aliases.size < 128) aliases.set(key, `target-${aliases.size + 1}`);
    return aliases.get(key) ?? "target-other";
  }
  span(stage: DiagnosticStage, target?: DiagnosticTarget, route?: string): DiagnosticSpan {
    const current = this.current;
    if (!this.active() || !current) {
      if (this.enabled && current) current.capture.limited = true;
      return noop;
    }
    return this.beginSpan(stage, current, this.alias(target), route);
  }
  private beginSpan(stage: DiagnosticStage, current: NonNullable<ConnectionDiagnostics["current"]>, target?: string, route?: string, parent?: number): DiagnosticSpan {
    if (!this.enabled || this.epochs.get(current.capture) !== this.epoch || !this.captures.includes(current.capture)) return noop;
    if (this.now() - current.start > WINDOW_MS || current.capture.events.length >= EVENTS) { current.capture.limited = true; return noop; }
    const started = this.now();
    const event: DiagnosticEvent = { id: this.nextEvent++, stage, clock: "browser", start_ms: started - current.start, duration_ms: 0, outcome: "pending", target, ...(route ? { route } : {}), ...(parent ? { parent } : {}) };
    current.capture.events.push(event);
    let finished = false;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const retained = () => this.enabled && this.epochs.get(current.capture) === this.epoch && this.captures.includes(current.capture);
    const child = (entry: DiagnosticEvent): void => {
      if (!retained()) return;
      if (current.capture.events.length >= EVENTS) { current.capture.limited = true; return; }
      current.capture.events.push(entry);
    };
    if (this.report && BLOCKING.has(stage)) {
      deadline = setTimeout(() => { this.deadlines.delete(deadline!); if (retained() && !finished) this.emit(current.capture, "slow"); }, SLOW_RECONNECT_MS);
      this.deadlines.add(deadline);
    }
    return {
      child: (stage) => this.beginSpan(stage, current, event.target, event.route, event.id),
      end: (outcome = "ok", status) => {
        if (deadline !== undefined) { clearTimeout(deadline); this.deadlines.delete(deadline); }
        if (finished || !retained()) return;
        finished = true; event.duration_ms = this.now() - started; event.outcome = outcome;
        if (status !== undefined) event.status = status;
        if (BLOCKING.has(stage) && outcome !== "cancelled" && event.duration_ms >= SLOW_RECONNECT_MS) this.emit(current.capture, "slow");
        if (outcome === "ok" && RECOVERY.has(stage) && !current.capture.events.some((entry) => entry.clock === "browser" && BLOCKING.has(entry.stage as DiagnosticStage) && entry.outcome === "pending")) this.emit(current.capture, "recovered");
      },
      mark: (stage) => {
        child({ id: this.nextEvent++, stage, clock: "browser", start_ms: this.now() - current.start, duration_ms: 0, outcome: "ok", target: event.target, parent: event.id });
        if (["http.timeout", "ws.probe-timeout", "ws.connect-timeout"].includes(stage)) this.emit(current.capture, "timeout");
      },
      server: (entries) => {
        for (const entry of entries) child({ id: this.nextEvent++, stage: entry.stage, clock: entry.remote ? "remote" : "server", start_ms: entry.start_ms, duration_ms: entry.duration_ms, outcome: entry.failed ? "error" : "ok", parent: event.id, target: event.target });
      },
    };
  }
  mark(stage: DiagnosticStage, target?: DiagnosticTarget, status?: number): void { this.span(stage, target).end("ok", status); }
  private emit(capture: DiagnosticCapture, trigger: ReconnectReport["trigger"]): void {
    if (!this.enabled || this.epochs.get(capture) !== this.epoch || !this.captures.includes(capture)) return;
    const episode = this.episodes.get(capture);
    if (!this.report || !episode || episode.sent.has(trigger) || (trigger === "recovered" && episode.sent.size === 0)) return;
    episode.sent.add(trigger);
    const elapsed = this.now() - this.starts.get(capture)!;
    const bounded = (value: number) => Math.round(Math.max(0, Math.min(300_000, value)) * 100) / 100;
    // Polling must not evict the pending wait or socket state that explains this episode.
    const important = capture.events.filter((entry) => entry.outcome !== "ok" || BLOCKING.has(entry.stage as DiagnosticStage) || ["ws.wake", "ws.no-ping", "http.timeout"].includes(entry.stage)).slice(-RECONNECT_REPORT_EVENTS);
    const room = RECONNECT_REPORT_EVENTS - important.length;
    const selected = [...important, ...(room ? capture.events.filter((entry) => !important.includes(entry)).slice(-room) : [])].sort((a, b) => a.id - b.id);
    const events = selected.map((entry) => ({ ...entry, start_ms: bounded(entry.start_ms), duration_ms: bounded(entry.outcome === "pending" && entry.clock === "browser" ? elapsed - entry.start_ms : entry.duration_ms) }));
    try { this.report({ id: episode.id, reason: capture.reason, trigger, elapsed_ms: bounded(elapsed), events }); } catch { /* diagnostics never fail the chat */ }
  }
}

export const connectionDiagnostics = new ConnectionDiagnostics(undefined, (report) => {
  if (typeof document === "undefined" || document.visibilityState === "hidden") return;
  // Best effort, no persisted queue or retries. A recovery record carries the same episode detail.
  void fetch("/api/diagnostics/reconnect", { method: "POST", headers: { "content-type": "application/json", "x-herdr-machine": "1" },
    body: JSON.stringify(report), signal: AbortSignal.timeout(3000) }).catch(() => undefined);
});

/** Register before React/socket listeners so resume is the start of every socket's wake timeline. */
export function watchConnectionDiagnostics(): void {
  connectionDiagnostics.setEnabled(true);
  let hidden = document.visibilityState === "hidden";
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") { hidden = true; connectionDiagnostics.mark("page.hidden"); }
    else if (hidden) { hidden = false; connectionDiagnostics.begin("resume"); }
  });
  window.addEventListener("pageshow", (event) => { if (event.persisted && !hidden) connectionDiagnostics.begin("resume"); });
  window.addEventListener("online", () => connectionDiagnostics.begin("online"));
}

const responses = new WeakMap<Response, { headers: DiagnosticSpan; target: DiagnosticTarget; route: string }>();

/** No global fetch patch: only same-origin, allowlisted GET reads participate. */
export async function diagnosticFetch(url: string, init?: RequestInit): Promise<Response> {
  if (!connectionDiagnostics.active() || (init?.method ?? "GET") !== "GET" || !url.startsWith("/api/") || url.startsWith("//")) return fetch(url, init);
  const parsed = new URL(url, "http://diagnostic.invalid");
  const route = timingRoute(parsed.pathname);
  if (!route) return fetch(url, init);
  const target: DiagnosticTarget = { machineId: /^\/api\/machines\/([^/]+)\//.exec(parsed.pathname)?.[1] ?? "local", ...(parsed.searchParams.has("pane_id") ? { paneId: parsed.searchParams.get("pane_id")! } : {}) };
  const span = connectionDiagnostics.span("http.headers", target, route);
  const headers = new Headers(init?.headers); headers.set(TIMING_HEADER, "1");
  try {
    const response = await fetch(url, { ...init, headers });
    span.end(response.ok || response.status === 304 ? "ok" : "error", response.status);
    const entries = parseServerTiming(response.headers.get("server-timing"));
    span.server(entries);
    if (!entries.some((entry) => !entry.remote && entry.stage === "server.total")) span.mark("http.no-server-timing");
    if (target.machineId !== "local" && !entries.some((entry) => entry.remote && entry.stage === "server.total")) span.mark("http.no-remote-timing");
    responses.set(response, { headers: span, target, route });
    return response;
  } catch (error) { span.end(init?.signal?.aborted ? "cancelled" : "error"); throw error; }
}

/** Split body download/decompression from JSON parsing without ever retaining either in the trace. */
export async function diagnosticJson<T>(response: Response): Promise<T> {
  const context = responses.get(response);
  if (!context || !connectionDiagnostics.active()) return response.json() as Promise<T>;
  responses.delete(response);
  const body = context.headers.child("http.body");
  let text: string;
  try { text = await response.text(); body.end(); }
  catch (error) { body.end("error"); throw error; }
  const json = context.headers.child("http.json");
  try { const value = JSON.parse(text) as T; json.end(); return value; }
  catch (error) { json.end("error"); throw error; }
}
