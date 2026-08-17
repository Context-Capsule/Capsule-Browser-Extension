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

export interface RestoreOptions {
  /**
   * Optional native fallback used by Firefox-derived browsers whose normal
   * WebExtension window creation synchronizes an existing workspace instead of
   * creating a disposable blank window. The callback must only request a new
   * blank browser window; tab population remains inside this module.
   */
  createBlankWindow?: () => Promise<void>;
}

const NEW_WINDOW_SETTLE_MS = 300;
const NATIVE_BLANK_WINDOW_TIMEOUT_MS = 5_000;
const NATIVE_BLANK_WINDOW_POLL_MS = 100;

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

async function restoreGeometry(windowId: number, saved: BrowserWindowSnapshot): Promise<void> {
  if (saved.state === "normal") {
    const geometry: Parameters<typeof browser.windows.update>[1] = { state: "normal" };
    if (saved.left !== undefined) geometry.left = saved.left;
    if (saved.top !== undefined) geometry.top = saved.top;
    if (saved.width !== undefined) geometry.width = saved.width;
    if (saved.height !== undefined) geometry.height = saved.height;
    await browser.windows.update(windowId, geometry);
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
    if (saved.groups.length > 0) {
      report.warnings.push("This Firefox version does not expose the tabGroups API; tabs were restored ungrouped.");
    }
    return;
  }

  for (const group of saved.groups) {
    if (!isPortableTabGroup(group)) {
      report.warnings.push(
        `Skipped anonymous tab relationship '${group.key}'; Firefox-derived browsers can expose split/vendor relationships as an anonymous group, so restoring it as a normal group would be unsafe.`,
      );
      continue;
    }

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
    if (!savedTab.restorable) {
      report.warnings.push(
        `Skipped privileged/internal tab '${savedTab.title ?? savedTab.url}' because its URL cannot be safely recreated by a WebExtension.`,
      );
      continue;
    }

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

async function createNativeBlankWindow(
  saved: BrowserWindowSnapshot,
  report: RestoreReport,
  options: RestoreOptions,
): Promise<number | undefined> {
  if (!options.createBlankWindow) {
    report.warnings.push(
      `Skipped creating ${saved.key}: the browser synchronized real tabs into the provisional window and no native blank-window fallback is available. Existing tabs were left untouched.`,
    );
    return undefined;
  }

  const before = await normalWindowIds();
  try {
    await options.createBlankWindow();
  } catch (error) {
    report.warnings.push(
      `Skipped creating ${saved.key}: native blank-window fallback failed: ${error instanceof Error ? error.message : String(error)}. Existing tabs were left untouched.`,
    );
    return undefined;
  }

  const blank = await waitForNewDisposableWindow(before);
  if (blank?.id === undefined) {
    report.warnings.push(
      `Skipped creating ${saved.key}: native blank-window fallback did not produce a safe disposable browser window. Existing tabs were left untouched.`,
    );
    return undefined;
  }

  await populateWindow(blank.id, blank.tabs?.[0]?.id, saved, report);
  report.created_windows += 1;
  report.warnings.push(
    `Restored ${saved.key} through the native blank-window fallback because normal window creation synchronized existing browser state.`,
  );
  return blank.id;
}

async function createSavedWindow(
  saved: BrowserWindowSnapshot,
  report: RestoreReport,
  options: RestoreOptions,
): Promise<number | undefined> {
  const created = await browser.windows.create({ url: "about:blank", focused: false, state: "normal" });
  if (created.id === undefined) throw new Error("Firefox created a window without an ID");

  // Standard Firefox creates one blank bootstrap tab. Zen and other Firefox-derived
  // browsers can synchronize a Space into the new window instead. Never assume the
  // first returned tab is disposable: that can delete Essentials or mutate an
  // existing synchronized context.
  await delay(NEW_WINDOW_SETTLE_MS);
  const settled = await browser.windows.get(created.id, { populate: true }).catch(() => created);
  if (!disposableBootstrapWindow(settled)) {
    await browser.windows.remove(created.id).catch(() => undefined);
    return createNativeBlankWindow(saved, report, options);
  }

  await populateWindow(created.id, settled.tabs?.[0]?.id, saved, report);
  report.created_windows += 1;
  return created.id;
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
    if (id !== undefined && savedWindow.focused) focusedWindowId = id;
  }

  if (focusedWindowId !== undefined) {
    await browser.windows.update(focusedWindowId, { focused: true }).catch(() => undefined);
  }
  return report;
}
