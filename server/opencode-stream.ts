/**
 * OpenCode 2's live event stream -> the text of the reply it is writing, for a chat watching it.
 *
 * OpenCode writes an assistant message to its store once the message ends (measured on 2.0.29: a
 * 20 s reply reached session_message in one write at the end), so the transcript read alone shows
 * a streaming reply only when it is done. Its local service streams every step as it happens
 * (`GET /api/event`, server-sent events): `session.text.delta` carries the text by message and part
 * (`ordinal`), `session.text.ended` the whole part, and the step and execution events say when the
 * store has the result. This keeps one subscription open while any chat watches an OpenCode pane,
 * routes the session's text to the panes showing it, and says when the transcript should be read
 * again. The transcript stays the truth: what goes out here is provisional, replaced by the next read.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** What the browser hears for one pane: a slice of a part's text from `offset`, or the reply's end. */
export type OpencodeStreamFrame =
  | { message_id: string; part: number; offset: number; text: string }
  | { message_id: string; done: true };

export interface OpencodeService { url: string; authorization: string }

const RETRY_MIN_MS = 1_000;
const RETRY_MAX_MS = 15_000;
/** a reply longer than this is shown from the transcript alone: the stream is for the live tail */
const PART_MAX_CHARS = 512 * 1024;
/** the events after which the store holds something new: the transcript is read again at once */
const SETTLING = new Set(["session.text.ended", "session.step.ended", "session.step.failed", "session.tool.success", "session.tool.failed", "session.execution.succeeded", "session.execution.failed", "session.execution.interrupted"]);
const ENDED = new Set(["session.execution.succeeded", "session.execution.failed", "session.execution.interrupted"]);

/**
 * The background service OpenCode 2's TUIs share, as its service.json names it.
 *
 * OPEN DECISION: this reads the service's password to subscribe to its events. The model controls
 * (opencode-model.ts) deliberately never read it and go through `opencode api`, but that command
 * answers only once a response ends, and an event stream never ends. The password stays in this
 * process's memory: it is never logged, stored or sent to a browser.
 */
export function readOpencodeService(env: Record<string, string | undefined> = process.env, home = homedir()): OpencodeService | null {
  const file = join(env["XDG_STATE_HOME"] || join(home, ".local", "state"), "opencode", "service.json");
  try {
    const saved = JSON.parse(readFileSync(file, "utf8")) as { url?: unknown; password?: unknown };
    if (typeof saved.url !== "string" || !/^http:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d+\/?$/.test(saved.url) || typeof saved.password !== "string") return null;
    return { url: saved.url.replace(/\/$/, ""), authorization: `Basic ${Buffer.from(`opencode:${saved.password}`).toString("base64")}` };
  } catch { return null; }
}

/** Splits server-sent events out of `buffer`: each complete event's data, and what is left of an unfinished one. */
export function parseSse(buffer: string): { data: string[]; rest: string } {
  const data: string[] = [];
  const blocks = buffer.replace(/\r\n?/g, "\n").split("\n\n");
  const rest = blocks.pop() ?? "";
  for (const block of blocks) {
    const lines = block.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(line.startsWith("data: ") ? 6 : 5));
    if (lines.length > 0) data.push(lines.join("\n"));
  }
  return { data, rest };
}

interface Reply { message: string; parts: string[] }

export class OpencodeStream {
  /** each watched pane's session */
  private readonly panes = new Map<string, string>();
  /** the reply each session is writing, as streamed so far */
  private readonly replies = new Map<string, Reply>();
  private abort: AbortController | null = null;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private failures = 0;

