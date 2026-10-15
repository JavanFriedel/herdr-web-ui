import { useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowUpCircle, ChevronDown, ChevronRight, Download, Monitor, MonitorCog, Pencil, Plug, Plus, RefreshCw, Settings, Trash2, Unplug, X } from "lucide-react";
import type { Machine, MachineState, MachineUpdate } from "../../shared/machines.ts";
import { MachineContext } from "../lib/machineContext.tsx";
import { answerMachineSetup, machineRequest } from "../lib/api.ts";
import { describeProgress } from "../lib/bridgeProgress.ts";
import { keepDismissed, noticeKey, readDismissed, waitingMachines, writeDismissed } from "../lib/machineNotice.ts";
import type { AppActions } from "../lib/actions.ts";
import { useInstallPrompt } from "../lib/install.ts";
import { Sidebar } from "./Sidebar.tsx";
import { RowMenu, type RowMenuItem } from "./RowMenu.tsx";
import { ConfirmDialog } from "./ConfirmDialog.tsx";
import { AgentSidebar, NeedsYou } from "./AgentSidebar.tsx";
import { SidebarActivityProvider, type SidebarActivity } from "../lib/sidebarActivity.tsx";
import type { NeedsYouRow } from "../lib/needsYou.ts";
import { UsageMeters } from "./UsageMeters.tsx";
import "./Machines.css";
import { useT } from "../lib/i18n.ts";

/** The PC header's state word; "connected" is the quiet default and shows as a dot alone, every other state also writes its word under the name. */
export const STATE_WORD: Readonly<Record<MachineState, string>> = {
  connecting: "Connecting…",
  connected: "Connected",
  reconnecting: "Reconnecting…",
  disconnected: "Disconnected",
  error: "Connection error",
};

interface Props { notice?: ReactNode; activity: SidebarActivity; needsYou: readonly NeedsYouRow[]; machines: Machine[]; selectedMachineId: string; selectedPaneId: string | null; actions: AppActions; onSelect(machineId: string, paneId: string | null): void; onNew(machineId: string): void; onSetup(machine: Machine, update?: boolean): void }
export function MachineSidebar(props: Props) {
  const t = useT();
  const { canInstall, installed, install, help } = useInstallPrompt();
  const [installHelpOpen, setInstallHelpOpen] = useState(false);
  // both lists draw from it: live counters per PC (lib/sidebarActivity.tsx);
  // App owns it, since the drawer's toggle counts Needs you from it too
  const { activity } = props;
  // no top bar: a workspace starts from its PC's header, and Add PC lives in Settings → Remote PCs
  return <SidebarActivityProvider value={activity}><div className="sidebar-shell">
    <NeedsYou rows={props.needsYou} machines={props.machines} onSelect={props.onSelect} />
    <div className="machine-list" aria-label={t("PCs and workspaces")}>
      {props.machines.map((machine) => <MachineGroup key={machine.id} {...props} machine={machine} />)}
      {!props.machines.length && <p className="tree-state" role="status">{t("Loading PCs…")}</p>}
    </div>
    <AgentSidebar machines={props.machines} selectedMachineId={props.selectedMachineId} selectedPaneId={props.selectedPaneId} stateWord={(machine) => t(STATE_WORD[machine.state])} onSelect={props.onSelect} />
    <footer className="sidebar-footer">
      {/* the app's update line (UpdateNotice): here, not over the chat, and the header's toggle points to it */}
      {props.notice}
      {/* browsers without an install prompt (iOS, plain HTTP) get the steps instead */}
      {!installed && <button className="btn btn-ghost sidebar-footer-action" aria-expanded={canInstall ? undefined : installHelpOpen} onClick={() => { if (canInstall) void install(); else setInstallHelpOpen(!installHelpOpen); }}><Download aria-hidden="true" />{t("Install app")}</button>}
      {!installed && !canInstall && installHelpOpen && <p className="sidebar-install-help" role="status">{help}</p>}
      <div className="sidebar-footer-row">
        <button className="btn btn-ghost sidebar-footer-action" title={t("Settings (⌘⇧,)")} onClick={props.actions.openSettings}><Settings aria-hidden="true" />{t("Settings")}</button>
        <UsageMeters />
      </div>
    </footer>
  </div></SidebarActivityProvider>;
}

