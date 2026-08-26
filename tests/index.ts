import {
  isDisposableBootstrapTabs,
  isPortableTabGroup,
  isRestorableUrl,
  restorableUrl,
  savedTabsMatchLiveTabs,
  savedWindowSimilarity,
  tabCount,
  type BrowserTabSnapshot,
  type FirefoxSnapshot,
} from "../src/browser/model";
import {
  maximumWeightAssignment,
  normalWindowGeometryMatches,
  restoreFirefoxSnapshot,
  savedWindowStateAndMonitorMatch,
} from "../src/browser/restore";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function savedTab(index: number, url: string, active = false): BrowserTabSnapshot {
  return {
    index,
    url,
    pinned: false,
    active,
    discarded: false,
    muted: false,
    restorable: true,
  };
}

assert(isRestorableUrl("https://example.com/path"), "https URL should be restorable");
assert(isRestorableUrl("http://localhost:3000"), "localhost should be restorable");
assert(isRestorableUrl("about:blank"), "about:blank should be restorable");
assert(isRestorableUrl("about:newtab"), "about:newtab should be restorable");
assert(!isRestorableUrl("about:config"), "privileged about URL must not be restored");
assert(!isRestorableUrl("moz-extension://abc/popup.html"), "extension URL must not be restored");
assert(!isRestorableUrl("file:///C:/secret.txt"), "file URL must not be restored");
assert(restorableUrl("about:newtab") === undefined, "newtab should be restored by omitting URL");
assert(restorableUrl("about:config") === undefined, "privileged URL should be skipped instead of becoming a blank tab");

assert(isDisposableBootstrapTabs([]), "zero tabs should be a disposable native bootstrap");
assert(
  isDisposableBootstrapTabs([{ index: 0, url: "about:newtab", pinned: false }]),
  "one ordinary new tab should be a disposable bootstrap",
);
assert(
  !isDisposableBootstrapTabs([{ index: 0, url: "https://example.com", pinned: false }]),
  "real user content must not be treated as disposable bootstrap state",
);
assert(
  !isDisposableBootstrapTabs([
    { index: 0, url: "about:newtab", pinned: false },
    { index: 1, url: "about:blank", pinned: false },
  ]),
  "multi-tab windows must not be treated as disposable startup state",
);

assert(
  !isPortableTabGroup({ key: "group-0", title: "", color: "blue", collapsed: false }),
  "anonymous groups are ambiguous with vendor-specific split relationships",
);
assert(
  isPortableTabGroup({ key: "group-1", title: "Research", color: "blue", collapsed: false }),
  "named Firefox tab groups should remain portable",
);

const snapshot: FirefoxSnapshot = {
  schema_version: 1,
  browser: "firefox",
  extension_version: "0.1.0",
  captured_at_unix_ms: 1,
  skipped_private_windows: 0,
  windows: [
    {
      key: "one",
      focused: true,
      state: "normal",
      left: 240,
      top: 120,
      width: 900,
      height: 700,
      tabs: [{
        index: 0,
        url: "https://a.test",
        pinned: false,
        active: true,
        discarded: false,
        muted: false,
        cookie_store_id: "firefox-container-1",
        restorable: true,
      }],
      groups: [],
    },
    {
      key: "two",
      focused: false,
      state: "maximized",
      tabs: [
        { index: 0, url: "https://b.test", pinned: true, active: true, discarded: false, muted: false, restorable: true },
        { index: 1, url: "https://c.test", pinned: false, active: false, discarded: true, muted: true, restorable: true },
      ],
      groups: [],
    },
  ],
};
assert(tabCount(snapshot) === 3, "tabCount should sum every window");

const savedWindow = snapshot.windows[0]!;
assert(
  savedTabsMatchLiveTabs(savedWindow, [{
    index: 0,
    url: "https://a.test",
    pinned: false,
    cookieStoreId: "firefox-container-1",
  }]),
  "identical saved/live tab topology should be reusable",
);
assert(
  !savedTabsMatchLiveTabs(savedWindow, [{
    index: 0,
    url: "https://a.test",
    pinned: false,
    cookieStoreId: "firefox-container-2",
  }]),
  "a different container must not be treated as satisfied",
);
assert(
  !savedTabsMatchLiveTabs(savedWindow, [
    { index: 0, url: "https://a.test", pinned: false, cookieStoreId: "firefox-container-1" },
    { index: 1, url: "https://extra.test", pinned: false },
  ]),
  "extra live tabs must not count as an exact match",
);