  constructor(
    private readonly send: (paneId: string, frame: OpencodeStreamFrame) => void,
    /** the transcript has something new for this pane: read it now rather than at the next poll */
    private readonly settled: (paneId: string) => void,
    private readonly service: () => OpencodeService | null = readOpencodeService,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  get watching(): number { return this.panes.size; }
  get connected(): boolean { return this.abort !== null; }

  /** The pane shows this OpenCode session (null: no longer, or another agent): its text follows it. */
  watch(paneId: string, session: string | null): void {
    if (session === null) { this.unwatch(paneId); return; }
    if (this.panes.get(paneId) === session) return;
    this.panes.set(paneId, session);
    // a chat opened while the reply streams starts from what is streamed so far
    const reply = this.replies.get(session);
    if (reply) reply.parts.forEach((text, part) => { if (text) this.send(paneId, { message_id: reply.message, part, offset: 0, text }); });
    this.start();
  }

  unwatch(paneId: string): void {
    if (!this.panes.delete(paneId) || this.panes.size > 0) return;
    this.stop();
  }

  stop(): void {
    if (this.retry !== null) clearTimeout(this.retry);
    this.retry = null;
    this.abort?.abort();
    this.abort = null;
    this.replies.clear();
  }

  /** One event from the stream (the tests' way in): routed to the panes showing its session. */
  handle(event: unknown): void {
    if (typeof event !== "object" || event === null) return;
    const { type, data } = event as { type?: unknown; data?: unknown };
    if (typeof type !== "string" || typeof data !== "object" || data === null) return;
    const fields = data as { sessionID?: unknown; assistantMessageID?: unknown; ordinal?: unknown; delta?: unknown; text?: unknown };
    const session = typeof fields.sessionID === "string" ? fields.sessionID : null;
    if (session === null) return;
    const panes = [...this.panes].filter(([, watched]) => watched === session).map(([pane]) => pane);
    // the service streams every session it runs: one no chat here shows is not kept
    if (panes.length === 0) { this.replies.delete(session); return; }
    const message = typeof fields.assistantMessageID === "string" ? fields.assistantMessageID : null;
    const part = typeof fields.ordinal === "number" && Number.isInteger(fields.ordinal) && fields.ordinal >= 0 && fields.ordinal < 1000 ? fields.ordinal : null;
    if ((type === "session.text.delta" || type === "session.text.ended") && message !== null && part !== null) {
      let reply = this.replies.get(session);
      if (reply?.message !== message) { reply = { message, parts: [] }; this.replies.set(session, reply); }
      const before = reply.parts[part] ?? "";
      if (type === "session.text.delta" && typeof fields.delta === "string") {
        if (before.length + fields.delta.length > PART_MAX_CHARS) return;
        reply.parts[part] = before + fields.delta;
        for (const pane of panes) this.send(pane, { message_id: message, part, offset: before.length, text: fields.delta });
      } else if (type === "session.text.ended" && typeof fields.text === "string" && fields.text.length <= PART_MAX_CHARS) {
        // the whole part: it mends a delta lost on the way
        reply.parts[part] = fields.text;
        for (const pane of panes) this.send(pane, { message_id: message, part, offset: 0, text: fields.text });
      }
    }
    if (ENDED.has(type)) {
      const reply = this.replies.get(session);
      this.replies.delete(session);
      if (reply) for (const pane of panes) this.send(pane, { message_id: reply.message, done: true });
    }
    if (SETTLING.has(type)) for (const pane of panes) this.settled(pane);
  }

  private start(): void {
    if (this.abort !== null || this.retry !== null || this.panes.size === 0) return;
    const service = this.service();
    if (service === null) { this.again(); return; }
    const abort = new AbortController();
    this.abort = abort;
    void this.read(service, abort).finally(() => {
      if (this.abort !== abort) return;
      this.abort = null;
      // a gap in the stream: what was streamed may miss deltas, and the store may have moved on
      this.replies.clear();
      for (const pane of this.panes.keys()) this.settled(pane);
      this.again();
    });
  }

  private again(): void {
    if (this.panes.size === 0 || this.retry !== null) return;
    const delay = Math.min(RETRY_MAX_MS, RETRY_MIN_MS * 2 ** this.failures);
    this.failures += 1;
    this.retry = setTimeout(() => { this.retry = null; this.start(); }, delay);
    this.retry.unref?.();
  }

  private async read(service: OpencodeService, abort: AbortController): Promise<void> {
    try {
      const response = await this.fetchImpl(`${service.url}/api/event`, { headers: { authorization: service.authorization, accept: "text/event-stream" }, signal: abort.signal });
      if (!response.ok || response.body === null) return;
      this.failures = 0;
      const decoder = new TextDecoder();
      let buffer = "";
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        const { data, rest } = parseSse(buffer + decoder.decode(chunk, { stream: true }));
        buffer = rest;
        for (const item of data) {
          let event: unknown;
          try { event = JSON.parse(item); } catch { continue; }
          this.handle(event);
        }
      }
    } catch { /* aborted, or the service went away: start() tries again while a chat watches */ }
  }
}
