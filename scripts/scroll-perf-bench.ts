/**
 * Terminal scrolling on a phone, measured: a shell with 2000 lines of herdr history, a 390x844
 * touch screen with its CPU slowed 4x, and a link that adds LATENCY_MS each way to every
 * WebSocket frame and scroll request (80 ms round trip by default, about a phone on Tailscale).
 * It drags and flicks with real touch events and reports, per gesture: how long until the first
 * output answers the finger, how long output keeps arriving after the finger lifts, how far herdr
 * scrolled, the frames and bytes each way, and the page's main-thread time.
 *
 *   bun run build && bun scripts/scroll-perf-bench.ts            # LATENCY_MS=40 RUNS=3 CPU=4
 *
 * A benchmark, not a regression: it prints numbers and asserts only that the page scrolled.
 * It runs on the tests' own herdr (test-herdr.ts), never the user's.
 */
import "./test-herdr.ts";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type CDPSession, type Page } from "playwright-core";
import { createServer } from "../server/index.ts";
import { UsageService } from "../server/usage.ts";
import { herdrRpc, paneScroll, paneScrollInfo, workspaceClose, workspaceCreate } from "../server/herdr/client.ts";

const LATENCY_MS = Number(process.env["LATENCY_MS"] ?? 40);
const RUNS = Number(process.env["RUNS"] ?? 3);
const CPU = Number(process.env["CPU"] ?? 4);
const LINES = 2000;

interface Wire { up: { at: number; type: string; bytes: number }[]; down: { at: number; type: string; bytes: number }[] }
interface Result { firstMs: number | null; settleMs: number; lines: number; upFrames: number; upHttp: number; downFrames: number; downKiB: number; taskMs: number; longTasks: number }

const state = realpathSync(mkdtempSync(join(tmpdir(), "herdr-scroll-bench-")));
let workspace: string | undefined;
let server: ReturnType<typeof createServer> | undefined;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Waits until no output frame has arrived for `quietMs`, at most `maxMs`; the time of the last one. */
async function settled(wire: Wire, quietMs = 1200, maxMs = 15_000): Promise<number> {
  const started = Date.now();
  for (;;) {
    const last = wire.down.filter((frame) => frame.type === "pty-data").at(-1)?.at ?? 0;
    if (Date.now() - Math.max(last, started) >= quietMs || Date.now() - started > maxMs) return last;
    // fixed wait: the poll step of a loop bounded by quietMs and maxMs above
    await wait(50);
  }
}

async function taskMs(cdp: CDPSession): Promise<number> {
  const { metrics } = await cdp.send("Performance.getMetrics");
  return (metrics.find((metric) => metric.name === "TaskDuration")?.value ?? 0) * 1000;
}

/** One finger from (x, y0) to (x, y1) in `ms`, a move every frame, lifted `holdMs` after the last move. */
async function swipe(cdp: CDPSession, x: number, y0: number, y1: number, ms: number, holdMs: number): Promise<{ start: number; end: number }> {
  const steps = Math.max(2, Math.round(ms / 16));
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y: y0 }] });
  const start = Date.now();
  for (let step = 1; step <= steps; step += 1) {
    // fixed wait: a finger moves once a frame; the gesture is the timing under test
    await wait(ms / steps);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y: y0 + (y1 - y0) * step / steps }] });
  }
  // fixed wait: the finger rests before it lifts, part of the gesture
  if (holdMs > 0) await wait(holdMs);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  return { start, end: Date.now() };
}

async function gesture(page: Page, cdp: CDPSession, wire: Wire, paneId: string, kind: "drag" | "flick"): Promise<Result> {
  await paneScroll(paneId, 0);
  await settled(wire);
  const box = (await page.locator(".xterm-screen").boundingBox())!;
  const x = box.x + box.width / 2;
  const before = { up: wire.up.length, down: wire.down.length, task: await taskMs(cdp), long: await page.evaluate(() => (window as unknown as { longTasks: number }).longTasks) };
  // the finger moves down: older lines come into view, as in any phone list
  const { start, end } = kind === "drag"
    ? await swipe(cdp, x, box.y + 120, box.y + 620, 1000, 120)
    : await swipe(cdp, x, box.y + 150, box.y + 550, 120, 0);
  const last = await settled(wire);
  const up = wire.up.slice(before.up);
  const down = wire.down.slice(before.down).filter((frame) => frame.type === "pty-data");
  const first = down.find((frame) => frame.at >= start);
  const scroll = await paneScrollInfo(paneId);
  if (process.env["VERBOSE"]) {
    const posts = await page.evaluate(() => { const all = (window as unknown as { scrollPosts: number[] }).scrollPosts; const copy = [...all]; all.length = 0; return copy; });
    console.log(`  ${kind} posts ${posts.length}: gaps ${posts.slice(1).map((at, index) => at - posts[index]!).join(",")}`);
    const kinds = (frames: { type: string }[]) => Object.entries(frames.reduce<Record<string, number>>((all, frame) => ({ ...all, [frame.type]: (all[frame.type] ?? 0) + 1 }), {})).map(([type, n]) => `${type}:${n}`).join(" ");
    console.log(`  ${kind} up ${kinds(up)} | down ${kinds(wire.down.slice(before.down))}`);
  }
  return {
    firstMs: first ? first.at - start : null,
    settleMs: Math.max(0, last - end),
    lines: scroll?.offset_from_bottom ?? -1,
    upFrames: up.filter((frame) => frame.type !== "pty-ack" && frame.type !== "ping" && !frame.type.startsWith("http:")).length,
    upHttp: up.filter((frame) => frame.type === "http:scroll").length,
    downFrames: down.length,
    downKiB: down.reduce((sum, frame) => sum + frame.bytes, 0) / 1024,
    taskMs: (await taskMs(cdp)) - before.task,
    longTasks: (await page.evaluate(() => (window as unknown as { longTasks: number }).longTasks)) - before.long,
  };
}