function MachineGroup({ machine, ...props }: Props & { machine: Machine }) {
  const t = useT();
  const [collapsed, setCollapsed] = useState(() => { try { return localStorage.getItem(`herdr-web-ui:pc-collapsed:${machine.id}`) === "1"; } catch { return false; } });
  // the PC's details sheet, opened from its name; Rename and Remove start from there
  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(machine.name);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const online = machine.state === "connected";
  // one request at a time: a double-clicked Disconnect/Connect can otherwise race and leave this
  // UI's idea of the state opposite the server's until the next refetch
  const [busy, setBusy] = useState(false);
  // the state disables the buttons; the ref refuses a second click that lands before that render
  const inFlight = useRef(false);
  const mutate = async (method: string, body?: unknown): Promise<boolean> => {
    if (inFlight.current) return false;
    inFlight.current = true;
    setBusy(true);
    // The selected PC moves to this one before it is removed: the server tells every tab the
    // roster without it before it answers, and a selection on a PC the roster has dropped reads
    // as one removed elsewhere ("That link's PC is not set up here"). A failure puts it back.
    const leaving = method === "DELETE" && props.selectedMachineId === machine.id ? { pane: props.selectedPaneId } : null;
    if (leaving) props.onSelect("local", null);
    try { await machineRequest(`/${machine.id}`, method, body); setError(null); return true; }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); if (leaving) props.onSelect(machine.id, leaving.pane); return false; }
    finally { inFlight.current = false; setBusy(false); }
  };
  const actions: AppActions = { ...props.actions, selectPane: (id) => props.onSelect(machine.id, id), openNewSession: () => props.onNew(machine.id) };
  const toggle = () => {
    setCollapsed(!collapsed);
    try { localStorage.setItem(`herdr-web-ui:pc-collapsed:${machine.id}`, collapsed ? "0" : "1"); } catch {}
  };
  const ssh = machine.kind === "ssh";
  const reachable = machine.enabled && Boolean(machine.target);
  const menuItems: RowMenuItem[] = [
    ...(ssh && !["setup", "connect"].includes(machine.action_required ?? "") && reachable ? [{ id: "reconnect", label: t("Reconnect / setup"), icon: RefreshCw, run: () => props.onSetup(machine) }] : []),
    ...(ssh && machine.action_required !== "connect" && reachable ? [{ id: "update-bridge", label: t("Update bridge…"), icon: ArrowUpCircle, run: () => props.onSetup(machine, true) }] : []),
    ...(ssh && !machine.herdr_profile_id ? [{ id: "toggle-enabled", label: t(machine.enabled ? "Disconnect" : "Connect"), icon: machine.enabled ? Unplug : Plug, run: () => void mutate("PATCH", { enabled: !machine.enabled }) }] : []),
    ...(ssh && !machine.herdr_profile_id ? [{ id: "rename", label: t("Rename…"), icon: Pencil, divider: true, run: () => { setName(machine.name); setRenaming(true); } }] : []),
    ...(ssh && !machine.herdr_profile_id ? [{ id: "remove", label: t("Remove PC"), icon: Trash2, danger: true, run: () => setConfirmDelete(true) }] : []),
    // the host has nothing of its own to change here: its sheet is where another PC is added
    ...(ssh ? [] : [{ id: "add-pc", label: t("Add PC"), icon: MonitorCog, run: props.actions.openAddPc }]),
  ];
  const details = [
    t(machine.action_required === "setup" ? "Setup needed" : STATE_WORD[machine.state]),
    machine.target ? machine.target.destination + (machine.target.port ? `:${machine.target.port}` : "") : null,
    machine.herdr ? t("herdr {version} · protocol {protocol}", { version: machine.herdr.version, protocol: machine.herdr.protocol }) : null,
  ].filter((part): part is string => part !== null);
  // the PC's name is the head of its workspaces, and the caret beside its + the one fold over them
  return <section className={`machine-group${props.selectedMachineId === machine.id ? " is-current" : ""}${online ? "" : " is-offline"}`} aria-label={t("PC {name}", { name: machine.name })}>
    <header className="machine-header">
      {/* the name opens the PC's details: its state, address and herdr, and what can be done about them */}
      <button type="button" className="machine-title" aria-haspopup="menu" aria-expanded={menuAnchor !== null} aria-label={t("Details for {name}", { name: machine.name })} title={details.join(" · ")} onClick={(event) => setMenuAnchor(menuAnchor ? null : event.currentTarget)}>
        <span className="sidebar-mark" aria-hidden="true"><Monitor /></span>
        <span className="machine-name">{machine.name}</span>
        {/* the computer this app's server runs on; on a phone "this PC" read as the phone */}
        {machine.kind === "local" && <span className="machine-kind" title={t("The computer this app runs on")}>{t("Host")}</span>}
        <span className={`machine-dot is-${machine.action_required === "setup" ? "setup" : machine.state}`} aria-hidden="true" />
      </button>
      {/* the fold over this PC's workspaces sits beside the + */}
      <button className="sidebar-row-action machine-toggle" aria-expanded={!collapsed} aria-label={collapsed ? t("Expand {name}", { name: machine.name }) : t("Collapse {name}", { name: machine.name })} title={collapsed ? t("Expand {name}", { name: machine.name }) : t("Collapse {name}", { name: machine.name })} onClick={toggle}>{collapsed ? <ChevronRight aria-hidden="true" /> : <ChevronDown aria-hidden="true" />}</button>
      <button className="sidebar-row-action machine-new" disabled={!online} aria-label={t("New workspace on {name}", { name: machine.name })} title={t("New workspace")} onClick={() => props.onNew(machine.id)}><Plus aria-hidden="true" /></button>
    </header>
    {/* connected is the norm and says nothing new; every other state is spelled out */}
    {machine.action_required || machine.updating ? <MachineActionNotice machine={machine} onSetup={props.onSetup} /> : <p className={`machine-state is-${machine.state}${online ? " visually-hidden" : ""}`} role="status" title={machine.error ?? undefined}>
      <span className="machine-state-word">{t(STATE_WORD[machine.state])}</span>
      {machine.error && <span className="machine-state-detail">{machine.error}</span>}
    </p>}
    {menuAnchor && <RowMenu
      anchor={menuAnchor}
      title={machine.name}
      header={<div className="machine-sheet-head">
        <span className="machine-sheet-name">{machine.name}</span>
        <span className={`machine-sheet-state is-${machine.action_required === "setup" ? "setup" : machine.state}`}>{details[0]}</span>
        {details.slice(1).map((line) => <span key={line} className="machine-sheet-line">{line}</span>)}
        {machine.error && <span className="machine-sheet-line machine-sheet-error">{machine.error}</span>}
        {machine.herdr_profile_id && <span className="machine-sheet-line">{t("Managed by herdr. Rename, disable or remove it there.")}</span>}
      </div>}
      items={menuItems}
      onClose={() => setMenuAnchor(null)}
    />}
    {renaming && <form className="machine-controls" onSubmit={(e) => { e.preventDefault(); void mutate("PATCH", { name }).then((done) => { if (done) setRenaming(false); }); }}>
      <label className="field"><span className="field-label">{t("PC name")}</span><input className="input" value={name} maxLength={100} autoFocus onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === "Escape") setRenaming(false); }} /></label>
      <div className="machine-control-buttons">
        <button className="btn btn-primary" type="submit" disabled={busy}>{t("Rename")}</button>
        <button className="btn btn-ghost" type="button" onClick={() => setRenaming(false)}>{t("Cancel")}</button>
      </div>
    </form>}
    {confirmDelete && <ConfirmDialog title={t("Remove {name}?", { name: machine.name })} body={t("Removes this registration. Remote sessions keep running.")} confirmLabel={t("Remove PC")} onConfirm={async () => { await mutate("DELETE"); }} onClose={() => setConfirmDelete(false)} />}
    {error && <p className="machine-error" role="alert">{error}</p>}
    {!collapsed && <div className={online ? "" : "machine-offline"} inert={!online}>
      {!online && !machine.snapshot ? <p className="tree-state machine-empty" role="status">{t("No saved sessions")}</p> : <MachineContext.Provider value={machine.id}><Sidebar snapshot={machine.snapshot} online={online} selectedPaneId={props.selectedMachineId === machine.id ? props.selectedPaneId : null} actions={actions} /></MachineContext.Provider>}
    </div>}
  </section>;
}

