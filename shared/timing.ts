/** Opt-in read diagnostics. No request values, descriptions or identifiers cross this contract. */
export const TIMING_HEADER = "x-herdr-timing";
export const TIMING_LIMIT = 64;
export const TIMING_STAGES = [
  "server.total", "server.startup", "server.access", "server.route", "server.compress",
  "bridge.headers", "bridge.body", "rpc.other",
  "history.resolve", "history.store", "history.serialize",
  "rpc.pane.get", "rpc.pane.process_info", "rpc.pane.read", "rpc.agent.get", "rpc.session.snapshot",
  "rpc.connect", "rpc.wait", "rpc.decode",
] as const;
export type TimingStage = typeof TIMING_STAGES[number];
export interface ServerTiming {
  stage: TimingStage;
  /** Milliseconds from this server's request start, NOT the browser's clock. */
  start_ms: number;
  duration_ms: number;
  remote?: boolean;
  failed?: boolean;
}

export function timingStage(value: string): TimingStage | null {
  return (TIMING_STAGES as readonly string[]).includes(value) ? value as TimingStage : null;
}

/** Our bounded Server-Timing subset; reject arbitrary remote descriptions rather than exporting them. */
export function parseServerTiming(header: string | null): ServerTiming[] {
  if (!header || header.length > 12_000) return [];
  const result: ServerTiming[] = [];
  for (const field of header.split(",").slice(0, TIMING_LIMIT)) {
    const match = /^\s*herdr\d+;dur=(\d+(?:\.\d+)?);desc="(remote\.)?([a-z._]+)@(\d+(?:\.\d+)?)(!error)?"\s*$/.exec(field);
    if (!match) continue;
    const stage = timingStage(match[3]!);
    const duration = Number(match[1]);
    const start = Number(match[4]);
    if (stage && duration <= 300_000 && start <= 300_000) result.push({ stage, start_ms: start, duration_ms: duration, ...(match[2] ? { remote: true } : {}), ...(match[5] ? { failed: true } : {}) });
  }
  return result;
}

export function formatServerTiming(entries: readonly ServerTiming[]): string {
  return entries.slice(0, TIMING_LIMIT).map((entry, index) =>
    `herdr${index};dur=${entry.duration_ms.toFixed(2)};desc="${entry.remote ? "remote." : ""}${entry.stage}@${entry.start_ms.toFixed(2)}${entry.failed ? "!error" : ""}"`).join(", ");
}

/** Only the connection/chat reads needed for reconnect diagnosis, never files, credentials or writes. */
export function timingRoute(pathname: string): string | null {
  const route = pathname.replace(/^\/api\/machines\/[^/]+\//, "/api/");
  return /^\/api\/(?:health|session|machines|pane\/(?:conversation|read|commands|prompt))$/.test(route) ? route.slice(5) : null;
}
