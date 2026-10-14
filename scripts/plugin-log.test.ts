import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { rotateServerLog } from "./plugin-log.ts";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "herdr-web-ui-plugin-log-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("rotateServerLog", () => {
  it("leaves a log at or under the limit where it is", () => {
    const file = join(dir, "server.log");
    writeFileSync(file, "x".repeat(10));
    expect(rotateServerLog(file, 10)).toBe(false);
    expect(readFileSync(file, "utf8")).toBe("x".repeat(10));
  });

  it("sets a larger one aside as server.log.1, replacing the copy before it", () => {
    const file = join(dir, "server.log");
    writeFileSync(`${file}.1`, "older");
    writeFileSync(file, "x".repeat(11));
    expect(rotateServerLog(file, 10)).toBe(true);
    expect(existsSync(file)).toBe(false);
    expect(readFileSync(`${file}.1`, "utf8")).toBe("x".repeat(11));
  });

  it("does nothing when there is no log yet", () => {
    expect(rotateServerLog(join(dir, "server.log"), 10)).toBe(false);
  });
});
