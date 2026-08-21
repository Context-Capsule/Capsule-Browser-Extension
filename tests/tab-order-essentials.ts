import { restoreFirefoxSnapshot } from "../src/browser/restore";
import type { FirefoxSnapshot } from "../src/browser/model";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

interface MockTab {
  id: number;
  index: number;
  url: string;
  pinned: boolean;
  active: boolean;
  discarded: boolean;
  mutedInfo: { muted: boolean };
  cookieStoreId?: string;
}

interface MockWindow {
  id: number;
  focused: boolean;
  incognito: boolean;
  state: "normal" | "minimized" | "maximized" | "fullscreen";
  left?: number;
  top?: number;
  width?: number;
  height?: number;
  tabs: MockTab[];
}

const windows: MockWindow[] = [];
let nextTabId = 10_000;
const removedIds: number[] = [];
const movedIds: number[] = [];
const pinnedUpdates: Array<{ id: number; pinned: boolean }> = [];

function reindex(window: MockWindow): void {
  window.tabs.forEach((tab, index) => { tab.index = index; });
}

function findWindow(id: number): MockWindow {
  const window = windows.find((candidate) => candidate.id === id);
  if (!window) throw new Error(`window ${id} not found`);
  return window;
}

function findTab(id: number): { window: MockWindow; tab: MockTab } {
  for (const window of windows) {
    const tab = window.tabs.find((candidate) => candidate.id === id);
    if (tab) return { window, tab };
  }
  throw new Error(`tab ${id} not found`);
}

function liveTab(id: number, index: number, url: string, pinned = false): MockTab {
  return {
    id,
    index,
    url,
    pinned,
    active: false,
    discarded: false,
    mutedInfo: { muted: false },
  };
}

(globalThis as any).browser = {
  windows: {
    getAll: async () => windows,
    get: async (id: number) => findWindow(id),
    update: async (id: number, changes: Record<string, any>) => {
      const window = findWindow(id);
      Object.assign(window, changes);
      return window;
    },
    create: async () => { throw new Error("new window creation is not expected"); },
    remove: async (id: number) => {
      const index = windows.findIndex((window) => window.id === id);
      if (index >= 0) windows.splice(index, 1);
    },
  },
  tabs: {
    create: async (properties: Record<string, any>) => {
      const window = findWindow(properties.windowId);
      const tab: MockTab = {
        id: nextTabId++,
        index: window.tabs.length,
        url: properties.url ?? "about:newtab",
        pinned: properties.pinned ?? false,
        active: properties.active ?? false,
        discarded: false,
        mutedInfo: { muted: false },
        ...(properties.cookieStoreId ? { cookieStoreId: properties.cookieStoreId } : {}),
      };
      // Firefox keeps pinned tabs in a separate leading segment.
      if (tab.pinned) {
        const pinnedCount = window.tabs.filter((candidate) => candidate.pinned).length;
        window.tabs.splice(pinnedCount, 0, tab);
      } else {
        window.tabs.push(tab);
      }
      reindex(window);
      return tab;
    },
    update: async (id: number, changes: Record<string, any>) => {
      const { window, tab } = findTab(id);
      if (typeof changes.pinned === "boolean" && changes.pinned !== tab.pinned) {
        pinnedUpdates.push({ id, pinned: changes.pinned });
        const oldIndex = window.tabs.indexOf(tab);
        window.tabs.splice(oldIndex, 1);
        tab.pinned = changes.pinned;
        const target = tab.pinned
          ? window.tabs.filter((candidate) => candidate.pinned).length
          : window.tabs.filter((candidate) => candidate.pinned).length;
        window.tabs.splice(target, 0, tab);
        reindex(window);
      }
      if (typeof changes.muted === "boolean") tab.mutedInfo = { muted: changes.muted };
      if (changes.active) {
        for (const candidate of window.tabs) candidate.active = candidate.id === id;
      }
      return tab;
    },
    move: async (id: number, properties: Record<string, any>) => {
      const { window, tab } = findTab(id);
      movedIds.push(id);
      const oldIndex = window.tabs.indexOf(tab);
      window.tabs.splice(oldIndex, 1);
      reindex(window);

      const pinnedCount = window.tabs.filter((candidate) => candidate.pinned).length;
      const requested = Number(properties.index ?? window.tabs.length);
      const index = tab.pinned
        ? Math.max(0, Math.min(requested, pinnedCount))
        : Math.max(pinnedCount, Math.min(requested, window.tabs.length));
      window.tabs.splice(index, 0, tab);
      reindex(window);
      return tab;
    },
    remove: async (ids: number | number[]) => {
      for (const id of Array.isArray(ids) ? ids : [ids]) {
        const { window, tab } = findTab(id);
        removedIds.push(id);
        window.tabs.splice(window.tabs.indexOf(tab), 1);
        reindex(window);
      }
    },
  },
};

function savedTab(index: number, url: string, pinned = false, active = false) {
  return {
    index,
    url,
    pinned,
    active,
    discarded: false,
    muted: false,
    restorable: true,
  };
}

