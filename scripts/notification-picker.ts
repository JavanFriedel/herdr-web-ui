import { emitKeypressEvents } from "node:readline";
import type { NotificationMode, NotificationModeStatus } from "../shared/protocol.ts";

export interface NotificationPickerOptions {
  origin: string;
  token?: string;
  input?: NodeJS.ReadStream;
  output?: NodeJS.WriteStream;
  fetch?: (input: string, init?: RequestInit) => Promise<Response>;
}

export function notificationPickerFrame(status: NotificationModeStatus, selected: NotificationMode, width = 52, error = ""): string {
  const current = status.changing ? "Change incomplete; choose Desktop to recover" : status.mode ? `Current: ${status.mode === "desktop" ? "Desktop" : "Mobile"}` : "Choose where new agent alerts should go";
  const row = (mode: NotificationMode, label: string) => `${selected === mode ? ">" : " "} ${status.mode === mode ? "✓" : " "} ${label}`;
  const errorLines: string[] = [];
  if (error) {
    for (const word of error.split(/\s+/)) {
      const last = errorLines.length - 1;
      if (last >= 0 && errorLines[last]!.length + word.length + 1 <= width) errorLines[last] += ` ${word}`;
      else errorLines.push(word.slice(0, width));
    }
  }
  return [current, "", row("desktop", "Desktop — phone pushes off"), "", row("mobile", "Mobile — phone pushes immediately"), "", ...errorLines.slice(0, 3), "↑/↓ select · Enter apply · Esc close"].map((line) => line.slice(0, width)).join("\r\n");
}

/** A plugin-owned terminal popup; it never starts/stops Herdr or requests browser permissions. */
export async function notificationPicker(options: NotificationPickerOptions): Promise<number> {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const request = options.fetch ?? fetch;
  const headers: Record<string, string> = {};
  if (options.token) headers["authorization"] = `Bearer ${options.token}`;
  let status: NotificationModeStatus;
  try {
    const response = await request(`${options.origin}/api/notifications/mode`, { headers, signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error("Could not read notification mode. Check the plugin's connection and token.");
    status = await response.json() as NotificationModeStatus;
    if (status?.supported !== true) throw new Error("This bridge does not support notification modes. Update the web UI plugin first.");
    if (typeof status.changing !== "boolean" || status.mode !== null && status.mode !== "desktop" && status.mode !== "mobile") throw new Error("The bridge sent an invalid notification mode; no settings were changed.");
  } catch (error) {
    output.write(`${error instanceof Error ? error.message : "Could not reach the web UI bridge."}\r\n`);
    return 1;
  }
  if (!input.isTTY) { output.write(`${notificationPickerFrame(status, status.mode ?? "desktop")}\r\n`); return 0; }

  let selected = status.mode ?? "desktop";
  let error = "";
  let busy = false;
  let closed = false;
  const draw = () => { if (!closed) output.write(`\x1b[H\x1b[2J${notificationPickerFrame(status, selected, output.columns || 52, busy ? "Applying…" : error)}`); };
  const wasRaw = input.isRaw;
  emitKeypressEvents(input);
  input.setRawMode(true);
  output.write("\x1b[?25l\x1b[?1000h\x1b[?1006h");
  draw();
  return new Promise<number>((resolve) => {
    const finish = (code: number) => {
      if (closed) return;
      closed = true;
      input.off("keypress", keypress);
      input.off("data", mouse);
      input.off("end", ended);
      output.off("resize", draw);
      process.off("SIGTERM", terminated);
      input.setRawMode(wasRaw ?? false);
      input.pause();
      output.write("\x1b[?1006l\x1b[?1000l\x1b[?25h\r\n");
      resolve(code);
    };
    const apply = async () => {
      if (busy) return;
      busy = true; error = ""; draw();
      try {
        const response = await request(`${options.origin}/api/notifications/mode`, { method: "POST", headers: { ...headers, "content-type": "application/json", "x-herdr-machine": "1" }, body: JSON.stringify({ mode: selected }), signal: AbortSignal.timeout(30_000) });
        const body = await response.json() as NotificationModeStatus & { error?: { message?: string } };
        if (!response.ok) throw new Error(body.error?.message ?? "The notification switch failed; no new mode was confirmed.");
        if (body.mode !== selected || body.changing) throw new Error("The bridge did not confirm the selected notification mode.");
        finish(0);
      } catch (cause) { error = cause instanceof Error ? cause.message : "Could not switch notification mode."; busy = false; draw(); }
    };
    const keypress = (_text: string, key: { name?: string; ctrl?: boolean }) => {
      if (busy) return;
      if (key.name === "escape" || key.name === "c" && key.ctrl) return finish(0);
      if (key.name === "up" || key.name === "down" || key.name === "tab") selected = selected === "desktop" ? "mobile" : "desktop";
      else if (key.name === "d" || key.name === "1") selected = "desktop";
      else if (key.name === "m" || key.name === "2") selected = "mobile";
      else if (key.name === "return") { void apply(); return; }
      draw();
    };
    const mouse = (chunk: Buffer) => {
      if (busy) return;
      const hit = /\x1b\[<0;\d+;(3|5)M/.exec(chunk.toString());
      if (hit) { selected = hit[1] === "3" ? "desktop" : "mobile"; void apply(); }
    };
    const ended = () => { if (!busy) finish(0); };
    const terminated = () => finish(1);
    input.on("keypress", keypress);
    input.on("data", mouse);
    input.once("end", ended);
    output.on("resize", draw);
    process.once("SIGTERM", terminated);
    input.resume();
  });
}
