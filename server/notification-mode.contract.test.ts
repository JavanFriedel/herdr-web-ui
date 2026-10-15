import { describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { isolate } from "../scripts/check.ts";
import { disposableConfig } from "../scripts/disposable-config.ts";
import { DesktopNotifications, herdrConfigPath } from "./desktop-notifications.ts";
import { NotificationModes } from "./notification-mode.ts";
import { createServer } from "./index.ts";
import { herdrSocketPath, ping, serverReloadConfig, sessionSnapshot, workspaceCreate } from "./herdr/client.ts";
import { shellQuote } from "./machine-security.ts";

describe("notification modes through the Herdr plugin", () => {
  it.skipIf(disposableConfig(process.env, herdrSocketPath()) === null || process.platform !== "linux")("opens the real popup, applies Mobile immediately and restores Desktop without restarting panes", async () => {
    // Native config and the plugin registry are per user, not per session. Give
    // this fixture its own config too, so sibling browser/integration lanes cannot see it.
    const isolation = isolate({ ...process.env, CHECK_DIR: undefined });
    const env: Record<string, string | undefined> = { ...isolation.env, TERM: "xterm-256color" };
    for (const key of ["HERDR_CONFIG_PATH", "HERDR_CLIENT_SOCKET_PATH"]) delete env[key];
    const session = isolation.env["HERDR_TEST_SESSION"]!;
    const socket = join(isolation.sessions, session, "herdr.sock");
    const configRoot = disposableConfig(env, socket)!;
    expect(configRoot).not.toBeNull();
    const root = mkdtempSync(join(tmpdir(), "herdr-notifications-contract-"));
    const config = herdrConfigPath(env);
    const previous = existsSync(config) ? readFileSync(config, "utf8") : null;
    const original = 'onboarding = false\n[ui.toast]\ndelivery = "herdr"\n[ui.sound]\nenabled = true\n[[keys.command]]\nkey = "prefix+shift+m"\ntype = "plugin_action"\ncommand = "devswha.herdr-web-ui.notifications"\ndescription = "notification fixture"\n';
    mkdirSync(join(config, ".."), { recursive: true });
    writeFileSync(config, original);
    const modes = new NotificationModes(root, new DesktopNotifications(config, () => serverReloadConfig(socket)));
    const app = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir: join(root, "app"), notificationModes: modes });
    const binary = process.env["HERDR_WEB_HERDR_BIN"] || Bun.which("herdr")!;
    const pluginId = "devswha.herdr-web-ui";
    const pluginConfig = join(configRoot, "herdr", "plugins", "config", pluginId);
    const origin = `http://127.0.0.1:${app.port}`;
    let tui: ReturnType<typeof Bun.spawn> | undefined;
    let native: ReturnType<typeof Bun.spawn> | undefined;
    let screen = "";
    const wait = async (ready: () => boolean | Promise<boolean>, label: string) => {
      for (const deadline = Date.now() + 10_000; !(await ready());) {
        if (Date.now() > deadline) throw new Error(`${label}: ${stripVTControlCharacters(screen).slice(-4000)}`);
        await Bun.sleep(25);
      }
    };
    try {
      const zdotdir = join(root, "zdotdir");
      mkdirSync(zdotdir); writeFileSync(join(zdotdir, ".zshrc"), "");
      native = Bun.spawn([binary, "--session", session, "server"], { env: { ...env, ZDOTDIR: zdotdir }, stdin: "ignore", stdout: Bun.file(join(root, "native.log")), stderr: Bun.file(join(root, "native.log")) });
      await wait(() => ping(socket).then(() => true, () => false), "fixture Herdr did not start");
      await workspaceCreate({ cwd: root, label: "notification-mode-fixture" }, socket);
      const linked = Bun.spawnSync([binary, "plugin", "link", resolve(import.meta.dir, "..")], { env, stdout: "pipe", stderr: "pipe" });
      expect(linked.exitCode, linked.stderr.toString()).toBe(0);
      mkdirSync(pluginConfig, { recursive: true });
      writeFileSync(join(pluginConfig, "env"), `PORT=${app.port}\nHOST=127.0.0.1\nHERDR_WEB_STATE_DIR=${root}\n`);
      await serverReloadConfig(socket);
      const before = await sessionSnapshot(socket);
      await modes.set("desktop");
      tui = Bun.spawn(["script", "-qefc", `stty rows 20 cols 60; exec ${shellQuote(binary)} --session ${shellQuote(session)}`, "/dev/null"], { env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
      const input = tui.stdin as import("bun").FileSink;
      const reading = (async () => {
        const reader = (tui!.stdout as ReadableStream<Uint8Array>).getReader();
        const decoder = new TextDecoder();
        for (;;) { const next = await reader.read(); if (next.done) break; screen = (screen + decoder.decode(next.value, { stream: true })).slice(-200_000); }
      })();
      await wait(() => stripVTControlCharacters(screen).toLowerCase().includes("herdr"), "Herdr client did not render");
      input.write("\x02M"); await input.flush();
      await wait(() => stripVTControlCharacters(screen).replace(/\s+/g, "").includes("Current:Desktop"), "notification popup did not open");
      input.write("j\r"); await input.flush();
      await wait(async () => (await (await fetch(`${origin}/api/notifications/mode`)).json()).mode === "mobile", "Mobile was not confirmed");
      expect(Bun.TOML.parse(readFileSync(config, "utf8"))).toMatchObject({ ui: { toast: { delivery: "off" }, sound: { enabled: false } } });
      screen = "";
      input.write("\x02M"); await input.flush();
      await wait(() => stripVTControlCharacters(screen).replace(/\s+/g, "").includes("Current:Mobile"), "popup did not show saved Mobile mode");
      // Read the rendered location: Herdr centers popups in its pane surface,
      // not the entire outer terminal (desktop and narrow layouts differ).
      const header = screen.lastIndexOf("Current:");
      const move = [...screen.slice(0, header).matchAll(/\x1b\[(\d+);(\d+)H/g)].at(-1);
      expect(move).toBeDefined();
      const row = Number(move![1]) + 2;
      const column = Number(move![2]) + 6;
      input.write(`\x1b[<0;${column};${row}M\x1b[<0;${column};${row}m`); await input.flush();
      await wait(() => modes.status().mode === "desktop", "Desktop was not restored");
      expect(readFileSync(config, "utf8")).toBe(original);
      const after = await sessionSnapshot(socket);
      expect(after.panes.map((pane) => [pane.pane_id, pane.terminal_id])).toEqual(before.panes.map((pane) => [pane.pane_id, pane.terminal_id]));
      tui.kill("SIGTERM");
      await tui.exited;
      await reading;
    } finally {
      if (tui && tui.exitCode === null) tui.kill("SIGTERM");
      app.stop();
      Bun.spawnSync([binary, "plugin", "unlink", pluginId], { env, stdout: "ignore", stderr: "ignore" });
      if (previous === null) rmSync(config, { force: true }); else writeFileSync(config, previous);
      if (native && native.exitCode === null) {
        const stopped = Bun.spawnSync([binary, "--session", session, "server", "stop"], { env, timeout: 10_000, stdout: "pipe", stderr: "pipe" });
        if (stopped.exitCode !== 0) throw new Error(`Owned notification fixture did not stop; config retained at ${configRoot}`);
        await wait(() => ping(socket).then(() => false, () => true), "fixture Herdr did not stop");
        await native.exited;
      }
      isolation.remove();
      rmSync(root, { recursive: true, force: true });
    }
  }, 45_000);
});
