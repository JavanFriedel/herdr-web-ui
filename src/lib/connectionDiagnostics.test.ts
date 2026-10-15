import { afterEach, describe, expect, it, jest } from "bun:test";
import { ConnectionDiagnostics, connectionDiagnostics, diagnosticFetch, diagnosticJson } from "./connectionDiagnostics.ts";
import { ConversationRefresh } from "./conversationRefresh.ts";
import { formatServerTiming, parseServerTiming } from "../../shared/timing.ts";
import { parseReconnectReport, type ReconnectReport } from "../../shared/reconnect-diagnostics.ts";

const originalFetch = globalThis.fetch;
afterEach(() => { jest.useRealTimers(); globalThis.fetch = originalFetch; connectionDiagnostics.setEnabled(false); connectionDiagnostics.clear(); });

describe("reconnect captures", () => {
  it("is disabled by default, anonymizes targets and uses monotonic millisecond spans", () => {
    let now = 100;
    const store = new ConnectionDiagnostics(() => now);
    store.mark("ws.wake", { machineId: "private-machine", paneId: "private-pane" });
    expect(store.state().captures).toHaveLength(0);
    store.setEnabled(true);
    const span = store.span("history.read", { machineId: "private-machine", paneId: "private-pane" });
    now += 123.25; span.end(); span.end("error");
    expect(store.state().captures[0]!.events[1]).toMatchObject({ start_ms: 0, duration_ms: 123.25, outcome: "ok", target: "target-1" });
    expect(JSON.stringify(store.state())).not.toContain("private-");
  });
  it("keeps in-flight phases on their original capture, and ignores late completions after clearing or stopping", () => {
    let now = 0;
    const store = new ConnectionDiagnostics(() => now); store.setEnabled(true);
    const span = store.span("http.headers");
    now = 10; store.begin("resume");
    span.child("http.body").end();
    expect(store.state().captures[0]!.events.at(-1)?.stage).toBe("http.body");
    expect(store.state().captures[1]!.events).toHaveLength(1);
    store.setEnabled(false); expect(store.state().captures[0]!.events[1]!.duration_ms).toBe(10);
    store.setEnabled(true); span.child("http.json").end(); span.end();
    expect(store.state().captures[0]!.events).toHaveLength(3);
    store.clear(); span.mark("ws.wake"); expect(store.state().captures[0]!.events).toHaveLength(1);
  });
  it("bounds captures, entries and recording windows", () => {
    let now = 0;
    const store = new ConnectionDiagnostics(() => now); store.setEnabled(true);
    for (let index = 0; index < 1100; index++) store.mark("ws.wake");
    expect(store.state().captures[0]!.events).toHaveLength(1000);
    expect(store.state().captures[0]!.limited).toBe(true);
    for (let index = 0; index < 8; index++) store.begin("resume");
    expect(store.state().captures).toHaveLength(4);
    now = 120_001; store.mark("ws.wake"); expect(store.state().captures.at(-1)!.events).toHaveLength(1);
    store.begin("resume"); expect(store.active()).toBe(true);
  });
  it("accepts only bounded, known server timing descriptions", () => {
    const valid = { stage: "rpc.pane.process_info" as const, start_ms: 1.5, duration_ms: 10.25, remote: true, failed: true };
    expect(parseServerTiming(formatServerTiming([valid]))).toEqual([valid]);
    expect(parseServerTiming('secret;dur=1;desc="token", herdr0;dur=1;desc="private.secret@0", herdr1;dur=999999;desc="server.total@0"')).toEqual([]);
    expect(parseServerTiming("x".repeat(12_001))).toEqual([]);
  });
});