const twoWindowRestore: FirefoxSnapshot = {
  schema_version: 1,
  browser: "firefox",
  extension_version: "0.1.0",
  captured_at_unix_ms: 2,
  skipped_private_windows: 0,
  windows: [
    {
      key: "window-0",
      focused: false,
      state: "normal",
      left: 1913,
      top: 830,
      width: 1094,
      height: 647,
      tabs: [
        { index: 0, url: "https://www.youtube.com/", pinned: true, active: false, discarded: true, muted: false, restorable: true },
        { index: 1, url: "https://www.messenger.com/t/example", pinned: true, active: false, discarded: true, muted: false, restorable: true },
        { index: 3, url: "about:debugging#/runtime/this-firefox", pinned: false, active: true, discarded: false, muted: false, restorable: false },
        { index: 4, url: "https://www.scaleway.com/en/pricing/managed-databases/", pinned: false, active: false, discarded: false, muted: false, restorable: true },
        { index: 5, url: "https://domains.cloudflare.com/", pinned: false, active: false, discarded: false, muted: false, restorable: true },
        { index: 6, url: "https://github.com/Context-Capsule/Capsule-CLI", pinned: false, active: false, discarded: false, muted: false, restorable: true },
        { index: 7, url: "https://github.com/Context-Capsule/Capsule-Firefox-Extension", pinned: false, active: false, discarded: false, muted: false, restorable: true },
      ],
      groups: [],
    },
    {
      key: "window-1",
      focused: false,
      state: "maximized",
      left: -7,
      top: -7,
      width: 1550,
      height: 878,
      tabs: [savedTab(1, "https://chatgpt.com/c/example", true)],
      groups: [],
    },
  ],
};

const savedManyTabs = twoWindowRestore.windows[0]!;
const savedChatGptOnly = twoWindowRestore.windows[1]!;
const liveManyTabs = [
  { index: 0, url: "https://www.youtube.com/", pinned: true },
  { index: 1, url: "https://www.messenger.com/t/example", pinned: true },
  { index: 2, url: "https://www.scaleway.com/en/pricing/managed-databases/", pinned: false },
  { index: 3, url: "https://domains.cloudflare.com/", pinned: false },
  { index: 4, url: "https://github.com/Context-Capsule/Capsule-CLI", pinned: false },
  { index: 5, url: "https://github.com/Context-Capsule/Capsule-Firefox-Extension", pinned: false },
];
const liveManyTabsWithOneChange = [
  ...liveManyTabs,
  { index: 6, url: "https://example.com/new-live-tab", pinned: false },
];
const liveLargeWindowContainingChatGpt = [
  ...liveManyTabs,
  { index: 6, url: "https://chatgpt.com/c/example", pinned: false },
];

const manyTabSimilarity = savedWindowSimilarity(savedManyTabs, liveManyTabs);
assert(
  !manyTabSimilarity.exact && manyTabSimilarity.score > 0,
  "a many-tab Zen window should retain fuzzy identity when a privileged tab is absent",
);
assert(
  savedWindowSimilarity(savedManyTabs, liveManyTabsWithOneChange).score > 0,
  "one extra live tab should not erase strong window identity",
);
assert(
  savedWindowSimilarity(savedManyTabs, [
    { index: 0, url: "https://www.youtube.com/", pinned: true },
    { index: 1, url: "https://www.messenger.com/t/example", pinned: true },
  ]).score === 0,
  "shared pinned Zen Essentials alone must not claim a saved multi-tab window",
);
assert(
  savedWindowSimilarity(savedChatGptOnly, liveLargeWindowContainingChatGpt).score === 0,
  "a single-tab saved window must not claim a large live window containing that one tab",
);
assert(
  savedWindowSimilarity(savedChatGptOnly, [
    { index: 0, url: "https://chatgpt.com/c/example", pinned: false },
  ]).score > 0,
  "a ChatGPT-only saved window should match a ChatGPT-only live window",
);

