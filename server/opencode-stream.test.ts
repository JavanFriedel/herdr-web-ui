import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { OpencodeStream, parseSse, readOpencodeService, type OpencodeStreamFrame } from "./opencode-stream.ts";

const SERVICE = { url: "http://127.0.0.1:1", authorization: "Basic test" };
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const delta = (session: string, message: string, ordinal: number, text: string) =>
  ({ type: "session.text.delta", data: { sessionID: session, assistantMessageID: message, ordinal, delta: text } });

/** Waits for `done` within a deadline. */
async function until(done: () => boolean, ms = 3_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!done()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await Bun.sleep(5);
  }
}

/** A stream whose events go nowhere but `handle`: no service is ever asked. */
function harness() {
  const frames: [string, OpencodeStreamFrame][] = [];
  const settled: string[] = [];
  const stream = new OpencodeStream((pane, frame) => frames.push([pane, frame]), (pane) => settled.push(pane), () => null);
  return { stream, frames, settled };
}

describe("parseSse", () => {
  it("returns each complete event's data and keeps an unfinished one for the next chunk", () => {
    const first = parseSse('data: {"a":1}\n\nid: 7\ndata: {"b":\n');
    expect(first.data).toEqual(['{"a":1}']);
    const second = parseSse(`${first.rest}data: 2}\r\n\r\n: keepalive\n\n`);
    expect(second.data).toEqual(['{"b":\n2}']);
    expect(second.rest).toBe("");
  });
});

describe("readOpencodeService", () => {
  it("reads the local service and refuses one that is not on this PC's loopback", () => {
    const root = mkdtempSync(join(tmpdir(), "herdr-opencode-stream-")); roots.push(root);
    mkdirSync(join(root, "opencode"));
    writeFileSync(join(root, "opencode", "service.json"), JSON.stringify({ url: "http://127.0.0.1:49374", password: "pw" }));
    expect(readOpencodeService({ XDG_STATE_HOME: root })).toEqual({ url: "http://127.0.0.1:49374", authorization: `Basic ${btoa("opencode:pw")}` });
    writeFileSync(join(root, "opencode", "service.json"), JSON.stringify({ url: "http://example.com:80", password: "pw" }));
    expect(readOpencodeService({ XDG_STATE_HOME: root })).toBeNull();
  });
});

