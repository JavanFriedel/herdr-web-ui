import { useEffect, useState } from "react";
import { WifiOff } from "lucide-react";

import { ApiError } from "../lib/api.ts";
import { useT, type Translate } from "../lib/i18n.ts";
import "./BootScreen.css";

/** how long the first answer may take before the screen says it is still waiting, and for how long */
const QUIET_MS = 3000;

export interface BootFailure {
  error: unknown;
  /** how long the request was given before it was dropped, for a timeout's words */
  timeoutMs: number;
}

interface Props {
  /** the browser's own word on the network */
  networkOnline: boolean;
  /** the address asked (location.host), so a person can tell which server it is */
  host: string;
  /** when the first question went out */
  startedAt: number;
  /** the last question's failure; null while none has failed (or it is still waiting) */
  failure: BootFailure | null;
  /** when the next question goes out by itself */
  nextTryAt: number;
  onRetry(): void;
}

/**
 * What the terminal's place shows before the server has said whether it wants a token (the shell
 * draws around it, without a terminal and so without a WebSocket). The page itself may come from
 * this device's saved copy (public/sw.js) while the server stays out of reach, so a failure is said
 * here, with the browser's words for it, instead of "Connecting…" forever.
 */
export function BootScreen({ networkOnline, host, startedAt, failure, nextTryAt, onRetry }: Props) {
  const t = useT();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const failed = failure !== null || !networkOnline;
  const waited = Math.round((now - startedAt) / 1000);
  const retryIn = Math.max(0, Math.ceil((nextTryAt - now) / 1000));
  let detail: string | null = null;
  if (!networkOnline) detail = t("This device has no network connection.");
  else if (failure) detail = failureWords(failure, t);
  else if (now - startedAt >= QUIET_MS) detail = t("No answer yet · {seconds} s", { seconds: waited });

  return (
    <div className={`boot-screen${failed ? " is-failed" : ""}`} role="status">
      {failed && <WifiOff className="boot-screen-icon" aria-hidden="true" />}
      <span className="boot-screen-title">{!networkOnline ? t("No network") : failure ? t("Can't reach herdr web ui") : t("Connecting to herdr web ui…")}</span>
      {detail && <span className="boot-screen-detail">{detail}</span>}
      {failed && <>
        <span className="boot-screen-detail">{host}</span>
        <span className="boot-screen-hint">{t("Check that this device can reach the server, for example that its VPN is on.")}</span>
        <div className="boot-screen-retry">
          <span>{t("Trying again in {seconds} s", { seconds: retryIn })}</span>
          <button type="button" className="btn btn-ghost" onClick={onRetry}>{t("Retry")}</button>
        </div>
      </>}
    </div>
  );
}

/** the failure in words: a timeout by its length, a server's refusal by its status, the browser's own words otherwise */
function failureWords(failure: BootFailure, t: Translate): string {
  const { error } = failure;
  if (error instanceof DOMException && (error.name === "TimeoutError" || error.name === "AbortError")) {
    return t("No answer after {seconds} s", { seconds: Math.round(failure.timeoutMs / 1000) });
  }
  if (error instanceof ApiError) return t("The server answered {status}: {detail}", { status: error.status, detail: error.detail });
  return error instanceof Error && error.message ? error.message : String(error);
}
