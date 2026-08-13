"use client";

import { FitAddon } from "@xterm/addon-fit";
import { Terminal as XTerm, type IDisposable } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { Check, ClipboardPaste, Copy as CopyIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

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

function isMacLike(): boolean {
  if (typeof navigator === "undefined") return false;
  return /Mac|iPhone|iPad|iPod/i.test(navigator.platform || navigator.userAgent);
}

async function copyToClipboard(text: string): Promise<boolean> {
  if (!text) return false;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Async clipboard can be blocked (permissions/insecure context) — fall back.
  }
  try {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.select();
    const ok = document.execCommand("copy");
    textarea.remove();
    return ok;
  } catch {
    return false;
  }
}

async function readClipboard(): Promise<string> {
  try {
    return (await navigator.clipboard?.readText()) ?? "";
  } catch {
    return "";
  }
}

interface CellMetrics {
  width: number;
  height: number;
}

/**
 * Reads the current cell size from xterm's render service. This is an
 * internal xterm API (pinned to @xterm/xterm 6.0.0); a failure just disables
 * touch selection gracefully.
 */
function getCellMetrics(term: XTerm): CellMetrics | null {
  try {
    const core = (term as unknown as {
      _core?: {
        _renderService?: {
          dimensions?: { css?: { cell?: { width?: number; height?: number } } };
        };
      };
    })._core;
    const cell = core?._renderService?.dimensions?.css?.cell;
    const width = cell?.width;
    const height = cell?.height;
    if (width !== undefined && height !== undefined && width > 0 && height > 0) {
      return { width, height };
    }
  } catch {
    // fall through
  }
  return null;
}

/**
 * Client-only xterm.js wrapper. Handles:
 * - instance creation with a dark, high-contrast theme
 * - FitAddon fitting on mount, container resize (ResizeObserver), window
 *   resize, orientation change, visual viewport changes and font load
 * - rAF-coalesced fitting so resize storms don't spam fit()
 * - focus on pointerdown (also summons the mobile keyboard)
 * - copy/paste: Ctrl/Cmd+C (with a selection), Ctrl/Cmd+Shift+C, Ctrl+Insert
 *   copy; Ctrl/Cmd+Shift+V and Shift+Insert paste; right-click opens a
 *   Copy / Paste / Select All context menu
 * - touch selection: long-press then drag to select text on mobile, which
 *   also opens the copy/paste menu
 *
 * Note: xterm.js blocks the browser's native selection (it preventDefaults
 * mousedown and ships `user-select: none`), so selection is xterm's own and
 * copying must go through the clipboard helpers above.
 */
