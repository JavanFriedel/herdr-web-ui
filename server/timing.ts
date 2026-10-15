import { AsyncLocalStorage } from "node:async_hooks";
import { TIMING_LIMIT, type ServerTiming, type TimingStage } from "../shared/timing.ts";

interface TimingContext { start: number; enabled: boolean; entries: ServerTiming[] }
const contexts = new AsyncLocalStorage<TimingContext>();
const noop = () => {};
const disabledTimer = (_stage: TimingStage) => noop;

/** Capture the context before socket callbacks: a concurrent request can never own this span. */
export function serverSpan(stage: TimingStage): (failed?: boolean) => void {
  return captureServerTimer()(stage);
}

export function captureServerTimer(): (stage: TimingStage) => (failed?: boolean) => void {
  const context = contexts.getStore();
  if (!context) return disabledTimer;
  return (stage) => beginSpan(context, stage);
}

function beginSpan(context: TimingContext | undefined, stage: TimingStage): (failed?: boolean) => void {
  if (!context || context.entries.length >= TIMING_LIMIT - 1) return () => {};
  const start = performance.now();
  const entry: ServerTiming = { stage, start_ms: start - context.start, duration_ms: 0 };
  context.entries.push(entry);
  let finished = false;
  return (failed) => { if (!finished) { finished = true; entry.duration_ms = performance.now() - start; if (failed) entry.failed = true; } };
}

export function enableTiming(): void {
  const context = contexts.getStore();
  if (context) context.enabled = true;
}

export function addRemoteTimings(entries: readonly ServerTiming[]): void {
  const context = contexts.getStore();
  if (!context?.enabled) return;
  // Reserve one slot for the local request's total, even on a very busy remote read.
  for (const entry of entries.slice(0, TIMING_LIMIT - 1 - context.entries.length)) {
    context.entries.push({ ...entry, remote: true });
  }
}

export function timingEnabled(): boolean { return contexts.getStore()?.enabled === true; }

/** Transport-independent scope; HTTP authorization and headers belong to request-timing.ts. */
export function collectTimings<T>(read: (context: TimingContext) => Promise<T>): Promise<T> {
  const context: TimingContext = { start: performance.now(), enabled: false, entries: [] };
  return contexts.run(context, () => read(context));
}