// A live Zen window contains three pinned tabs. The first two represent the
// captured Essentials; the third represents a pinned/Essential tab added after
// the capsule was saved. Ordinary tabs are deliberately scrambled.
windows.push({
  id: 1,
  focused: true,
  incognito: false,
  state: "normal",
  tabs: [
    liveTab(101, 0, "https://essential-a.test", true),
    liveTab(102, 1, "https://essential-b.test", true),
    liveTab(103, 2, "https://essential-new.test", true),
    liveTab(203, 3, "https://ordinary-c.test"),
    liveTab(201, 4, "https://ordinary-a.test"),
    liveTab(299, 5, "https://remove-me.test"),
    liveTab(202, 6, "https://ordinary-b.test"),
  ],
});

const orderedSnapshot: FirefoxSnapshot = {
  schema_version: 1,
  browser: "firefox",
  extension_version: "0.1.3",
  captured_at_unix_ms: 1,
  skipped_private_windows: 0,
  windows: [{
    key: "ordered",
    focused: true,
    state: "normal",
    tabs: [
      savedTab(0, "https://essential-a.test", true),
      savedTab(1, "https://essential-b.test", true),
      savedTab(2, "https://ordinary-a.test"),
      savedTab(3, "https://ordinary-b.test", false, true),
      savedTab(4, "https://ordinary-c.test"),
    ],
    groups: [],
  }],
};

const orderedReport = await restoreFirefoxSnapshot(orderedSnapshot, {
  createBlankWindow: async () => { throw new Error("existing window should be reused"); },
});

assert(windows.length === 1, "the existing Zen window should be reused");
assert(
  findWindow(1).tabs.map((tab) => tab.id).join(",") === "101,102,103,201,202,203",
  "protected pinned/Essential tabs must stay in place while ordinary tabs converge to saved order",
);
assert(findTab(101).tab.pinned && findTab(102).tab.pinned && findTab(103).tab.pinned, "all original pinned/Essential tabs must remain pinned");
assert(!removedIds.includes(101) && !removedIds.includes(102) && !removedIds.includes(103), "restore must never delete original pinned/Essential tabs");
assert(!movedIds.includes(101) && !movedIds.includes(102) && !movedIds.includes(103), "restore must never move original pinned/Essential tabs through the generic tab strip");
assert(!pinnedUpdates.some((update) => [101, 102, 103].includes(update.id) && !update.pinned), "restore must never unpin an original pinned/Essential tab");
assert(removedIds.includes(299), "ordinary tabs outside the capsule should still be removed");
assert(findTab(202).tab.active, "saved active ordinary tab should be restored");
assert(orderedReport.created_tabs === 0, "existing target tabs should all be reused");
assert(orderedReport.reused_tabs === 5, "the five capsule tabs should be reused");
assert(!orderedReport.warnings.some((warning) => warning.includes("Tab order")), "ordinary tab order should converge without warning");

// If a saved ordinary tab has the same URL as a live pinned/Essential tab, the
// pinned native tab is not a valid candidate. Reusing it would require
// unpinning and would destroy Zen's private Essential state.
windows.splice(0, windows.length, {
  id: 2,
  focused: true,
  incognito: false,
  state: "normal",
  tabs: [liveTab(301, 0, "https://same-url.test", true)],
});
removedIds.splice(0, removedIds.length);
movedIds.splice(0, movedIds.length);
pinnedUpdates.splice(0, pinnedUpdates.length);
nextTabId = 20_000;

const demotionSnapshot: FirefoxSnapshot = {
  schema_version: 1,
  browser: "firefox",
  extension_version: "0.1.3",
  captured_at_unix_ms: 2,
  skipped_private_windows: 0,
  windows: [{
    key: "no-demotion",
    focused: true,
    state: "normal",
    tabs: [savedTab(0, "https://same-url.test", false, true)],
    groups: [],
  }],
};

const demotionReport = await restoreFirefoxSnapshot(demotionSnapshot, {
  createBlankWindow: async () => { throw new Error("existing window should be reused"); },
});

assert(findTab(301).tab.pinned, "the pre-existing pinned/Essential tab must remain pinned");
assert(!removedIds.includes(301), "the pre-existing pinned/Essential tab must not be removed");
assert(!movedIds.includes(301), "the pre-existing pinned/Essential tab must not be moved");
assert(!pinnedUpdates.some((update) => update.id === 301 && !update.pinned), "the pre-existing pinned/Essential tab must never be demoted");
const sameUrlTabs = findWindow(2).tabs.filter((tab) => tab.url === "https://same-url.test");
assert(sameUrlTabs.length === 2, "an ordinary saved tab should be created alongside the protected Essential when their URLs collide");
assert(sameUrlTabs.some((tab) => !tab.pinned), "the capsule target should exist as an ordinary tab");
assert(demotionReport.created_tabs === 1 && demotionReport.reused_tabs === 0, "the protected Essential must not be falsely counted as the reused ordinary target");

console.log("Zen Essentials preservation and exact ordinary-tab order regressions passed");
