/**
 * Lightweight WebSocket Sync Adapter (`@jiange/collab/ws`) with exponential reconnect,
 * heartbeat, and offline outgoing frame queue. Zero third-party dependencies.
 */

export type WsConnectionState = "disconnected" | "connecting" | "connected" | "closed";

export interface WebSocketLike {
  readonly readyState: number;
  binaryType?: string;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  onclose: ((ev: { code?: number; reason?: string }) => void) | null;
  send(data: string | Uint8Array): void;
  close(code?: number, reason?: string): void;
}

export interface WebSocketSyncOptions {
  url: string;
  createSocket?: (url: string) => WebSocketLike;
  onMessage?: (payload: string | Uint8Array) => void;
  onStateChange?: (state: WsConnectionState) => void;
  reconnectBaseMs?: number;
  reconnectMaxMs?: number;
  maxRetries?: number;
  heartbeatIntervalMs?: number;
  heartbeatPayload?: string;
}

const WS_OPEN = 1;

export class WebSocketSyncAdapter {
  private socket: WebSocketLike | null = null;
  private state: WsConnectionState = "disconnected";
  private queue: Array<string | Uint8Array> = [];
  private retries = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly options: WebSocketSyncOptions) {}

  get connectionState(): WsConnectionState {
    return this.state;
  }

  get queuedCount(): number {
    return this.queue.length;
  }

  private setState(next: WsConnectionState): void {
    if (this.state === next) return;
    this.state = next;
    this.options.onStateChange?.(next);
  }

  private clearTimers(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  connect(): void {
    if (this.state === "connected" || this.state === "connecting") return;
    this.clearTimers();
    this.setState("connecting");

    const factory =
      this.options.createSocket ??
      ((url: string) => new WebSocket(url) as unknown as WebSocketLike);
    const sock = factory(this.options.url);
    sock.binaryType = "arraybuffer";
    this.socket = sock;

    sock.onopen = () => {
      this.retries = 0;
      this.setState("connected");
      this.flushQueue();
      const hb = this.options.heartbeatIntervalMs ?? 0;
      if (hb > 0) {
        this.heartbeatTimer = setInterval(() => {
          if (this.socket && this.socket.readyState === WS_OPEN) {
            this.socket.send(this.options.heartbeatPayload ?? '{"type":"ping"}');
          }
        }, hb);
      }
    };

    sock.onmessage = (ev) => {
      if (typeof ev.data === "string") {
        this.options.onMessage?.(ev.data);
      } else if (ev.data instanceof Uint8Array) {
        this.options.onMessage?.(ev.data);
      } else if (ev.data instanceof ArrayBuffer) {
        this.options.onMessage?.(new Uint8Array(ev.data));
      }
    };

    sock.onerror = () => {
      // onclose drives reconnect
    };

    sock.onclose = () => {
      this.clearTimers();
      this.socket = null;
      if (this.state === "closed") return;
      this.setState("disconnected");
      const maxRetries = this.options.maxRetries ?? 10;
      if (this.retries < maxRetries) {
        const base = this.options.reconnectBaseMs ?? 500;
        const cap = this.options.reconnectMaxMs ?? 15000;
        const delay = Math.min(cap, base * Math.pow(2, this.retries));
        this.retries++;
        this.reconnectTimer = setTimeout(() => {
          if (this.state !== "closed") this.connect();
        }, delay);
      }
    };
  }

  send(payload: string | Uint8Array): boolean {
    if (this.socket && this.socket.readyState === WS_OPEN) {
      this.socket.send(payload);
      return true;
    }
    this.queue.push(payload);
    return false;
  }

  private flushQueue(): void {
    while (this.queue.length > 0 && this.socket && this.socket.readyState === WS_OPEN) {
      const next = this.queue.shift()!;
      this.socket.send(next);
    }
  }

  close(code = 1000, reason = "client close"): void {
    this.setState("closed");
    this.clearTimers();
    this.socket?.close(code, reason);
    this.socket = null;
  }
}
