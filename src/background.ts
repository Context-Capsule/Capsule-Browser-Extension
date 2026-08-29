import { captureBrowserSnapshot } from "./browser/capture";
import { enforceFinalTabOrder } from "./browser/order";
import { restoreFirefoxSnapshot } from "./browser/restore";
import {
  tabCount,
  type FirefoxSnapshot,
  type RestoreReport,
} from "./browser/model";
import {
  BROWSER_ADAPTER_ID,
  BROWSER_LABEL,
  IS_FIREFOX,
} from "./platform";
import { NativeClient, type NativeClientStatus, type NativeLogLevel } from "./native/client";
import type { RestoreRequest } from "./native/protocol";

interface ExtensionStatus {
  native: NativeClientStatus;
  last_sync_unix_ms?: number;
  install_type?: string;
  windows: number;
  tabs: number;
  skipped_private_windows: number;
  syncing: boolean;
  restoring: boolean;
  last_error?: string;
  last_restore?: RestoreReport;
}

interface MessageErrorEnvelope {
  __context_capsule_error: string;
}

type PopupMessage =
  | { type: "status" }
  | { type: "capture-now" }
  | { type: "restore-capsule"; capsule_name: string };

type SyncReason = "automatic" | "manual" | "startup";

let latestSnapshot: FirefoxSnapshot | undefined;
let syncTimer: ReturnType<typeof setTimeout> | undefined;
let syncing = false;
let restoring = false;
let nativeStatus: NativeClientStatus = { connected: false };
let lastSyncUnixMs: number | undefined;
let lastError: string | undefined;
let lastRestore: RestoreReport | undefined;
let lastHandledRestoreRequestId: string | undefined;
let lastLoggedError: string | undefined;

const RESTORE_POLL_MS = 350;

const native = new NativeClient((status) => {
  const wasConnected = nativeStatus.connected;
  nativeStatus = status;
  if (status.connected && !wasConnected) {
    queueMicrotask(() => persistDiagnostic("info", `${BROWSER_LABEL} adapter connected to native host`));
    // Reconnecting can happen after the native host is installed/reinstalled
    // while the browser is already open. Publish semantic state immediately so
    // a CLI save does not have to wait for a tab event or periodic timer.
    queueMicrotask(() => scheduleSync(0, "startup"));
  }
});

function persistDiagnostic(level: NativeLogLevel, message: string): void {
  if (!native.currentStatus().connected) return;
  void native.appendLog(level, message).catch(() => {
    // Logging must never break capture/restore or trigger another log request.
  });
}

function recordError(context: string, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  lastError = message;
  const signature = `${context}:${message}`;
  if (signature !== lastLoggedError) {
    lastLoggedError = signature;
    persistDiagnostic("error", `${context}; ${message}`);
  }
  return message;
}

function clearError(): void {
  lastError = undefined;
  lastLoggedError = undefined;
}

function status(): ExtensionStatus {
  const value: ExtensionStatus = {
    native: nativeStatus,
    windows: latestSnapshot?.windows.length ?? 0,
    tabs: latestSnapshot ? tabCount(latestSnapshot) : 0,
    skipped_private_windows: latestSnapshot?.skipped_private_windows ?? 0,
    syncing,
    restoring,
  };
  if (latestSnapshot?.install_type) value.install_type = latestSnapshot.install_type;
  if (lastSyncUnixMs !== undefined) value.last_sync_unix_ms = lastSyncUnixMs;
  if (lastError) value.last_error = lastError;
  if (lastRestore) value.last_restore = lastRestore;
  return value;
}

async function syncSnapshot(reason: SyncReason = "automatic"): Promise<ExtensionStatus> {
  if (syncing || restoring) return status();
  syncing = true;
  try {
    const snapshot = await captureBrowserSnapshot();
    latestSnapshot = snapshot;
    await native.updateState(snapshot);
    lastSyncUnixMs = Date.now();
    clearError();
    if (reason !== "automatic") {
      persistDiagnostic(
        "info",
        `${BROWSER_LABEL} semantic capture completed; reason=${reason} install_type=${snapshot.install_type ?? "unknown"} windows=${snapshot.windows.length} tabs=${tabCount(snapshot)} private_skipped=${snapshot.skipped_private_windows}`,
      );
    }
  } catch (error) {
    recordError(`${BROWSER_LABEL} semantic capture failed; reason=${reason}`, error);
  } finally {
    syncing = false;
  }
  return status();
}

