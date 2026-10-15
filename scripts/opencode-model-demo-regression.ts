import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { buildDemoApp } from "./demo-build.ts";
import { appFaces } from "./app-faces.ts";
import panes from "../site/demo/fixtures/panes.json";

// The real client + fictional demo transport. No user's terminals, credentials or OpenCode service.
const app = mkdtempSync(join(tmpdir(), "herdr-model-picker-browser-"));
let server: ReturnType<typeof Bun.serve> | undefined;
try {
  await buildDemoApp(app);
  const index = join(app, "index.html");
  const patch = `<script>(() => {
    const TARGET = ${JSON.stringify(panes.api)};
    const clone = structuredClone;
    const fix = (value) => {
      if (!value || typeof value !== "object") return value;
      if (Array.isArray(value)) { value.forEach(fix); return value; }
      if (value.pane_id === TARGET && "agent_status" in value) Object.assign(value, { agent: window.qaAgent, agent_status: "idle", background_tasks: 0 });
      if (!window.qaFixtureReady && value.metadata && Array.isArray(value.turns)) value.metadata = { model: "gpt-6.1", reasoning_effort: "low" };
      Object.values(value).forEach(fix); return value;
    };
    window.structuredClone = (value, options) => fix(clone(value, options));
    const parse = JSON.parse;
    JSON.parse = (text, reviver) => fix(parse(text, reviver));
    const json = Response.prototype.json;
    Response.prototype.json = async function () { return fix(await json.call(this)); };
  })();</script><script src="./demo-transport.js"></script><script>(() => {
    window.qaFixtureReady = true;
    window.modelWrites = []; window.terminalSubmits = [];
    const original = window.fetch;
    window.fetch = async (input, init) => {
      const path = String(typeof input === "string" ? input : input.url ?? input);
      if (path.includes("/pane/commands") && window.qaOlder) return Response.json({ commands: [] });
      if (path.includes("/pane/models") && window.qaFail) return Response.json({ error: { code: "opencode_unavailable", message: "Fixture connection unavailable" } }, { status: 502 });
      if (path.endsWith("/pane/model")) {
        window.modelWrites.push(JSON.parse(init.body));
        if (window.qaStale) return Response.json({ error: { code: "model_changed", message: "The session's model changed. Reopen the model selector." } }, { status: 409 });
      }
      return original(input, init);
    };
    const Socket = window.WebSocket;
    const Wrapped = function (...args) {
      const socket = new Socket(...args); const send = socket.send.bind(socket);
      socket.send = (value) => { const message = JSON.parse(value); if (["submit", "input"].includes(message.type)) window.terminalSubmits.push(message); return send(value); };
      return socket;
    };
    Object.assign(Wrapped, { CONNECTING: Socket.CONNECTING, OPEN: Socket.OPEN, CLOSING: Socket.CLOSING, CLOSED: Socket.CLOSED });
    window.WebSocket = Wrapped;
  })();</script>`;
  writeFileSync(index, readFileSync(index, "utf8").replace(/<script type="module"/, `${patch}<script type="module"`));
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
      const page = await context.newPage();
      try {
        await context.addInitScript(() => {
          Object.assign(window, { qaAgent: "opencode" });
          localStorage.setItem("herdr-web-ui:settings", JSON.stringify({ language: "en", voiceInput: "off" }));
        });
        const errors: string[] = []; page.on("pageerror", (error) => errors.push(error.message));
        await page.goto(`http://127.0.0.1:${server.port}/?pane=${encodeURIComponent(panes.api)}&view=chat`);
        await page.locator(".conn-live").waitFor({ state: "attached" });
        await appFaces(page);
        const message = page.getByRole("textbox", { name: "Message", exact: true });
        const model = page.getByRole("button", { name: "Choose a model", exact: true });
        const effort = page.getByRole("button", { name: "Choose reasoning effort", exact: true });
        await model.waitFor(); await effort.waitFor();
        await message.fill("Keep this unsent draft");
        if (process.env.EVIDENCE_DIR) await page.screenshot({ path: join(process.env.EVIDENCE_DIR, `opencode-composer-${width}.png`) });
        await model.click();
        const dialog = page.getByRole("dialog", { name: "Choose a model", exact: true });
        await dialog.getByRole("searchbox").fill("anthropic sonnet");
        if (process.env.EVIDENCE_DIR) {
          await page.waitForFunction(() => document.querySelector(".model-picker")?.getAnimations().every((animation) => animation.playState !== "running"), undefined, { timeout: 5_000 });
          await page.screenshot({ path: join(process.env.EVIDENCE_DIR, `opencode-picker-${width}.png`) });
        }
        await dialog.getByRole("button", { name: /Sonnet 5/ }).click();
        const variants = page.getByRole("dialog", { name: "Choose reasoning effort", exact: true });
        await variants.getByRole("button", { name: "high", exact: true }).click();
        await variants.waitFor({ state: "detached" });
        await page.waitForFunction(() => document.querySelector(".composer-model")?.textContent?.includes("Sonnet 5"));
        assert.equal(await message.inputValue(), "Keep this unsent draft");
        assert.equal(await page.evaluate(() => (window as unknown as { terminalSubmits: unknown[] }).terminalSubmits.length), 0);
        await effort.click();
        await page.getByRole("dialog").getByRole("button", { name: "Default", exact: true }).click();
        await page.getByRole("dialog").waitFor({ state: "detached" });
        await page.waitForFunction(() => document.querySelector(".composer-reasoning")?.textContent === "Default");
        assert.equal(await message.inputValue(), "Keep this unsent draft");

        // Both supported commands open the picker rather than submitting a prompt to OpenCode.
        for (const command of ["/model", "/models", "/variants"]) {
          await message.fill(command); await page.locator(".composer-send").click();
          await page.getByRole("dialog").waitFor();
          await page.getByRole("dialog").getByRole("button", { name: "Cancel", exact: true }).click();
          assert.equal(await message.inputValue(), "");
        }
        assert.equal(await page.evaluate(() => (window as unknown as { terminalSubmits: unknown[] }).terminalSubmits.length), 0);

        await page.evaluate(() => Object.assign(window, { qaFail: true }));
        await model.click(); await page.getByRole("alert").filter({ hasText: "Fixture connection unavailable" }).waitFor();
        await page.evaluate(() => Object.assign(window, { qaFail: false }));
        await page.getByRole("dialog").getByRole("button", { name: "Reload models" }).click();
        await page.getByRole("searchbox").waitFor();
        await page.getByRole("dialog").getByRole("button", { name: "Cancel" }).click();

        // A 409 disables choices and never retries the mutation behind the user's back.
        await page.evaluate(() => Object.assign(window, { qaStale: true }));
        await effort.click(); await page.getByRole("dialog").getByRole("button", { name: "high", exact: true }).click();
        await page.getByRole("alert").filter({ hasText: "session's model changed" }).waitFor();
        assert.equal(await page.getByRole("dialog").getByRole("button", { name: "high", exact: true }).isDisabled(), true);
        const writes = await page.evaluate(() => (window as unknown as { modelWrites: unknown[] }).modelWrites);
        assert.equal(writes.length, 3);
        assert.equal((writes[0] as { pane_id: string }).pane_id, panes.api);
        await page.getByRole("dialog").getByRole("button", { name: "Cancel" }).click();
        if (width === 1280) {
          await model.focus(); await page.keyboard.press("Enter"); await page.getByRole("searchbox").waitFor();
          await page.getByRole("searchbox").fill("sonnet"); await page.keyboard.press("ArrowDown");
          assert.equal(await page.getByRole("dialog").getByRole("button", { name: /Sonnet 5/ }).evaluate((element) => element === document.activeElement), true);
          await page.keyboard.press("Enter");
          await page.getByRole("dialog").getByRole("button", { name: "Default", exact: true }).waitFor();
          assert.equal(await page.getByRole("dialog").getByRole("button", { name: "Default", exact: true }).evaluate((element) => element === document.activeElement), true);
          await page.keyboard.press("ArrowDown");
          assert.equal(await page.getByRole("dialog").getByRole("button", { name: "low", exact: true }).evaluate((element) => element === document.activeElement), true);
          await page.keyboard.press("Escape"); assert.equal(await model.evaluate((element) => element === document.activeElement), true);
        }
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false);
        assert.deepEqual(errors, []);
        console.log(`PASS OpenCode model/effort selectors at ${width}px: drafts, commands, defaults, failures, stale writes and focus`);
      } catch (error) {
        if (process.env.EVIDENCE_DIR) await page.screenshot({ path: join(process.env.EVIDENCE_DIR, `opencode-model-${width}-failed.png`) }).catch(() => {});
        console.error(await page.locator(".composer-status").innerHTML().catch(() => "No composer status"));
        throw error;
      } finally { await context.close(); }
    }
    for (const scenario of [{ agent: "claude", older: false }, { agent: "opencode", older: true }]) {
      const context = await browser.newContext({ viewport: { width: 1280, height: 844 } });
      try {
        await context.addInitScript((scenario) => { Object.assign(window, { qaAgent: scenario.agent, qaOlder: scenario.older }); }, scenario);
        const page = await context.newPage();
        await page.goto(`http://127.0.0.1:${server.port}/?pane=${encodeURIComponent(panes.api)}&view=chat`);
        await page.locator(".composer-model").waitFor();
        assert.equal(await page.locator("button.composer-model-control").count(), 0);
      } finally { await context.close(); }
    }
    console.log("PASS other agents and old remote bridges retain read-only model labels");
  } finally { await browser.close(); }
} finally { server?.stop(); rmSync(app, { recursive: true, force: true }); }
