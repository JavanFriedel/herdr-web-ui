import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { Check } from "lucide-react";

import type { PaneModels, PaneModelSelection } from "../../shared/protocol.ts";
import { ApiError } from "../lib/api.ts";
import { useMachineApi } from "../lib/machineContext.tsx";
import { filterPaneModels } from "../lib/paneModels.ts";
import { useT } from "../lib/i18n.ts";
import { nativeModalOver, useFocusTrap } from "../lib/useFocusTrap.ts";
import { useSheetSwipe } from "../lib/sheets.ts";
import { usePhoneSheetBack } from "../lib/sheetHistory.ts";
import "./ModelPicker.css";

interface Props {
  paneId: string;
  mode: "model" | "reasoning";
  onClose: () => void;
  onChanged: () => void;
}

/** Choices come from OpenCode's live API. No terminal text, keybindings, or provider config is changed. */
export function ModelPicker({ paneId, mode, onClose, onChanged }: Props) {
  const t = useT();
  const id = useId();
  const { fetchPaneModels, switchPaneModel } = useMachineApi();
  const surface = useFocusTrap<HTMLDivElement>(true);
  const search = useRef<HTMLInputElement>(null);
  const mounted = useRef(true);
  const [catalog, setCatalog] = useState<PaneModels | null>(null);
  const [chosen, setChosen] = useState<PaneModels["models"][number] | null>(null);
  const [query, setQuery] = useState("");
  const [retry, setRetry] = useState(0);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [changed, setChanged] = useState(false);
  const pending = loading || saving;
  useSheetSwipe(surface, saving ? null : onClose);
  usePhoneSheetBack(() => { if (saving) return false; onClose(); });

  useEffect(() => {
    mounted.current = true;
    let live = true;
    setLoading(true); setError(null); setChanged(false); setCatalog(null); setChosen(null);
    void fetchPaneModels(paneId).then((state) => {
      if (!live) return;
      setCatalog(state);
      if (mode === "reasoning") {
        const model = state.models.find((item) => item.provider_id === state.current?.provider_id && item.model_id === state.current?.model_id);
        if (model) setChosen(model);
        else setError(t("Choose a model before changing reasoning effort."));
      }
    }).catch((reason: unknown) => {
      if (live) setError(reason instanceof ApiError ? reason.detail : t("Could not load models. Check the OpenCode connection in Terminal."));
    }).finally(() => { if (live) setLoading(false); });
    return () => { live = false; mounted.current = false; };
  }, [paneId, mode, retry, fetchPaneModels]);

  useEffect(() => {
    if (loading) return;
    if (chosen) {
      const options = surface.current;
      (options?.querySelector<HTMLButtonElement>('.model-picker-option[aria-current="true"]') ?? options?.querySelector<HTMLButtonElement>(".model-picker-option"))?.focus({ preventScroll: true });
    } else if (mode === "model") search.current?.focus({ preventScroll: true });
  }, [loading, chosen, mode]);

  useEffect(() => {
    if (pending) surface.current?.focus({ preventScroll: true });
  }, [pending]);

  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent): void => {
      if (event.key !== "Escape" || nativeModalOver(surface.current)) return;
      event.preventDefault(); event.stopPropagation();
      if (!saving) onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [saving, onClose]);

  const choose = async (model: PaneModelSelection): Promise<void> => {
    if (!catalog || saving || changed) return;
    setSaving(true); setError(null);
    try {
      await switchPaneModel({ pane_id: paneId, session_id: catalog.session_id, revision: catalog.revision, model });
      if (!mounted.current) return;
      onChanged(); onClose();
    } catch (reason: unknown) {
      if (!mounted.current) return;
      setError(reason instanceof ApiError ? reason.detail : t("Model change not confirmed. Check Terminal before trying again."));
      // No retry of a stale or uncertain mutation: only a new catalog can enable a fresh explicit choice.
      setChanged(true);
    } finally { if (mounted.current) setSaving(false); }
  };

  const selectModel = (model: PaneModels["models"][number]): void => {
    if (model.variants.length > 0) { setChosen(model); setError(null); return; }
    void choose({ provider_id: model.provider_id, model_id: model.model_id, variant: null });
  };
  const title = chosen || mode === "reasoning" ? t("Choose reasoning effort") : t("Choose a model");
  const models = catalog ? filterPaneModels(catalog.models, query) : [];
  const currentModel = chosen?.provider_id === catalog?.current?.provider_id && chosen?.model_id === catalog?.current?.model_id;
  const onListKey = (event: KeyboardEvent<HTMLElement>): void => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const buttons = [...(surface.current?.querySelectorAll<HTMLButtonElement>(".model-picker-option:not(:disabled)") ?? [])];
    if (buttons.length === 0) return;
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : Math.max(0, Math.min(buttons.length - 1, at + (event.key === "ArrowDown" ? 1 : -1)));
    event.preventDefault(); buttons[next]?.focus();
  };

  return createPortal(
    <div className="modal-scrim" onMouseDown={(event) => { if (event.target === event.currentTarget && !saving) onClose(); }}>
      <div ref={surface} className="modal model-picker" role="dialog" aria-modal="true" aria-labelledby={`${id}-title`} aria-busy={pending} tabIndex={-1}>
        <header className="modal-header"><h2 className="modal-title" id={`${id}-title`}>{title}</h2></header>
        <div className="modal-body model-picker-body">
          {loading && <p role="status">{t("Loading models…")}</p>}
          {error && <p className="model-picker-error" role="alert">{error}</p>}
          {!loading && catalog && !chosen && mode === "model" && <>
            <input ref={search} className="input" type="search" aria-label={t("Search models…")} placeholder={t("Search models…")} value={query} disabled={saving} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === "ArrowDown") onListKey(event); }} />
            <div className="model-picker-options" onKeyDown={onListKey}>
              {models.map((model) => <button type="button" className="model-picker-option" key={`${model.provider_id}/${model.model_id}`} aria-current={model.provider_id === catalog.current?.provider_id && model.model_id === catalog.current?.model_id ? "true" : undefined} disabled={saving || changed} onClick={() => selectModel(model)}>
                <span><span className="model-picker-name">{model.name}</span><span className="model-picker-provider">{model.provider_id}/{model.model_id}</span></span>
                {model.provider_id === catalog.current?.provider_id && model.model_id === catalog.current?.model_id && <Check aria-hidden="true" />}
              </button>)}
              {models.length === 0 && <p role="status">{t("No models found")}</p>}
            </div>
          </>}
          {!loading && chosen && <div className="model-picker-options" onKeyDown={onListKey}>
            <p className="model-picker-selected">{chosen.name}</p>
            {[null, ...chosen.variants].map((variant) => <button type="button" className="model-picker-option" key={variant ?? "default"} aria-current={currentModel && variant === catalog?.current?.variant ? "true" : undefined} disabled={saving || changed} onClick={() => void choose({ provider_id: chosen.provider_id, model_id: chosen.model_id, variant })}>
              <span>{variant ?? t("Default")}</span>
              {currentModel && variant === catalog?.current?.variant && <Check aria-hidden="true" />}
            </button>)}
          </div>}
          {saving && <p role="status">{t("Changing model…")}</p>}
        </div>
        <footer className="modal-footer">
          {chosen && mode === "model" && <button type="button" className="btn" disabled={saving} onClick={() => setChosen(null)}>{t("Back")}</button>}
          {(error || catalog?.models.length === 0) && <button type="button" className="btn" disabled={pending} onClick={() => setRetry((value) => value + 1)}>{t("Reload models")}</button>}
          <button type="button" className="btn" disabled={saving} onClick={onClose}>{t("Cancel")}</button>
        </footer>
      </div>
    </div>, document.body,
  );
}
