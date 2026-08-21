export const BROWSER_SNAPSHOT_SCHEMA_VERSION = 1 as const;
export const FIREFOX_BROWSER_ID = "firefox" as const;

export type BrowserWindowState = "normal" | "minimized" | "maximized" | "fullscreen";
export type BrowserSplitOrientation = "vertical" | "horizontal" | "grid";
export type TabGroupColor =
  | "blue"
  | "cyan"
  | "grey"
  | "green"
  | "orange"
  | "pink"
  | "purple"
  | "red"
  | "yellow";

const SPLIT_GROUP_TITLE_PREFIX = "__context_capsule_split_v1__:";

export interface BrowserTabSnapshot {
  index: number;
  url: string;
  title?: string;
  pinned: boolean;
  active: boolean;
  discarded: boolean;
  muted: boolean;
  cookie_store_id?: string;
  group_key?: string;
  restorable: boolean;
}

export interface BrowserTabGroupSnapshot {
  key: string;
  title: string;
  color: TabGroupColor;
  collapsed: boolean;
}

export interface BrowserWindowSnapshot {
  key: string;
  focused: boolean;
  state: BrowserWindowState;
  left?: number;
  top?: number;
  width?: number;
  height?: number;
  tabs: BrowserTabSnapshot[];
  groups: BrowserTabGroupSnapshot[];
}

export interface FirefoxSnapshot {
  schema_version: typeof BROWSER_SNAPSHOT_SCHEMA_VERSION;
  browser: typeof FIREFOX_BROWSER_ID;
  extension_version: string;
  /** Firefox reports "development" for an unpacked temporary development add-on. */
  install_type?: string;
  captured_at_unix_ms: number;
  skipped_private_windows: number;
  windows: BrowserWindowSnapshot[];
}

export interface RestoreReport {
  created_windows: number;
  created_tabs: number;
  created_groups: number;
  reused_windows: number;
  reused_tabs: number;
  warnings: string[];
}

export interface ComparableLiveTab {
  index: number;
  url?: string;
  pinned: boolean;
  cookieStoreId?: string;
}

export interface SavedWindowSimilarity {
  score: number;
  exact: boolean;
  overlap: number;
  savedRelevant: number;
  liveRelevant: number;
}

export function splitGroupTitle(orientation: BrowserSplitOrientation): string {
  return `${SPLIT_GROUP_TITLE_PREFIX}${orientation}`;
}

export function splitOrientationFromGroup(
  group: Pick<BrowserTabGroupSnapshot, "title">,
): BrowserSplitOrientation | undefined {
  if (!group.title.startsWith(SPLIT_GROUP_TITLE_PREFIX)) return undefined;
  const orientation = group.title.slice(SPLIT_GROUP_TITLE_PREFIX.length);
  return orientation === "vertical" || orientation === "horizontal" || orientation === "grid"
    ? orientation
    : undefined;
}

export function isSplitViewGroup(group: Pick<BrowserTabGroupSnapshot, "title">): boolean {
  return splitOrientationFromGroup(group) !== undefined;
}

export function savedTabsMatchLiveTabs(saved: BrowserWindowSnapshot, live: ComparableLiveTab[]): boolean {
  const currentTabs = [...live].sort((a, b) => a.index - b.index);
  const savedTabs = [...saved.tabs].sort((a, b) => a.index - b.index);
  if (currentTabs.length !== savedTabs.length) return false;

  return savedTabs.every((savedTab, index) => {
    const tab = currentTabs[index];
    if (!tab) return false;
    return (tab.url ?? "about:blank") === savedTab.url
      && tab.pinned === savedTab.pinned
      && (tab.cookieStoreId ?? undefined) === (savedTab.cookie_store_id ?? undefined);
  });
}

/**
 * A native Zen "New blank window" can surface either with no tabs yet or with
 * one ordinary blank/new-tab bootstrap. Both shapes are safe to populate.
 * Anything containing real user state (including multiple tabs) is not.
 */
export function isDisposableBootstrapTabs(live: ComparableLiveTab[]): boolean {
  if (live.length === 0) return true;
  if (live.length !== 1) return false;
  const tab = live[0];
  if (!tab || tab.pinned) return false;
  const url = tab.url ?? "about:blank";
  return url === "about:blank" || url === "about:newtab" || url === "about:home";
}

/**
 * Named groups are portable through the standard Firefox tabGroups API. Split
 * relationships deliberately use a private snapshot marker and are restored by
 * Zen's own split command instead of being synthesized as an ordinary group.
 */
export function isPortableTabGroup(group: BrowserTabGroupSnapshot): boolean {
  return group.title.trim().length > 0 && !isSplitViewGroup(group);
}

export function tabCount(snapshot: FirefoxSnapshot): number {
  return snapshot.windows.reduce((total, window) => total + window.tabs.length, 0);
}