it("automatically logs a threshold breach, timeout and recovery once per episode, but no fast recovery", () => {
  jest.useFakeTimers();
  let now = 0; const reports: ReconnectReport[] = [];
  const store = new ConnectionDiagnostics(() => now, (report) => reports.push(report)); store.setEnabled(true);
  const fast = store.span("history.read"); fast.end(); fast.child("chat.next-frame").end();
  expect(reports).toEqual([]);
  const read = store.span("history.read", { machineId: "private-machine", paneId: "private-pane" });
  for (let index = 0; index < 200; index++) store.mark("http.no-server-timing");
  now = 4999; jest.advanceTimersByTime(4999); expect(reports).toEqual([]);
  now = 5000; jest.advanceTimersByTime(1);
  expect(reports.map((report) => report.trigger)).toEqual(["slow"]);
  expect(reports[0]!.events).toHaveLength(64);
  expect(reports[0]!.events).toContainEqual(expect.objectContaining({ stage: "history.read", outcome: "pending", duration_ms: 5000 }));
  read.mark("http.timeout"); read.mark("http.timeout"); read.end("error");
  const retry = store.span("history.read"); retry.end(); retry.child("chat.next-frame").end();
  expect(reports.map((report) => report.trigger)).toEqual(["slow", "timeout", "recovered"]);
  expect(new Set(reports.map((report) => report.id)).size).toBe(1);
  expect(reports.every((report) => parseReconnectReport(JSON.parse(JSON.stringify(report))) !== null)).toBe(true);
  expect(JSON.stringify(reports)).not.toContain("private-");
  store.setEnabled(false);
});

it("a failing diagnostic writer cannot fail recovery", () => {
  jest.useFakeTimers();
  const store = new ConnectionDiagnostics(() => 5000, () => { throw new Error("writer refused"); }); store.setEnabled(true);
  const read = store.span("history.read");
  expect(() => jest.advanceTimersByTime(5000)).not.toThrow();
  read.end(); store.setEnabled(false);
});

it("does not report a timeout from an obsolete capture after clearing or stopping", () => {
  const reports: ReconnectReport[] = [];
  const store = new ConnectionDiagnostics(() => 0, (report) => reports.push(report)); store.setEnabled(true);
  const cleared = store.span("history.read"); store.clear(); cleared.mark("http.timeout");
  const stopped = store.span("history.read"); store.setEnabled(false); stopped.mark("http.timeout");
  expect(reports).toEqual([]);
});

it("does not add headers when off, to files, or to writes; captures no query values or bodies", async () => {
  const seen: RequestInit[] = [];
  globalThis.fetch = (async (_url, init) => { seen.push(init ?? {}); return new Response('{"text":"private-message"}'); }) as typeof fetch;
  await diagnosticFetch("/api/pane/conversation?pane_id=private-pane");
  connectionDiagnostics.setEnabled(true);
  await diagnosticFetch("/api/fs/file?path=private-path");
  await diagnosticFetch("/api/pane/prompt", { method: "POST", body: "private-secret" });
  const response = await diagnosticFetch("/api/machines/private-machine/pane/conversation?pane_id=private-pane&from=private-cursor");
  expect(await diagnosticJson<{ text: string }>(response)).toEqual({ text: "private-message" });
  expect(seen.slice(0, 3).every((init) => !new Headers(init.headers).has("x-herdr-timing"))).toBe(true);
  expect(new Headers(seen[3]!.headers).get("x-herdr-timing")).toBe("1");
  const exported = JSON.stringify(connectionDiagnostics.state());
  expect(exported).not.toContain("private-");
  expect(exported).toContain("http.no-remote-timing");
  expect(exported).toContain("http.body"); expect(exported).toContain("http.json");
});

it("records queue time behind a still-pending pre-resume history read without overlapping it", async () => {
  const previous = (globalThis as any).window; (globalThis as any).window = globalThis;
  const coordinator = new ConversationRefresh({ machineId: "private-machine", paneId: "private-pane" });
  const old = Promise.withResolvers<void>();
  let started = 0;
  try {
    coordinator.setRead(() => old.promise); coordinator.refresh(); coordinator.stop();
    connectionDiagnostics.setEnabled(true);
    coordinator.setRead(async () => { started++; }); coordinator.refresh();
    expect(started).toBe(0);
    expect(connectionDiagnostics.state().captures[0]!.events.at(-1)).toMatchObject({ stage: "history.queue", outcome: "pending" });
    old.resolve(); for (let step = 0; step < 10 && started === 0; step++) await Promise.resolve();
    expect(started).toBe(1);
    expect(connectionDiagnostics.state().captures[0]!.events.at(-1)?.outcome).toBe("ok");
  } finally { old.resolve(); coordinator.stop(); (globalThis as any).window = previous; }
});
