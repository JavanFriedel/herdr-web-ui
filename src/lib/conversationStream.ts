import type { ConversationTurn, ServerMessage } from "../../shared/protocol.ts";

/** The reply a pane's agent is writing as the bridge streamed it (feature "conversation-stream"). */
export interface LiveReply { message: string; parts: string[]; done: boolean }

type StreamFrame = Extract<ServerMessage, { type: "conversation-stream" }>;

/** The reply after one frame. A slice of another message starts that one only from its beginning:
 * a chat opened mid-reply first hears what was streamed so far, at offset 0. */
export function applyStreamFrame(current: LiveReply | null, frame: StreamFrame): LiveReply | null {
  if ("done" in frame) return current?.message === frame.message_id ? { ...current, done: true } : current;
  let reply = current;
  if (reply?.message !== frame.message_id) {
    if (frame.offset !== 0) return current;
    reply = { message: frame.message_id, parts: [], done: false };
  }
  const before = reply.parts[frame.part] ?? "";
  // a slice past what arrived would leave a hole: wait for the part whole (its end sends it so)
  if (frame.offset > before.length) return reply;
  const parts = [...reply.parts];
  parts[frame.part] = before.slice(0, frame.offset) + frame.text;
  return { ...reply, parts };
}

const words = (text: string): string => text.replace(/\s+/g, " ").trim();

/** How far back a recorded answer may sit and still be the streamed one: the user's next message
 * (and its answer's first steps) can come after it before the stream's next reply starts. */
const COVER_TURNS = 6;

/** What of the live reply to show after the transcript's turns: nothing once one of the
 * transcript's latest answers holds it (the read after the reply's end brings it whole). */
export function provisionalReply(live: LiveReply | null, turns: readonly ConversationTurn[]): string | null {
  if (live === null) return null;
  const text = words(live.parts.filter((part) => part.length > 0).join("\n\n"));
  if (text === "") return null;
  for (const turn of turns.slice(-COVER_TURNS)) {
    if (turn.role !== "assistant") continue;
    if (words(turn.parts.map((part) => part.kind === "text" ? part.text : "").join(" ")).startsWith(text)) return null;
  }
  return live.parts.filter((part) => part.length > 0).join("\n\n");
}
