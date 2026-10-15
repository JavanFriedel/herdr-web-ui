import { useEffect, useState } from "react";
import { RefreshCw, WifiOff } from "lucide-react";

import type { Machine } from "../../shared/machines.ts";
import { useLocale, useT } from "../lib/i18n.ts";
import { STATE_WORD } from "./MachineSidebar.tsx";
import "./ConnectionStrip.css";

/** how long a pane's socket may be down before the strip says so: a pane switch drops it for a moment */
const PANE_GRACE_MS = 2000;

interface Props {
  /** the browser's own word on the network (navigator.onLine and its events) */
  networkOnline: boolean;
  /** the roster could not be read: this app's server did not answer */
  serverError: string | null;
  /** when the roster was last read, so an offline strip can say how old the screen is */
  syncedAt: number | null;
  /** the PC the pane on screen lives on */
  machine: Machine | null;
  /** that PC's herdr answers (health's herdr, or the remote bridge's) */
  herdrUp: boolean;
  /** a pane is on screen, so its socket's state is news */
  paneShown: boolean;
  /** the pane's socket is live */
  paneConnected: boolean;
  /** a 4008 close stopped the output: the pane's own banner says so and offers Reconnect */
  outputStopped: boolean;
  onRetry(): void;
  /** the pane's socket is reconnecting: start a fresh attempt now rather than wait out the one in flight */
  onReconnect(): void;
  /** the PC's state is the sidebar's to explain: its name opens the PC's details there */
  onOpenPcs(): void;
}

type Level = "warning" | "danger";
interface Line { level: Level; text: string; detail?: string; action?: { label: string; run(): void }; offline?: boolean; spinning?: boolean }

/**
 * One line under the header that says when what is on screen is not live, most fundamental cause
 * first: no network, this app's server unreachable, the pane's PC away, its herdr silent, then the
 * pane's own socket reconnecting. Live draws nothing. It replaces the header's connection pill on
 * a phone, where that pill was a dot beside a cut title.
 */
export function ConnectionStrip(props: Props) {
  const t = useT();
  const locale = useLocale();
  // the pane's socket may drop for a moment on a switch: say so only once it stays down
  const paneDown = props.paneShown && !props.paneConnected && !props.outputStopped;
  const [downSince, setDownSince] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { setDownSince(paneDown ? Date.now() : null); }, [paneDown]);
  const ticking = downSince !== null || !props.networkOnline || props.serverError !== null;
  useEffect(() => {
    if (!ticking) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [ticking]);

  const synced = props.syncedAt === null ? null : t("Last synced {time}", { time: new Date(props.syncedAt).toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit" }) });
  const machine = props.machine;
  let line: Line | null = null;
  if (!props.networkOnline) {
    line = { level: "danger", offline: true, text: t("No network"), detail: synced ?? undefined };
  } else if (props.serverError !== null) {
    line = { level: "danger", offline: true, text: t("Can't reach herdr web ui"), detail: synced ?? undefined, action: { label: t("Retry"), run: props.onRetry } };
  } else if (machine && machine.state !== "connected") {
    const level: Level = machine.state === "connecting" || machine.state === "reconnecting" ? "warning" : "danger";
    line = { level, spinning: level === "warning", text: `${machine.name}: ${t(STATE_WORD[machine.state])}`, detail: machine.error ?? undefined, action: { label: t("Details"), run: props.onOpenPcs } };
  } else if (machine && !props.herdrUp) {
    line = { level: "danger", text: t("herdr is not answering on {name}", { name: machine.name }), action: { label: t("Details"), run: props.onOpenPcs } };
  } else if (downSince !== null && now - downSince >= PANE_GRACE_MS) {
    line = { level: "warning", spinning: true, text: t("Reconnecting…"), detail: t("{seconds} s", { seconds: Math.round((now - downSince) / 1000) }), action: { label: t("Reconnect now"), run: props.onReconnect } };
  }
  if (line === null) return null;
  const Icon = line.offline ? WifiOff : RefreshCw;
  return <div className={`connection-strip is-${line.level}`} role="status">
    <Icon className={`connection-strip-icon${line.spinning ? " is-spinning" : ""}`} aria-hidden="true" />
    <span className="connection-strip-text">{line.text}</span>
    {line.detail && <span className="connection-strip-detail" title={line.detail}>{line.detail}</span>}
    {line.action && <button type="button" className="btn btn-ghost connection-strip-action" onClick={line.action.run}>{line.action.label}</button>}
  </div>;
}
