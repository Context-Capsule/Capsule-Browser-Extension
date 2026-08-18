import {
  type BrowserTabSnapshot,
  type BrowserWindowSnapshot,
  type ComparableLiveTab,
  type FirefoxSnapshot,
  type RestoreReport,
  isDisposableBootstrapTabs,
  isPortableTabGroup,
  restorableUrl,
  savedTabsMatchLiveTabs,
} from "./model";

interface TabsGroupingApi {
  group(options: { tabIds: number | number[]; createProperties?: { windowId?: number }; groupId?: number }): Promise<number>;
}

interface TabGroupsApi {
  update(
    groupId: number,
    properties: { title?: string; color?: string; collapsed?: boolean },
  ): Promise<unknown>;
}

export type NativeBlankWindowResult = "created" | "unsupported";

export interface RestoreOptions {
  /**
   * Ask the native host to create an independent browser window when it knows
   * how to do so. Zen uses this to avoid Window Sync cloning/mutating the
   * current Space. Plain Firefox reports "unsupported" and uses the standard
   * WebExtension windows API instead.
   */
  createBlankWindow?: () => Promise<NativeBlankWindowResult>;
}

const NEW_WINDOW_SETTLE_MS = 300;
const NATIVE_BLANK_WINDOW_TIMEOUT_MS = 5_000;
const NATIVE_BLANK_WINDOW_POLL_MS = 100;
const NORMAL_GEOMETRY_SETTLE_MS = 180;
const NORMAL_GEOMETRY_RETRIES = 5;
const NORMAL_GEOMETRY_TOLERANCE = 8;