assert(
  normalWindowGeometryMatches(
    { left: 244, top: 116, width: 905, height: 696, state: "normal" },
    savedWindow,
  ),
  "small native/browser frame variance should count as placed",
);
assert(
  !normalWindowGeometryMatches(
    { left: 0, top: 0, width: 900, height: 700, state: "normal" },
    savedWindow,
  ),
  "a cascaded window must not count as the saved geometry",
);
assert(
  savedWindowStateAndMonitorMatch(
    { left: 0, top: 0, state: "maximized" },
    savedChatGptOnly,
  ),
  "native maximized frame offsets within tolerance should count as the saved monitor",
);
assert(
  !savedWindowStateAndMonitorMatch(
    { left: 1913, top: -7, state: "maximized" },
    savedChatGptOnly,
  ),
  "a maximized window on the other monitor must not count as restored",
);

const optimal = maximumWeightAssignment([
  [2, 1],
  [2, 0],
]);
assert(
  optimal[0] === 1 && optimal[1] === 0,
  "global assignment must accept a weaker first match when it increases total tab reuse",
);

const mockWindows: Array<Record<string, any>> = [];
const windowUpdates: Array<{ id: number; changes: Record<string, unknown> }> = [];
let nextTabId = 500;
let nativeBlankCreates = 0;

function reindex(window: Record<string, any>): void {
  window.tabs.forEach((tab: Record<string, any>, index: number) => { tab.index = index; });
}

function mockWindow(id: number): Record<string, any> {
  const found = mockWindows.find(window => window.id === id);
  if (!found) throw new Error(`mock window ${id} not found`);
  return found;
}

function mockTab(id: number): { window: Record<string, any>; tab: Record<string, any> } {
  for (const window of mockWindows) {
    const tab = window.tabs.find((candidate: Record<string, any>) => candidate.id === id);
    if (tab) return { window, tab };
  }
  throw new Error(`mock tab ${id} not found`);
}

(globalThis as any).browser = {
  windows: {
    getAll: async () => mockWindows,
    get: async (id: number) => mockWindow(id),
    create: async () => { throw new Error("standard Firefox creation should not be used in these Zen tests"); },
    update: async (id: number, changes: Record<string, unknown>) => {
      const window = mockWindow(id);
      Object.assign(window, changes);
      windowUpdates.push({ id, changes: { ...changes } });
      return window;
    },
    remove: async (id: number) => {
      const index = mockWindows.findIndex(window => window.id === id);
      if (index >= 0) mockWindows.splice(index, 1);
    },
  },
  tabs: {
    create: async (properties: Record<string, any>) => {
      const window = mockWindow(properties.windowId);
      const tab = {
        id: nextTabId++,
        index: window.tabs.length,
        url: properties.url ?? "about:newtab",
        pinned: properties.pinned ?? false,
        active: properties.active ?? false,
        discarded: false,
        mutedInfo: { muted: false },
        ...(properties.cookieStoreId ? { cookieStoreId: properties.cookieStoreId } : {}),
      };
      window.tabs.push(tab);
      reindex(window);
      return tab;
    },
    update: async (id: number, changes: Record<string, any>) => {
      const { window, tab } = mockTab(id);
      if (changes.active) {
        for (const candidate of window.tabs) candidate.active = candidate.id === id;
      }
      if (typeof changes.muted === "boolean") tab.mutedInfo = { muted: changes.muted };
      if (typeof changes.pinned === "boolean") tab.pinned = changes.pinned;
      return tab;
    },
    move: async (id: number, properties: Record<string, any>) => {
      const { window: source, tab } = mockTab(id);
      const sourceIndex = source.tabs.findIndex((candidate: Record<string, any>) => candidate.id === id);
      source.tabs.splice(sourceIndex, 1);
      reindex(source);
      const destination = properties.windowId !== undefined ? mockWindow(properties.windowId) : source;
      const requested = typeof properties.index === "number" ? properties.index : destination.tabs.length;
      const index = Math.max(0, Math.min(requested, destination.tabs.length));
      destination.tabs.splice(index, 0, tab);
      reindex(destination);
      return tab;
    },
    remove: async (ids: number | number[]) => {
      for (const id of Array.isArray(ids) ? ids : [ids]) {
        const found = mockTab(id);
        const index = found.window.tabs.findIndex((candidate: Record<string, any>) => candidate.id === id);
        if (index >= 0) found.window.tabs.splice(index, 1);
        reindex(found.window);
      }
    },
  },
};