export function isRestorableUrl(url: string): boolean {
  if (url === "about:blank" || url === "about:newtab") {
    return true;
  }

  try {
    const parsed = new URL(url);
    return ["http:", "https:", "ftp:"].includes(parsed.protocol);
  } catch {
    return false;
  }
}

export function restorableUrl(url: string): string | undefined {
  if (url === "about:newtab") {
    return undefined;
  }
  return isRestorableUrl(url) ? url : undefined;
}

function savedTabIdentity(tab: BrowserTabSnapshot): string | undefined {
  if (!tab.restorable || !isRestorableUrl(tab.url)) return undefined;
  return `${tab.pinned ? "p" : "u"}\u0000${tab.cookie_store_id ?? ""}\u0000${tab.url}`;
}

function liveTabIdentity(tab: ComparableLiveTab): string | undefined {
  if (!tab.url || !isRestorableUrl(tab.url)) return undefined;
  return `${tab.pinned ? "p" : "u"}\u0000${tab.cookieStoreId ?? ""}\u0000${tab.url}`;
}

function multisetOverlap(left: string[], right: string[]): number {
  const counts = new Map<string, number>();
  for (const value of right) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }

  let overlap = 0;
  for (const value of left) {
    const remaining = counts.get(value) ?? 0;
    if (remaining <= 0) continue;
    overlap += 1;
    if (remaining === 1) counts.delete(value);
    else counts.set(value, remaining - 1);
  }
  return overlap;
}

/**
 * Score whether a live window is already the saved window even when the live
 * topology is not byte-for-byte identical. Restore must be conservative here:
 * a false negative creates a duplicate Zen window, while a false positive only
 * means Context Capsule leaves a changed live window alone.
 *
 * Privileged/non-restorable tabs are deliberately excluded from fuzzy identity.
 * They cannot be recreated and Firefox-derived browsers may expose them
 * differently between capture and restore. Single-tab windows remain strict so
 * a saved ChatGPT-only window can never match a large window that merely happens
 * to contain the same ChatGPT tab. Pinned tabs can be shared Zen Essentials, so
 * fuzzy matching also requires independent evidence from unpinned tabs.
 */
export function savedWindowSimilarity(
  saved: BrowserWindowSnapshot,
  live: ComparableLiveTab[],
): SavedWindowSimilarity {
  const exact = savedTabsMatchLiveTabs(saved, live);
  if (exact) {
    return {
      score: 100_000 + saved.tabs.length,
      exact: true,
      overlap: saved.tabs.length,
      savedRelevant: saved.tabs.length,
      liveRelevant: live.length,
    };
  }

  const savedRelevantTabs = saved.tabs.filter(tab => savedTabIdentity(tab) !== undefined);
  const liveRelevantTabs = live.filter(tab => liveTabIdentity(tab) !== undefined);
  const savedIds = savedRelevantTabs.map(tab => savedTabIdentity(tab)!).filter(Boolean);
  const liveIds = liveRelevantTabs.map(tab => liveTabIdentity(tab)!).filter(Boolean);
  const overlap = multisetOverlap(savedIds, liveIds);

  const empty: SavedWindowSimilarity = {
    score: 0,
    exact: false,
    overlap,
    savedRelevant: savedIds.length,
    liveRelevant: liveIds.length,
  };
  if (savedIds.length === 0 || liveIds.length === 0 || overlap === 0) return empty;

  if (savedIds.length === 1) {
    return overlap === 1 && liveIds.length === 1
      ? { ...empty, score: 5_000 }
      : empty;
  }

  const savedUnpinnedIds = savedRelevantTabs
    .filter(tab => !tab.pinned)
    .map(tab => savedTabIdentity(tab)!);
  const liveUnpinnedIds = liveRelevantTabs
    .filter(tab => !tab.pinned)
    .map(tab => liveTabIdentity(tab)!);
  if (savedUnpinnedIds.length === 0) return empty;

  const unpinnedOverlap = multisetOverlap(savedUnpinnedIds, liveUnpinnedIds);
  const requiredUnpinnedOverlap = Math.min(2, savedUnpinnedIds.length);
  const savedCoverage = overlap / savedIds.length;
  const liveCoverage = overlap / liveIds.length;
  const unpinnedCoverage = unpinnedOverlap / savedUnpinnedIds.length;

  if (
    overlap < 2
    || unpinnedOverlap < requiredUnpinnedOverlap
    || savedCoverage < 0.6
    || liveCoverage < 0.45
    || unpinnedCoverage < 0.6
  ) {
    return empty;
  }

  const countDelta = Math.abs(savedIds.length - liveIds.length);
  return {
    ...empty,
    score: 1_000
      + overlap * 100
      + unpinnedOverlap * 50
      + Math.round(savedCoverage * 100)
      + Math.round(liveCoverage * 100)
      - countDelta * 5,
  };
}
