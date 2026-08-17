export const BROWSER_SNAPSHOT_SCHEMA_VERSION = 1 as const;
export const FIREFOX_BROWSER_ID = "firefox" as const;

export type BrowserWindowState = "normal" | "minimized" | "maximized" | "fullscreen";
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
  return isRestorableUrl(url) ? url : "about:blank";
}