function groupingApis(): { tabs?: TabsGroupingApi; groups?: TabGroupsApi } {
  const root = browser as unknown as {
    tabs: typeof browser.tabs & Partial<TabsGroupingApi>;
    tabGroups?: TabGroupsApi;
  };
  const result: { tabs?: TabsGroupingApi; groups?: TabGroupsApi } = {};
  if (typeof root.tabs.group === "function") result.tabs = root.tabs as unknown as TabsGroupingApi;
  if (root.tabGroups) result.groups = root.tabGroups;
  return result;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function createTab(
  windowId: number,
  tab: BrowserTabSnapshot,
  warnings: string[],
): Promise<browser.tabs.Tab> {
  const properties: Parameters<typeof browser.tabs.create>[0] = {
    windowId,
    active: false,
    pinned: tab.pinned,
  };
  const url = restorableUrl(tab.url);
  if (url !== undefined) properties.url = url;
  if (tab.cookie_store_id) properties.cookieStoreId = tab.cookie_store_id;

  let created: browser.tabs.Tab;
  try {
    created = await browser.tabs.create(properties);
  } catch (error) {
    if (!tab.cookie_store_id) throw error;
    delete properties.cookieStoreId;
    warnings.push(
      `Container '${tab.cookie_store_id}' was unavailable for '${tab.title ?? tab.url}'; restored in the default container.`,
    );
    created = await browser.tabs.create(properties);
  }

  if (created.id !== undefined && tab.muted) {
    await browser.tabs.update(created.id, { muted: true }).catch(() => undefined);
  }
  return created;
}

function numberClose(actual: number | undefined, expected: number | undefined): boolean {
  if (expected === undefined) return true;
  return actual !== undefined && Math.abs(actual - expected) <= NORMAL_GEOMETRY_TOLERANCE;
}

export function normalWindowGeometryMatches(
  actual: Pick<browser.windows.Window, "left" | "top" | "width" | "height" | "state">,
  saved: Pick<BrowserWindowSnapshot, "left" | "top" | "width" | "height">,
): boolean {
  return (actual.state === undefined || actual.state === "normal")
    && numberClose(actual.left, saved.left)
    && numberClose(actual.top, saved.top)
    && numberClose(actual.width, saved.width)
    && numberClose(actual.height, saved.height);
}

function describeGeometry(window: Pick<browser.windows.Window, "left" | "top" | "width" | "height" | "state">): string {
  return `left=${window.left ?? "?"}, top=${window.top ?? "?"}, width=${window.width ?? "?"}, height=${window.height ?? "?"}, state=${window.state ?? "?"}`;
}

async function restoreNormalGeometry(windowId: number, saved: BrowserWindowSnapshot): Promise<void> {
  // Firefox documents that non-normal states cannot be combined with geometry.
  // More importantly for Zen, the native --blank-window can be re-laid-out by
  // browser startup/Window Sync shortly after creation. Normalize the state
  // first, then apply and verify the saved bounds repeatedly until Zen stops
  // moving the new independent window underneath us.
  await browser.windows.update(windowId, { state: "normal" });
  await delay(NORMAL_GEOMETRY_SETTLE_MS);

  const geometry: Parameters<typeof browser.windows.update>[1] = {};
  if (saved.left !== undefined) geometry.left = saved.left;
  if (saved.top !== undefined) geometry.top = saved.top;
  if (saved.width !== undefined) geometry.width = saved.width;
  if (saved.height !== undefined) geometry.height = saved.height;

  if (Object.keys(geometry).length === 0) return;

  let last: browser.windows.Window | undefined;
  for (let attempt = 0; attempt < NORMAL_GEOMETRY_RETRIES; attempt += 1) {
    await browser.windows.update(windowId, geometry);
    await delay(NORMAL_GEOMETRY_SETTLE_MS * (attempt + 1));
    last = await browser.windows.get(windowId).catch(() => undefined);
    if (last && normalWindowGeometryMatches(last, saved)) return;
  }

  throw new Error(
    `window bounds did not converge to the saved geometry after ${NORMAL_GEOMETRY_RETRIES} attempts; saved ${describeGeometry({ ...saved, state: "normal" })}; observed ${last ? describeGeometry(last) : "window unavailable"}`,
  );
}

async function restoreGeometry(windowId: number, saved: BrowserWindowSnapshot): Promise<void> {
  if (saved.state === "normal") {
    await restoreNormalGeometry(windowId, saved);
    return;
  }

  await browser.windows.update(windowId, { state: saved.state });
}

async function restoreGroups(
  windowId: number,
  saved: BrowserWindowSnapshot,
  restoredByIndex: Map<number, browser.tabs.Tab>,
  report: RestoreReport,
): Promise<void> {
  const { tabs: tabsGrouping, groups: groupsApi } = groupingApis();
  if (!tabsGrouping || !groupsApi) {
    if (saved.groups.some(isPortableTabGroup)) {
      report.warnings.push("This Firefox version does not expose the tabGroups API; named tab groups were restored ungrouped.");
    }
    return;
  }

  for (const group of saved.groups) {
    // Anonymous group identifiers are also used by some Firefox-derived
    // browsers for vendor/split relationships. Silently preserve the tabs as
    // independent tabs instead of emitting a warning on every restore.
    if (!isPortableTabGroup(group)) continue;

    const tabIds = saved.tabs
      .filter((tab) => tab.group_key === group.key && !tab.pinned)
      .sort((a, b) => a.index - b.index)
      .map((tab) => restoredByIndex.get(tab.index)?.id)
      .filter((id): id is number => id !== undefined);
    if (tabIds.length === 0) continue;

    try {
      const groupId = await tabsGrouping.group({ tabIds, createProperties: { windowId } });
      await groupsApi.update(groupId, {
        title: group.title,
        color: group.color,
        collapsed: group.collapsed,
      });
      report.created_groups += 1;
    } catch (error) {
      report.warnings.push(
        `Failed to restore tab group '${group.title || group.key}': ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

function comparableLiveTab(tab: browser.tabs.Tab): ComparableLiveTab {
  const comparable: ComparableLiveTab = {
    index: tab.index,
    pinned: tab.pinned,
  };
  if (tab.url !== undefined) comparable.url = tab.url;
  if (tab.cookieStoreId !== undefined) comparable.cookieStoreId = tab.cookieStoreId;
  return comparable;
}

function liveTabs(current: browser.windows.Window): ComparableLiveTab[] {
  return (current.tabs ?? []).map(comparableLiveTab);
}

function windowAlreadyContainsSnapshot(saved: BrowserWindowSnapshot, current: browser.windows.Window): boolean {
  return savedTabsMatchLiveTabs(saved, liveTabs(current));
}

function disposableBootstrapWindow(current: browser.windows.Window): boolean {
  return isDisposableBootstrapTabs(liveTabs(current));
}

function mapExistingTabs(saved: BrowserWindowSnapshot, current: browser.windows.Window): Map<number, browser.tabs.Tab> {
  const result = new Map<number, browser.tabs.Tab>();
  const currentTabs = [...(current.tabs ?? [])].sort((a, b) => a.index - b.index);
  const savedTabs = [...saved.tabs].sort((a, b) => a.index - b.index);
  savedTabs.forEach((savedTab, index) => {
    const currentTab = currentTabs[index];
    if (currentTab) result.set(savedTab.index, currentTab);
  });
  return result;
}

async function reconcileTabs(
  saved: BrowserWindowSnapshot,
  restoredByIndex: Map<number, browser.tabs.Tab>,
): Promise<void> {
  for (const savedTab of saved.tabs) {
    const tab = restoredByIndex.get(savedTab.index);
    if (tab?.id === undefined) continue;
    if (tab.mutedInfo?.muted !== savedTab.muted) {
      await browser.tabs.update(tab.id, { muted: savedTab.muted }).catch(() => undefined);
    }
  }

  const activeSaved = saved.tabs.find((tab) => tab.active);
  const activeRestored = activeSaved ? restoredByIndex.get(activeSaved.index) : undefined;
  const fallback = activeRestored ?? [...restoredByIndex.values()][0];
  if (fallback?.id !== undefined) {
    await browser.tabs.update(fallback.id, { active: true }).catch(() => undefined);
  }
}

async function reuseSatisfiedWindow(
  saved: BrowserWindowSnapshot,
  current: browser.windows.Window,
  report: RestoreReport,
): Promise<number> {
  if (current.id === undefined) throw new Error("Firefox returned an existing window without an ID");
  const windowId = current.id;
  const restoredByIndex = mapExistingTabs(saved, current);
  await reconcileTabs(saved, restoredByIndex);
  await restoreGroups(windowId, saved, restoredByIndex, report);
  await restoreGeometry(windowId, saved).catch((error) => {
    report.warnings.push(
      `Could not reconcile geometry for ${saved.key}: ${error instanceof Error ? error.message : String(error)}`,
    );
  });
  report.reused_windows += 1;
  report.reused_tabs += restoredByIndex.size;
  return windowId;
}

async function populateWindow(
  windowId: number,
  bootstrapTabId: number | undefined,
  saved: BrowserWindowSnapshot,
  report: RestoreReport,
): Promise<void> {
  const restoredByIndex = new Map<number, browser.tabs.Tab>();
  for (const savedTab of [...saved.tabs].sort((a, b) => a.index - b.index)) {
    if (!savedTab.restorable) continue;

    try {
      const restored = await createTab(windowId, savedTab, report.warnings);
      restoredByIndex.set(savedTab.index, restored);
      report.created_tabs += 1;
    } catch (error) {
      report.warnings.push(
        `Failed to restore '${savedTab.title ?? savedTab.url}': ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  // Do not remove any startup tab until at least one saved tab exists in the
  // target window. This prevents a failed restore from leaving an empty window.
  if (bootstrapTabId !== undefined && restoredByIndex.size > 0) {
    await browser.tabs.remove(bootstrapTabId).catch(() => undefined);
  }

  await restoreGroups(windowId, saved, restoredByIndex, report);
  await reconcileTabs(saved, restoredByIndex);
  await restoreGeometry(windowId, saved).catch((error) => {
    report.warnings.push(
      `Could not restore geometry for ${saved.key}: ${error instanceof Error ? error.message : String(error)}`,
    );
  });
}

async function reuseBootstrapWindow(
  saved: BrowserWindowSnapshot,
  current: browser.windows.Window,
  report: RestoreReport,
): Promise<number> {
  if (current.id === undefined) throw new Error("Firefox returned a bootstrap window without an ID");
  const bootstrapTabId = current.tabs?.[0]?.id;
  await populateWindow(current.id, bootstrapTabId, saved, report);
  report.reused_windows += 1;
  return current.id;
}

async function normalWindowIds(): Promise<Set<number>> {
  const windows = await browser.windows.getAll({ populate: false, windowTypes: ["normal"] });
  return new Set(windows.map((window) => window.id).filter((id): id is number => id !== undefined));
}

async function waitForNewDisposableWindow(
  before: Set<number>,
  timeoutMs = NATIVE_BLANK_WINDOW_TIMEOUT_MS,
): Promise<browser.windows.Window | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const windows = await browser.windows.getAll({ populate: true, windowTypes: ["normal"] });
    const candidate = windows.find((window) =>
      window.id !== undefined
      && !before.has(window.id)
      && !window.incognito
      && disposableBootstrapWindow(window));
    if (candidate) return candidate;
    await delay(NATIVE_BLANK_WINDOW_POLL_MS);
  }
  return undefined;
}

/**
 * Returns "unsupported" only when the native host explicitly says that the
 * current browser is not Zen. Undefined means a native Zen attempt failed and
 * callers must not fall back to browser.windows.create(), because doing so can
 * mutate a synchronized Zen Space.
 */
async function tryCreateNativeBlankWindow(
  saved: BrowserWindowSnapshot,
  report: RestoreReport,
  options: RestoreOptions,
): Promise<number | "unsupported" | undefined> {
  if (!options.createBlankWindow) return "unsupported";

  const before = await normalWindowIds();
  let outcome: NativeBlankWindowResult;
  try {
    outcome = await options.createBlankWindow();
  } catch (error) {
    report.warnings.push(
      `Could not create the independent browser window for ${saved.key}: ${error instanceof Error ? error.message : String(error)}. Existing tabs were left untouched.`,
    );
    return undefined;
  }
  if (outcome === "unsupported") return "unsupported";

  const blank = await waitForNewDisposableWindow(before);
  if (blank?.id === undefined) {
    report.warnings.push(
      `Zen reported a new blank window for ${saved.key}, but the extension could not observe a safe disposable window. Existing tabs were left untouched.`,
    );
    return undefined;
  }

  await populateWindow(blank.id, blank.tabs?.[0]?.id, saved, report);
  report.created_windows += 1;
  return blank.id;
}

async function createStandardFirefoxWindow(
  saved: BrowserWindowSnapshot,
  report: RestoreReport,
): Promise<number | undefined> {
  const created = await browser.windows.create({ url: "about:blank", focused: false, state: "normal" });
  if (created.id === undefined) throw new Error("Firefox created a window without an ID");

  await delay(NEW_WINDOW_SETTLE_MS);
  const settled = await browser.windows.get(created.id, { populate: true }).catch(() => created);
  if (!disposableBootstrapWindow(settled)) {
    report.warnings.push(
      `Firefox created ${saved.key} with unexpected user tabs; the new window was closed without modifying them.`,
    );
    await browser.windows.remove(created.id).catch(() => undefined);
    return undefined;
  }

  await populateWindow(created.id, settled.tabs?.[0]?.id, saved, report);
  report.created_windows += 1;
  return created.id;
}

async function createSavedWindow(
  saved: BrowserWindowSnapshot,
  report: RestoreReport,
  options: RestoreOptions,
): Promise<number | undefined> {
  // Ask the native host first for every missing window. This is deliberately
  // independent of browser.runtime.getBrowserInfo(): Zen builds can identify
  // themselves as Firefox there. The native host checks the real executable.
  const nativeResult = await tryCreateNativeBlankWindow(saved, report, options);
  if (nativeResult !== "unsupported") return nativeResult;
  return createStandardFirefoxWindow(saved, report);
}

export async function restoreFirefoxSnapshot(
  snapshot: FirefoxSnapshot,
  options: RestoreOptions = {},
): Promise<RestoreReport> {
  const report: RestoreReport = {
    created_windows: 0,
    created_tabs: 0,
    created_groups: 0,
    reused_windows: 0,
    reused_tabs: 0,
    warnings: [],
  };

  const currentWindows = (await browser.windows.getAll({ populate: true, windowTypes: ["normal"] }))
    .filter((window) => !window.incognito);
  const usedWindowIds = new Set<number>();

  let focusedWindowId: number | undefined;
  for (const savedWindow of snapshot.windows) {
    const satisfied = currentWindows.find((window) =>
      window.id !== undefined
      && !usedWindowIds.has(window.id)
      && windowAlreadyContainsSnapshot(savedWindow, window));

    let id: number | undefined;
    if (satisfied) {
      id = await reuseSatisfiedWindow(savedWindow, satisfied, report);
      usedWindowIds.add(id);
    } else {
      const bootstrap = currentWindows.find((window) =>
        window.id !== undefined
        && !usedWindowIds.has(window.id)
        && disposableBootstrapWindow(window));
      if (bootstrap) {
        id = await reuseBootstrapWindow(savedWindow, bootstrap, report);
        usedWindowIds.add(id);
      } else {
        id = await createSavedWindow(savedWindow, report, options);
      }
    }
    if (id !== undefined) {
      usedWindowIds.add(id);
      if (savedWindow.focused) focusedWindowId = id;
    }
  }

  if (focusedWindowId !== undefined) {
    await browser.windows.update(focusedWindowId, { focused: true }).catch(() => undefined);
  }
  return report;
}
