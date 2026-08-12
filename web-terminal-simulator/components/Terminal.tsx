'use client';

import React, { useEffect, useRef, useCallback } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

export default function TerminalComponent() {
  const terminalRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<XTerm | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const currentLineRef = useRef<string>('');

  const prompt = useCallback((term: XTerm) => {
    term.write('\r\n$ ');
  }, []);

  const handleCommand = useCallback((commandStr: string, term: XTerm) => {
    if (commandStr === '') {
      prompt(term);
      return;
    }

    const args = commandStr.split(' ');
    const cmd = args[0].toLowerCase();

    switch (cmd) {
      case 'help':
        term.writeln('Available commands:');
        term.writeln('  help    - Show this help message');
        term.writeln('  clear   - Clear the terminal screen');
        term.writeln('  echo    - Print arguments to the standard output');
        term.writeln('  whoami  - Print the current user');
        term.writeln('  date    - Print the current date and time');
        break;
      case 'clear':
        term.clear();
        break;
      case 'echo':
        term.writeln(args.slice(1).join(' '));
        break;
      case 'whoami':
        term.writeln('guest');
        break;
      case 'date':
        term.writeln(new Date().toString());
        break;
      default:
        term.writeln(`Command not found: ${cmd}`);
    }

    prompt(term);
  }, [prompt]);

  useEffect(() => {
    if (!terminalRef.current) return;

    // Initialize xterm.js
    const term = new XTerm({
      cursorBlink: true,
      theme: {
        background: '#000000',
        foreground: '#ffffff',
      },
      fontFamily: 'var(--font-mono), monospace',
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);

    term.open(terminalRef.current);
    fitAddon.fit();

    xtermRef.current = term;
    fitAddonRef.current = fitAddon;

    term.writeln('Welcome to Web Terminal Simulator v1.0.0');
    term.writeln('Type "help" for a list of available commands.');
    prompt(term);

    const handleResize = () => {
      if (fitAddonRef.current) {
        fitAddonRef.current.fit();
      }
    };

    window.addEventListener('resize', handleResize);

    // Input handling
    term.onData((data) => {
      switch (data) {
        case '\r': // Enter
          term.write('\r\n');
          handleCommand(currentLineRef.current.trim(), term);
          currentLineRef.current = '';
          break;
        case '\u0003': // Ctrl+C
          term.write('^C\r\n');
          currentLineRef.current = '';
          prompt(term);
          break;
        case '\u007F': // Backspace (DEL)
        case '\b':     // Backspace
          if (currentLineRef.current.length > 0) {
            currentLineRef.current = currentLineRef.current.substring(0, currentLineRef.current.length - 1);
            term.write('\b \b');
          }
          break;
        default:
          // Filter out other control characters to prevent injection/formatting issues
          if (data >= String.fromCharCode(0x20) && data <= String.fromCharCode(0x7E)) {
            currentLineRef.current += data;
            term.write(data);
          }
      }
    });

    return () => {
      window.removeEventListener('resize', handleResize);
      term.dispose();
      xtermRef.current = null;
      fitAddonRef.current = null;
    };
  }, [prompt, handleCommand]);

  return (
    <div
      ref={terminalRef}
      className="w-full h-full min-h-[400px] bg-black p-4 rounded-lg overflow-hidden"
    />
  );
}
