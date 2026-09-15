import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import { createPortal } from "react-dom";
import { getJson, postJson } from "../api/http";
import { useAppState } from "../state/app-state";
import type { RuntimePickerOption } from "../types/ui";

type ModelCatalog = {
  providers: RuntimePickerOption[];
  all_models_by_provider: Record<string, Array<RuntimePickerOption & { enabled: boolean }>>;
};

type Change = { profile: string; model?: string; enabled: boolean };

function previewChanges(catalog: ModelCatalog, changes: Change[]): ModelCatalog {
  return changes.reduce((value, change) => ({ ...value, all_models_by_provider: {
    ...value.all_models_by_provider,
    [change.profile]: value.all_models_by_provider[change.profile].map((model) =>
      change.model === undefined || model.value === change.model ? { ...model, enabled: change.enabled } : model),
  } }), catalog);
}

export function ModelAvailabilityMenu({ anchorRef, onClose }: {
  anchorRef: RefObject<HTMLButtonElement | null>; onClose: () => void;
}) {
  const { state, dispatch } = useAppState();
  const panel = useRef<HTMLDivElement>(null);
  const [catalog, setCatalog] = useState<ModelCatalog | null>(null);
  const confirmed = useRef<ModelCatalog | null>(null);
  const pending = useRef<Change[]>([]);
  const draining = useRef(false);
  const runtimePicker = useRef(state.runtimePicker);
  runtimePicker.current = state.runtimePicker;
  const [expanded, setExpanded] = useState(state.activeProfile);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [position, setPosition] = useState({ left: 8, bottom: 80, maxHeight: 360 });
  useEffect(() => {
    let mounted = true;
    getJson<ModelCatalog>("/api/settings/models").then((value) => {
      if (mounted) { confirmed.current = value; setCatalog(value); setExpanded((current) => current || value.providers[0]?.value || ""); }
    }).catch((reason) => { if (mounted) setError(String(reason.message || reason)); });
    return () => { mounted = false; };
  }, []);
  useLayoutEffect(() => {
    const update = () => {
      const rect = anchorRef.current?.getBoundingClientRect();
      if (rect) setPosition({ left: Math.max(8, Math.min(rect.left, window.innerWidth - 328)), bottom: window.innerHeight - rect.top + 8, maxHeight: Math.max(80, rect.top - 16) });
    };
    update();
    panel.current?.focus();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, [anchorRef]);
  useEffect(() => {
    const outside = (event: PointerEvent) => {
      if (!panel.current?.contains(event.target as Node) && !anchorRef.current?.contains(event.target as Node)) onClose();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") { onClose(); anchorRef.current?.focus(); }
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", outside); document.removeEventListener("keydown", escape); };
  }, [anchorRef, onClose]);

  async function drain() {
    if (draining.current) return;
    draining.current = true;
    setSaving(true);
    while (pending.current.length) {
      const change = pending.current[0];
      try {
        const value = await postJson<ModelCatalog>("/api/settings/models", change);
        confirmed.current = value;
        dispatch({ type: "backend_event", event: { type: "state_snapshot", state: { runtime_options: {
          ...value,
          context_window: runtimePicker.current.contextWindow,
          standard_context_window: runtimePicker.current.standardContextWindow,
          context_mode_available: runtimePicker.current.contextModeAvailable,
          efforts: runtimePicker.current.efforts,
        } } } });
      } catch (reason) {
        setError(`저장하지 못했습니다. 다시 선택해 주세요. ${reason instanceof Error ? reason.message : String(reason)}`);
      }
      pending.current.shift();
      if (confirmed.current) setCatalog(previewChanges(confirmed.current, pending.current));
    }
    draining.current = false;
    setSaving(false);
  }
  function toggle(profile: string, model: string | undefined, enabled: boolean) {
    if (!state.adminMode || !confirmed.current) return;
    pending.current.push({ profile, ...(model === undefined ? {} : { model }), enabled });
    setError("");
    setCatalog(previewChanges(confirmed.current, pending.current));
    void drain();
  }
  if (!state.adminMode) return null;
  return createPortal(<div ref={panel} tabIndex={-1} className="model-availability-menu" role="dialog" aria-label="사용 가능한 모델 관리" style={position}>
    <div className="model-availability-heading"><strong>사용 가능한 모델</strong><span>ADMIN</span></div>
    <p className="model-availability-hint">체크한 모델만 사용자가 선택할 수 있습니다.</p>
    {!catalog && !error && <p role="status">불러오는 중...</p>}
    {catalog?.providers.map((provider) => {
      const models = catalog.all_models_by_provider[provider.value] || [];
      const open = expanded === provider.value;
      return <section key={provider.value}>
        <div className="model-availability-provider-row">
          <input type="checkbox" aria-label={`${provider.label} 전체 선택`} checked={models.length > 0 && models.every((model) => model.enabled)}
            ref={(input) => { if (input) input.indeterminate = models.some((model) => model.enabled) && !models.every((model) => model.enabled); }}
            onChange={(event) => toggle(provider.value, undefined, event.target.checked)} />
        <button type="button" className="model-availability-provider" aria-expanded={open} onClick={() => setExpanded(open ? "" : provider.value)}>
          <strong>{provider.label}</strong><span>{models.filter((model) => model.enabled).length}/{models.length}</span><span aria-hidden="true">{open ? "⌄" : "›"}</span>
        </button>
        </div>
        {open && <div className="model-availability-list" role="group" aria-label={`${provider.label} 허용 모델`}>
          {models.map((model) => <label key={model.value} className="model-availability-option">
            <input type="checkbox" checked={model.enabled} onChange={(event) => void toggle(provider.value, model.value, event.target.checked)} />
            <span>{model.label}</span>
          </label>)}
        </div>}
      </section>;
    })}
    {saving && <p role="status" className="model-availability-hint">저장 중...</p>}
    {error && <p role="alert" className="model-availability-error">{error}</p>}
  </div>, document.body);
}
