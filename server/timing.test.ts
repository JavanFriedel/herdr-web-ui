import { describe, expect, it } from "bun:test";
import { enableTiming, captureServerTimer, serverSpan } from "./timing.ts";
import { withRequestTiming } from "./request-timing.ts";
import { parseServerTiming } from "../shared/timing.ts";
import { handleMachineRequest } from "./machine-api.ts";
import type { MachineManager } from "./machines.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { herdrRpc } from "./herdr/client.ts";

const request = (path = "/api/session", headers: Record<string, string> = { "x-herdr-timing": "1" }, method = "GET") => new Request(`http://localhost${path}`, { method, headers });

describe("request-scoped timing", () => {
  it("isolates concurrent requests and captures delayed callback context", async () => {
    const a = Promise.withResolvers<void>();
    const b = Promise.withResolvers<void>();
    const read = (stage: "rpc.pane.get" | "rpc.session.snapshot", wait: Promise<void>) => withRequestTiming(request(), async () => {
      enableTiming(); const time = captureServerTimer(); const end = time(stage); await wait;
      time("rpc.decode")(); end(); return new Response("{}");
    });
    const first = read("rpc.pane.get", a.promise); const second = read("rpc.session.snapshot", b.promise);
    b.resolve(); const secondResponse = await second; a.resolve(); const firstResponse = await first;
    expect(parseServerTiming(firstResponse!.headers.get("server-timing")).map((entry) => entry.stage)).toEqual(["server.total", "rpc.pane.get", "rpc.decode"]);
    expect(parseServerTiming(secondResponse!.headers.get("server-timing")).map((entry) => entry.stage)).toEqual(["server.total", "rpc.session.snapshot", "rpc.decode"]);
  });
  it("never exposes timings without normal authorization or on excluded/cross-origin requests", async () => {
    for (const req of [request(), request("/api/session", {}), request("/api/fs/file"), request("/api/session", { "x-herdr-timing": "1", origin: "https://evil.invalid" }), request("/api/session", { "x-herdr-timing": "1" }, "POST")]) {
      const response = await withRequestTiming(req, async () => { serverSpan("rpc.pane.get")(); return new Response("{}"); });
      expect(response!.headers.has("server-timing")).toBe(false);
    }
  });
  it("bounds header entries and keeps a total", async () => {
    const response = await withRequestTiming(request(), async () => { enableTiming(); for (let index = 0; index < 1000; index++) serverSpan("rpc.pane.get")(); return new Response("{}"); });
    const entries = parseServerTiming(response!.headers.get("server-timing"));
    expect(entries).toHaveLength(64); expect(entries[0]!.stage).toBe("server.total");
  });
});

it("forwards only the opt-in diagnostic header and validates remote timing descriptions", async () => {
  const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req) {
    expect(req.headers.get("authorization")).toBe("Bearer fictional-bridge-token");
    expect(req.headers.has("cookie")).toBe(false);
    expect(req.headers.get("x-herdr-timing")).toBe("1");
    return new Response("{}", { headers: { "server-timing": 'herdr0;dur=12;desc="server.total@0", herdr1;dur=1;desc="private_secret@0"' } });
  } });
  const manager = { endpoint: () => ({ url: `http://127.0.0.1:${upstream.port}`, token: "fictional-bridge-token" }), trackTerminal: () => () => {} } as unknown as MachineManager;
  try {
    const req = request("/api/machines/fictional-machine/session", { "x-herdr-timing": "1", cookie: "private-cookie", authorization: "Bearer private-browser-token" });
    const response = await withRequestTiming(req, async () => { enableTiming(); return handleMachineRequest(req, manager); });
    const entries = parseServerTiming(response!.headers.get("server-timing"));
    expect(entries).toContainEqual({ stage: "server.total", start_ms: 0, duration_ms: 12, remote: true });
    expect(entries.some((entry) => entry.stage === "bridge.headers")).toBe(true);
    expect(entries.some((entry) => entry.stage === "bridge.body")).toBe(true);
    expect(response!.headers.get("server-timing")).not.toContain("private");
  } finally { upstream.stop(true); }
});

it.skipIf(process.platform === "win32")("records a failed RPC wait without recording request or error values", async () => {
  const root = mkdtempSync(join(tmpdir(), "herdr-timing-rpc-"));
  const path = join(root, "fake.sock");
  const sockets = new Set<{ end(): void }>();
  const listener = Bun.listen({ unix: path, socket: {
    open(socket) { sockets.add(socket); },
    data() { /* Deliberately unanswered; the RPC's existing deadline, not a sleep, settles it. */ },
    close(socket) { sockets.delete(socket); },
  } });
  try {
    const response = await withRequestTiming(request(), async () => {
      enableTiming();
      await expect(herdrRpc("pane.get", { pane_id: "private-pane" }, path, 10)).rejects.toMatchObject({ code: "timeout" });
      return new Response("{}", { status: 502 });
    });
    const header = response!.headers.get("server-timing");
    const entries = parseServerTiming(header);
    expect(entries.find((entry) => entry.stage === "rpc.pane.get")?.failed).toBe(true);
    expect(entries.find((entry) => entry.stage === "rpc.wait")?.failed).toBe(true);
    expect(header).not.toContain("private"); expect(header).not.toContain(path);
  } finally { for (const socket of sockets) socket.end(); listener.stop(true); rmSync(root, { recursive: true, force: true }); }
});
