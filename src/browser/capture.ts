import { IS_FIREFOX } from "../platform";
import {
  BROWSER_SNAPSHOT_SCHEMA_VERSION,
  type BrowserSplitOrientation,
  type BrowserTabGroupSnapshot,
  type BrowserTabSnapshot,
  type BrowserWindowSnapshot,
  type BrowserWindowState,
  type FirefoxSnapshot,
  type TabGroupColor,
  currentBrowserAdapterId,
  isRestorableUrl,
  splitGroupTitle,
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

type ExtendedTab = browser.tabs.Tab & {
  groupId?: number;
  splitViewId?: number;
  width?: number;
  height?: number;
};

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

export function inferSplitOrientation(
  source: Pick<browser.windows.Window, "width" | "height">,
  members: Array<Pick<ExtendedTab, "width" | "height">>,
): BrowserSplitOrientation {
  if (members.length !== 2) return "grid";
  const windowWidth = source.width ?? 0;
  const windowHeight = source.height ?? 0;
  const widths = members.map(tab => tab.width ?? 0);
  const heights = members.map(tab => tab.height ?? 0);
  if (windowWidth <= 0 || windowHeight <= 0 || widths.some(value => value <= 0) || heights.some(value => value <= 0)) {
    return "vertical";
  }

  const widthPackingError = Math.abs(widths.reduce((sum, value) => sum + value, 0) / windowWidth - 1);
  const heightPackingError = Math.abs(heights.reduce((sum, value) => sum + value, 0) / windowHeight - 1);
  return widthPackingError <= heightPackingError ? "vertical" : "horizontal";
}

export function isCapturedSplitGroup(
  group: { title: string },
  members: ExtendedTab[],
): boolean {
  // Chrome has legitimate unnamed tab groups. The anonymous-group fallback is
  // a Zen implementation detail and must never reinterpret Chrome groups as
  // split views.
  if (!IS_FIREFOX) return false;
  if (members.length < 2 || members.length > 4) return false;
  const explicitIds = members
    .map(tab => tab.splitViewId)
    .filter((id): id is number => typeof id === "number" && id >= 0);
  if (explicitIds.length === members.length && explicitIds.every(id => id === explicitIds[0])) return true;

  // Zen currently implements split views as an empty-label tab group created
  // with its private `forSplitView` flag. That flag is not surfaced through the
  // WebExtension tabGroups API, so an anonymous 2-4 tab group is the portable
  // fallback signal when splitViewId is not exposed by the Firefox base.
  return group.title.trim().length === 0;
}

async function captureWindow(
  source: browser.windows.Window,
  windowIndex: number,
): Promise<BrowserWindowSnapshot | undefined> {
  if (source.id === undefined || source.incognito) return undefined;

  const tabs = [...(source.tabs ?? [])].sort((left, right) => left.index - right.index) as ExtendedTab[];
  const groupsApi = tabGroupsApi();
  const groups = groupsApi ? await groupsApi.query({ windowId: source.id }).catch(() => []) : [];
  const groupKeyById = new Map<number, string>();
  const capturedGroups: BrowserTabGroupSnapshot[] = groups.map((group, groupIndex) => {
    const key = `group-${groupIndex}`;
    groupKeyById.set(group.id, key);
    const members = tabs.filter(tab => tab.groupId === group.id);
    const split = isCapturedSplitGroup(group, members);
    return {
      key,
      title: split ? splitGroupTitle(inferSplitOrientation(source, members)) : group.title,
      color: group.color as TabGroupColor,
      collapsed: group.collapsed,
    };
  });

  const capturedTabs: BrowserTabSnapshot[] = tabs.map((tab) => {
    const url = tab.url ?? "about:blank";
    const groupKey = tab.groupId === undefined || tab.groupId < 0 ? undefined : groupKeyById.get(tab.groupId);
    const cookieStoreId = IS_FIREFOX ? tab.cookieStoreId : undefined;
    const snapshot: BrowserTabSnapshot = {
      index: tab.index,
      url,
      pinned: tab.pinned,
      active: tab.active,
      discarded: tab.discarded ?? false,
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

async function extensionInstallType(): Promise<string | undefined> {
  try {
    const extension = await browser.management.getSelf();
    return extension.installType || undefined;
  } catch {
    return undefined;
  }
}

export async function captureBrowserSnapshot(): Promise<FirefoxSnapshot> {
  const extension = browser.runtime.getManifest();
  const [windows, installType] = await Promise.all([
    browser.windows.getAll({ populate: true, windowTypes: ["normal"] }),
    extensionInstallType(),
  ]);
  const privateCount = windows.filter((window) => window.incognito).length;
  const captured = await Promise.all(windows.map((window, index) => captureWindow(window, index)));
  const snapshot: FirefoxSnapshot = {
    schema_version: BROWSER_SNAPSHOT_SCHEMA_VERSION,
    browser: currentBrowserAdapterId(),
    extension_version: extension.version,
    captured_at_unix_ms: Date.now(),
    skipped_private_windows: privateCount,
    windows: captured.filter((window): window is BrowserWindowSnapshot => window !== undefined),
  };
  if (installType) snapshot.install_type = installType;
  return snapshot;
}

/** Backward-compatible export used by the existing Firefox-focused tests. */
export async function captureFirefoxSnapshot(): Promise<FirefoxSnapshot> {
  return captureBrowserSnapshot();
}
