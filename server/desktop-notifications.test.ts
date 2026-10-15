import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DesktopNotifications, herdrConfigPath } from "./desktop-notifications.ts";

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "herdr-desktop-alerts-")); });
afterEach(() => rmSync(root, { recursive: true, force: true }));
const desktop = () => new DesktopNotifications(join(root, "config.toml"), async () => {});

describe("desktop settings preservation", () => {
  it("preserves BOM, CRLF, comments and unrelated tables", () => {
    const content = '\uFEFF# config\r\n[ui.toast]\r\ndelivery = "herdr" # comment\r\n[ui.sound]\r\nenabled = true\r\n[theme]\r\nname = "terminal"\r\n';
    const settings = desktop();
    const captured = settings.capture(content);
    const muted = settings.mute(content);
    expect(muted.startsWith("\uFEFF")).toBe(true);
    expect(muted).not.toMatch(/(?<!\r)\n/);
    expect(settings.restore(muted, captured)).toBe(content);
  });
  it("restores absent fields and legacy toast settings rather than inventing new preferences", () => {
    const content = "[ui.toast]\nenabled = true\n";
    const settings = desktop();
    const restored = settings.restore(settings.mute(content), settings.capture(content));
    const parsed = Bun.TOML.parse(restored);
    expect(parsed).toEqual({ ui: { toast: { enabled: true }, sound: {} } });
  });
  it("rejects invalid TOML and unsupported inline notification tables before editing", () => {
    expect(() => desktop().mute("[ui.toast\n")).toThrow("invalid");
    expect(() => desktop().mute('[ui]\ntoast = { delivery = "system" }\n')).toThrow("tables");
  });
  it("does not overwrite a concurrent config edit", () => {
    const settings = desktop();
    writeFileSync(settings.path, "# changed\n");
    expect(() => settings.write("# earlier\n", "# new\n")).toThrow("changed during");
    expect(readFileSync(settings.path, "utf8")).toBe("# changed\n");
  });
  it.skipIf(process.platform === "win32")("updates a config symlink's target without replacing the symlink", () => {
    const target = join(root, "dotfile.toml");
    writeFileSync(target, "# dotfile\n");
    symlinkSync(target, join(root, "config.toml"));
    const settings = desktop();
    settings.write(settings.read(), "# updated\n");
    expect(readFileSync(target, "utf8")).toBe("# updated\n");
    expect(settings.path).toBe(target);
  });
  it.skipIf(process.platform === "win32")("does not restore a snapshot into a newly retargeted config symlink", () => {
    const first = join(root, "first.toml");
    const second = join(root, "second.toml");
    const link = join(root, "config.toml");
    writeFileSync(first, '[ui.toast]\ndelivery = "herdr"\n');
    writeFileSync(second, '[ui.toast]\ndelivery = "system"\n');
    symlinkSync(first, link);
    const settings = desktop();
    const snapshot = settings.capture(settings.read());
    rmSync(link); symlinkSync(second, link);
    expect(() => settings.restore(settings.read(), snapshot)).toThrow("configuration path changed");
    expect(() => settings.write(settings.read(), "", snapshot.config_path)).toThrow("configuration path changed");
    expect(readFileSync(second, "utf8")).toContain('delivery = "system"');
  });
  it("uses the native config override and platform locations", () => {
    expect(herdrConfigPath({ HERDR_CONFIG_PATH: join(root, "custom.toml") })).toBe(join(root, "custom.toml"));
    expect(herdrConfigPath({ XDG_CONFIG_HOME: root }, "linux")).toBe(join(root, "herdr", "config.toml"));
    expect(herdrConfigPath({ APPDATA: root }, "win32")).toBe(join(root, "herdr", "config.toml"));
  });
});
