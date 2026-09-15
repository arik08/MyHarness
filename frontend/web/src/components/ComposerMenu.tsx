import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { createPortal } from "react-dom";

// Source vectors: lucide-icons/lucide (ISC), lobehub/lobe-icons OpenAI (MIT).
// See composer-icons.LICENSE. Do not substitute brand marks with generic glyphs.
export function ComposerIcon({ name }: { name: "attach" | "context" | "skill" | "enhance" | "search" | "length" | "file" | "openai" }) {
  const shapes = {
    attach: <> <path d="m16 6-8.414 8.586a2 2 0 0 0 2.829 2.829l8.414-8.586a4 4 0 1 0-5.657-5.657l-8.379 8.551a6 6 0 1 0 8.485 8.485l8.379-8.551" /> </>,
    context: <> <circle cx="12" cy="12" r="4" /><path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-4 8" /> </>,
    skill: <> <circle cx="12" cy="12" r="10" /><path d="M16 8h-6a2 2 0 1 0 0 4h4a2 2 0 1 1 0 4H8" /><path d="M12 18V6" /> </>,
    enhance: <> <path d="m21.64 3.64-1.28-1.28a1.21 1.21 0 0 0-1.72 0L2.36 18.64a1.21 1.21 0 0 0 0 1.72l1.28 1.28a1.2 1.2 0 0 0 1.72 0L21.64 5.36a1.2 1.2 0 0 0 0-1.72" /><path d="m14 7 3 3" /><path d="M5 6v4" /><path d="M19 14v4" /><path d="M10 2v2" /><path d="M7 8H3" /><path d="M21 16h-4" /><path d="M11 3H9" /> </>,
    search: <> <path d="m21 21-4.34-4.34" /><circle cx="11" cy="11" r="8" /> </>,
    length: <> <path d="M21 5H3" /><path d="M15 12H3" /><path d="M17 19H3" /> </>,
    file: <> <path d="M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z" /><path d="M14 2v5a1 1 0 0 0 1 1h5" /><path d="M10 9H8" /><path d="M16 13H8" /><path d="M16 17H8" /> </>,
    openai: <> <path d="M9.205 8.658v-2.26c0-.19.072-.333.238-.428l4.543-2.616c.619-.357 1.356-.523 2.117-.523 2.854 0 4.662 2.212 4.662 4.566 0 .167 0 .357-.024.547l-4.71-2.759a.797.797 0 00-.856 0l-5.97 3.473zm10.609 8.8V12.06c0-.333-.143-.57-.429-.737l-5.97-3.473 1.95-1.118a.433.433 0 01.476 0l4.543 2.617c1.309.76 2.189 2.378 2.189 3.948 0 1.808-1.07 3.473-2.76 4.163zM7.802 12.703l-1.95-1.142c-.167-.095-.239-.238-.239-.428V5.899c0-2.545 1.95-4.472 4.591-4.472 1 0 1.927.333 2.712.928L8.23 5.067c-.285.166-.428.404-.428.737v6.898zM12 15.128l-2.795-1.57v-3.33L12 8.658l2.795 1.57v3.33L12 15.128zm1.796 7.23c-1 0-1.927-.332-2.712-.927l4.686-2.712c.285-.166.428-.404.428-.737v-6.898l1.974 1.142c.167.095.238.238.238.428v5.233c0 2.545-1.974 4.472-4.614 4.472zm-5.637-5.303l-4.544-2.617c-1.308-.761-2.188-2.378-2.188-3.948A4.482 4.482 0 014.21 6.327v5.423c0 .333.143.571.428.738l5.947 3.449-1.95 1.118a.432.432 0 01-.476 0zm-.262 3.9c-2.688 0-4.662-2.021-4.662-4.519 0-.19.024-.38.047-.57l4.686 2.71c.286.167.571.167.856 0l5.97-3.448v2.26c0 .19-.07.333-.237.428l-4.543 2.616c-.619.357-1.356.523-2.117.523zm5.899 2.83a5.947 5.947 0 005.827-4.756C22.287 18.339 24 15.84 24 13.296c0-1.665-.713-3.282-1.998-4.448.119-.5.19-.999.19-1.498 0-3.401-2.759-5.947-5.946-5.947-.642 0-1.26.095-1.88.31A5.962 5.962 0 0010.205 0a5.947 5.947 0 00-5.827 4.757C1.713 5.447 0 7.945 0 10.49c0 1.666.713 3.283 1.998 4.448-.119.5-.19 1-.19 1.499 0 3.401 2.759 5.946 5.946 5.946.642 0 1.26-.095 1.88-.309a5.96 5.96 0 004.162 1.713z" /> </>,
  };
  return <svg viewBox="0 0 24 24" aria-hidden="true" data-icon={name} fillRule={name === "openai" ? "evenodd" : undefined} style={name === "openai" ? { fill: "currentColor", stroke: "none" } : undefined}>{shapes[name]}</svg>;
}

export function ComposerMenu({ label, text, icon, children, disabled = false, chevron = false, compact = false }: {
  label: string; text?: string; icon?: ReactNode; disabled?: boolean; chevron?: boolean; compact?: boolean;
  children: ReactNode | ((close: () => void) => ReactNode);
}) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ left: 12, bottom: 60, maxHeight: 400 });
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const id = useId();
  const close = () => { setOpen(false); trigger.current?.focus(); };
  useLayoutEffect(() => {
    if (!open) return;
    const update = () => {
      const rect = trigger.current?.getBoundingClientRect();
      if (!rect) return;
      const width = panel.current?.offsetWidth || 280;
      setPosition({ left: Math.max(12, Math.min(rect.left, window.innerWidth - width - 12)), bottom: window.innerHeight - rect.top + 8, maxHeight: Math.max(100, rect.top - 20) });
    };
    update();
    panel.current?.querySelector<HTMLElement>("button:not(:disabled), input, textarea")?.focus();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => { window.removeEventListener("resize", update); window.removeEventListener("scroll", update, true); };
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (!panel.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: globalThis.KeyboardEvent) => { if (event.key === "Escape") close(); };
    const focus = (event: FocusEvent) => {
      if (!panel.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    document.addEventListener("focusin", focus);
    return () => { document.removeEventListener("pointerdown", outside); document.removeEventListener("keydown", escape); document.removeEventListener("focusin", focus); };
  }, [open]);
  return <>
    <button ref={trigger} type="button" className="composer-tool" aria-label={label} data-tooltip={label} data-tooltip-placement="top" aria-expanded={open} aria-controls={open ? id : undefined} aria-haspopup="dialog" disabled={disabled} onClick={() => setOpen(!open)}>
      {icon}{text && <span className={text === "Auto" ? "composer-auto-label" : undefined}>{text}</span>}{chevron && <svg className="composer-chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>}
    </button>
    {open && createPortal(<div ref={panel} id={id} role="dialog" aria-label={label} className={`composer-popover${compact ? " composer-popover-compact" : ""}`} style={position}>
      <strong className="composer-menu-heading">{label}</strong>
      {typeof children === "function" ? children(close) : children}
    </div>, document.body)}
  </>;
}

export function ComposerChoice({ label, selected, onClick, description }: { label: string; selected: boolean; onClick: () => void; description?: string }) {
  return <button className="composer-choice" type="button" aria-pressed={selected} onClick={onClick}>
    <span><span>{label}</span>{description && <small>{description}</small>}</span><span aria-hidden="true">{selected ? "✓" : ""}</span>
  </button>;
}