describe("OpencodeStream", () => {
  it("sends a watched session's text to the panes showing it, and nothing of other sessions", () => {
    const { stream, frames } = harness();
    stream.watch("w1:p1", "ses_a");
    stream.watch("w1:p2", "ses_a");
    stream.handle(delta("ses_a", "msg_1", 0, "Hel"));
    stream.handle(delta("ses_a", "msg_1", 0, "lo"));
    stream.handle(delta("ses_b", "msg_9", 0, "someone else's"));
    expect(frames).toEqual([
      ["w1:p1", { message_id: "msg_1", part: 0, offset: 0, text: "Hel" }],
      ["w1:p2", { message_id: "msg_1", part: 0, offset: 0, text: "Hel" }],
      ["w1:p1", { message_id: "msg_1", part: 0, offset: 3, text: "lo" }],
      ["w1:p2", { message_id: "msg_1", part: 0, offset: 3, text: "lo" }],
    ]);
    stream.stop();
  });

  it("gives a chat opened mid-reply what was streamed so far, and a part's end mends it whole", () => {
    const { stream, frames } = harness();
    stream.watch("w1:p1", "ses_a");
    stream.handle(delta("ses_a", "msg_1", 0, "one "));
    stream.handle(delta("ses_a", "msg_1", 1, "two"));
    stream.watch("w1:p2", "ses_a");
    expect(frames.filter(([pane]) => pane === "w1:p2")).toEqual([
      ["w1:p2", { message_id: "msg_1", part: 0, offset: 0, text: "one " }],
      ["w1:p2", { message_id: "msg_1", part: 1, offset: 0, text: "two" }],
    ]);
    frames.length = 0;
    stream.handle({ type: "session.text.ended", data: { sessionID: "ses_a", assistantMessageID: "msg_1", ordinal: 0, text: "one whole" } });
    expect(frames[0]).toEqual(["w1:p1", { message_id: "msg_1", part: 0, offset: 0, text: "one whole" }]);
    stream.stop();
  });

  it("ends the reply and has the transcript looked at when the session's work ends", () => {
    const { stream, frames, settled } = harness();
    stream.watch("w1:p1", "ses_a");
    stream.handle(delta("ses_a", "msg_1", 0, "hi"));
    stream.handle({ type: "session.tool.success", data: { sessionID: "ses_a" } });
    expect(settled).toEqual(["w1:p1"]);
    frames.length = 0;
    stream.handle({ type: "session.execution.succeeded", data: { sessionID: "ses_a" } });
    expect(frames).toEqual([["w1:p1", { message_id: "msg_1", done: true }]]);
    expect(settled).toEqual(["w1:p1", "w1:p1"]);
    // a chat opened after the end hears nothing old
    frames.length = 0;
    stream.watch("w1:p3", "ses_a");
    expect(frames).toEqual([]);
    stream.stop();
  });

  it("follows a pane to its new session and lets go of one no longer watched", () => {
    const { stream, frames } = harness();
    stream.watch("w1:p1", "ses_a");
    stream.watch("w1:p1", "ses_b");
    stream.handle(delta("ses_a", "msg_1", 0, "old"));
    stream.handle(delta("ses_b", "msg_2", 0, "new"));
    expect(frames).toEqual([["w1:p1", { message_id: "msg_2", part: 0, offset: 0, text: "new" }]]);
    stream.watch("w1:p1", null);
    expect(stream.watching).toBe(0);
    stream.stop();
  });

  it("subscribes only while a pane is watched, and subscribes again after the stream ends", async () => {
    const encoder = new TextEncoder();
    const requests: { url: string; authorization: string | null }[] = [];
    const bodies: ReadableStreamDefaultController<Uint8Array>[] = [];
    const fakeFetch = (async (url: string, init: RequestInit) => {
      requests.push({ url, authorization: new Headers(init.headers).get("authorization") });
      const body = new ReadableStream<Uint8Array>({ start(controller) { bodies.push(controller); } });
      init.signal?.addEventListener("abort", () => { try { bodies.at(-1)?.error(new Error("aborted")); } catch { /* closed */ } });
      return new Response(body, { status: 200 });
    }) as unknown as typeof fetch;
    const frames: [string, OpencodeStreamFrame][] = [];
    const settled: string[] = [];
    const stream = new OpencodeStream((pane, frame) => frames.push([pane, frame]), (pane) => settled.push(pane), () => SERVICE, fakeFetch);
    try {
      expect(requests).toHaveLength(0);
      stream.watch("w1:p1", "ses_a");
      await until(() => requests.length === 1);
      expect(requests).toEqual([{ url: "http://127.0.0.1:1/api/event", authorization: "Basic test" }]);
      await until(() => bodies.length === 1);
      bodies[0]!.enqueue(encoder.encode(`data: ${JSON.stringify(delta("ses_a", "msg_1", 0, "streamed"))}\n\n`));
      await until(() => frames.length === 1);
      expect(frames).toEqual([["w1:p1", { message_id: "msg_1", part: 0, offset: 0, text: "streamed" }]]);
      // the service closed the stream: the chat reads its transcript, and a new subscription follows
      bodies[0]!.close();
      await until(() => settled.length === 1);
      expect(settled).toEqual(["w1:p1"]);
      // after the first retry's 1 s backoff
      await until(() => requests.length === 2);
      stream.unwatch("w1:p1");
      expect(stream.connected).toBe(false);
    } finally {
      stream.stop();
    }
  });
});
