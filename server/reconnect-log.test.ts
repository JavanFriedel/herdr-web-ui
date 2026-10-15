import { afterEach, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReconnectLog, handleReconnectLog } from "./reconnect-log.ts";
import { parseReconnectReport, type ReconnectReport } from "../shared/reconnect-diagnostics.ts";

const roots: string[] = [];
const root = () => { const path = mkdtempSync(join(tmpdir(), "herdr-reconnect-log-")); roots.push(path); return path; };
const report = (): ReconnectReport => ({ id: crypto.randomUUID(), reason: "resume", trigger: "slow", elapsed_ms: 5000,
  events: [{ id: 1, stage: "history.queue", clock: "browser", start_ms: 0, duration_ms: 5000, outcome: "pending", target: "target-1" }] });
afterEach(() => { for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }); });

it("writes bounded private local records atomically and reloads them", () => {
  let now = Date.now(); const path = root(); const log = new ReconnectLog(path, () => now);
  const first = report(); expect(log.record(first)).toBe("saved"); expect(log.record(first)).toBe("duplicate");
  for (let index = 0; index < 50; index++) { now += 60_001; const next = report(); next.events = Array.from({ length: 64 }, (_, id) => ({ ...next.events[0]!, id: id + 1, parent: 999999999, status: 65535, route: "pane/conversation", start_ms: 300000, duration_ms: 300000 })); log.record(next); }
  expect(log.list().length).toBeLessThanOrEqual(32); expect(statSync(log.file).size).toBeLessThanOrEqual(256 * 1024);
  expect(new ReconnectLog(path).list()).toEqual(log.list());
  expect(readdirSync(join(path, "logs"))).toEqual(["reconnect.json"]);
  if (process.platform !== "win32") { expect(statSync(log.file).mode & 0o777).toBe(0o600); expect(statSync(join(path, "logs")).mode & 0o777).toBe(0o700); }
  expect(readFileSync(log.file, "utf8")).not.toContain("private");
});

it("limits writes even when reports use unique IDs", () => {
  const log = new ReconnectLog(root());
  for (let index = 0; index < 30; index++) expect(log.record(report())).toBe("saved");
  expect(log.record(report())).toBe("limited");
});

it("rejects raw content, identities, unknown fields and invalid numeric or enum values", () => {
  const value = report();
  for (const invalid of [
    { ...value, message: "private prompt" }, { ...value, id: "private-device" }, { ...value, reason: ["resume"] }, { ...value, elapsed_ms: Infinity },
    { ...value, events: [{ ...value.events[0], target: "private-machine" }] },
    { ...value, events: [{ ...value.events[0], route: "/private/file" }] },
    { ...value, events: [{ ...value.events[0], error: "private error" }] },
    { ...value, events: [{ ...value.events[0], stage: "private-secret" }] },
    { ...value, events: Array(65).fill(value.events[0]) },
  ]) expect(parseReconnectReport(invalid)).toBeNull();
});

it("enforces same-origin, the custom header and streaming body limits", async () => {
  const log = new ReconnectLog(root()); const value = report();
  const post = (body: string, headers: Record<string, string> = {}) => new Request("http://localhost/api/diagnostics/reconnect", { method: "POST", headers, body });
  expect((await handleReconnectLog(post(JSON.stringify(value)), log)).status).toBe(403);
  expect((await handleReconnectLog(post(JSON.stringify(value), { "x-herdr-machine": "1", origin: "https://untrusted.invalid" }), log)).status).toBe(403);
  expect((await handleReconnectLog(post("x".repeat(32769), { "x-herdr-machine": "1" }), log)).status).toBe(413);
  expect((await handleReconnectLog(post(JSON.stringify(value), { "x-herdr-machine": "1" }), log)).status).toBe(200);
  const response = await handleReconnectLog(new Request("http://localhost/api/diagnostics/reconnect"), log);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect((await response.json()).records).toHaveLength(1);
});
