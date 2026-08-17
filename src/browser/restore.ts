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
  query(queryInfo: { windowId?: number }): Promise<Array<{
    id: number;
    title: string;
    color: string;
    collapsed: boolean;
    windowId: number;
  }>>;
  update(
    groupId: number,
    properties: { title?: string; color?: string; collapsed?: boolean },
  ): Promise<unknown>;
}

interface CurrentWindow {
  window: browser.windows.Window;
  tabs: browser.tabs.Tab[];
}

const GEOMETRY_TOLERANCE_PX = 12;

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

function currentTabGroupId(tab: browser.tabs.Tab): number | undefined {
  return (tab as browser.tabs.Tab & { groupId?: number }).groupId;
}

function currentUrl(tab: browser.tabs.Tab): string {
  return tab.url ?? "about:blank";
}

export function tabMatchesSnapshot(saved: BrowserTabSnapshot, current: Pick<browser.tabs.Tab, "url" | "cookieStoreId">): boolean {
  const currentValue = current.url ?? "about:blank";
  const savedStore = saved.cookie_store_id ?? "firefox-default";
  const currentStore = current.cookieStoreId ?? "firefox-default";
  if (savedStore !== currentStore) return false;
  if (saved.restorable) return saved.url === currentValue;
  return saved.url === currentValue || currentValue === "about:blank";
}

function isDisposableBlankWindow(current: CurrentWindow): boolean {
  if (current.tabs.length !== 1) return false;
  const tab = current.tabs[0];
  if (!tab || tab.pinned) return false;
  return ["about:blank", "about:newtab", "about:home"].includes(currentUrl(tab));
}

function tabOverlapScore(saved: BrowserWindowSnapshot, current: CurrentWindow): number {
  const remaining = [...current.tabs];
  let matched = 0;
  for (const savedTab of saved.tabs) {
    const index = remaining.findIndex((tab) => tabMatchesSnapshot(savedTab, tab));
    if (index >= 0) {
      matched += 1;
      remaining.splice(index, 1);
    }
  }
  return matched;
}

function geometryDistance(saved: BrowserWindowSnapshot, current: browser.windows.Window): number {
  const pairs: Array<[number | undefined, number | undefined]> = [
    [saved.left, current.left],
    [saved.top, current.top],
    [saved.width, current.width],
    [saved.height, current.height],
  ];
  return pairs.reduce((total, [left, right]) => {
    if (left === undefined || right === undefined) return total;
    return total + Math.min(2000, Math.abs(left - right));
  }, 0);
}

export function windowReuseScore(
  saved: BrowserWindowSnapshot,
  current: { tabs: Array<Pick<browser.tabs.Tab, "url" | "cookieStoreId" | "pinned">>; left?: number; top?: number; width?: number; height?: number },
): number {
  const remaining = [...current.tabs];
  let overlap = 0;
  for (const savedTab of saved.tabs) {
    const index = remaining.findIndex((tab) => tabMatchesSnapshot(savedTab, tab));
    if (index >= 0) {
      overlap += 1;
      remaining.splice(index, 1);
    }
  }
  if (overlap > 0) return overlap * 100_000;
  const first = current.tabs[0];
  const disposable = current.tabs.length === 1
    && first !== undefined
    && !first.pinned
    && ["about:blank", "about:newtab", "about:home"].includes(first.url ?? "about:blank");
  if (!disposable) return 0;

  const pairs: Array<[number | undefined, number | undefined]> = [
    [saved.left, current.left],
    [saved.top, current.top],
    [saved.width, current.width],
    [saved.height, current.height],
  ];
  const distance = pairs.reduce((total, [left, right]) => {
    if (left === undefined || right === undefined) return total;
    return total + Math.min(2000, Math.abs(left - right));
  }, 0);
  return 10_000 - Math.min(9_999, distance);
}

async function createTab(windowId: number, tab: BrowserTabSnapshot, warnings: string[]): Promise<browser.tabs.Tab> {
  const properties: Parameters<typeof browser.tabs.create>[0] = { windowId, active: false, pinned: tab.pinned };
  const url = restorableUrl(tab.url);
  if (url !== undefined) properties.url = url;
  if (tab.cookie_store_id) properties.cookieStoreId = tab.cookie_store_id;

  if (!tab.restorable) warnings.push(`Cannot reopen privileged/internal URL '${tab.url}'; using an existing or new about:blank tab.`);

  try {
    return await browser.tabs.create(properties);
  } catch (error) {
    if (tab.cookie_store_id) {
      delete properties.cookieStoreId;
      warnings.push(`Container '${tab.cookie_store_id}' was unavailable for '${tab.title ?? tab.url}'; restored in the default container.`);
      return browser.tabs.create(properties);
    }
    throw error;
  }
}

