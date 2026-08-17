import { captureFirefoxSnapshot } from "./browser/capture";
import { restoreFirefoxSnapshot } from "./browser/restore";
import { tabCount, type FirefoxSnapshot, type RestoreReport } from "./browser/model";
import { NativeClient, type NativeClientStatus } from "./native/client";
import type { RestoreRequest } from "./native/protocol";

interface ExtensionStatus {
  native: NativeClientStatus;
  last_sync_unix_ms?: number;
  windows: number;
  tabs: number;
  skipped_private_windows: number;
  syncing: boolean;
  restoring: boolean;
  last_error?: string;
  last_restore?: RestoreReport;
}

type PopupMessage =
  | { type: "status" }
  | { type: "capture-now" }
  | { type: "restore-capsule"; capsule_name: string };

let latestSnapshot: FirefoxSnapshot | undefined;
let syncTimer: ReturnType<typeof setTimeout> | undefined;
let syncing = false;
let restoring = false;
let nativeStatus: NativeClientStatus = { connected: false };
let lastSyncUnixMs: number | undefined;
let lastError: string | undefined;
let lastRestore: RestoreReport | undefined;
let lastHandledRestoreRequestId: string | undefined;

const native = new NativeClient((status) => {
  nativeStatus = status;
});

function status(): ExtensionStatus {
  const value: ExtensionStatus = {
    native: nativeStatus,
    windows: latestSnapshot?.windows.length ?? 0,
    tabs: latestSnapshot ? tabCount(latestSnapshot) : 0,
    skipped_private_windows: latestSnapshot?.skipped_private_windows ?? 0,
    syncing,
    restoring,
  };
  if (lastSyncUnixMs !== undefined) value.last_sync_unix_ms = lastSyncUnixMs;
  if (lastError) value.last_error = lastError;
  if (lastRestore) value.last_restore = lastRestore;
  return value;
}

async function syncSnapshot(): Promise<ExtensionStatus> {
  if (syncing || restoring) return status();
  syncing = true;
  try {
    const snapshot = await captureFirefoxSnapshot();
    latestSnapshot = snapshot;
    await native.updateState(snapshot);
    lastSyncUnixMs = Date.now();
    lastError = undefined;
  } catch (error) {
    lastError = error instanceof Error ? error.message : String(error);
  } finally {
    syncing = false;
  }
  return status();
}

function scheduleSync(delay = 500): void {
  if (restoring) return;
  if (syncTimer) clearTimeout(syncTimer);
  syncTimer = setTimeout(() => {
    syncTimer = undefined;
    void syncSnapshot();
  }, delay);
}

function restoreOptions() {
  return {
    createBlankWindow: () => native.createBlankBrowserWindow(),
  };
}

async function restoreCapsule(name: string): Promise<ExtensionStatus> {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("Enter a capsule name to restore");
  restoring = true;
  lastError = undefined;
  try {
    const snapshot = await native.getCapsule(trimmed);
    lastRestore = await restoreFirefoxSnapshot(snapshot, restoreOptions());
  } catch (error) {
    lastError = error instanceof Error ? error.message : String(error);
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
  lastError = undefined;
  let report: RestoreReport | undefined;
  let restoreError: string | undefined;

  try {
    if (request.adapter !== "firefox" || request.schema_version !== 1) {
      throw new Error("Unsupported Context Capsule Firefox restore request");
    }
    report = await restoreFirefoxSnapshot(request.payload, restoreOptions());
    lastRestore = report;
  } catch (error) {
    restoreError = error instanceof Error ? error.message : String(error);
    lastError = restoreError;
  }

  try {
    const snapshot = await captureFirefoxSnapshot();
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
    lastError = completionError instanceof Error ? completionError.message : String(completionError);
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
    // NativeClient owns connection/reconnect status. A transient poll failure should
    // not overwrite the user's last semantic restore error every second.
  }
}

browser.runtime.onMessage.addListener((message: unknown) => {
  const request = message as Partial<PopupMessage>;
  switch (request.type) {
    case "status":
      return Promise.resolve(status());
    case "capture-now":
      return syncSnapshot();
    case "restore-capsule":
      return restoreCapsule((request as { capsule_name?: string }).capsule_name ?? "");
    default:
      return undefined;
  }
});

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

native.connect();
scheduleSync(100);
setInterval(() => scheduleSync(0), 30_000);
setInterval(() => void pollNativeRestore(), 1_000);
