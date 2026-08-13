export type PtyStatus = "connecting" | "open" | "closed" | "error";

export interface PtyHandlers {
  onData(data: string): void;
  onStatus(status: PtyStatus, detail?: string): void;
  onExit?(exitCode: number): void;
}

const MAX_RETRIES = 5;
const BACKOFF_MS = 1000;

/**
 * Thin WebSocket client for the real PTY backend. Used in MODE 2 only:
 * raw keystrokes are forwarded to the server and terminal output is
 * streamed back. Authentication happens via the first message.
 */
export class PtyClient {
  private ws: WebSocket | null = null;
  private disposed = false;
  private retries = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly url: string,
    private readonly token: string,
    private readonly handlers: PtyHandlers,
  ) {}

  connect(): void {
    if (this.disposed) return;
    this.handlers.onStatus("connecting");
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.url);
    } catch (error) {
      this.handlers.onStatus("error", (error as Error).message);
      return;
    }
    this.ws = ws;

    ws.onopen = () => {
      ws.send(JSON.stringify({ type: "auth", token: this.token }));
    };

    ws.onmessage = (event) => {
      let message: { type?: string; data?: string; cols?: number; rows?: number; exitCode?: number };
      try {
        message = JSON.parse(String(event.data));
      } catch {
        return;
      }
      switch (message.type) {
        case "ready":
          this.retries = 0;
          this.handlers.onStatus("open");
          break;
        case "data":
          if (typeof message.data === "string") this.handlers.onData(message.data);
          break;
        case "exit":
          this.handlers.onExit?.(message.exitCode ?? 0);
          break;
        default:
          break;
      }
    };

    ws.onclose = () => {
      if (this.disposed) {
        this.handlers.onStatus("closed");
        return;
      }
      if (this.retries < MAX_RETRIES) {
        this.retries += 1;
        this.handlers.onStatus("connecting");
        this.reconnectTimer = setTimeout(() => this.connect(), BACKOFF_MS * this.retries);
      } else {
        this.handlers.onStatus("error", "connection lost");
      }
    };

    ws.onerror = () => {
      // onclose follows; status is handled there.
    };
  }

  sendData(data: string): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: "input", data }));
    }
  }

  sendResize(cols: number, rows: number): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: "resize", cols, rows }));
    }
  }

  dispose(): void {
    this.disposed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close();
    this.ws = null;
  }
}
