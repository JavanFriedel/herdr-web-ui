import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createPresenceCheck, presenceFromEnv, shellArgv } from "./presence.ts";

let dir: string;
let logged: string[];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "herdr-web-ui-presence-"));
  logged = [];
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const log = (message: string): void => { logged.push(message); };

describe("the presence command's answer", () => {
  it("takes exit 0 as at the PC and exit 1 as away, quietly", async () => {
    expect(await createPresenceCheck({ command: "exit 0", log })()).toBe(true);
    expect(await createPresenceCheck({ command: "exit 1", log })()).toBe(false);
    expect(logged).toEqual([]);
  });

  it("takes any other exit as away and says so", async () => {
    expect(await createPresenceCheck({ command: "exit 3", log })()).toBe(false);
    expect(logged).toEqual(["presence command exited 3; alerts go out"]);
  });

  it("takes a command the shell cannot find as away", async () => {
    expect(await createPresenceCheck({ command: join(dir, "missing-presence-command"), log })()).toBe(false);
    expect(logged).toHaveLength(1);
  });

  it("stops a command still running at the deadline and lets alerts through", async () => {
    const started = Date.now();
    expect(await createPresenceCheck({ command: "sleep 5; exit 0", timeoutMs: 100, log })()).toBe(false);
    expect(Date.now() - started).toBeLessThan(4_000);
    expect(logged).toEqual(["presence command still ran after 100 ms; alerts go out"]);
  });
});

describe("runs of the presence command", () => {
  const runs = (): number => {
    try { return readFileSync(join(dir, "runs"), "utf8").length; } catch { return 0; }
  };

  it("answers again from the last run until it is older than reuseMs", async () => {
    let clock = 1_000;
    const check = createPresenceCheck({ command: `printf x >> '${join(dir, "runs")}'; exit 0`, reuseMs: 500, now: () => clock, log });
    expect(await check()).toBe(true);
    clock += 499;
    expect(await check()).toBe(true);
    expect(runs()).toBe(1);
    clock += 1;
    expect(await check()).toBe(true);
    expect(runs()).toBe(2);
  });

  it("shares one run between alerts that ask while it runs", async () => {
    const check = createPresenceCheck({ command: `printf x >> '${join(dir, "runs")}'; exit 1`, reuseMs: 0, log });
    expect(await Promise.all([check(), check(), check()])).toEqual([false, false, false]);
    expect(runs()).toBe(1);
  });
});

describe("configuration", () => {
  it("runs the line through the platform's shell", () => {
    expect(shellArgv("idle-check --max 180", "linux")).toEqual(["sh", "-c", "idle-check --max 180"]);
    expect(shellArgv("idle-check.cmd", "win32")).toEqual(["cmd.exe", "/d", "/s", "/c", "idle-check.cmd"]);
  });

  it("has no check when HERDR_WEB_PRESENCE_CMD is unset or blank", () => {
    expect(presenceFromEnv({})).toBeUndefined();
    expect(presenceFromEnv({ HERDR_WEB_PRESENCE_CMD: "  " })).toBeUndefined();
    expect(presenceFromEnv({ HERDR_WEB_PRESENCE_CMD: "exit 0" })).toBeFunction();
  });
});
