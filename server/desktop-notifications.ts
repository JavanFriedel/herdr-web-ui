import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export class NotificationModeError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

/** Only the two settings we temporarily own; unrelated config edits are never restored. */
export interface DesktopNotificationSnapshot {
  config_path: string;
  toast: string | null;
  sound: string | null;
}

export function herdrConfigPath(env: Record<string, string | undefined> = process.env, platform = process.platform): string {
  if (env["HERDR_CONFIG_PATH"]) return resolve(env["HERDR_CONFIG_PATH"]);
  return join(platform === "win32" ? env["APPDATA"] || join(homedir(), "AppData", "Roaming") : env["XDG_CONFIG_HOME"] || join(env["HOME"] || homedir(), ".config"), "herdr", "config.toml");
}

export function writePrivateFile(path: string, content: string, mode = 0o600): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, content, { mode });
    renameSync(temporary, path);
  } finally { rmSync(temporary, { force: true }); }
}

interface NotificationConfig {
  ui?: { toast?: { delivery?: unknown }; sound?: { enabled?: unknown } };
}

function parse(content: string): NotificationConfig {
  try { return Bun.TOML.parse(content.replace(/^\uFEFF/, "")) as NotificationConfig; }
  catch { throw new NotificationModeError("herdr_config_invalid", "Herdr's configuration is invalid; no notification settings were changed."); }
}

function section(content: string, name: string): { lines: string[]; start: number; end: number; newline: string } {
  const lines = content.split(/\r?\n/);
  const header = new RegExp(`^\\s*\\[${name.replaceAll(".", "\\.")}\\]\\s*(?:#.*)?$`);
  const start = lines.findIndex((line) => header.test(line.replace(/^\uFEFF/, "")));
  let end = lines.length;
  if (start >= 0) {
    const next = lines.findIndex((line, index) => index > start && /^\s*\[/.test(line));
    if (next >= 0) end = next;
  }
  return { lines, start, end, newline: content.includes("\r\n") ? "\r\n" : "\n" };
}

function keyLine(content: string, name: string, key: string): string | null {
  const part = section(content, name);
  return part.start < 0 ? null : part.lines.slice(part.start + 1, part.end).find((line) => new RegExp(`^\\s*${key}\\s*=`).test(line)) ?? null;
}

function setKey(content: string, name: string, key: string, line: string | null): string {
  const part = section(content, name);
  if (part.start < 0) {
    if (line === null) return content;
    return `${content}${content.endsWith(part.newline) || !content ? "" : part.newline}${part.newline}[${name}]${part.newline}${line}${part.newline}`;
  }
  const index = part.lines.findIndex((entry, index) => index > part.start && index < part.end && new RegExp(`^\\s*${key}\\s*=`).test(entry));
  if (index >= 0) part.lines.splice(index, 1, ...(line === null ? [] : [line]));
  else if (line !== null) part.lines.splice(part.start + 1, 0, line);
  return part.lines.join(part.newline);
}

export function validDesktopSnapshot(value: unknown): value is DesktopNotificationSnapshot {
  if (!value || typeof value !== "object") return false;
  const snapshot = value as DesktopNotificationSnapshot;
  return typeof snapshot.config_path === "string" && [snapshot.toast, snapshot.sound].every((line) => line === null || typeof line === "string" && !/[\r\n]/.test(line))
    && (snapshot.toast === null || /^\s*delivery\s*=/.test(snapshot.toast))
    && (snapshot.sound === null || /^\s*enabled\s*=/.test(snapshot.sound));
}

export class DesktopNotifications {
  private readonly sourcePath: string;
  constructor(path: string, readonly reload: () => Promise<void>) {
    this.sourcePath = resolve(path);
  }

  get path(): string { return existsSync(this.sourcePath) ? realpathSync(this.sourcePath) : this.sourcePath; }

  read(): string {
    try { return readFileSync(this.path, "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return ""; throw error; }
  }

  capture(content: string): DesktopNotificationSnapshot {
    const config = parse(content);
    const toast = keyLine(content, "ui.toast", "delivery");
    const sound = keyLine(content, "ui.sound", "enabled");
    if (config.ui?.toast?.delivery !== undefined && toast === null || config.ui?.sound?.enabled !== undefined && sound === null) {
      throw new NotificationModeError("herdr_config_layout", "Use [ui.toast] and [ui.sound] tables for notification settings before switching modes.");
    }
    return { config_path: this.path, toast, sound };
  }

  mute(content: string): string {
    this.capture(content);
    const edited = setKey(setKey(content, "ui.toast", "delivery", 'delivery = "off"'), "ui.sound", "enabled", "enabled = false");
    const config = parse(edited);
    if (config.ui?.toast?.delivery !== "off" || config.ui?.sound?.enabled !== false) throw new NotificationModeError("herdr_config_layout", "Could not safely edit Herdr's notification settings.");
    return edited;
  }

  restore(content: string, snapshot: DesktopNotificationSnapshot): string {
    if (snapshot.config_path !== this.path) throw new NotificationModeError("herdr_config_changed", "Herdr's configuration path changed. Restore the previous notification settings before switching modes.");
    const config = parse(content);
    const original = parse(`${snapshot.toast === null ? "" : `[ui.toast]\n${snapshot.toast}\n`}${snapshot.sound === null ? "" : `[ui.sound]\n${snapshot.sound}\n`}`);
    const toast = config.ui?.toast?.delivery;
    const sound = config.ui?.sound?.enabled;
    if (toast !== "off" && toast !== original.ui?.toast?.delivery || sound !== false && sound !== original.ui?.sound?.enabled) {
      throw new NotificationModeError("herdr_config_changed", "Desktop notification settings were edited while Mobile was active; they have not been overwritten.");
    }
    const restored = setKey(setKey(content, "ui.toast", "delivery", snapshot.toast), "ui.sound", "enabled", snapshot.sound);
    parse(restored);
    return restored;
  }

  write(expected: string, content: string, expectedPath = this.path): void {
    if (this.path !== expectedPath) throw new NotificationModeError("herdr_config_changed", "Herdr's configuration path changed during the switch; no settings were overwritten.");
    if (this.read() !== expected) throw new NotificationModeError("herdr_config_changed", "Herdr's configuration changed during the switch; try again.");
    if (content === expected) return;
    const mode = existsSync(this.path) ? statSync(this.path).mode & 0o777 : 0o600;
    writePrivateFile(this.path, content, mode);
  }
}