/** Seconds since the stage began, ticking on this device: install and restart have no bytes to show. */
function useStageSeconds(update: MachineUpdate): number {
  const key = `${update.job_id}:${update.progress?.stage ?? ""}`;
  const [start, setStart] = useState(() => ({ key, at: Date.now() - (update.progress?.elapsed_ms ?? 0) }));
  const [now, setNow] = useState(Date.now());
  useEffect(() => { if (start.key !== key) setStart({ key, at: Date.now() - (update.progress?.elapsed_ms ?? 0) }); }, [key]);
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 1000); return () => window.clearInterval(timer); }, []);
  return Math.max(0, Math.round((now - start.at) / 1000));
}

/** A bridge install in words and a bar: the step, the bytes, and roughly how long is left. */
export function BridgeUpdateProgress({ update }: { update: MachineUpdate }) {
  const view = describeProgress(update.progress);
  const seconds = useStageSeconds(update);
  if (!view) return <p className="bridge-progress-step">{update.step}</p>;
  return <div className="bridge-progress">
    <p className="bridge-progress-step"><span>{view.label}</span><span className="bridge-progress-count">{view.step}</span></p>
    <div className="bridge-progress-bar" role="progressbar" aria-label={view.label} aria-valuemin={0} aria-valuemax={100} {...(view.percent === null ? {} : { "aria-valuenow": view.percent })}>
      <span className={view.percent === null ? "is-indeterminate" : ""} style={view.percent === null ? undefined : { width: `${view.percent}%` }} />
    </div>
    <p className="bridge-progress-detail">{view.detail ?? `${seconds} s`}</p>
  </div>;
}