export default function TerminalComponent({
  onData,
  onResize,
  onReady,
  autoFocus = true,
  className,
}: TerminalProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const rafRef = useRef<number | null>(null);
  const longPressTimerRef = useRef<number | null>(null);
  const touchStateRef = useRef<{
    startX: number;
    startY: number;
    /** Long-press fired — the finger is now dragging to extend a selection. */
    active: boolean;
    anchorCol: number;
    anchorRow: number;
    endX: number;
    endY: number;
  } | null>(null);

  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [hasSelection, setHasSelection] = useState(false);
  const [copied, setCopied] = useState(false);

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

  const closeMenu = useCallback(() => {
    setMenu(null);
    setCopied(false);
  }, []);

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

  const copySelection = useCallback(async () => {
    const term = termRef.current;
    if (!term || !term.hasSelection()) return;
    const ok = await copyToClipboard(term.getSelection());
    if (ok) {
      setCopied(true);
      window.setTimeout(closeMenu, 900);
    }
  }, [closeMenu]);

  const pasteFromClipboard = useCallback(async () => {
    const term = termRef.current;
    if (!term) return;
    const text = await readClipboard();
    if (text) term.paste(text);
    closeMenu();
  }, [closeMenu]);

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
    const selectionDisposable: IDisposable = term.onSelectionChange(() =>
      setHasSelection(term.hasSelection()),
    );
    onReadyRef.current?.(term);

    /* ------------------------------------------------------------ */
    /* Copy / paste keyboard shortcuts                               */
    /* ------------------------------------------------------------ */
    // Runs before xterm's own keydown handling; returning false prevents the
    // keystroke from reaching the shell (e.g. ^C must not fire when copying).
    const keyHandler = (event: KeyboardEvent): boolean => {
      const primary = isMacLike() ? event.metaKey : event.ctrlKey;
      const code = event.code;

      // Copy: Ctrl/Cmd+C while a selection is active (like native terminals),
      // or Ctrl/Cmd+Shift+C. Without a selection, Ctrl/Cmd+C stays ^C.
      if (primary && code === "KeyC" && (event.shiftKey || term.hasSelection())) {
        if (term.hasSelection()) {
          event.preventDefault();
          void copyToClipboard(term.getSelection());
        }
        return false;
      }

      // Paste: Ctrl/Cmd+Shift+V. Plain Ctrl/Cmd+V is handled by the browser's
      // native paste event, which xterm already forwards into the terminal.
      if (primary && event.shiftKey && code === "KeyV") {
        event.preventDefault();
        void readClipboard().then((text) => {
          if (text) term.paste(text);
        });
        return false;
      }

      // Legacy terminal keys: Ctrl+Insert copies, Shift+Insert pastes.
      if (primary && code === "Insert") {
        event.preventDefault();
        if (term.hasSelection()) void copyToClipboard(term.getSelection());
        return false;
      }
      if (event.shiftKey && !primary && code === "Insert") {
        event.preventDefault();
        void readClipboard().then((text) => {
          if (text) term.paste(text);
        });
        return false;
      }

      return true;
    };
    term.attachCustomKeyEventHandler(keyHandler);

    /* ------------------------------------------------------------ */
    /* Right-click context menu                                      */
    /* ------------------------------------------------------------ */
    // Capture phase: run before xterm's own contextmenu handler, which would
    // otherwise replace the drag selection with the word under the cursor.
    const handleContextMenu = (event: MouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      setHasSelection(term.hasSelection());
      setCopied(false);
      const margin = 8;
      const width = 176;
      const height = 128;
      const x = Math.min(event.clientX, window.innerWidth - width - margin);
      const y = Math.min(event.clientY, window.innerHeight - height - margin);
      setMenu({ x: Math.max(margin, x), y: Math.max(margin, y) });
    };
    container.addEventListener("contextmenu", handleContextMenu, true);

    const handlePointerDown = (event: PointerEvent) => {
      if (
        menuRef.current &&
        event.target instanceof Node &&
        !menuRef.current.contains(event.target)
      ) {
        closeMenu();
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeMenu();
    };
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);

    /* ------------------------------------------------------------ */
    /* Touch: long-press, then drag to select (mobile)               */
    /* ------------------------------------------------------------ */
    // xterm blocks native selection entirely (preventDefault on mousedown +
    // user-select: none), so on touch devices we drive xterm's own selection
    // from touch events: hold still ~450ms to start, then drag to extend.
    const clearLongPress = () => {
      if (longPressTimerRef.current !== null) {
        window.clearTimeout(longPressTimerRef.current);
        longPressTimerRef.current = null;
      }
    };

    const cellFromEvent = (clientX: number, clientY: number) => {
      const screen = container.querySelector<HTMLElement>(".xterm-screen");
      const metrics = getCellMetrics(term);
      if (!screen || !metrics) return null;
      const rect = screen.getBoundingClientRect();
      const buffer = term.buffer.active;
      const col = Math.floor((clientX - rect.left) / metrics.width);
      const row = Math.floor((clientY - rect.top) / metrics.height);
      return {
        col: Math.min(Math.max(col, 0), term.cols - 1),
        row: Math.min(Math.max(buffer.viewportY + row, 0), Math.max(0, buffer.length - 1)),
      };
    };

    const selectFromAnchor = (clientX: number, clientY: number) => {
      const state = touchStateRef.current;
      if (!state) return;
      const cell = cellFromEvent(clientX, clientY);
      if (!cell) return;
      const cols = term.cols;
      const anchor = state.anchorRow * cols + state.anchorCol;
      const current = cell.row * cols + cell.col;
      const start = Math.min(anchor, current);
      const end = Math.max(anchor, current);
      term.select(start % cols, Math.floor(start / cols), end - start + 1);
      state.endX = clientX;
      state.endY = clientY;
    };

    const handleTouchStart = (event: TouchEvent) => {
      clearLongPress();
      if (event.touches.length !== 1) return;
      const touch = event.touches[0];
      touchStateRef.current = {
        startX: touch.clientX,
        startY: touch.clientY,
        active: false,
        anchorCol: 0,
        anchorRow: 0,
        endX: touch.clientX,
        endY: touch.clientY,
      };
      longPressTimerRef.current = window.setTimeout(() => {
        longPressTimerRef.current = null;
        const state = touchStateRef.current;
        if (!state || state.active) return;
        const cell = cellFromEvent(state.startX, state.startY);
        if (!cell) return;
        state.active = true;
        state.anchorCol = cell.col;
        state.anchorRow = cell.row;
        term.select(cell.col, cell.row, 1);
        if (typeof navigator.vibrate === "function") navigator.vibrate(10);
      }, 450);
    };

    const handleTouchMove = (event: TouchEvent) => {
      const state = touchStateRef.current;
      if (!state) return;
      const touch = event.touches[0];
      if (!state.active) {
        // The finger moved before the long-press fired — treat as scrolling.
        if (Math.hypot(touch.clientX - state.startX, touch.clientY - state.startY) > 10) {
          clearLongPress();
        }
        return;
      }
      event.preventDefault(); // keep the viewport from scrolling while selecting
      selectFromAnchor(touch.clientX, touch.clientY);
    };

    const openTouchMenu = (clientX: number, clientY: number) => {
      setHasSelection(term.hasSelection());
      setCopied(false);
      const margin = 8;
      const width = 176;
      const height = 128;
      const x = Math.min(clientX, window.innerWidth - width - margin);
      let y = clientY - height - margin;
      if (y < margin) y = Math.min(clientY + 16, window.innerHeight - height - margin);
      setMenu({ x: Math.max(margin, x), y: Math.max(margin, y) });
    };

    const handleTouchEnd = (event: TouchEvent) => {
      clearLongPress();
      const state = touchStateRef.current;
      touchStateRef.current = null;
      if (!state || !state.active) return;
      const touch = event.changedTouches?.[0];
      const clientX = touch?.clientX ?? state.endX;
      const clientY = touch?.clientY ?? state.endY;
      if (term.hasSelection()) openTouchMenu(clientX, clientY);
    };

    const handleTouchCancel = () => {
      clearLongPress();
      touchStateRef.current = null;
    };

    container.addEventListener("touchstart", handleTouchStart, { passive: true });
    container.addEventListener("touchmove", handleTouchMove, { passive: false });
    container.addEventListener("touchend", handleTouchEnd);
    container.addEventListener("touchcancel", handleTouchCancel);

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
      selectionDisposable.dispose();
      observer.disconnect();
      container.removeEventListener("contextmenu", handleContextMenu, true);
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
      container.removeEventListener("touchstart", handleTouchStart);
      container.removeEventListener("touchmove", handleTouchMove);
      container.removeEventListener("touchend", handleTouchEnd);
      container.removeEventListener("touchcancel", handleTouchCancel);
      clearLongPress();
      touchStateRef.current = null;
      window.removeEventListener("resize", handleWindowResize);
      window.removeEventListener("orientationchange", handleOrientationChange);
      window.visualViewport?.removeEventListener("resize", handleVisualViewport);
      container.removeEventListener("pointerdown", focusTerminal);
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, [fit, autoFocus, closeMenu]);

  const isMac = isMacLike();
  const copyShortcut = isMac ? "⌘⇧C" : "Ctrl+Shift+C";
  const pasteShortcut = isMac ? "⌘⇧V" : "Ctrl+Shift+V";

  return (
    <>
      <div ref={containerRef} className={className} />
      {menu && (
        <div
          ref={menuRef}
          role="menu"
          className="fixed z-50 min-w-44 overflow-hidden rounded-md border border-zinc-800 bg-zinc-950/95 py-1 text-sm text-zinc-200 shadow-2xl backdrop-blur"
          style={{ left: menu.x, top: menu.y }}
          onContextMenu={(event) => {
            event.preventDefault();
            event.stopPropagation();
          }}
        >
          <button
            type="button"
            role="menuitem"
            disabled={!hasSelection}
            onClick={() => void copySelection()}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-zinc-300 transition-colors hover:bg-zinc-800 hover:text-zinc-100 disabled:cursor-default disabled:text-zinc-600 disabled:hover:bg-transparent"
          >
            {copied ? (
              <Check className="h-3.5 w-3.5 text-emerald-400" />
            ) : (
              <CopyIcon className="h-3.5 w-3.5" />
            )}
            {copied ? "Copied" : "Copy"}
            <span className="ml-auto pl-4 text-[10px] text-zinc-600">{copyShortcut}</span>
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => void pasteFromClipboard()}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-zinc-300 transition-colors hover:bg-zinc-800 hover:text-zinc-100"
          >
            <ClipboardPaste className="h-3.5 w-3.5" />
            Paste
            <span className="ml-auto pl-4 text-[10px] text-zinc-600">{pasteShortcut}</span>
          </button>
          <div className="my-1 h-px bg-zinc-800" />
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              termRef.current?.selectAll();
              closeMenu();
            }}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-zinc-300 transition-colors hover:bg-zinc-800 hover:text-zinc-100"
          >
            Select All
          </button>
        </div>
      )}
    </>
  );
}
