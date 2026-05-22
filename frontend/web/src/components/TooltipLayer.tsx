import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

const gap = 8;
const edgePadding = 8;
const showDelayMs = 260;
export const showTooltipNowEvent = "myharness:tooltip-show-now";

type TooltipState = {
  text: string;
  target: HTMLElement;
  x: number;
  y: number;
  placement: "top" | "bottom" | "right";
};

function findTooltipTarget(target: EventTarget | null) {
  if (!(target instanceof Element)) {
    return null;
  }
  const tooltipTarget = target.closest<HTMLElement>("[data-tooltip]");
  const text = tooltipTarget?.dataset.tooltip?.trim();
  if (!tooltipTarget || !text || tooltipTarget.getAttribute("aria-disabled") === "true") {
    return null;
  }
  return tooltipTarget;
}

function getTooltipState(target: HTMLElement): TooltipState | null {
  const text = target.dataset.tooltip?.trim();
  if (!text || target.getAttribute("aria-disabled") === "true") {
    return null;
  }
  const rect = target.getBoundingClientRect();
  if (target.dataset.tooltipPlacement === "right") {
    return {
      text,
      target,
      x: rect.right + gap,
      y: rect.top + rect.height / 2,
      placement: "right",
    };
  }
  const yBelow = rect.bottom + gap;
  const yAbove = rect.top - gap;
  const placement = yBelow + 36 <= window.innerHeight ? "bottom" : "top";
  return {
    text,
    target,
    x: rect.left + rect.width / 2,
    y: placement === "bottom" ? yBelow : yAbove,
    placement,
  };
}

