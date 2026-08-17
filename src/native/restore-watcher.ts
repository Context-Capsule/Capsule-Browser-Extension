import {
  NATIVE_HOST_NAME,
  NATIVE_PROTOCOL_VERSION,
  requestId,
  type NativeRequest,
  type NativeResponse,
} from "./protocol";

const REQUEST_TIMEOUT_MS = 30_000;
const RECONNECT_DELAY_MS = 1_000;

export interface OrchestratedRestoreRequest {
  restore_request_id: string;
  capsule_name: string;
}

export interface OrchestratedRestoreResult {
  summary?: string;
}

type RestoreHandler = (request: OrchestratedRestoreRequest) => Promise<OrchestratedRestoreResult>;

type Pending = {
  resolve: (response: NativeResponse) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
};

export class NativeRestoreWatcher {
  private port: browser.runtime.Port | undefined;
  private pending = new Map<string, Pending>();
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private generation = 0;
  private stopped = false;
  private handler: RestoreHandler | undefined;

  start(handler: RestoreHandler): void {
    this.handler = handler;
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.generation += 1;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.rejectPending(new Error("restore watcher stopped"));
    this.port?.disconnect();
    this.port = undefined;
  }

  private connect(): void {
    if (this.stopped || this.port) return;
    try {
      const port = browser.runtime.connectNative(NATIVE_HOST_NAME);
      this.port = port;
      const generation = ++this.generation;
      port.onMessage.addListener((message: unknown) => this.onMessage(message));
      port.onDisconnect.addListener(() => this.onDisconnect(port));
      void this.watchLoop(generation);
    } catch {
      this.port = undefined;
      this.scheduleReconnect();
    }
  }

  private async watchLoop(generation: number): Promise<void> {
    while (!this.stopped && this.port && generation === this.generation) {
      try {
        const response = await this.request({
          protocol_version: NATIVE_PROTOCOL_VERSION,
          request_id: requestId(),
          type: "restore.request.wait",
        });
        if (response.type === "restore.request.none") continue;
        if (response.type !== "restore.request") {
          throw new Error(`Unexpected restore watcher response '${response.type}'`);
        }
        const restoreRequestId = response.restore_request_id?.trim();
        const capsuleName = response.capsule_name?.trim();
        if (!restoreRequestId || !capsuleName) {
          throw new Error("Native host returned an incomplete restore request");
        }
        await this.processRestore({
          restore_request_id: restoreRequestId,
          capsule_name: capsuleName,
        });
      } catch {
        if (this.stopped || generation !== this.generation) return;
        if (!this.port) {
          this.scheduleReconnect();
          return;
        }
        await delay(RECONNECT_DELAY_MS);
      }
    }
  }

  private async processRestore(request: OrchestratedRestoreRequest): Promise<void> {
    const handler = this.handler;
    if (!handler) return;

    try {
      const result = await handler(request);
      const completion: NativeRequest = {
        protocol_version: NATIVE_PROTOCOL_VERSION,
        request_id: requestId(),
        type: "restore.request.complete",
        restore_request_id: request.restore_request_id,
        restore_ok: true,
      };
      if (result.summary) completion.restore_summary = result.summary;
      await this.request(completion);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.request({
        protocol_version: NATIVE_PROTOCOL_VERSION,
        request_id: requestId(),
        type: "restore.request.complete",
        restore_request_id: request.restore_request_id,
        restore_ok: false,
        restore_error: message,
      }).catch(() => undefined);
    }
  }

  private request(request: NativeRequest): Promise<NativeResponse> {
    const port = this.port;
    if (!port) return Promise.reject(new Error("restore native host is not connected"));

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(request.request_id);
        reject(new Error(`Native restore request '${request.type}' timed out`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(request.request_id, { resolve, reject, timeout });
      try {
        port.postMessage(request);
      } catch (error) {
        clearTimeout(timeout);
        this.pending.delete(request.request_id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private onMessage(message: unknown): void {
    if (!message || typeof message !== "object") return;
    const response = message as Partial<NativeResponse>;
    if (typeof response.request_id !== "string") return;
    const pending = this.pending.get(response.request_id);
    if (!pending) return;
    clearTimeout(pending.timeout);
    this.pending.delete(response.request_id);
    if (!response.ok) {
      pending.reject(new Error(response.error ?? "Native restore request failed"));
      return;
    }
    pending.resolve(response as NativeResponse);
  }

  private onDisconnect(port: browser.runtime.Port): void {
    if (this.port !== port) return;
    this.port = undefined;
    this.generation += 1;
    const message = browser.runtime.lastError?.message ?? "restore native host disconnected";
    this.rejectPending(new Error(message));
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.connect();
    }, RECONNECT_DELAY_MS);
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
