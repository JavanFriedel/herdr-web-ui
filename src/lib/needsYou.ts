/**
 * Needs you: the agents across every connected PC that wait on the user, for the top of the
 * sidebar and the count on the drawer's toggle. An agent waiting for an answer comes first, then
 * a finish not opened here yet, each newest first by herdr's state_change_seq. The pane on screen
 * is left out: it is already in front of the user.
 */
import type { Machine } from "../../shared/machines.ts";
import type { Attention, SidebarActivity } from "./sidebarActivity.tsx";
import { sidebarAgents, type SidebarAgent } from "./sidebarAgents.ts";

export interface NeedsYouRow { machine: Machine; entry: SidebarAgent; attention: Attention }

const RANK: Record<Attention, number> = { blocked: 0, done: 1 };

export function needsYouRows(
  machines: readonly Machine[],
  activity: Pick<SidebarActivity, "attention" | "seqs">,
  selectedMachineId: string,
  selectedPaneId: string | null,
): NeedsYouRow[] {
  const rows: (NeedsYouRow & { seq: number })[] = [];
  for (const machine of machines) {
    // a saved roster's state is not news: a PC that is away asks nothing
    if (machine.state !== "connected") continue;
    const seqs = activity.seqs(machine.id);
    for (const entry of sidebarAgents(machine.snapshot)) {
      if (machine.id === selectedMachineId && entry.pane.pane_id === selectedPaneId) continue;
      const attention = activity.attention(machine.id, entry.pane);
      if (attention) rows.push({ machine, entry, attention, seq: seqs.get(entry.pane.pane_id) ?? 0 });
    }
  }
  rows.sort((a, b) => RANK[a.attention] - RANK[b.attention] || b.seq - a.seq);
  return rows.map(({ seq: _seq, ...row }) => row);
}
