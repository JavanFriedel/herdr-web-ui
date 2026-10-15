import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DesktopNotifications, NotificationModeError } from "./desktop-notifications.ts";
import { handleNotificationModeRequest, NotificationModes } from "./notification-mode.ts";

let root: string;
let configPath: string;
const original = '# Keep this comment\n[theme]\nname = "terminal"\n[ui.toast]\ndelivery = "system" # preferred desktop delivery\n[ui.sound]\nenabled = true # preferred sound\n';
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "herdr-notification-modes-")); configPath = join(root, "config.toml"); writeFileSync(configPath, original); });
afterEach(() => rmSync(root, { recursive: true, force: true }));
const store = (reload = async () => {}) => new NotificationModes(root, new DesktopNotifications(configPath, reload));

describe("notification destination", () => {
  it("keeps existing delivery until an explicit choice, then persists mobile and restores desktop", async () => {
    let reloads = 0;
    const modes = store(async () => { reloads++; });
    expect(modes.deliveryMode()).toBeNull();
    expect(modes.status()).toEqual({ supported: true, mode: null, changing: false });
    await modes.set("mobile");
    expect(modes.deliveryMode()).toBe("mobile");
    const muted = Bun.TOML.parse(readFileSync(configPath, "utf8"));
    expect(muted).toMatchObject({ ui: { toast: { delivery: "off" }, sound: { enabled: false } } });
    expect(store().deliveryMode()).toBe("mobile");
    expect(statSync(modes.path).mode & 0o777).toBe(0o600);
    await modes.set("desktop");
    expect(modes.deliveryMode()).toBe("desktop");
    expect(readFileSync(configPath, "utf8")).toBe(original);
    expect(reloads).toBe(4);
    await modes.set("desktop");
    expect(reloads).toBe(4);
  });

  it("restores only notification keys and preserves edits made while mobile was active", async () => {
    const modes = store();
    await modes.set("mobile");
    writeFileSync(configPath, readFileSync(configPath, "utf8").replace('name = "terminal"', 'name = "catppuccin"'));
    await modes.set("desktop");
    expect(readFileSync(configPath, "utf8")).toBe(original.replace('name = "terminal"', 'name = "catppuccin"'));
  });

  it("does not overwrite notification settings the user changed themselves", async () => {
    const modes = store();
    await modes.set("mobile");
    const changed = readFileSync(configPath, "utf8").replace('delivery = "off"', 'delivery = "terminal"');
    writeFileSync(configPath, changed);
    await expect(modes.set("desktop")).rejects.toBeInstanceOf(NotificationModeError);
    expect(readFileSync(configPath, "utf8")).toBe(changed);
    expect(modes.deliveryMode()).toBe("mobile");
  });

  it("changes nothing when Herdr cannot confirm a config reload", async () => {
    const modes = store(async () => { throw new Error("fixture: Herdr unavailable"); });
    await expect(modes.set("mobile")).rejects.toThrow("unavailable");
    expect(readFileSync(configPath, "utf8")).toBe(original);
    expect(existsSync(modes.path)).toBe(false);
  });

  it("rolls config and state back if applying the new config fails", async () => {
    let reloads = 0;
    const modes = store(async () => { if (++reloads === 2) throw new Error("fixture: reload rejected"); });
    await expect(modes.set("mobile")).rejects.toThrow("rejected");
    expect(readFileSync(configPath, "utf8")).toBe(original);
    expect(modes.deliveryMode()).toBeNull();
    expect(reloads).toBe(3);
  });

  it("never rolls back another writer's config when our own write was refused", async () => {
    const desktop = new DesktopNotifications(configPath, async () => {});
    const external = desktop.mute(original);
    const modes = store(async () => { writeFileSync(configPath, external); });
    await expect(modes.set("mobile")).rejects.toThrow("changed during the switch");
    expect(readFileSync(configPath, "utf8")).toBe(external);
    expect(existsSync(modes.path)).toBe(false);
  });

  it("keeps recovery state when a rollback cannot be confirmed", async () => {
    let reloads = 0;
    const modes = store(async () => { if (++reloads > 1) throw new Error("fixture: lost Herdr"); });
    await expect(modes.set("mobile")).rejects.toThrow("Choose Desktop to recover");
    expect(modes.deliveryMode()).toBe("desktop");
    expect(modes.status().changing).toBe(true);
    await store().set("desktop");
    expect(store().deliveryMode()).toBe("desktop");
    expect(readFileSync(configPath, "utf8")).toBe(original);
  });

  it("serializes competing mode changes", async () => {
    const modes = store();
    const [mobile, desktop] = await Promise.all([modes.set("mobile"), modes.set("desktop")]);
    expect(mobile.mode).toBe("mobile"); expect(desktop.mode).toBe("desktop");
    expect(readFileSync(configPath, "utf8")).toBe(original);
  });

  it("keeps malformed state for recovery instead of losing the saved desktop settings", async () => {
    const modes = store();
    writeFileSync(modes.path, "broken");
    await expect(modes.set("mobile")).rejects.toThrow("kept for recovery");
    expect(readFileSync(modes.path, "utf8")).toBe("broken");
    expect(readFileSync(configPath, "utf8")).toBe(original);
  });
});

describe("notification mode HTTP handler", () => {
  const request = (body: unknown, headers: Record<string, string> = { "x-herdr-machine": "1" }) => new Request("http://localhost/api/notifications/mode", { method: "POST", headers, body: JSON.stringify(body) });
  it("reports unsupported on embeddings without a desktop controller", async () => {
    const response = await handleNotificationModeRequest(new Request("http://localhost/api/notifications/mode"));
    expect(await response.json()).toEqual({ supported: false, mode: null, changing: false });
    expect((await handleNotificationModeRequest(request({ mode: "mobile" }))).status).toBe(409);
  });
  it("rejects cross-origin, unmarked and invalid choices without changing settings", async () => {
    const modes = store();
    expect((await handleNotificationModeRequest(request({ mode: "mobile" }, {}), modes)).status).toBe(403);
    expect((await handleNotificationModeRequest(request({ mode: "mobile" }, { "x-herdr-machine": "1", origin: "http://elsewhere.example" }), modes)).status).toBe(403);
    expect((await handleNotificationModeRequest(request({ mode: "auto" }), modes)).status).toBe(400);
    expect(readFileSync(configPath, "utf8")).toBe(original);
    expect(existsSync(modes.path)).toBe(false);
  });
  it("confirms a mode only after both settings and delivery state are committed", async () => {
    const modes = store();
    const response = await handleNotificationModeRequest(request({ mode: "mobile" }), modes);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ supported: true, mode: "mobile", changing: false });
  });
});
