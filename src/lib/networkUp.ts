/**
 * Knowing when the network works again after a phone wakes. A phone's VPN (Tailscale) can take
 * 10 s or more to carry traffic again after an unlock, and every request sent meanwhile sits in
 * TCP's own backoff: a connect attempt made at once retries its handshake only 1, 3 and 7 s
 * later, and an HTTP read waits out its whole deadline, so the app noticed the network back up
 * to seconds after it was. Measured on a phone: connect and history read sent at the wake, the
 * network back between 11 and 15 s, both answered at 15.4 s.
 *
 * `confirmNetwork()` (a wake from a long hide, or the browser's online event) asks this app's own
 * server a tiny question about once a second, each try given up after a short deadline, until one
 * is answered. An answer of any status proves the path. Then every listener hears the time that
 * answered request was sent: whatever started well before it went out on a dead path and should
 * be replaced by a fresh one, which now gets through at once. Only the visible page asks.
 */
import { connectionDiagnostics } from "./connectionDiagnostics.ts";

const TRY_MS = 1_500;
const SPACING_MS = 1_000;
const GIVE_UP_MS = 45_000;

type Listener = (sentAt: number) => void;
const listeners = new Set<Listener>();
let running = false;
/** how many times the network was heard to work: a run that started at an earlier count has its answer */
let ups = 0;
/** the count when the run asking now started */
let runUps = 0;
/** a run gave up since the network last worked: a long outage, not a wake's few seconds */
let gaveUp = false;

/** `listener` hears the send time of the first request answered after a confirmNetwork() */
export function onNetworkUp(listener: Listener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/**
 * Tells every listener the network carried a request sent at `sentAt`: a confirm's answer, or a
 * socket that opened (lib/ws.ts). Also the tests' way in.
 */
export function notifyNetworkUp(sentAt: number): void {
  ups += 1;
  gaveUp = false;
  startOver(sentAt);
}

/** Whatever went out well before `sentAt` starts over: each listener decides what that is. */
function startOver(sentAt: number): void {
  for (const listener of [...listeners]) listener(sentAt);
}

/**
 * A run is asking and nothing has answered yet: whether the network carries traffic is not known.
 * False again once a run gave up, until the network works: a long outage is not hurried.
 */
export function confirmingNetwork(): boolean {
  return running && !gaveUp && ups === runUps;
}

/**
 * The user's Reconnect now: whatever is still connecting, reading or waiting out a backoff starts
 * over at once, as when the network comes back, and the network is asked about again.
 */
export function retryNow(): void {
  connectionDiagnostics.mark("net.retry-now");
  // asked first, so the attempts that start over get the short deadline of a network in doubt
  gaveUp = false;
  confirmNetwork();
  startOver(Date.now());
}

/** Starts asking whether the network carries traffic again; a run already asking is left to it. */
export function confirmNetwork(): void {
  // only a page asks its server: a test or a worker has no origin to ask
  if (running || typeof fetch !== "function" || typeof location === "undefined") return;
  running = true;
  runUps = ups;
  void ask().finally(() => { running = false; });
}

async function ask(): Promise<void> {
  const started = Date.now();
  const span = connectionDiagnostics.span("net.confirm");
  while (Date.now() - started < GIVE_UP_MS) {
    if (typeof document !== "undefined" && document.visibilityState === "hidden") { span.end("cancelled"); return; }
    // a socket opened meanwhile: the network is proven, and its listeners have heard
    if (ups !== runUps) { span.end(); return; }
    const sentAt = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TRY_MS);
    try {
      // any answer proves the path; an abandoned try also ends the connection it was stuck on
      await fetch("/api/health?scope=bridge", { cache: "no-store", signal: controller.signal });
      clearTimeout(timer);
      span.end();
      notifyNetworkUp(sentAt);
      return;
    } catch {
      clearTimeout(timer);
      const left = SPACING_MS - (Date.now() - sentAt);
      if (left > 0) await new Promise((resolve) => setTimeout(resolve, left));
    }
  }
  gaveUp = true;
  span.end("error");
}