/** Retrying can't reconnect this PC: say what the user has to do, with the button that does it. */
function MachineActionNotice({ machine, onSetup }: { machine: Machine; onSetup(machine: Machine, update?: boolean): void }) {
  const t = useT();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async (request: () => Promise<unknown>) => {
    setBusy(true); setError(null);
    try { await request(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };
  if (machine.updating) {
    const updating = machine.updating;
    return <div className="machine-action is-updating" role="status">
      <p className="machine-action-text"><strong>{t("Updating the bridge")}</strong><span>{t("You can keep using the app; this PC reconnects when it is done.")}</span></p>
      <BridgeUpdateProgress update={updating} />
      <button type="button" className="btn" disabled={busy} onClick={() => void run(() => answerMachineSetup(updating.job_id, { action: "cancel" }))}>{t("Cancel update")}</button>
      {error && <p className="machine-error" role="alert">{error}</p>}
    </div>;
  }
  if (machine.action_required === "connect") return <div className="machine-action is-setup" role="status">
    <p className="machine-action-text"><strong>{t("Saved in herdr")}</strong><span>{t("Connect once to enable automatic reconnection. Installation and startup need separate approval.")}</span></p>
    <button type="button" className="btn btn-primary" onClick={() => onSetup(machine, false)}>{t("Connect")}</button>
  </div>;
  // another app's bridge runs on this PC: neither an update from here nor an approval fixes that,
  // so it is named as what it is, with the server's reason and a plain reconnect
  if (machine.action_required === "bridge_conflict") return <div className="machine-action" role="alert">
    <p className="machine-action-text"><strong>{t("Bridge connection conflict")}</strong><span>{t("Update the apps connected to this PC to the same version, or disconnect the other app, then reconnect here. Sessions keep running.")}</span>{machine.error && <span className="machine-action-reason">{machine.error}</span>}</p>
    <button type="button" className="btn btn-primary" onClick={() => onSetup(machine, false)}>{t("Reconnect")}</button>
  </div>;
  const update = machine.action_required === "update_bridge";
  return <div className={`machine-action${update ? "" : " is-setup"}`} role={update ? "alert" : "status"}>
    <p className="machine-action-text">
      <strong>{t(update ? "Bridge update needed" : "Setup needed")}</strong>
      <span>{t(update ? "This PC runs a bridge from a different version of herdr web ui. Update it to reconnect; herdr sessions keep running." : "Browser access uses a bridge on this PC. Review any installation or startup changes before connecting.")}</span>
      {/* the two generic reasons only repeat the sentence above */}
      {machine.error && !/different version|setup needs approval/.test(machine.error) && <span className="machine-action-reason">{machine.error}</span>}
    </p>
    {update ? <div className="machine-action-buttons">
      {/* a PC saved in herdr that has not connected yet is refused a direct update: its dialog connects first */}
      <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void run(() => machineRequest(`/${encodeURIComponent(machine.id)}/update-bridge`, "POST").catch((e) => { if (!machine.herdr_profile_id) throw e; onSetup(machine, true); }))}>{t("Update bridge")}</button>
      {/* a PC that needs a password or a new host key goes through its dialog */}
      <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => onSetup(machine, true)}>{t("Sign in and update…")}</button>
    </div> : <button type="button" className="btn btn-primary" onClick={() => onSetup(machine, false)}>{t("Set up web access")}</button>}
    {error && <p className="machine-error" role="alert">{error}</p>}
  </div>;
}