function liveTab(id: number, index: number, url: string, pinned = false): Record<string, any> {
  return {
    id,
    index,
    url,
    pinned,
    active: index === 0,
    discarded: false,
    mutedInfo: { muted: false },
  };
}

// Regression 1: a strongly matching existing Zen window is the window to
// restore. Do not blank it and do not create a duplicate of it.
mockWindows.push({
  id: 10,
  focused: true,
  incognito: false,
  state: "normal",
  left: 1913,
  top: 830,
  width: 1094,
  height: 647,
  tabs: liveManyTabs.map((tab, position) => ({
    id: 100 + position,
    ...tab,
    active: position === 2,
    discarded: false,
    mutedInfo: { muted: false },
  })),
});

const firstReport = await restoreFirefoxSnapshot(twoWindowRestore, {
  createBlankWindow: async () => {
    nativeBlankCreates += 1;
    mockWindows.push({
      id: 20,
      focused: false,
      incognito: false,
      state: "normal",
      left: 2050,
      top: 100,
      width: 800,
      height: 600,
      tabs: [liveTab(400, 0, "about:newtab")],
    });
    return "created";
  },
});

assert(nativeBlankCreates === 1, "only the actually missing ChatGPT window should be created");
assert(mockWindows.length === 2, "restore should keep the reusable window and create only one missing window");
assert(mockWindow(10).tabs.length === 6, "the reusable many-tab window should keep its six restorable tabs without duplication");
assert(
  mockWindow(10).tabs.map((tab: Record<string, any>) => tab.url).join("|")
    === liveManyTabs.map(tab => tab.url).join("|"),
  "the reusable window should retain the existing matching tab objects in saved semantic order",
);
assert(mockWindow(10).tabs[0]?.active === true, "when the saved privileged active tab is unavailable, a retained target tab should become active");
assert(windowUpdates.some(update => update.id === 10), "the reused window should now receive saved geometry/state reconciliation");
assert(firstReport.reused_windows === 1, "the existing many-tab window should be counted as reused");
assert(firstReport.reused_tabs === 6, "all six already-open restorable tabs should be counted as reused");
assert(firstReport.created_windows === 1, "only the missing ChatGPT window should be created");
assert(firstReport.created_tabs === 1, "only the missing ChatGPT tab should be created");
assert(
  firstReport.warnings.some(warning => warning.includes("about:debugging")),
  "the missing non-restorable debugging tab should be reported rather than replaced with a duplicate blank tab",
);
const restoredChatWindow = mockWindow(20);
assert(restoredChatWindow.state === "maximized", "the recreated ChatGPT window should receive the saved maximized state");
assert(restoredChatWindow.left === -7 && restoredChatWindow.top === -7, "the recreated ChatGPT window should be staged on its saved monitor");
assert(restoredChatWindow.tabs.length === 1 && restoredChatWindow.tabs[0]?.url === "https://chatgpt.com/c/example", "the recreated ChatGPT window should contain exactly the saved tab");

// Regression 2: global assignment must maximize reuse across all windows. A
// greedy algorithm would give live window 10 (A+B) to saved window 0 and then
// have no candidate for saved window 1. The optimum is window 11 (C) -> saved 0
// and window 10 (A+B) -> saved 1, reusing three tabs and creating no windows.
mockWindows.splice(0, mockWindows.length,
  {
    id: 10,
    focused: true,
    incognito: false,
    state: "normal",
    tabs: [
      liveTab(1000, 0, "https://a.test"),
      liveTab(1001, 1, "https://b.test"),
    ],
  },
  {
    id: 11,
    focused: false,
    incognito: false,
    state: "normal",
    tabs: [liveTab(1100, 0, "https://c.test")],
  },
);
windowUpdates.splice(0, windowUpdates.length);
nextTabId = 2000;
nativeBlankCreates = 0;

