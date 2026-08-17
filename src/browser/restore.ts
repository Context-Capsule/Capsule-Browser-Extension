import {
  type BrowserTabSnapshot,
  type BrowserWindowSnapshot,
  type FirefoxSnapshot,
  type RestoreReport,
  restorableUrl,
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

  if (!tab.restorable) {
    warnings.push(`Cannot restore privileged/internal URL '${tab.url}'; opened about:blank instead.`);
  }

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

function comparableUrl(tab: browser.tabs.Tab): string {
  return tab.url ?? "about:blank";
}

function windowAlreadyContainsSnapshot(saved: BrowserWindowSnapshot, current: browser.windows.Window): boolean {
  const currentTabs = [...(current.tabs ?? [])].sort((a, b) => a.index - b.index);
  const savedTabs = [...saved.tabs].sort((a, b) => a.index - b.index);
  if (currentTabs.length !== savedTabs.length) return false;

  return savedTabs.every((savedTab, index) => {
    const tab = currentTabs[index];
    if (!tab) return false;
    return comparableUrl(tab) === savedTab.url
      && tab.pinned === savedTab.pinned
      && (tab.cookieStoreId ?? undefined) === (savedTab.cookie_store_id ?? undefined);
  });
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
  if (activeSaved) {
    const activeRestored = restoredByIndex.get(activeSaved.index);
    if (activeRestored?.id !== undefined) {
      await browser.tabs.update(activeRestored.id, { active: true }).catch(() => undefined);
    }
  }
}

async function reuseWindow(
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

async function restoreWindow(saved: BrowserWindowSnapshot, report: RestoreReport): Promise<number> {
  const created = await browser.windows.create({ url: "about:blank", focused: false, state: "normal" });
  if (created.id === undefined) throw new Error("Firefox created a window without an ID");
  const windowId = created.id;
  const bootstrapTabId = created.tabs?.[0]?.id;

  const restoredByIndex = new Map<number, browser.tabs.Tab>();
  for (const savedTab of [...saved.tabs].sort((a, b) => a.index - b.index)) {
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

  report.created_windows += 1;
  return windowId;
}

export async function restoreFirefoxSnapshot(snapshot: FirefoxSnapshot): Promise<RestoreReport> {
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
    const reusable = currentWindows.find((window) =>
      window.id !== undefined
      && !usedWindowIds.has(window.id)
      && windowAlreadyContainsSnapshot(savedWindow, window));

    let id: number;
    if (reusable) {
      id = await reuseWindow(savedWindow, reusable, report);
      usedWindowIds.add(id);
    } else {
      id = await restoreWindow(savedWindow, report);
    }
    if (savedWindow.focused) focusedWindowId = id;
  }

  if (focusedWindowId !== undefined) {
    await browser.windows.update(focusedWindowId, { focused: true }).catch(() => undefined);
  }
  return report;
}