/** The app-wide line for PCs that wait on the user, so a closed drawer on a phone still says so. */
export function MachineActionBanner({ machines, onSetup, onDismiss }: { machines: Machine[]; onSetup(machine: Machine, update?: boolean): void; onDismiss?(): void }) {
  const t = useT();
  // a PC that cannot be updated right now would hold this line open for good: it can be closed,
  // and the PC's own row in the sidebar keeps saying what it needs
  const [dismissed, setDismissed] = useState(readDismissed);
  useEffect(() => {
    const kept = keepDismissed(dismissed, machines);
    if (kept.length !== dismissed.length) { setDismissed(kept); writeDismissed(kept); }
  }, [machines, dismissed]);
  const running = machines.find((machine) => machine.updating);
  if (running?.updating) {
    const view = describeProgress(running.updating.progress);
    return <div className="update-notice" role="status">
      <span>{t("Updating the bridge on {name}", { name: running.name })}{view ? ` · ${t(view.label)}${view.percent === null ? "" : ` ${view.percent}%`}` : "…"}</span>
    </div>;
  }
  const waiting = waitingMachines(machines, dismissed);
  const first = waiting[0];
  if (!first) return null;
  const conflict = first.action_required === "bridge_conflict";
  const update = first.action_required === "update_bridge";
  const others = waiting.length > 1 ? t(" (+{n} more)", { n: waiting.length - 1 }) : "";
  return <div className="update-notice" role="status">
    <span>{t(conflict ? "{name} has a bridge connection conflict{others}." : update ? "{name} needs a bridge update to reconnect{others}." : "{name} needs web access setup{others}.", { name: first.name, others })}</span>
    <button type="button" className="btn" onClick={() => update ? void machineRequest(`/${encodeURIComponent(first.id)}/update-bridge`, "POST").catch(() => onSetup(first, true)) : onSetup(first, false)}>{t(conflict ? "Reconnect" : update ? "Update bridge" : "Set up web access")}</button>
    <button type="button" className="icon-button update-notice-dismiss" aria-label={t("Dismiss")} title={t("Dismiss")} onClick={() => { const next = [...dismissed, ...waiting.map(noticeKey)]; setDismissed(next); writeDismissed(next); onDismiss?.(); }}><X /></button>
  </div>;
}
