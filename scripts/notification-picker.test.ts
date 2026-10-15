import { describe, expect, it } from "bun:test";
import { PassThrough } from "node:stream";
import { notificationPicker, notificationPickerFrame } from "./notification-picker.ts";

describe("notification popup", () => {
  it("shows the confirmed choice separately from the highlighted choice", () => {
    const frame = notificationPickerFrame({ supported: true, mode: "desktop", changing: false }, "mobile");
    expect(frame).toContain("Current: Desktop");
    expect(frame).toContain("  ✓ Desktop");
    expect(frame).toContain(">   Mobile");
    expect(frame).toContain("phone pushes immediately");
    expect(frame).toContain("j/k or ↑/↓");
  });
  it("fits narrow terminals and explains interrupted switches", () => {
    const frame = notificationPickerFrame({ supported: true, mode: null, changing: true }, "desktop", 32);
    expect(frame.split("\r\n").every((line) => line.length <= 32)).toBe(true);
    expect(frame).toContain("Change incomplete");
  });
  it("never writes a mode when the bridge does not support it", async () => {
    let output = "";
    const code = await notificationPicker({ origin: "http://localhost", output: { write: (text: string) => { output += text; } } as NodeJS.WriteStream, fetch: async () => Response.json({ supported: false, mode: null, changing: false }) });
    expect(code).toBe(1);
    expect(output).toContain("Update the web UI plugin first");
  });

  const terminal = () => {
    const input = Object.assign(new PassThrough(), { isTTY: true, isRaw: false, setRawMode(raw: boolean) { this.isRaw = raw; } });
    const output = Object.assign(new PassThrough(), { columns: 52 });
    let text = "";
    output.on("data", (chunk) => { text += chunk.toString(); });
    const seen = (needle: string) => new Promise<void>((resolve, reject) => {
      if (text.includes(needle)) { resolve(); return; }
      const timer = setTimeout(() => { output.off("data", read); reject(new Error(`popup did not show ${needle}`)); }, 2000);
      const read = () => { if (text.includes(needle)) { clearTimeout(timer); output.off("data", read); resolve(); } };
      output.on("data", read);
    });
    return { input, output, seen, text: () => text };
  };

  it("applies the highlighted mode with Enter and restores terminal input modes", async () => {
    const tty = terminal();
    const posted: unknown[] = [];
    const running = notificationPicker({ origin: "http://localhost", input: tty.input as unknown as NodeJS.ReadStream, output: tty.output as unknown as NodeJS.WriteStream,
      fetch: async (_url, init) => {
        if (init?.method !== "POST") return Response.json({ supported: true, mode: "desktop", changing: false });
        posted.push(JSON.parse(String(init.body)));
        expect(new Headers(init.headers).get("x-herdr-machine")).toBe("1");
        return Response.json({ supported: true, mode: "mobile", changing: false });
      },
    });
    await tty.seen("Current: Desktop");
    tty.input.emit("keypress", "", { name: "down" });
    tty.input.emit("keypress", "", { name: "return" });
    expect(await running).toBe(0);
    expect(posted).toEqual([{ mode: "mobile" }]);
    expect(tty.input.isRaw).toBe(false);
    expect(tty.text()).toContain("\x1b[?25h");
  });

  it("lets a mouse click choose Mobile without typing a command", async () => {
    const tty = terminal();
    let posted: unknown;
    const running = notificationPicker({ origin: "http://localhost", input: tty.input as unknown as NodeJS.ReadStream, output: tty.output as unknown as NodeJS.WriteStream,
      fetch: async (_url, init) => {
        if (init?.method !== "POST") return Response.json({ supported: true, mode: "desktop", changing: false });
        posted = JSON.parse(String(init.body));
        return Response.json({ supported: true, mode: "mobile", changing: false });
      },
    });
    await tty.seen("Current: Desktop");
    tty.input.write("\x1b[<0;8;5M");
    expect(await running).toBe(0);
    expect(posted).toEqual({ mode: "mobile" });
  });

  it.each([
    ["desktop", "j", "mobile"],
    ["mobile", "k", "desktop"],
  ] as const)("moves from %s with %s, applying %s only on Enter", async (current, key, selected) => {
    const tty = terminal();
    const posted: unknown[] = [];
    const running = notificationPicker({ origin: "http://localhost", input: tty.input as unknown as NodeJS.ReadStream, output: tty.output as unknown as NodeJS.WriteStream,
      fetch: async (_url, init) => {
        if (init?.method !== "POST") return Response.json({ supported: true, mode: current, changing: false });
        posted.push(JSON.parse(String(init.body)));
        return Response.json({ supported: true, mode: selected, changing: false });
      },
    });
    await tty.seen(`Current: ${current === "desktop" ? "Desktop" : "Mobile"}`);
    tty.input.write(key);
    const frame = tty.text().split("\x1b[H\x1b[2J").at(-1)!;
    expect(frame).toContain(`>   ${selected === "desktop" ? "Desktop" : "Mobile"}`);
    expect(frame).toContain(`Current: ${current === "desktop" ? "Desktop" : "Mobile"}`);
    expect(posted).toEqual([]);
    tty.input.write("\r");
    expect(await running).toBe(0);
    expect(posted).toEqual([{ mode: selected }]);
  });

  it("Escape closes without changing anything", async () => {
    const tty = terminal();
    let requests = 0;
    const running = notificationPicker({ origin: "http://localhost", input: tty.input as unknown as NodeJS.ReadStream, output: tty.output as unknown as NodeJS.WriteStream,
      fetch: async () => { requests++; return Response.json({ supported: true, mode: "desktop", changing: false }); },
    });
    await tty.seen("Current: Desktop");
    tty.input.emit("keypress", "", { name: "escape" });
    expect(await running).toBe(0);
    expect(requests).toBe(1);
  });

  it("shows a rejected switch without marking Mobile as active or retrying it", async () => {
    const tty = terminal();
    let posts = 0;
    const running = notificationPicker({ origin: "http://localhost", input: tty.input as unknown as NodeJS.ReadStream, output: tty.output as unknown as NodeJS.WriteStream,
      fetch: async (_url, init) => {
        if (init?.method !== "POST") return Response.json({ supported: true, mode: "desktop", changing: false });
        posts++;
        return Response.json({ error: { code: "fixture", message: "Desktop settings changed; no settings were overwritten." } }, { status: 409 });
      },
    });
    await tty.seen("Current: Desktop");
    tty.input.emit("keypress", "", { name: "m" });
    tty.input.emit("keypress", "", { name: "return" });
    await tty.seen("overwritten.");
    expect(tty.text()).not.toContain("Current: Mobile");
    expect(posts).toBe(1);
    tty.input.emit("keypress", "", { name: "escape" });
    expect(await running).toBe(0);
  });
});