function scheduleSync(delay = 500, reason: SyncReason = "automatic"): void {
  if (restoring) return;
  if (syncTimer) clearTimeout(syncTimer);
  syncTimer = setTimeout(() => {
    syncTimer = undefined;
    void syncSnapshot(reason);
  }, delay);
}

function restoreOptions() {
  // The native blank-window fallback exists only for Zen. Chrome and ordinary
  // Firefox use the standard WebExtension windows API.
  return IS_FIREFOX
    ? { createBlankWindow: () => native.createBlankBrowserWindow() }
    : {};
}

function restoreSummary(report: RestoreReport): string {
  return `created_windows=${report.created_windows} created_tabs=${report.created_tabs} created_groups=${report.created_groups} reused_windows=${report.reused_windows} reused_tabs=${report.reused_tabs} warnings=${report.warnings.length}`;
}

async function finalizeTabOrder(snapshot: FirefoxSnapshot, report: RestoreReport): Promise<void> {
  const ordering = await enforceFinalTabOrder(snapshot);
  report.warnings.push(...ordering.warnings);
  if (ordering.correctedWindows > 0 || ordering.warnings.length > 0) {
    persistDiagnostic(
      ordering.warnings.length > 0 ? "warn" : "info",
      `Final browser tab ordering completed; corrected_windows=${ordering.correctedWindows} warnings=${ordering.warnings.length}`,
    );
  }
}

/**
 * The restore engine owns window planning and resource reconciliation. A final
 * independent ordering pass runs only after creation, reuse, grouping, active
 * state, and geometry have finished, so no later semantic browser operation can
 * silently disturb the saved tab sequence.
 *
 * Zen split restoration remains intentionally disabled. Chrome never enters
 * the Zen-specific split/native-window paths.
 */
async function prepareAuthoritativeRestore(snapshot: FirefoxSnapshot): Promise<FirefoxSnapshot> {
  persistDiagnostic(
    "info",
    `${BROWSER_LABEL} authoritative restore delegated to global reuse planner; saved_windows=${snapshot.windows.length} saved_tabs=${tabCount(snapshot)}`,
  );
  return snapshot;
}

async function restoreCapsule(name: string): Promise<ExtensionStatus> {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("Enter a capsule name to restore");
  restoring = true;
  clearError();
  persistDiagnostic("info", `Popup-requested ${BROWSER_LABEL} semantic restore started`);
  try {
    const snapshot = await native.getCapsule(trimmed);
    if (snapshot.browser !== BROWSER_ADAPTER_ID) {
      throw new Error(`Capsule returned ${snapshot.browser} state to the ${BROWSER_ADAPTER_ID} adapter`);
    }
    const prepared = await prepareAuthoritativeRestore(snapshot);
    lastRestore = await restoreFirefoxSnapshot(prepared, restoreOptions());
    await finalizeTabOrder(prepared, lastRestore);
    persistDiagnostic(
      lastRestore.warnings.length > 0 ? "warn" : "info",
      `Popup-requested ${BROWSER_LABEL} semantic restore completed; ${restoreSummary(lastRestore)}`,
    );
  } catch (error) {
    recordError(`Popup-requested ${BROWSER_LABEL} semantic restore failed`, error);
    throw error;
  } finally {
    restoring = false;
    scheduleSync(1_000);
  }
  return status();
}

async function completeNativeRestore(request: RestoreRequest): Promise<void> {
  if (restoring || request.request_id === lastHandledRestoreRequestId) return;
  restoring = true;
  clearError();
  let report: RestoreReport | undefined;
  let restoreError: string | undefined;
  persistDiagnostic(
    "info",
    `CLI-requested ${BROWSER_LABEL} semantic restore started; windows=${request.payload.windows.length} tabs=${tabCount(request.payload)}`,
  );

  try {
    if (request.adapter !== BROWSER_ADAPTER_ID || request.schema_version !== 1) {
      throw new Error(`Unsupported Context Capsule ${BROWSER_LABEL} restore request`);
    }
    if (request.payload.browser !== BROWSER_ADAPTER_ID) {
      throw new Error(`Restore payload belongs to '${request.payload.browser}', not '${BROWSER_ADAPTER_ID}'`);
    }
    const prepared = await prepareAuthoritativeRestore(request.payload);
    report = await restoreFirefoxSnapshot(prepared, restoreOptions());
    await finalizeTabOrder(prepared, report);
    lastRestore = report;
    persistDiagnostic(
      report.warnings.length > 0 ? "warn" : "info",
      `CLI-requested ${BROWSER_LABEL} semantic restore applied; ${restoreSummary(report)}`,
    );
  } catch (error) {
    restoreError = recordError(`CLI-requested ${BROWSER_LABEL} semantic restore failed`, error);
  }

  try {
    const snapshot = await captureBrowserSnapshot();
    latestSnapshot = snapshot;
    const completion: {
      requestId: string;
      report?: RestoreReport;
      error?: string;
    } = { requestId: request.request_id };
    if (report) completion.report = report;
    if (restoreError) completion.error = restoreError;
    await native.updateState(snapshot, completion);
    lastSyncUnixMs = Date.now();
    lastHandledRestoreRequestId = request.request_id;
  } catch (completionError) {
    recordError(`${BROWSER_LABEL} restore completion synchronization failed`, completionError);
  } finally {
    restoring = false;
  }
}