export function TooltipLayer() {
  const [tooltip, setTooltip] = useState<TooltipState | null>(null);
  const tooltipRef = useRef<HTMLDivElement | null>(null);
  const targetRef = useRef<HTMLElement | null>(null);
  const pointerTargetRef = useRef<HTMLElement | null>(null);
  const focusTargetRef = useRef<HTMLElement | null>(null);
  const showTimerRef = useRef<number | null>(null);
  const mutationObserverRef = useRef<MutationObserver | null>(null);
  const tooltipVisibleRef = useRef(false);

  useEffect(() => {
    tooltipVisibleRef.current = Boolean(tooltip);
  }, [tooltip]);

  useEffect(() => {
    function clearShowTimer() {
      if (showTimerRef.current !== null) {
        window.clearTimeout(showTimerRef.current);
        showTimerRef.current = null;
      }
    }

    function disconnectTooltipObserver() {
      mutationObserverRef.current?.disconnect();
      mutationObserverRef.current = null;
    }

    function observeTooltipTarget(target: HTMLElement | null) {
      disconnectTooltipObserver();
      if (!target || typeof MutationObserver === "undefined") {
        return;
      }
      mutationObserverRef.current = new MutationObserver(() => {
        if (tooltipVisibleRef.current) {
          refreshTooltip();
        } else if (target === pointerTargetRef.current || target === focusTargetRef.current) {
          showForTarget(target, true);
        }
      });
      mutationObserverRef.current.observe(target, {
        attributeFilter: ["aria-disabled", "data-tooltip", "data-tooltip-placement"],
        attributes: true,
      });
    }

    function showForTarget(target: HTMLElement | null, immediate = false) {
      clearShowTimer();
      targetRef.current = target;
      observeTooltipTarget(target);
      if (!target) {
        setTooltip(null);
        return;
      }
      if (immediate) {
        setTooltip(getTooltipState(target));
        return;
      }
      setTooltip(null);
      showTimerRef.current = window.setTimeout(() => {
        showTimerRef.current = null;
        if (targetRef.current === target) {
          setTooltip(getTooltipState(target));
        }
      }, showDelayMs);
    }

    function hideTooltip() {
      clearShowTimer();
      disconnectTooltipObserver();
      targetRef.current = null;
      pointerTargetRef.current = null;
      focusTargetRef.current = null;
      setTooltip(null);
    }

    function refreshTooltip() {
      const target = targetRef.current;
      if (!target?.isConnected) {
        hideTooltip();
        return;
      }
      const nextTooltip = getTooltipState(target);
      if (!nextTooltip) {
        hideTooltip();
        return;
      }
      setTooltip(nextTooltip);
    }

    function handlePointerOver(event: PointerEvent) {
      const target = findTooltipTarget(event.target);
      pointerTargetRef.current = target;
      showForTarget(target);
    }

    function handlePointerActivate(event: PointerEvent | MouseEvent) {
      const target = findTooltipTarget(event.target);
      if (!target) {
        return;
      }
      if ("pointerId" in event) {
        pointerTargetRef.current = target;
      }
      showForTarget(target, true);
    }

    function handlePointerOut(event: PointerEvent) {
      const target = targetRef.current;
      if (!target) {
        return;
      }
      const related = event.relatedTarget instanceof Node ? event.relatedTarget : null;
      if (!related || !target.contains(related)) {
        pointerTargetRef.current = null;
        if (focusTargetRef.current?.isConnected) {
          showForTarget(focusTargetRef.current, true);
        } else {
          hideTooltip();
        }
      }
    }

    function handleFocusIn(event: FocusEvent) {
      const target = findTooltipTarget(event.target);
      focusTargetRef.current = target;
      showForTarget(target, true);
    }

    function handleFocusOut(event: FocusEvent) {
      const target = targetRef.current;
      if (!target) {
        return;
      }
      const related = event.relatedTarget instanceof Node ? event.relatedTarget : null;
      if (!related || !target.contains(related)) {
        focusTargetRef.current = null;
        if (pointerTargetRef.current?.isConnected) {
          showForTarget(pointerTargetRef.current, true);
        } else {
          hideTooltip();
        }
      }
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        hideTooltip();
      }
    }

    function handleShowTooltipNow(event: Event) {
      const target = (event as CustomEvent<{ target?: unknown }>).detail?.target;
      if (!(target instanceof HTMLElement)) {
        return;
      }
      pointerTargetRef.current = target;
      showForTarget(target, true);
    }

    document.addEventListener("pointerover", handlePointerOver, true);
    document.addEventListener("pointerdown", handlePointerActivate, true);
    document.addEventListener("click", handlePointerActivate, true);
    document.addEventListener("pointerout", handlePointerOut, true);
    document.addEventListener("focusin", handleFocusIn, true);
    document.addEventListener("focusout", handleFocusOut, true);
    document.addEventListener("keydown", handleKeyDown);
    window.addEventListener(showTooltipNowEvent, handleShowTooltipNow);
    window.addEventListener("resize", refreshTooltip);
    window.addEventListener("scroll", refreshTooltip, true);
    return () => {
      document.removeEventListener("pointerover", handlePointerOver, true);
      document.removeEventListener("pointerdown", handlePointerActivate, true);
      document.removeEventListener("click", handlePointerActivate, true);
      document.removeEventListener("pointerout", handlePointerOut, true);
      document.removeEventListener("focusin", handleFocusIn, true);
      document.removeEventListener("focusout", handleFocusOut, true);
      document.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener(showTooltipNowEvent, handleShowTooltipNow);
      window.removeEventListener("resize", refreshTooltip);
      window.removeEventListener("scroll", refreshTooltip, true);
      disconnectTooltipObserver();
      clearShowTimer();
    };
  }, []);

  useLayoutEffect(() => {
    if (!tooltip || !tooltipRef.current) {
      return;
    }
    const rect = tooltipRef.current.getBoundingClientRect();
    const nextX = tooltip.placement === "right"
      ? Math.min(Math.max(tooltip.x, edgePadding), window.innerWidth - edgePadding - rect.width)
      : Math.min(
        Math.max(tooltip.x, edgePadding + rect.width / 2),
        window.innerWidth - edgePadding - rect.width / 2,
      );
    const nextY = tooltip.placement === "right"
      ? Math.min(
        Math.max(tooltip.y, edgePadding + rect.height / 2),
        window.innerHeight - edgePadding - rect.height / 2,
      )
      : tooltip.placement === "top"
        ? Math.max(edgePadding, tooltip.y - rect.height)
        : Math.min(tooltip.y, window.innerHeight - edgePadding - rect.height);
    if (Math.abs(nextX - tooltip.x) > 0.5 || Math.abs(nextY - tooltip.y) > 0.5) {
      setTooltip({ ...tooltip, x: nextX, y: nextY });
    }
  }, [tooltip]);

  if (!tooltip) {
    return null;
  }

  return createPortal(
    <div
      ref={tooltipRef}
      className="tooltip-layer"
      role="tooltip"
      style={{
        left: tooltip.x,
        position: "fixed",
        top: tooltip.y,
        transform: tooltip.placement === "right"
          ? "translate(0, -50%)"
          : tooltip.placement === "top"
            ? "translateX(-50%)"
            : "translate(-50%, 0)",
      }}
    >
      {tooltip.text}
    </div>,
    document.body,
  );
}