const optimalSnapshot: FirefoxSnapshot = {
  schema_version: 1,
  browser: "firefox",
  extension_version: "0.1.2",
  captured_at_unix_ms: 3,
  skipped_private_windows: 0,
  windows: [
    {
      key: "saved-abc",
      focused: true,
      state: "normal",
      tabs: [
        savedTab(0, "https://a.test", true),
        savedTab(1, "https://b.test"),
        savedTab(2, "https://c.test"),
      ],
      groups: [],
    },
    {
      key: "saved-abd",
      focused: false,
      state: "normal",
      tabs: [
        savedTab(0, "https://a.test", true),
        savedTab(1, "https://b.test"),
        savedTab(2, "https://d.test"),
      ],
      groups: [],
    },
  ],
};

const optimalReport = await restoreFirefoxSnapshot(optimalSnapshot, {
  createBlankWindow: async () => {
    nativeBlankCreates += 1;
    return "created";
  },
});

assert(nativeBlankCreates === 0, "global reuse planning should avoid creating any browser window when two useful live candidates already exist");
assert(mockWindows.length === 2, "the two live windows should both be reused");
assert(
  mockWindow(11).tabs.map((tab: Record<string, any>) => tab.url).join("|")
    === "https://a.test|https://b.test|https://c.test",
  "the C-only live window should be completed into the saved A+B+C window",
);
assert(
  mockWindow(10).tabs.map((tab: Record<string, any>) => tab.url).join("|")
    === "https://a.test|https://b.test|https://d.test",
  "the A+B live window should be completed into the saved A+B+D window",
);
assert(optimalReport.reused_windows === 2, "both existing windows should be reused");
assert(optimalReport.reused_tabs === 3, "the globally optimal assignment should reuse three existing tabs in total");
assert(optimalReport.created_windows === 0, "no new window should be created for a restorable subset candidate");
assert(optimalReport.created_tabs === 3, "only the three tabs missing from the two chosen subsets should be created");

console.log("extension model and optimal window-reuse restore regression tests passed");

// Regression 3: even a zero-overlap live window is a better shell than creating
// another browser window. Semantic overlap decides *which* live window wins;
// lack of overlap alone must not force native window creation.
mockWindows.splice(0, mockWindows.length, {
  id: 30,
  focused: true,
  incognito: false,
  state: "normal",
  tabs: [liveTab(3000, 0, "https://unrelated.test")],
});
windowUpdates.splice(0, windowUpdates.length);
nextTabId = 3001;
nativeBlankCreates = 0;

const zeroOverlapSnapshot: FirefoxSnapshot = {
  schema_version: 1,
  browser: "firefox",
  extension_version: "0.1.2",
  captured_at_unix_ms: 4,
  skipped_private_windows: 0,
  windows: [{
    key: "saved-target",
    focused: true,
    state: "normal",
    tabs: [savedTab(0, "https://target.test", true)],
    groups: [],
  }],
};

const zeroOverlapReport = await restoreFirefoxSnapshot(zeroOverlapSnapshot, {
  createBlankWindow: async () => {
    nativeBlankCreates += 1;
    return "created";
  },
});
assert(nativeBlankCreates === 0, "an existing zero-overlap live window should be repurposed before creating a new window");
assert(mockWindows.length === 1 && mockWindow(30).tabs.length === 1, "the existing shell should remain the only window");
assert(mockWindow(30).tabs[0]?.url === "https://target.test", "the zero-overlap shell should be reconciled to the saved target tab");
assert(zeroOverlapReport.reused_windows === 1 && zeroOverlapReport.created_windows === 0, "zero-overlap shell reuse should be reported as window reuse, not creation");
assert(zeroOverlapReport.reused_tabs === 0 && zeroOverlapReport.created_tabs === 1, "the shell should reuse the window while creating only the missing tab");

