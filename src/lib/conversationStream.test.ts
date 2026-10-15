import { describe, expect, it } from "bun:test";

import type { ConversationTurn } from "../../shared/protocol.ts";
import { applyStreamFrame, provisionalReply, type LiveReply } from "./conversationStream.ts";

const frame = (message_id: string, part: number, offset: number, text: string) => ({ type: "conversation-stream" as const, pane_id: "w1:p1", message_id, part, offset, text });
const turn = (role: "user" | "assistant", text: string): ConversationTurn => ({ role, ts: null, parts: [{ kind: "text", text }] });

describe("applyStreamFrame", () => {
  it("appends slices at their offset, and a whole part replaces what was streamed", () => {
    let reply = applyStreamFrame(null, frame("msg_1", 0, 0, "Hel"));
    reply = applyStreamFrame(reply, frame("msg_1", 0, 3, "lo"));
    reply = applyStreamFrame(reply, frame("msg_1", 1, 0, "next"));
    expect(reply).toEqual({ message: "msg_1", parts: ["Hello", "next"], done: false });
    reply = applyStreamFrame(reply, frame("msg_1", 0, 0, "Hello there"));
    expect(reply?.parts[0]).toBe("Hello there");
  });

  it("waits out a slice past what arrived, and starts another message only from its beginning", () => {
    const reply: LiveReply = { message: "msg_1", parts: ["ab"], done: false };
    expect(applyStreamFrame(reply, frame("msg_1", 0, 5, "zz"))).toBe(reply);
    expect(applyStreamFrame(reply, frame("msg_2", 0, 4, "mid"))).toBe(reply);
    expect(applyStreamFrame(reply, frame("msg_2", 0, 0, "new"))).toEqual({ message: "msg_2", parts: ["new"], done: false });
  });

  it("marks only its own message done", () => {
    const reply: LiveReply = { message: "msg_1", parts: ["ab"], done: false };
    expect(applyStreamFrame(reply, { type: "conversation-stream", pane_id: "w1:p1", message_id: "msg_1", done: true })?.done).toBe(true);
    expect(applyStreamFrame(reply, { type: "conversation-stream", pane_id: "w1:p1", message_id: "msg_0", done: true })).toBe(reply);
  });
});

describe("provisionalReply", () => {
  it("shows the streamed text after the user's message until the transcript's answer holds it", () => {
    const live: LiveReply = { message: "msg_1", parts: ["Line one\nLine", "two"], done: false };
    expect(provisionalReply(live, [turn("user", "hi")])).toBe("Line one\nLine\n\ntwo");
    expect(provisionalReply(live, [turn("user", "hi"), turn("assistant", "Line one Line two and more")])).toBeNull();
    // the transcript's last answer is an older one: the live reply still shows
    expect(provisionalReply(live, [turn("assistant", "earlier answer")])).toBe("Line one\nLine\n\ntwo");
    // the reply is recorded and the user wrote again: it does not come back under the new message
    expect(provisionalReply(live, [turn("assistant", "Line one Line two"), turn("user", "next")])).toBeNull();
    expect(provisionalReply(null, [])).toBeNull();
    expect(provisionalReply({ message: "msg_1", parts: [" "], done: false }, [])).toBeNull();
  });
});
