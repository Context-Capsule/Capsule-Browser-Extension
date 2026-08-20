import { captureFirefoxSnapshot } from "./browser/capture";
import { restoreFirefoxSnapshot } from "./browser/restore";
import {
  isDisposableBootstrapTabs,
  savedWindowSimilarity,
  tabCount,
  type ComparableLiveTab,
  type FirefoxSnapshot,
  type RestoreReport,
} from "./browser/model";
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

const native = new NativeClient((status) => {
  const wasConnected = nativeStatus.connected;
  nativeStatus = status;
  if (status.connected && !wasConnected) {
    queueMicrotask(() => persistDiagnostic("info", "Firefox adapter connected to native host"));
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
    const snapshot = await captureFirefoxSnapshot();
    latestSnapshot = snapshot;
    await native.updateState(snapshot);
    lastSyncUnixMs = Date.now();
    clearError();
    if (reason !== "automatic") {
      persistDiagnostic(
        "info",
        `Firefox semantic capture completed; reason=${reason} install_type=${snapshot.install_type ?? "unknown"} windows=${snapshot.windows.length} tabs=${tabCount(snapshot)} private_skipped=${snapshot.skipped_private_windows}`,
      );
    }
  } catch (error) {
    recordError(`Firefox semantic capture failed; reason=${reason}`, error);
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
  return {
    createBlankWindow: () => native.createBlankBrowserWindow(),
  };
}

function restoreSummary(report: RestoreReport): string {
  return `created_windows=${report.created_windows} created_tabs=${report.created_tabs} created_groups=${report.created_groups} reused_windows=${report.reused_windows} reused_tabs=${report.reused_tabs} warnings=${report.warnings.length}`;
}

function comparableTabs(window: browser.windows.Window): ComparableLiveTab[] {
  return (window.tabs ?? []).map((tab) => {
    const value: ComparableLiveTab = {
      index: tab.index,
      pinned: tab.pinned,
    };
    if (tab.url !== undefined) value.url = tab.url;
    if (tab.cookieStoreId !== undefined) value.cookieStoreId = tab.cookieStoreId;
    return value;
  });
}

function geometryDistance(
  saved: FirefoxSnapshot["windows"][number],
  live: browser.windows.Window,
): number {
  let distance = 0;
  let observed = 0;
  for (const [savedValue, liveValue] of [
    [saved.left, live.left],
    [saved.top, live.top],
    [saved.width, live.width],
    [saved.height, live.height],
  ] as const) {
    if (savedValue === undefined || liveValue === undefined) continue;
    distance += Math.abs(savedValue - liveValue);
    observed += 1;
  }
  return observed > 0 ? distance : 1_000_000;
}

interface AuthoritativeShellChoice {
  live: browser.windows.Window;
  savedIndex: number;
  exact: boolean;
  semanticScore: number;
  geometryDistance: number;
}

function chooseAuthoritativeShell(
  snapshot: FirefoxSnapshot,
  currentWindows: browser.windows.Window[],
): AuthoritativeShellChoice | undefined {
  if (snapshot.windows.length === 0 || currentWindows.length === 0) return undefined;

  let best: AuthoritativeShellChoice | undefined;
  for (const live of currentWindows) {
    if (live.id === undefined) continue;
    for (const [savedIndex, saved] of snapshot.windows.entries()) {
      const similarity = savedWindowSimilarity(saved, comparableTabs(live));
      const candidate: AuthoritativeShellChoice = {
        live,
        savedIndex,
        exact: similarity.exact,
        semanticScore: similarity.score,
        geometryDistance: geometryDistance(saved, live),
      };
      if (!best) {
        best = candidate;
        continue;
      }

      const candidateHasSemanticIdentity = candidate.semanticScore > 0;
      const bestHasSemanticIdentity = best.semanticScore > 0;
      if (candidateHasSemanticIdentity !== bestHasSemanticIdentity) {
        if (candidateHasSemanticIdentity) best = candidate;
        continue;
      }
      if (candidate.semanticScore !== best.semanticScore) {
        if (candidate.semanticScore > best.semanticScore) best = candidate;
        continue;
      }
      if (candidate.geometryDistance < best.geometryDistance) best = candidate;
    }
  }
  return best;
}

async function turnWindowIntoBootstrap(windowId: number): Promise<void> {
  const current = await browser.windows.get(windowId, { populate: true });
  const existingTabs = current.tabs ?? [];
  if (isDisposableBootstrapTabs(comparableTabs(current))) return;

  // Create the safety tab first so deleting unrelated live tabs can never close
  // the reusable window. Omitting the URL asks Firefox/Zen for its ordinary
  // new-tab page, matching the adapter's existing about:newtab restore path.
  const bootstrap = await browser.tabs.create({
    windowId,
    active: true,
  });
  if (bootstrap.id === undefined) {
    throw new Error("Zen created an authoritative bootstrap tab without an ID");
  }

  const staleTabIds = existingTabs
    .map((tab) => tab.id)
    .filter((id): id is number => id !== undefined && id !== bootstrap.id);
  if (staleTabIds.length > 0) {
    await browser.tabs.remove(staleTabIds);
  }

  const prepared = await browser.windows.get(windowId, { populate: true });
  if (!isDisposableBootstrapTabs(comparableTabs(prepared))) {
    throw new Error("Zen did not converge the reusable window to one disposable bootstrap tab");
  }
}

/**
 * Context Capsule restore is authoritative: the saved browser topology is the
 * target state, not an additive suggestion. Keep at most one pre-existing Zen
 * window as a shell, rebuild it when necessary, and close other live windows so
 * they cannot survive as stale third/fourth windows beside the capsule.
 *
 * The best shell is selected by saved-tab identity first and saved geometry
 * second. If it already exactly matches its saved window, preserve it intact.
 * Otherwise reduce it to one about:newtab and let the normal restore engine
 * repopulate that same HWND. Remaining saved windows are created through Zen's
 * independent native blank-window path.
 */
async function prepareAuthoritativeRestore(snapshot: FirefoxSnapshot): Promise<FirefoxSnapshot> {
  const currentWindows = (await browser.windows.getAll({ populate: true, windowTypes: ["normal"] }))
    .filter((window) => !window.incognito && window.id !== undefined);
  if (currentWindows.length === 0 || snapshot.windows.length === 0) return snapshot;

  const choice = chooseAuthoritativeShell(snapshot, currentWindows);
  if (!choice || choice.live.id === undefined) return snapshot;
  const shellId = choice.live.id;

  // One existing window is enough to keep Zen + the extension alive. Extra live
  // windows are outside the capsule and must not remain after an exact restore.
  for (const window of currentWindows) {
    if (window.id === undefined || window.id === shellId) continue;
    await browser.windows.remove(window.id);
  }

  if (!choice.exact) {
    await turnWindowIntoBootstrap(shellId);
  }

  const windows = [...snapshot.windows];
  if (choice.savedIndex !== 0) {
    const [matched] = windows.splice(choice.savedIndex, 1);
    if (matched) windows.unshift(matched);
  }

  persistDiagnostic(
    "info",
    `Authoritative Zen restore prepared; live_windows=${currentWindows.length} kept_shell=${shellId} exact_shell=${choice.exact} matched_saved_index=${choice.savedIndex} semantic_score=${choice.semanticScore} geometry_distance=${choice.geometryDistance}`,
  );
  return { ...snapshot, windows };
}

async function restoreCapsule(name: string): Promise<ExtensionStatus> {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("Enter a capsule name to restore");
  restoring = true;
  clearError();
  persistDiagnostic("info", "Popup-requested Firefox semantic restore started");
  try {
    const snapshot = await native.getCapsule(trimmed);
    const prepared = await prepareAuthoritativeRestore(snapshot);
    lastRestore = await restoreFirefoxSnapshot(prepared, restoreOptions());
    persistDiagnostic(
      lastRestore.warnings.length > 0 ? "warn" : "info",
      `Popup-requested Firefox semantic restore completed; ${restoreSummary(lastRestore)}`,
    );
  } catch (error) {
    recordError("Popup-requested Firefox semantic restore failed", error);
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
    `CLI-requested Firefox semantic restore started; windows=${request.payload.windows.length} tabs=${tabCount(request.payload)}`,
  );

  try {
    if (request.adapter !== "firefox" || request.schema_version !== 1) {
      throw new Error("Unsupported Context Capsule Firefox restore request");
    }
    const prepared = await prepareAuthoritativeRestore(request.payload);
    report = await restoreFirefoxSnapshot(prepared, restoreOptions());
    lastRestore = report;
    persistDiagnostic(
      report.warnings.length > 0 ? "warn" : "info",
      `CLI-requested Firefox semantic restore applied; ${restoreSummary(report)}`,
    );
  } catch (error) {
    restoreError = recordError("CLI-requested Firefox semantic restore failed", error);
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
    recordError("Firefox restore completion synchronization failed", completionError);
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
      return syncSnapshot("manual");
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
scheduleSync(100, "startup");
setInterval(() => scheduleSync(0), 30_000);
setInterval(() => void pollNativeRestore(), 1_000);
