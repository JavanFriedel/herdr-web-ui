import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Page } from "playwright-core";
import { buildDemoApp } from "./demo-build.ts";
import panes from "../site/demo/fixtures/panes.json";
import { parseReconnectReport, type ReconnectReport } from "../shared/reconnect-diagnostics.ts";

// Actual client, fictional chat and loopback transport. No user's panes or diagnostic log.
const app = mkdtempSync(join(tmpdir(), "herdr-reconnect-demo-"));
interface Fixture {
  reports: ReconnectReport[];
  reads: number;
  gate: boolean;
  headersReady: boolean;
  bodyReady: boolean;
  aborted: boolean;
  releaseHeaders(): void;
  releaseBody(): void;
}
const fixture = (page: Page) => page.evaluate(() => (window as unknown as { traceQA: Fixture }).traceQA);
const visibility = (page: Page, value: "hidden" | "visible") => page.evaluate(async (value) => {
  Object.defineProperty(document, "visibilityState", { configurable: true, value });
  document.dispatchEvent(new Event("visibilitychange"));
  // Let React commit the hidden cleanup before delivering a resume.
  await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
}, value);
const gateResume = async (page: Page) => {
  await visibility(page, "hidden");
  await page.evaluate(() => Object.assign((window as unknown as { traceQA: Fixture }).traceQA, { gate: true, headersReady: false, bodyReady: false, aborted: false }));
  await visibility(page, "visible");
  await page.waitForFunction(() => (window as unknown as { traceQA: Fixture }).traceQA.headersReady, undefined, { timeout: 5000 });
};

let server: ReturnType<typeof Bun.serve> | undefined;
try {
  await buildDemoApp(app);
  const index = join(app, "index.html");
  const mock = `<script src="./demo-transport.js"></script><script>(() => {
    const qa = window.traceQA = { reports: [], reads: 0, gate: false, headersReady: false, bodyReady: false, aborted: false };
    const original = window.fetch;
    window.fetch = async (input, init) => {
      const path = String(typeof input === "string" ? input : input.url ?? input);
      if (path === "/api/diagnostics/reconnect" && init?.method === "POST") {
        qa.reports.push(JSON.parse(init.body)); return Response.json({ ok: true });
      }
      if (!path.includes("/pane/conversation")) return original(input, init);
      qa.reads++;
      if (!qa.gate) return original(input, init);
      qa.gate = false;
      const response = await original(input, init); const text = await response.text();
      init?.signal?.addEventListener("abort", () => { qa.aborted = true; }, { once: true });
      // Deliberately ignore abort: the deadline/cancellation race must release the coordinator.
      await new Promise((resolve) => { qa.releaseHeaders = resolve; qa.headersReady = true; });
      return new Response(new ReadableStream({ start(controller) {
        controller.enqueue(new TextEncoder().encode(text));
        qa.releaseBody = () => controller.close(); qa.bodyReady = true;
      } }), { headers: { "content-type": "application/json", "server-timing": 'herdr0;dur=20;desc="server.total@0", herdr1;dur=10;desc="rpc.pane.get@2"' } });
    };
  })();</script>`;
  writeFileSync(index, readFileSync(index, "utf8").replace(/<script type="module"/, `${mock}<script type="module"`));
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    const file = path === "/" ? "index.html" : decodeURIComponent(path.slice(1));
    if (file.split("/").includes("..") || file.includes("\\")) return new Response("bad path", { status: 400 });
    const body = Bun.file(join(app, file));
    return await body.exists() ? new Response(body) : new Response("not found", { status: 404 });
  } });
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? "/opt/google/chrome/chrome", headless: true, args: ["--no-sandbox"] });
  try {
    for (const width of [1280, 390, 320]) {
      const context = await browser.newContext({ viewport: { width, height: 844 }, isMobile: width < 640, hasTouch: width < 640 });
      try {
        await context.addInitScript(() => localStorage.setItem("herdr-web-ui:settings", JSON.stringify({ language: "en", voiceInput: "off" })));
        const page = await context.newPage(); const errors: string[] = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await page.goto(`http://127.0.0.1:${server.port}/?pane=${encodeURIComponent(panes.api)}&view=chat`);
        await page.locator(".conn-live").waitFor({ state: "attached" });
        await page.locator(".chat-turn").first().waitFor();
        assert.equal(await page.locator(".connection-diagnostics").count(), 0);

        await gateResume(page);
        const oldReads = (await fixture(page)).reads;
        await visibility(page, "hidden"); await visibility(page, "visible");
        await page.waitForFunction((before) => (window as unknown as { traceQA: Fixture }).traceQA.reads > before, oldReads, { timeout: 2000 });
        assert.equal((await fixture(page)).aborted, true, "background cleanup aborts the obsolete HTTP read");
        assert.equal((await fixture(page)).reports.length, 0, "fast recovery writes no diagnostics");
        assert.equal(await page.getByRole("alert").filter({ hasText: "Chat read timed out." }).count(), 0);
        await page.evaluate(() => (window as unknown as { traceQA: Fixture }).traceQA.releaseHeaders());
        await page.waitForFunction(() => (window as unknown as { traceQA: Fixture }).traceQA.bodyReady, undefined, { timeout: 2000 });
        await page.evaluate(() => (window as unknown as { traceQA: Fixture }).traceQA.releaseBody());
        console.log(`PASS ${width}px: resume starts fresh history without waiting for an obsolete read or showing a timeout`);

        await gateResume(page);
        await page.waitForFunction(() => (window as unknown as { traceQA: Fixture }).traceQA.reports.some((report) => report.trigger === "slow"), undefined, { timeout: 8000 });
        const slow = (await fixture(page)).reports.find((report) => report.trigger === "slow")!;
        assert.ok(parseReconnectReport(slow)); assert.equal(slow.reason, "resume");
        assert.ok(slow.events.some((event) => event.stage === "history.read" && event.outcome === "pending" && event.duration_ms >= 4900));
        await page.evaluate(() => (window as unknown as { traceQA: Fixture }).traceQA.releaseHeaders());
        await page.waitForFunction(() => (window as unknown as { traceQA: Fixture }).traceQA.bodyReady, undefined, { timeout: 2000 });
        await page.evaluate(() => (window as unknown as { traceQA: Fixture }).traceQA.releaseBody());
        await page.waitForFunction(() => (window as unknown as { traceQA: Fixture }).traceQA.reports.some((report) => report.trigger === "recovered"), undefined, { timeout: 5000 });
        const reports = (await fixture(page)).reports;
        assert.deepEqual(reports.map((report) => report.trigger), ["slow", "recovered"]);
        assert.ok(reports.every((report) => parseReconnectReport(report) && report.id === slow.id));
        const recovered = reports.at(-1)!;
        assert.ok(recovered.events.some((event) => event.stage === "rpc.pane.get" && event.clock === "server"));
        assert.ok(recovered.events.some((event) => event.stage === "chat.next-frame" && event.outcome === "ok"));
        assert.ok(!JSON.stringify(reports).includes(panes.api), "reports use episode-local target aliases");
        assert.deepEqual(errors, []);
        console.log(`PASS ${width}px: >5s wait logs once automatically, then records HTTP/server/paint recovery without a trace UI`);
      } finally { await context.close(); }
    }
  } finally { await browser.close(); }
} finally { server?.stop(); rmSync(app, { recursive: true, force: true }); }
