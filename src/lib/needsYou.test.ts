import { describe, expect, it } from "bun:test";
import type { Machine } from "../../shared/machines.ts";
import type { AgentInfo, HerdrPane, SessionSnapshot } from "../../shared/protocol.ts";
import { needsYouRows } from "./needsYou.ts";
import type { Attention } from "./sidebarActivity.tsx";

function pane(id: string, overrides: Partial<HerdrPane> = {}): HerdrPane {
  return { pane_id: id, workspace_id: "w1", tab_id: "w1:t1", terminal_id: `${id}:term`, revision: 1, focused: false, agent_status: "idle", agent: "claude", ...overrides };
}

function machine(id: string, panes: HerdrPane[], state: Machine["state"] = "connected"): Machine {
  const snapshot: SessionSnapshot = {
    protocol: 22, version: "test", layouts: [], panes, agents: panes.map((p): AgentInfo => ({ ...p })),
    workspaces: [{ workspace_id: "w1", active_tab_id: "w1:t1", label: "w1", number: 1, tab_count: 1, pane_count: panes.length, focused: false, agent_status: "idle" }],
    tabs: [{ tab_id: "w1:t1", workspace_id: "w1", label: "t1", number: 1, pane_count: panes.length, focused: false, agent_status: "idle" }],
  };
  return { id, name: id, kind: "local", enabled: true, state, error: null, snapshot };
}

/** blocked and done ask, the rest do not; `opened` lists finishes already looked at */
function activity(seqs: Record<string, number>, opened: string[] = []) {
  return {
    seqs: () => new Map(Object.entries(seqs)),
    attention: (_machineId: string, p: Pick<HerdrPane, "pane_id" | "agent_status">): Attention | null =>
      p.agent_status === "blocked" ? "blocked" : p.agent_status === "done" && !opened.includes(p.pane_id) ? "done" : null,
  };
}

describe("needsYouRows", () => {
  it("puts answers first, then unopened finishes, each newest first", () => {
    const pc = machine("pc", [
      pane("old-done", { agent_status: "done" }), pane("new-done", { agent_status: "done" }),
      pane("ask", { agent_status: "blocked" }), pane("busy", { agent_status: "working" }),
    ]);
    const rows = needsYouRows([pc], activity({ "old-done": 1, "new-done": 5, ask: 2, busy: 9 }), "pc", null);
    expect(rows.map((row) => [row.entry.pane.pane_id, row.attention])).toEqual([["ask", "blocked"], ["new-done", "done"], ["old-done", "done"]]);
  });

  it("leaves out the pane on screen, opened finishes and PCs that are away", () => {
    const here = machine("here", [pane("shown", { agent_status: "blocked" }), pane("read", { agent_status: "done" })]);
    const away = machine("away", [pane("cached", { agent_status: "blocked" })], "reconnecting");
    expect(needsYouRows([here, away], activity({}, ["read"]), "here", "shown")).toEqual([]);
  });
});
