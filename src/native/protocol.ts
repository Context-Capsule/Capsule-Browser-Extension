import { BROWSER_ADAPTER_ID, NATIVE_HOST_NAME as TARGET_NATIVE_HOST_NAME } from "../platform";
import type { BrowserAdapterId, BrowserSplitOrientation, FirefoxSnapshot } from "../browser/model";

export const NATIVE_HOST_NAME = TARGET_NATIVE_HOST_NAME;
export const NATIVE_PROTOCOL_VERSION = 1 as const;

export interface RestoreRequest {
  schema_version: 1;
  request_id: string;
  adapter: BrowserAdapterId;
  created_at_unix_ms: number;
  payload: FirefoxSnapshot;
}

export type NativeRequest =
  | {
      protocol_version: typeof NATIVE_PROTOCOL_VERSION;
      request_id: string;
      type: "ping";
    }
  | {
      protocol_version: typeof NATIVE_PROTOCOL_VERSION;
      request_id: string;
      type: "browser.log.append";
      log_level: "error" | "warn" | "info" | "debug" | "trace";
      log_message: string;
    }
  | {
      protocol_version: typeof NATIVE_PROTOCOL_VERSION;
      request_id: string;
      type: "browser.state.update";
      snapshot: FirefoxSnapshot;
      restore_request_id?: string;
      restore_changed?: number;
      restore_skipped?: number;
      restore_warnings?: string[];
      restore_error?: string;
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
      type: "browser.window.blank.create";
    }
  | {
      protocol_version: typeof NATIVE_PROTOCOL_VERSION;
      request_id: string;
      type: "browser.zen.split.invoke";
      split_orientation: BrowserSplitOrientation;
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
  restore_request?: RestoreRequest;
}

export const CURRENT_ADAPTER_ID: BrowserAdapterId = BROWSER_ADAPTER_ID;

export function requestId(): string {
  return `${Date.now().toString(36)}-${crypto.randomUUID()}`;
}
