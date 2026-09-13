import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { getJson, postJson } from "../../api/http";
import "./design-mode.css";

const endpoint = "/api/settings/design-mode";
type DesignSettings = { mode: "classic" | "improved" };
const DesignModeContext = createContext<{
  improved: boolean;
  toggle: () => void;
  pending: boolean;
  error: string;
} | null>(null);

/** Server-wide presentation preference, independent of conversation state. */
export function DesignModeProvider({ children }: { children: ReactNode }) {
  const [improved, setImproved] = useState(false);
  const [pending, setPending] = useState(true);
  const [error, setError] = useState("");
  const saving = useRef(false);
  const generation = useRef(0);

  useEffect(() => {
    let active = true;
    let reading = false;
    const refresh = async () => {
      if (reading || saving.current) return;
      reading = true;
      const version = generation.current;
      try {
        const settings = await getJson<DesignSettings>(endpoint);
        if (active && version === generation.current) {
          setImproved(settings.mode === "improved");
          setPending(false);
          setError("");
        }
      } catch {
        if (active && version === generation.current) setError("디자인 설정을 불러오지 못했습니다.");
      } finally { reading = false; }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 3000);
    window.addEventListener("focus", refresh);
    return () => { active = false; window.clearInterval(timer); window.removeEventListener("focus", refresh); };
  }, []);

  const toggle = async () => {
    if (saving.current || pending) return;
    saving.current = true;
    generation.current += 1;
    setPending(true);
    setError("");
    try {
      const settings = await postJson<DesignSettings>(endpoint, { mode: improved ? "classic" : "improved" });
      setImproved(settings.mode === "improved");
    } catch {
      setError("디자인 설정을 저장하지 못했습니다. 관리자 모드를 확인해 주세요.");
    } finally { saving.current = false; setPending(false); }
  };

  useLayoutEffect(() => {
    if (improved) document.documentElement.dataset.designMode = "improved";
    else delete document.documentElement.dataset.designMode;
    return () => { delete document.documentElement.dataset.designMode; };
  }, [improved]);

  return (
    <DesignModeContext.Provider value={{ improved, toggle, pending, error }}>
      {children}
    </DesignModeContext.Provider>
  );
}

export function DesignModeToggle({ canEdit = false }: { canEdit?: boolean }) {
  const mode = useContext(DesignModeContext);
  if (!mode) return null;
  return (
    <>
    <button
      type="button"
      role="switch"
      aria-checked={mode.improved}
      aria-label="개선 디자인"
      className="settings-row design-mode-toggle"
      onClick={mode.toggle}
      disabled={!canEdit || mode.pending}
    >
      <strong>개선 디자인 <small>전체 사용자 적용</small></strong>
      <span className="design-mode-toggle-value">
        <span>{mode.improved ? "개선" : "기존"}</span>
        <span className="design-mode-switch" aria-hidden="true"><span /></span>
      </span>
    </button>
    {mode.error ? <small role="alert">{mode.error}</small> : null}
    </>
  );
}