async function pollNativeRestore(): Promise<void> {
  if (restoring || !native.currentStatus().connected) return;
  try {
    const request = await native.pollRestoreRequest();
    if (request) await completeNativeRestore(request);
  } catch {
    // NativeClient owns connection/reconnect status. A transient poll failure
    // must not replace the last semantic restore error.
  }
}

function messageError(error: unknown): MessageErrorEnvelope {
  return {
    __context_capsule_error: error instanceof Error ? error.message : String(error),
  };
}

if (IS_FIREFOX) {
  // Preserve the already-proven Firefox/Zen message boundary exactly. Firefox
  // supports promise-returning onMessage listeners, so the existing popup
  // behavior remains unchanged on the default build target.
  browser.runtime.onMessage.addListener((message: unknown) => {
    const request = message as Partial<PopupMessage>;
    switch (request.type) {
      case "status":
        return Promise.resolve(status());
      case "capture-now":
        return syncSnapshot("manual");
      case "restore-capsule":
        return restoreCapsule((request as { capsule_name?: string }).capsule_name ?? "");
      default:
        return undefined;
    }
  });
} else {
  // Promise-returning runtime.onMessage listeners are only natively supported
  // by Chrome starting with Chrome 148. The callback form works across MV3
  // Chrome releases and keeps this build compatible with Chrome 105+.
  browser.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
    const request = message as Partial<PopupMessage>;
    switch (request.type) {
      case "status":
        sendResponse(status());
        return false;
      case "capture-now":
        void syncSnapshot("manual").then(sendResponse, (error) => sendResponse(messageError(error)));
        return true;
      case "restore-capsule":
        void restoreCapsule((request as { capsule_name?: string }).capsule_name ?? "")
          .then(sendResponse, (error) => sendResponse(messageError(error)));
        return true;
      default:
        return false;
    }
  });
}

browser.tabs.onCreated.addListener(() => scheduleSync());
browser.tabs.onRemoved.addListener(() => scheduleSync());
browser.tabs.onMoved.addListener(() => scheduleSync());
browser.tabs.onActivated.addListener(() => scheduleSync());
browser.tabs.onAttached.addListener(() => scheduleSync());
browser.tabs.onDetached.addListener(() => scheduleSync());
browser.tabs.onUpdated.addListener(() => scheduleSync());
browser.windows.onCreated.addListener(() => scheduleSync());
browser.windows.onRemoved.addListener(() => scheduleSync());
browser.windows.onFocusChanged.addListener(() => scheduleSync());

const maybeGroups = (browser as unknown as {
  tabGroups?: {
    onCreated?: { addListener(listener: () => void): void };
    onMoved?: { addListener(listener: () => void): void };
    onRemoved?: { addListener(listener: () => void): void };
    onUpdated?: { addListener(listener: () => void): void };
  };
}).tabGroups;
for (const event of [maybeGroups?.onCreated, maybeGroups?.onMoved, maybeGroups?.onRemoved, maybeGroups?.onUpdated]) {
  event?.addListener(() => scheduleSync());
}

// connectNative keeps Chrome MV3's service worker alive while the native port
// is open (Chrome 105+). Firefox keeps the existing persistent background
// behavior. If the host is absent, ordinary browser events/popup interaction
// will restart the worker and retry the connection.
native.connect();
scheduleSync(100, "startup");
setInterval(() => scheduleSync(0), 30_000);
setInterval(() => void pollNativeRestore(), RESTORE_POLL_MS);
