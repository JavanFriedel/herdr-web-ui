import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createRequestLog, requestLogFromEnv, SLOW_REQUEST_MS, type RequestLogEntry } from "./request-log.ts";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "herdr-web-ui-request-log-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const at = () => new Date("2026-10-13T20:00:00.000Z");
const get = (path: string) => new Request(`http://127.0.0.1:7317${path}`);
const errorAnswer = (status: number, code: string, message: string) =>
  new Response(JSON.stringify({ error: { code, message } }), { status, headers: { "content-type": "application/json" } });
const lines = (file: string): RequestLogEntry[] =>
  existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as RequestLogEntry) : [];

describe("what the request log writes", () => {
  it("writes a failed request with its pane, duration and the error the client got", async () => {
    const log = createRequestLog({ dir, now: at });
    const answer = errorAnswer(502, "timeout", "herdr session.snapshot timed out after 10000ms");
    await log.observe(get("/api/pane/conversation?pane_id=w16%3ApB&path=%2Fhome%2Fsecret"), answer, 10_012.4);
    expect(lines(log.file)).toEqual([{
      t: "2026-10-13T20:00:00.000Z", status: 502, method: "GET", path: "/api/pane/conversation", pane: "w16:pB",
      ms: 10_012, slow: true, code: "timeout", message: "herdr session.snapshot timed out after 10000ms",
    }]);
    // the client still reads the body the log read a copy of
    expect(((await answer.json()) as { error: { code: string } }).error.code).toBe("timeout");
  });

  it("writes a slow request that succeeded, and nothing for a quick one or a client error", async () => {
    const log = createRequestLog({ dir, now: at, slowMs: 1_000 });
    await log.observe(get("/api/session"), new Response("{}"), 20);
    await log.observe(get("/api/pane/conversation?pane_id=p1"), errorAnswer(404, "pane_not_found", "no pane"), 15);
    await log.observe(get("/api/session"), new Response("{}"), 1_500);
    expect(lines(log.file)).toEqual([{ t: "2026-10-13T20:00:00.000Z", status: 200, method: "GET", path: "/api/session", ms: 1_500, slow: true }]);
  });

  it("writes only failures when slowMs is 0", async () => {
    const log = createRequestLog({ dir, slowMs: 0 });
    await log.observe(get("/api/session"), new Response("{}"), 60_000);
    expect(lines(log.file)).toEqual([]);
  });

  it("does not read a body it cannot parse", async () => {
    const log = createRequestLog({ dir, now: at });
    await log.observe(get("/"), new Response("Bad Gateway", { status: 502, headers: { "content-type": "text/plain" } }), 3);
    await log.observe(get("/api/x"), new Response(new Uint8Array([31, 139]), { status: 500, headers: { "content-type": "application/json", "content-encoding": "gzip" } }), 3);
    expect(lines(log.file).map((entry) => [entry.status, entry.code])).toEqual([[502, undefined], [500, undefined]]);
  });
});

describe("rotation", () => {
  it("moves a full log to .1, shifts the older ones and drops the one past keep", async () => {
    const log = createRequestLog({ dir, now: at, maxBytes: 400, keep: 2 });
    for (let index = 0; index < 12; index++) await log.observe(get(`/api/pane/conversation?pane_id=p${index}`), errorAnswer(502, "timeout", "x"), 10_000);
    const files = ["", ".1", ".2", ".3"].map((suffix) => `${log.file}${suffix}`);
    expect(files.map((file) => existsSync(file))).toEqual([true, true, true, false]);
    for (const file of files.slice(0, 3)) expect(statSync(file).size).toBeLessThanOrEqual(400);
    // newest last in the live file, and nothing lost between the live file and .1
    const live = lines(files[0]!).map((entry) => entry.pane);
    expect(live.at(-1)).toBe("p11");
    expect(lines(files[1]!).at(-1)?.pane).toBe(`p${11 - live.length}`);
  });

  it("keeps counting from a log an earlier server left", async () => {
    await createRequestLog({ dir, now: at }).observe(get("/a"), errorAnswer(500, "internal_error", "x"), 1);
    const before = statSync(join(dir, "requests.log")).size;
    const log = createRequestLog({ dir, now: at, maxBytes: before + 10 });
    await log.observe(get("/a"), errorAnswer(500, "internal_error", "x"), 1);
    expect(existsSync(`${log.file}.1`)).toBe(true);
    expect(lines(log.file)).toHaveLength(1);
  });
});

describe("configuration", () => {
  it("logs under <stateDir>/logs, with HERDR_WEB_SLOW_REQUEST_MS as the slow threshold", async () => {
    const log = requestLogFromEnv(dir, { HERDR_WEB_SLOW_REQUEST_MS: "50" });
    expect(log.file).toBe(join(dir, "logs", "requests.log"));
    await log.observe(get("/api/session"), new Response("{}"), 60);
    expect(lines(log.file)).toHaveLength(1);
    // a value that is no duration keeps the default
    const fallback = requestLogFromEnv(join(dir, "other"), { HERDR_WEB_SLOW_REQUEST_MS: "soon" });
    await fallback.observe(get("/api/session"), new Response("{}"), SLOW_REQUEST_MS - 1);
    expect(lines(fallback.file)).toEqual([]);
  });
});