console.log("zero-overlap shell reuse regression test passed");

// Regression: two Zen windows were saved. The large one disappears entirely,
// while the smaller one survives with one ordinary tab missing. Shared pinned
// Essentials must not make the surviving small window match the missing large
// window. The small window is repaired in place and the large window is recreated.
mockWindows.splice(0, mockWindows.length, {
  id: 40,
  focused: true,
  incognito: false,
  state: "normal",
  left: -7,
  top: -7,
  width: 1550,
  height: 878,
  tabs: [
    liveTab(4000, 0, "https://essential-one.test", true),
    liveTab(4001, 1, "https://essential-two.test", true),
    liveTab(4002, 2, "https://small-a.test"),
    liveTab(4003, 3, "https://small-c.test"),
  ],
});
windowUpdates.splice(0, windowUpdates.length);
nextTabId = 4100;
nativeBlankCreates = 0;

const sharedEssential = (index: number, url: string): BrowserTabSnapshot => ({
  index,
  url,
  pinned: true,
  active: false,
  discarded: false,
  muted: false,
  restorable: true,
});
const zenPartialRestoreSnapshot: FirefoxSnapshot = {
  schema_version: 1,
  browser: "firefox",
  extension_version: "0.1.7",
  captured_at_unix_ms: 5,
  skipped_private_windows: 0,
  windows: [
    {
      key: "large-saved-window",
      focused: false,
      state: "normal",
      left: 1900,
      top: 100,
      width: 1050,
      height: 700,
      tabs: [
        sharedEssential(0, "https://essential-one.test"),
        sharedEssential(1, "https://essential-two.test"),
        savedTab(2, "https://large-a.test"),
        savedTab(3, "https://large-b.test"),
        savedTab(4, "https://large-c.test"),
        savedTab(5, "https://large-d.test", true),
      ],
      groups: [],
    },
    {
      key: "small-saved-window",
      focused: true,
      state: "normal",
      left: -7,
      top: -7,
      width: 1550,
      height: 878,
      tabs: [
        sharedEssential(0, "https://essential-one.test"),
        sharedEssential(1, "https://essential-two.test"),
        savedTab(2, "https://small-a.test"),
        savedTab(3, "https://small-b.test"),
        savedTab(4, "https://small-c.test", true),
      ],
      groups: [],
    },
  ],
};

const zenPartialReport = await restoreFirefoxSnapshot(zenPartialRestoreSnapshot, {
  createBlankWindow: async () => {
    nativeBlankCreates += 1;
    mockWindows.push({
      id: 41,
      focused: false,
      incognito: false,
      state: "normal",
      left: 2000,
      top: 150,
      width: 800,
      height: 600,
      tabs: [liveTab(4099, 0, "about:newtab")],
    });
    return "created";
  },
});

assert(nativeBlankCreates === 1, "the completely closed large Zen window must be recreated exactly once");
assert(mockWindows.length === 2, "restore should finish with the two saved Zen windows");
assert(mockWindow(40).left === -7 && mockWindow(40).top === -7, "the surviving small window must keep the small saved geometry");
assert(
  mockWindow(40).tabs.filter((tab: Record<string, any>) => !tab.pinned).map((tab: Record<string, any>) => tab.url).join("|")
    === "https://small-a.test|https://small-b.test|https://small-c.test",
  "the surviving small Zen window must restore its one missing ordinary tab",
);
assert(mockWindow(41).left === 1900 && mockWindow(41).top === 100, "the recreated large Zen window must receive the large saved geometry");
assert(
  mockWindow(41).tabs.some((tab: Record<string, any>) => tab.url === "https://large-d.test"),
  "the recreated large Zen window must receive its saved ordinary tabs",
);
assert(zenPartialReport.reused_windows === 1, "only the surviving small window should be reused");
assert(zenPartialReport.created_windows === 1, "the missing large window should be reported as created");
assert(zenPartialReport.created_tabs === 7, "restore should create six large-window tabs and one missing small-window tab");

console.log("partial multi-window Zen restore regression test passed");
