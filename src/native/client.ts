import {
  NATIVE_HOST_NAME,
  NATIVE_PROTOCOL_VERSION,
  type NativeRequest,
  type NativeResponse,
  type RestoreRequest,
  requestId,
} from "./protocol";
import type { BrowserSplitOrientation, FirefoxSnapshot, RestoreReport } from "../browser/model";

export interface NativeClientStatus {
  connected: boolean;
  last_error?: string;
  host_version?: string;
}

export type BlankBrowserWindowResult = "created" | "unsupported";
export type NativeLogLevel = "error" | "warn" | "info" | "debug" | "trace";

type Pending = {
  resolve: (response: NativeResponse) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
};

const ZEN_NOT_RUNNING = "no running zen.exe application was detected";

export class NativeClient {
  private port: browser.runtime.Port | undefined;
  private pending = new Map<string, Pending>();
  private status: NativeClientStatus = { connected: false };
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly onStatusChange: (status: NativeClientStatus) => void) {}

  connect(): void {
    if (this.port) return;
    try {
      const port = browser.runtime.connectNative(NATIVE_HOST_NAME);
      this.port = port;
      port.onMessage.addListener((message: unknown) => this.onMessage(message));
      port.onDisconnect.addListener(() => this.onDisconnect());
      this.setStatus({ connected: true });
      void this.ping().catch((error) => this.failConnection(error));
    } catch (error) {
      this.failConnection(error);
    }
  }

  currentStatus(): NativeClientStatus {
    return { ...this.status };
  }

  async appendLog(level: NativeLogLevel, message: string): Promise<void> {
    if (!message.trim()) return;
    await this.request({
      protocol_version: NATIVE_PROTOCOL_VERSION,
      request_id: requestId(),
      type: "browser.log.append",
      log_level: level,
      log_message: message,
    });
  }

  async updateState(
    snapshot: FirefoxSnapshot,
    completion?: { requestId: string; report?: RestoreReport; error?: string },
  ): Promise<NativeResponse> {
    const request: NativeRequest = {
      protocol_version: NATIVE_PROTOCOL_VERSION,
      request_id: requestId(),
      type: "browser.state.update",
      snapshot,
    };
    if (completion) {
      request.restore_request_id = completion.requestId;
      request.restore_changed = completion.report
        ? completion.report.created_windows + completion.report.created_tabs + completion.report.created_groups
        : 0;
      request.restore_skipped = completion.report
        ? completion.report.reused_windows + completion.report.reused_tabs
        : 0;
      request.restore_warnings = completion.report?.warnings ?? [];
      if (completion.error) request.restore_error = completion.error;
    }
    return this.request(request);
  }

  async pollRestoreRequest(): Promise<RestoreRequest | undefined> {
    const response = await this.ping();
    return response.restore_request;
  }

  async getCapsule(name: string): Promise<FirefoxSnapshot> {
    const response = await this.request({
      protocol_version: NATIVE_PROTOCOL_VERSION,
      request_id: requestId(),
      type: "browser.capsule.get",
      capsule_name: name,
    });
    if (!response.snapshot) throw new Error("Native host returned no Firefox snapshot");
    return response.snapshot;
  }

  async createBlankBrowserWindow(): Promise<BlankBrowserWindowResult> {
    try {
      await this.request({
        protocol_version: NATIVE_PROTOCOL_VERSION,
        request_id: requestId(),
        type: "browser.window.blank.create",
      });
      return "created";
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.toLocaleLowerCase("en-US").includes(ZEN_NOT_RUNNING)) return "unsupported";
      throw error;
    }
  }

  /**
   * Split invocation deliberately uses a one-shot native-message process rather
   * than the long-lived adapter port. During development the CLI/native-host
   * binary is rebuilt in place; an already connected host can therefore remain
   * an older executable in memory even though the file on disk is current.
   * A fresh process makes the command path deterministic without disrupting the
   * persistent state/capture connection.
   */
  async invokeZenSplit(orientation: BrowserSplitOrientation): Promise<void> {
    const request: NativeRequest = {
      protocol_version: NATIVE_PROTOCOL_VERSION,
      request_id: requestId(),
      type: "browser.zen.split.invoke",
      split_orientation: orientation,
    };
    const response = await browser.runtime.sendNativeMessage(
      NATIVE_HOST_NAME,
      request,
    ) as NativeResponse | undefined;
    if (!response?.ok) {
      throw new Error(response?.error ?? "Fresh Context Capsule native host rejected the Zen split command");
    }
  }

  private async ping(): Promise<NativeResponse> {
    const response = await this.request({
      protocol_version: NATIVE_PROTOCOL_VERSION,
      request_id: requestId(),
      type: "ping",
    });
    const status: NativeClientStatus = { connected: true };
    if (response.host_version) status.host_version = response.host_version;
    this.setStatus(status);
    return response;
  }

  private request(request: NativeRequest): Promise<NativeResponse> {
    if (!this.port) this.connect();
    const port = this.port;
    if (!port) return Promise.reject(new Error("Context Capsule native host is not connected"));

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(request.request_id);
        reject(new Error(`Native request '${request.type}' timed out`));
      }, 10_000);
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
      pending.reject(new Error(response.error ?? "Native host request failed"));
      return;
    }
    pending.resolve(response as NativeResponse);
  }

  private onDisconnect(): void {
    const runtimeError = browser.runtime.lastError?.message;
    this.port = undefined;
    this.rejectPending(new Error(runtimeError ?? "Context Capsule native host disconnected"));
    const status: NativeClientStatus = { connected: false };
    if (runtimeError) status.last_error = runtimeError;
    this.setStatus(status);
    this.scheduleReconnect();
  }

  private failConnection(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.port = undefined;
    this.setStatus({ connected: false, last_error: message });
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.connect();
    }, 5_000);
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private setStatus(status: NativeClientStatus): void {
    this.status = status;
    this.onStatusChange(this.currentStatus());
  }
}
