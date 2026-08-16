import {
  BROWSER_SNAPSHOT_SCHEMA_VERSION,
  FIREFOX_BROWSER_ID,
  type BrowserTabGroupSnapshot,
  type BrowserTabSnapshot,
  type BrowserWindowSnapshot,
  type BrowserWindowState,
  type FirefoxSnapshot,
  type TabGroupColor,
  isRestorableUrl,
} from "./model";

interface TabGroupsApi {
  query(queryInfo: { windowId?: number }): Promise<Array<{
    id: number;
    title: string;
    color: string;
    collapsed: boolean;
    windowId: number;
  }>>;
}

function tabGroupsApi(): TabGroupsApi | undefined {
  return (browser as unknown as { tabGroups?: TabGroupsApi }).tabGroups;
}

function windowState(state: browser.windows.WindowState | undefined): BrowserWindowState {
  return state === "minimized" || state === "maximized" || state === "fullscreen"
    ? state
    : "normal";
}

function optionalNumber(value: number | undefined): number | undefined {
  return Number.isFinite(value) ? value : undefined;
}

async function captureWindow(
  source: browser.windows.Window,
  windowIndex: number,
): Promise<BrowserWindowSnapshot | undefined> {
  if (source.id === undefined || source.incognito) {
    return undefined;
  }

  const groupsApi = tabGroupsApi();
  const groups = groupsApi ? await groupsApi.query({ windowId: source.id }).catch(() => []) : [];
  const groupKeyById = new Map<number, string>();
  const capturedGroups: BrowserTabGroupSnapshot[] = groups.map((group, groupIndex) => {
    const key = `group-${groupIndex}`;
    groupKeyById.set(group.id, key);
    return {
      key,
      title: group.title,
      color: group.color as TabGroupColor,
      collapsed: group.collapsed,
    };
  });

  const tabs = [...(source.tabs ?? [])].sort((left, right) => left.index - right.index);
  const capturedTabs: BrowserTabSnapshot[] = tabs.map((tab) => {
    const url = tab.url ?? "about:blank";
    const groupId = (tab as browser.tabs.Tab & { groupId?: number }).groupId;
    const groupKey = groupId === undefined || groupId < 0 ? undefined : groupKeyById.get(groupId);
    const cookieStoreId = tab.cookieStoreId;
    const snapshot: BrowserTabSnapshot = {
      index: tab.index,
      url,
      pinned: tab.pinned,
      active: tab.active,
      discarded: tab.discarded,
      muted: tab.mutedInfo?.muted ?? false,
      restorable: isRestorableUrl(url),
    };
    if (tab.title) snapshot.title = tab.title;
    if (cookieStoreId) snapshot.cookie_store_id = cookieStoreId;
    if (groupKey) snapshot.group_key = groupKey;
    return snapshot;
  });

  const result: BrowserWindowSnapshot = {
    key: `window-${windowIndex}`,
    focused: source.focused,
    state: windowState(source.state),
    tabs: capturedTabs,
    groups: capturedGroups,
  };
  const left = optionalNumber(source.left);
  const top = optionalNumber(source.top);
  const width = optionalNumber(source.width);
  const height = optionalNumber(source.height);
  if (left !== undefined) result.left = left;
  if (top !== undefined) result.top = top;
  if (width !== undefined) result.width = width;
  if (height !== undefined) result.height = height;
  return result;
}

export async function captureFirefoxSnapshot(): Promise<FirefoxSnapshot> {
  const extension = browser.runtime.getManifest();
  const windows = await browser.windows.getAll({ populate: true, windowTypes: ["normal"] });
  const privateCount = windows.filter((window) => window.incognito).length;

  const captured = await Promise.all(windows.map((window, index) => captureWindow(window, index)));

  return {
    schema_version: BROWSER_SNAPSHOT_SCHEMA_VERSION,
    browser: FIREFOX_BROWSER_ID,
    extension_version: extension.version,
    captured_at_unix_ms: Date.now(),
    skipped_private_windows: privateCount,
    windows: captured.filter((window): window is BrowserWindowSnapshot => window !== undefined),
  };
}
