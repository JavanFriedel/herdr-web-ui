import type { PaneModels, SlashCommand } from "../../shared/protocol.ts";

/** The command catalog is the capability: an older remote bridge offers no API controls. */
export function hasOpencodeModelControls(agent: string | null, commands: readonly SlashCommand[]): boolean {
  return agent === "opencode" && commands.some((command) => command.source === "builtin" && command.name === "models");
}

/** Only standalone UI commands are intercepted; arguments and ordinary messages stay intact. */
export function opencodeModelCommand(text: string): "model" | "reasoning" | null {
  const command = text.trim();
  return /^\/models?$/.test(command) ? "model" : command === "/variants" ? "reasoning" : null;
}

export function filterPaneModels(models: PaneModels["models"], query: string): PaneModels["models"] {
  const terms = query.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
  return models.filter((model) => {
    const label = `${model.name} ${model.provider_id}/${model.model_id}`.toLocaleLowerCase();
    return terms.every((term) => label.includes(term));
  });
}
