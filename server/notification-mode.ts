import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { NotificationMode, NotificationModeStatus } from "../shared/protocol.ts";
import { DesktopNotifications, NotificationModeError, validDesktopSnapshot, writePrivateFile, type DesktopNotificationSnapshot } from "./desktop-notifications.ts";
import { badRequest, conflictResponse, errorResponse, isJsonObject, jsonResponse } from "./http.ts";
import { sameOrigin } from "./machine-security.ts";

interface SavedMode {
  version: 1;
  mode: NotificationMode | null;
  desktop: DesktopNotificationSnapshot | null;
  pending: NotificationMode | null;
}

export function isNotificationMode(value: unknown): value is NotificationMode { return value === "desktop" || value === "mobile"; }

/** The bridge owns both routing and the saved desktop settings, not the popup's process. */
export class NotificationModes {
  private queue: Promise<unknown> = Promise.resolve();
  private changing = false;
  private listeners = new Set<() => void>();
  readonly path: string;

  constructor(stateDir: string, private readonly desktop: DesktopNotifications) { this.path = join(stateDir, "notification-mode.json"); }

  private read(): SavedMode | null {
    let content: string;
    try { content = readFileSync(this.path, "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
    let value: unknown;
    try { value = JSON.parse(content); } catch { /* kept for recovery */ }
    if (!isJsonObject(value) || value["version"] !== 1 || !(value["mode"] === null || isNotificationMode(value["mode"]))
      || !(value["pending"] === null || isNotificationMode(value["pending"]))
      || !(value["desktop"] === null || validDesktopSnapshot(value["desktop"]))
      || (value["mode"] === "mobile" || value["pending"] !== null) && !validDesktopSnapshot(value["desktop"])) {
      throw new NotificationModeError("notification_state_invalid", "Notification mode state is invalid. It has been kept for recovery; no settings were changed.");
    }
    return value as unknown as SavedMode;
  }

  status(): NotificationModeStatus {
    const saved = this.read();
    return { supported: true, mode: saved?.mode ?? null, changing: this.changing || saved?.pending != null };
  }

  /** A transition or interrupted switch holds pushes until a choice is confirmed. */
  deliveryMode(): NotificationMode | null {
    const saved = this.read();
    return this.changing || saved?.pending != null ? "desktop" : saved?.mode ?? null;
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  set(mode: NotificationMode): Promise<NotificationModeStatus> {
    const run = this.queue.then(() => this.change(mode));
    this.queue = run.catch(() => {});
    return run;
  }

  private save(saved: SavedMode): void { writePrivateFile(this.path, `${JSON.stringify(saved, null, 2)}\n`); }

  private async change(mode: NotificationMode): Promise<NotificationModeStatus> {
    const saved = this.read();
    if (saved?.mode === mode && saved.pending === null) return this.status();
    const before = this.desktop.read();
    const snapshot = saved?.desktop ?? this.desktop.capture(before);
    const after = mode === "mobile" ? this.desktop.mute(before) : saved?.desktop ? this.desktop.restore(before, saved.desktop) : before;
    // Confirm Herdr can reload before muting anything. The journal keeps the
    // original settings recoverable if the bridge exits during the switch.
    await this.desktop.reload();
    this.save({ version: 1, mode: saved?.mode ?? null, desktop: snapshot, pending: mode });
    this.changing = true;
    for (const listener of this.listeners) listener();
    let applied = false;
    try {
      this.desktop.write(before, after, snapshot.config_path);
      applied = true;
      await this.desktop.reload();
      this.save({ version: 1, mode, desktop: mode === "mobile" ? snapshot : null, pending: null });
    } catch (error) {
      try {
        if (applied) {
          this.desktop.write(after, before, snapshot.config_path);
          await this.desktop.reload();
        }
        if (saved) this.save(saved); else rmSync(this.path, { force: true });
      } catch {
        throw new NotificationModeError("notification_restore_failed", "The switch did not complete. Choose Desktop to recover the saved settings, or use Herdr's Reload config after checking them.");
      }
      throw error;
    } finally {
      this.changing = false;
      for (const listener of this.listeners) listener();
    }
    return this.status();
  }
}

export async function handleNotificationModeRequest(request: Request, modes?: NotificationModes): Promise<Response> {
  try {
    if (request.method === "GET") return jsonResponse(modes?.status() ?? { supported: false, mode: null, changing: false } satisfies NotificationModeStatus, 200, { "cache-control": "no-store" });
    if (request.method !== "POST") return jsonResponse({ error: { code: "method_not_allowed", message: "Use GET or POST /api/notifications/mode" } }, 405);
    if (!sameOrigin(request) || request.headers.get("x-herdr-machine") !== "1" || new URL(request.url).search) return jsonResponse({ error: { code: "invalid_origin", message: "Use the notification controls from this plugin." } }, 403);
    if (!modes) return conflictResponse("notification_modes_unavailable", "This bridge does not support notification modes; update the web UI plugin first.");
    let body: unknown;
    try { body = await request.json(); } catch { return badRequest("invalid_json", "request body must be JSON"); }
    if (!isJsonObject(body) || !isNotificationMode(body["mode"])) return badRequest("invalid_notification_mode", "Choose desktop or mobile.");
    return jsonResponse(await modes.set(body["mode"]), 200, { "cache-control": "no-store" });
  } catch (error) {
    return error instanceof NotificationModeError ? conflictResponse(error.code, error.message) : errorResponse(error);
  }
}
