import type { FirefoxSnapshot } from "../browser/model";

export const NATIVE_HOST_NAME = "com.contextcapsule.host";
export const NATIVE_PROTOCOL_VERSION = 1 as const;

export type NativeRequest =
  | {
      protocol_version: typeof NATIVE_PROTOCOL_VERSION;
      request_id: string;
      type: "ping";
    }
  | {
      protocol_version: typeof NATIVE_PROTOCOL_VERSION;
      request_id: string;
      type: "browser.state.update";
      snapshot: FirefoxSnapshot;
    }
  | {
      protocol_version: typeof NATIVE_PROTOCOL_VERSION;
      request_id: string;
      type: "browser.capsule.get";
      capsule_name: string;
    }
  | {
      protocol_version: typeof NATIVE_PROTOCOL_VERSION;
      request_id: string;
      type: "restore.request.wait";
    }
  | {
      protocol_version: typeof NATIVE_PROTOCOL_VERSION;
      request_id: string;
      type: "restore.request.complete";
      restore_request_id: string;
      restore_ok: boolean;
      restore_summary?: string;
      restore_error?: string;
    };

export interface NativeResponse {
  protocol_version: number;
  request_id: string;
  type: string;
  ok: boolean;
  error?: string;
  snapshot?: FirefoxSnapshot;
  stored_at_unix_ms?: number;
  host_version?: string;
  restore_request_id?: string;
  capsule_name?: string;
}

export function requestId(): string {
  return `${Date.now().toString(36)}-${crypto.randomUUID()}`;
}
