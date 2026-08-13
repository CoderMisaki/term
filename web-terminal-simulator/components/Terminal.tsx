"use client";

import { FitAddon } from "@xterm/addon-fit";
import { Terminal as XTerm, type IDisposable } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { useCallback, useEffect, useRef } from "react";

export interface TerminalProps {
  /** Raw keystroke/input data from the terminal. */
  onData: (data: string) => void;
  /** Fired on terminal resize (cols/rows) — used by the PTY backend. */
  onResize?: (cols: number, rows: number) => void;
  /** Called once the xterm instance is ready (after mount + fit). */
  onReady?: (term: XTerm) => void;
  autoFocus?: boolean;
  className?: string;
}

const TERMINAL_THEME = {
  background: "#0b0f14",
  foreground: "#c9d1d9",
  cursor: "#3fb950",
  cursorAccent: "#0b0f14",
  selectionBackground: "#264f78",
  black: "#1c2128",
  red: "#ff7b72",
  green: "#3fb950",
  yellow: "#d29922",
  blue: "#58a6ff",
  magenta: "#bc8cff",
  cyan: "#39c5cf",
  white: "#c9d1d9",
  brightBlack: "#6e7681",
  brightRed: "#ffa198",
  brightGreen: "#56d364",
  brightYellow: "#e3b341",
  brightBlue: "#79c0ff",
  brightMagenta: "#d2a8ff",
  brightCyan: "#56d4dd",
  brightWhite: "#f0f6fc",
};

/**
 * Client-only xterm.js wrapper. Handles:
 * - instance creation with a dark, high-contrast theme
 * - FitAddon fitting on mount, container resize (ResizeObserver), window
 *   resize, orientation change, visual viewport changes and font load
 * - rAF-coalesced fitting so resize storms don't spam fit()
 * - focus on pointerdown (also summons the mobile keyboard)
 */
export default function TerminalComponent({
  onData,
  onResize,
  onReady,
  autoFocus = true,
  className,
}: TerminalProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const rafRef = useRef<number | null>(null);

  // Keep the latest callbacks in refs so the mount effect can close over
  // stable references (updated in an effect, not during render).
  const onDataRef = useRef(onData);
  const onResizeRef = useRef(onResize);
  const onReadyRef = useRef(onReady);
  useEffect(() => {
    onDataRef.current = onData;
    onResizeRef.current = onResize;
    onReadyRef.current = onReady;
  });

  const fit = useCallback(() => {
    if (rafRef.current !== null) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      try {
        fitRef.current?.fit();
      } catch {
        // Container is hidden or not measurable yet — retry on next event.
      }
    });
  }, []);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const term = new XTerm({
      cursorBlink: true,
      cursorStyle: "block",
      fontFamily: 'var(--font-geist-mono), ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace',
      fontSize: 14,
      lineHeight: 1.25,
      letterSpacing: 0,
      scrollback: 5000,
      allowTransparency: false,
      convertEol: false,
      theme: TERMINAL_THEME,
    });
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(container);

    termRef.current = term;
    fitRef.current = fitAddon;
    fit();

    const dataDisposable: IDisposable = term.onData((data) => onDataRef.current(data));
    const resizeDisposable: IDisposable = term.onResize(({ cols, rows }) =>
      onResizeRef.current?.(cols, rows),
    );
    onReadyRef.current?.(term);

    const observer = new ResizeObserver(() => fit());
    observer.observe(container);

    const handleWindowResize = () => fit();
    const handleOrientationChange = () => setTimeout(fit, 150);
    const handleVisualViewport = () => fit();
    window.addEventListener("resize", handleWindowResize);
    window.addEventListener("orientationchange", handleOrientationChange);
    window.visualViewport?.addEventListener("resize", handleVisualViewport);

    if (typeof document !== "undefined" && document.fonts?.ready) {
      document.fonts.ready.then(fit).catch(() => undefined);
    }

    const focusTerminal = () => term.focus();
    container.addEventListener("pointerdown", focusTerminal);
    if (autoFocus) term.focus();

    return () => {
      dataDisposable.dispose();
      resizeDisposable.dispose();
      observer.disconnect();
      window.removeEventListener("resize", handleWindowResize);
      window.removeEventListener("orientationchange", handleOrientationChange);
      window.visualViewport?.removeEventListener("resize", handleVisualViewport);
      container.removeEventListener("pointerdown", focusTerminal);
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, [fit, autoFocus]);

  return <div ref={containerRef} className={className} />;
}