function closeEnough(left: number | undefined, right: number | undefined): boolean {
  if (left === undefined) return true;
  if (right === undefined) return false;
  return Math.abs(left - right) <= GEOMETRY_TOLERANCE_PX;
}

function geometrySatisfied(current: browser.windows.Window, saved: BrowserWindowSnapshot): boolean {
  const currentState = current.state ?? "normal";
  if (saved.state !== "normal") return currentState === saved.state;
  return currentState === "normal"
    && closeEnough(saved.left, current.left)
    && closeEnough(saved.top, current.top)
    && closeEnough(saved.width, current.width)
    && closeEnough(saved.height, current.height);
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

async function chooseCurrentWindows(): Promise<CurrentWindow[]> {
  const windows = await browser.windows.getAll({ populate: true, windowTypes: ["normal"] });
  return windows
    .filter((window) => window.id !== undefined && !window.incognito)
    .map((window) => ({ window, tabs: [...(window.tabs ?? [])].sort((left, right) => left.index - right.index) }));
}

function chooseReusableWindow(saved: BrowserWindowSnapshot, candidates: CurrentWindow[]): number | undefined {
  let bestIndex: number | undefined;
  let bestScore = 0;
  for (const [index, candidate] of candidates.entries()) {
    const overlap = tabOverlapScore(saved, candidate);
    let score = overlap * 100_000;
    if (overlap === 0 && isDisposableBlankWindow(candidate)) score = 10_000 - Math.min(9_999, geometryDistance(saved, candidate.window));
    if (score > bestScore) {
      bestScore = score;
      bestIndex = index;
    }
  }
  return bestIndex;
}

async function reconcileTabProperties(tab: browser.tabs.Tab, saved: BrowserTabSnapshot, report: RestoreReport): Promise<browser.tabs.Tab> {
  if (tab.id === undefined) return tab;
  const changes: Parameters<typeof browser.tabs.update>[1] = {};
  if (tab.pinned !== saved.pinned) changes.pinned = saved.pinned;
  if ((tab.mutedInfo?.muted ?? false) !== saved.muted) changes.muted = saved.muted;
  if (Object.keys(changes).length > 0) {
    const updated = await browser.tabs.update(tab.id, changes);
    report.updated_tabs += 1;
    return updated;
  }
  return tab;
}

async function reconcileTabs(windowId: number, saved: BrowserWindowSnapshot, initialTabs: browser.tabs.Tab[], report: RestoreReport): Promise<Map<number, browser.tabs.Tab>> {
  const remaining = [...initialTabs];
  const restoredByIndex = new Map<number, browser.tabs.Tab>();
  const usedIds = new Set<number>();

  for (const savedTab of [...saved.tabs].sort((a, b) => a.index - b.index)) {
    let tab: browser.tabs.Tab | undefined;
    const exactIndex = remaining.findIndex((candidate) => tabMatchesSnapshot(savedTab, candidate));
    if (exactIndex >= 0) {
      tab = remaining.splice(exactIndex, 1)[0];
      if (!tab) continue;
      report.reused_tabs += 1;
    } else {
      try {
        tab = await createTab(windowId, savedTab, report.warnings);
        report.created_tabs += 1;
      } catch (error) {
        report.warnings.push(`Failed to restore '${savedTab.title ?? savedTab.url}': ${error instanceof Error ? error.message : String(error)}`);
        continue;
      }
    }

    tab = await reconcileTabProperties(tab, savedTab, report).catch((error) => {
      report.warnings.push(`Could not reconcile '${savedTab.title ?? savedTab.url}': ${error instanceof Error ? error.message : String(error)}`);
      return tab as browser.tabs.Tab;
    });

    if (tab.id !== undefined) {
      usedIds.add(tab.id);
      await browser.tabs.move(tab.id, { index: savedTab.index }).catch((error) => {
        report.warnings.push(`Could not restore tab order for '${savedTab.title ?? savedTab.url}': ${error instanceof Error ? error.message : String(error)}`);
      });
      if (savedTab.discarded && !savedTab.active) await browser.tabs.discard(tab.id).catch(() => undefined);
    }
    restoredByIndex.set(savedTab.index, tab);
  }

  if (initialTabs.length === 1 && isDisposableBlankWindow({ window: { id: windowId } as browser.windows.Window, tabs: initialTabs })) {
    const bootstrap = initialTabs[0];
    if (bootstrap?.id !== undefined && !usedIds.has(bootstrap.id) && restoredByIndex.size > 0) await browser.tabs.remove(bootstrap.id).catch(() => undefined);
  }
  return restoredByIndex;
}

async function reconcileGroups(windowId: number, saved: BrowserWindowSnapshot, restoredByIndex: Map<number, browser.tabs.Tab>, report: RestoreReport): Promise<void> {
  const { tabs: tabsGrouping, groups: groupsApi } = groupingApis();
  if (!tabsGrouping || !groupsApi) {
    if (saved.groups.length > 0) report.warnings.push("This Firefox version does not expose the tabGroups API; tabs were restored ungrouped.");
    return;
  }

  const existingGroups = await groupsApi.query({ windowId }).catch(() => []);
  for (const group of saved.groups) {
    const tabs = saved.tabs
      .filter((tab) => tab.group_key === group.key && !tab.pinned)
      .sort((a, b) => a.index - b.index)
      .map((tab) => restoredByIndex.get(tab.index))
      .filter((tab): tab is browser.tabs.Tab => tab !== undefined && tab.id !== undefined);
    if (tabs.length === 0) continue;

    const refreshed = await Promise.all(tabs.map((tab) => browser.tabs.get(tab.id!).catch(() => tab)));
    const groupIds = new Set(refreshed.map(currentTabGroupId).filter((id): id is number => id !== undefined && id >= 0));
    try {
      let groupId: number;
      const onlyGroupId = [...groupIds][0];
      if (groupIds.size === 1 && onlyGroupId !== undefined && refreshed.every((tab) => currentTabGroupId(tab) === onlyGroupId)) {
        groupId = onlyGroupId;
        report.reused_groups += 1;
      } else {
        groupId = await tabsGrouping.group({
          tabIds: refreshed.map((tab) => tab.id!).filter((id): id is number => id !== undefined),
          createProperties: { windowId },
        });
        report.created_groups += 1;
      }
      const currentGroup = existingGroups.find((candidate) => candidate.id === groupId);
      if (!currentGroup || currentGroup.title !== group.title || currentGroup.color !== group.color || currentGroup.collapsed !== group.collapsed) {
        await groupsApi.update(groupId, { title: group.title, color: group.color, collapsed: group.collapsed });
      }
    } catch (error) {
      report.warnings.push(`Failed to restore tab group '${group.title || group.key}': ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

async function reconcileWindow(saved: BrowserWindowSnapshot, current: CurrentWindow | undefined, report: RestoreReport): Promise<number> {
  let window: browser.windows.Window;
  let initialTabs: browser.tabs.Tab[];
  if (current?.window.id !== undefined) {
    window = current.window;
    initialTabs = current.tabs;
    report.reused_windows += 1;
  } else {
    window = await browser.windows.create({ url: "about:blank", focused: false, state: "normal" });
    if (window.id === undefined) throw new Error("Firefox created a window without an ID");
    initialTabs = [...(window.tabs ?? [])];
    report.created_windows += 1;
  }

  const windowId = window.id!;
  const restoredByIndex = await reconcileTabs(windowId, saved, initialTabs, report);
  await reconcileGroups(windowId, saved, restoredByIndex, report);
  const activeSaved = saved.tabs.find((tab) => tab.active);
  if (activeSaved) {
    const activeRestored = restoredByIndex.get(activeSaved.index);
    if (activeRestored?.id !== undefined) await browser.tabs.update(activeRestored.id, { active: true }).catch(() => undefined);
  }
  if (!geometrySatisfied(window, saved)) {
    await restoreGeometry(windowId, saved).then(() => { report.geometry_updates += 1; }).catch((error) => {
      report.warnings.push(`Could not restore geometry for ${saved.key}: ${error instanceof Error ? error.message : String(error)}`);
    });
  }
  return windowId;
}

export async function restoreFirefoxSnapshot(snapshot: FirefoxSnapshot): Promise<RestoreReport> {
  const report: RestoreReport = {
    created_windows: 0,
    reused_windows: 0,
    created_tabs: 0,
    reused_tabs: 0,
    updated_tabs: 0,
    created_groups: 0,
    reused_groups: 0,
    geometry_updates: 0,
    warnings: [],
  };
  const candidates = await chooseCurrentWindows();
  let focusedWindowId: number | undefined;
  for (const savedWindow of snapshot.windows) {
    const reusableIndex = chooseReusableWindow(savedWindow, candidates);
    const current = reusableIndex === undefined ? undefined : candidates.splice(reusableIndex, 1)[0];
    const id = await reconcileWindow(savedWindow, current, report);
    if (savedWindow.focused) focusedWindowId = id;
  }
  if (focusedWindowId !== undefined) await browser.windows.update(focusedWindowId, { focused: true }).catch(() => undefined);
  return report;
}