function report(kind: string, results: Result[]): void {
  const median = (values: number[]) => { const sorted = [...values].sort((a, b) => a - b); return sorted[Math.floor(sorted.length / 2)] ?? 0; };
  const pick = (key: keyof Result) => median(results.map((result) => Number(result[key] ?? -1)));
  console.log(`${kind.padEnd(6)} first ${pick("firstMs").toFixed(0).padStart(5)} ms | after lift ${pick("settleMs").toFixed(0).padStart(5)} ms | scrolled ${String(pick("lines")).padStart(4)} lines`
    + ` | up ${String(pick("upFrames")).padStart(3)} ws + ${pick("upHttp")} http | down ${String(pick("downFrames")).padStart(3)} frames ${pick("downKiB").toFixed(1).padStart(6)} KiB`
    + ` | main thread ${pick("taskMs").toFixed(0).padStart(5)} ms, ${pick("longTasks")} long tasks`);
}

try {
  const made = await workspaceCreate({ cwd: state, label: "herdr-web-ui-test-scroll-bench" });
  workspace = made.workspace.workspace_id;
  const paneId = made.root_pane.pane_id;
  const ready = herdrRpc("pane.wait_for_output", { pane_id: paneId, source: "visible", match: { type: "substring", value: "bench_2_ready" }, timeout_ms: 20000 }, undefined, 22000);
  await herdrRpc("pane.send_input", { pane_id: paneId, text: `for i in $(seq 1 ${LINES}); do printf '\\033[3%dm%05d\\033[0m lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod\\n' $((i%7+1)) $i; done; echo bench_$((1+1))_ready`, keys: ["enter"] });
  await ready;
  const history = (await paneScrollInfo(paneId))?.max_offset_from_bottom ?? 0;
  assert.ok(history > 500, `the shell holds the lines as herdr history (${history})`);

  server = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir: join(state, "state"), usage: new UsageService(undefined, []) });
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? chromium.executablePath(), headless: true, args: ["--no-sandbox"] });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3, locale: "en-US" });
  await context.addInitScript(() => {
    if (localStorage.getItem("herdr-web-ui:settings") === null) localStorage.setItem("herdr-web-ui:settings", JSON.stringify({ language: "en", defaultView: "terminal", alertsOn: false }));
    const posts: number[] = [];
    (window as unknown as { scrollPosts: number[] }).scrollPosts = posts;
    const original = window.fetch.bind(window);
    window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input instanceof Request ? input.url : input).includes("/api/pane/scroll") && (init?.method ?? "GET") === "POST") posts.push(Math.round(performance.now()));
      return original(input, init);
    };
    const counter = window as unknown as { longTasks: number };
    counter.longTasks = 0;
    try { new PerformanceObserver((list) => { counter.longTasks += list.getEntries().length; }).observe({ type: "longtask", buffered: false }); } catch { /* unsupported */ }
  });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const wire: Wire = { up: [], down: [] };
  // the link: every frame both ways, and every scroll request, LATENCY_MS late
  await page.routeWebSocket(/\/ws(?:\?|$)/, (socket) => {
    const upstream = socket.connectToServer();
    upstream.onMessage((raw) => {
      const text = String(raw);
      let type = "?"; try { type = (JSON.parse(text) as { type: string }).type; } catch { /* binary */ }
      setTimeout(() => { wire.down.push({ at: Date.now(), type, bytes: Buffer.byteLength(text) }); socket.send(raw); }, LATENCY_MS);
    });
    socket.onMessage((raw) => {
      const text = String(raw);
      let type = "?"; try { type = (JSON.parse(text) as { type: string }).type; } catch { /* binary */ }
      wire.up.push({ at: Date.now(), type, bytes: Buffer.byteLength(text) });
      setTimeout(() => upstream.send(raw), LATENCY_MS);
    });
  });
  await page.route(/\/api\/pane\/scroll/, async (route) => {
    if (route.request().method() === "POST") wire.up.push({ at: Date.now(), type: "http:scroll", bytes: 0 });
    // fixed wait: the simulated link delay is the condition under test
    await wait(LATENCY_MS);
    const response = await route.fetch();
    // fixed wait: the simulated link delay, on the way back
    await wait(LATENCY_MS);
    await route.fulfill({ response });
  });
  const cdp = await context.newCDPSession(page);
  await cdp.send("Performance.enable");
  await page.goto(`http://127.0.0.1:${server.port}/?pane=${encodeURIComponent(paneId)}&view=terminal`);
  await page.locator(".conn-live").waitFor({ state: "attached", timeout: 20_000 });
  await page.locator(".xterm-screen").waitFor();
  await page.getByText("bench_2_ready").first().waitFor({ timeout: 20_000 }).catch(() => undefined);
  await settled(wire, 1500);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: CPU });

  console.log(`scroll bench: ${LATENCY_MS} ms each way, CPU ${CPU}x, ${RUNS} runs, median per gesture`);
  for (const kind of ["drag", "flick"] as const) {
    const results: Result[] = [];
    for (let run = 0; run < RUNS; run += 1) results.push(await gesture(page, cdp, wire, paneId, kind));
    assert.ok(results.every((result) => result.lines > 0), `${kind}: herdr scrolled back into history`);
    report(kind, results);
  }
  assert.deepEqual(errors, []);
} finally {
  await browser?.close();
  server?.stop(true);
  if (workspace) await workspaceClose(workspace).catch(() => undefined);
  rmSync(state, { recursive: true, force: true });
}
