import {
  isDisposableBootstrapTabs,
  isPortableTabGroup,
  isRestorableUrl,
  restorableUrl,
  savedTabsMatchLiveTabs,
  savedWindowSimilarity,
  tabCount,
  type FirefoxSnapshot,
} from "../src/browser/model";
import { normalWindowGeometryMatches, restoreFirefoxSnapshot } from "../src/browser/restore";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
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

assert(
  isDisposableBootstrapTabs([]),
  "a native blank window with zero tabs should be safe to populate",
);
assert(
  isDisposableBootstrapTabs([{ index: 0, url: "about:newtab", pinned: false }]),
  "a single unpinned new-tab page should be safe to reuse as startup bootstrap",
);
assert(
  isDisposableBootstrapTabs([{ index: 0, url: "about:home", pinned: false }]),
  "a single unpinned home page should be safe to reuse as startup bootstrap",
);
assert(
  !isDisposableBootstrapTabs([{ index: 0, url: "https://example.com", pinned: false }]),
  "real user content must never be treated as disposable bootstrap state",
);
assert(
  !isDisposableBootstrapTabs([{ index: 0, url: "about:newtab", pinned: true }]),
  "a pinned startup tab is intentional user state and must not be replaced",
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
  "anonymous groups are ambiguous with vendor-specific split relationships and must not be synthesized",
);
assert(
  isPortableTabGroup({ key: "group-1", title: "Research", color: "blue", collapsed: false }),
  "named Firefox tab groups have enough semantic identity to restore",
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
assert(
  !savedTabsMatchLiveTabs(savedWindow, [{
    index: 0,
    url: "https://different.test",
    pinned: false,
    cookieStoreId: "firefox-container-1",
  }]),
  "different URL topology must not be reused exactly",
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
      tabs: [
        {
          index: 1,
          url: "https://chatgpt.com/c/example",
          pinned: false,
          active: true,
          discarded: false,
          muted: false,
          restorable: true,
        },
      ],
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
  "a saved many-tab Zen window must still match its live window when the non-restorable debugging tab is absent and indices shift",
);
assert(
  savedWindowSimilarity(savedManyTabs, liveManyTabsWithOneChange).score > 0,
  "one extra live tab must not make an otherwise strongly matching large Zen window look missing",
);
assert(
  savedWindowSimilarity(savedManyTabs, [
    { index: 0, url: "https://www.youtube.com/", pinned: true },
    { index: 1, url: "https://www.messenger.com/t/example", pinned: true },
  ]).score === 0,
  "shared pinned Zen Essentials alone must never be enough to claim a saved multi-tab window",
);
assert(
  savedWindowSimilarity(savedChatGptOnly, liveLargeWindowContainingChatGpt).score === 0,
  "a ChatGPT-only saved window must never match a many-tab live window merely because that window also contains ChatGPT",
);
assert(
  savedWindowSimilarity(savedChatGptOnly, [
    { index: 0, url: "https://chatgpt.com/c/example", pinned: false },
  ]).score > 0,
  "a ChatGPT-only saved window must match a ChatGPT-only live window",
);
assert(
  savedWindowSimilarity(savedManyTabs, [
    { index: 0, url: "https://unrelated.example/", pinned: false },
    { index: 1, url: "https://another.example/", pinned: false },
  ]).score === 0,
  "an unrelated multi-tab window must not be claimed by fuzzy matching",
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
  "a Zen window cascaded on top of the existing window must be retried",
);
assert(
  !normalWindowGeometryMatches(
    { left: 240, top: 120, width: 1100, height: 820, state: "normal" },
    savedWindow,
  ),
  "oversized geometry must not be treated as satisfied",
);

const mockWindows: Array<Record<string, any>> = [{
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
}];
const originalManyWindow = JSON.stringify(mockWindows[0]);
const windowUpdates: Array<{ id: number; changes: Record<string, unknown> }> = [];
let nextTabId = 500;
let nativeBlankCreates = 0;

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
      return tab;
    },
    update: async (id: number, changes: Record<string, any>) => {
      const { window, tab } = mockTab(id);
      if (changes.active) {
        for (const candidate of window.tabs) candidate.active = candidate.id === id;
      }
      if (typeof changes.muted === "boolean") tab.mutedInfo = { muted: changes.muted };
      return tab;
    },
    remove: async (id: number) => {
      const { window } = mockTab(id);
      const index = window.tabs.findIndex((candidate: Record<string, any>) => candidate.id === id);
      if (index >= 0) window.tabs.splice(index, 1);
      window.tabs.forEach((candidate: Record<string, any>, index: number) => { candidate.index = index; });
    },
  },
};

const restoreReport = await restoreFirefoxSnapshot(twoWindowRestore, {
  createBlankWindow: async () => {
    nativeBlankCreates += 1;
    mockWindows.push({
      id: 20,
      focused: false,
      incognito: false,
      state: "normal",
      left: 50,
      top: 50,
      width: 800,
      height: 600,
      tabs: [{
        id: 400,
        index: 0,
        url: "about:newtab",
        pinned: false,
        active: true,
        discarded: false,
        mutedInfo: { muted: false },
      }],
    });
    return "created";
  },
});

assert(nativeBlankCreates === 1, "the two-window restore must create exactly one native Zen window");
assert(mockWindows.length === 2, "restore must end with the original window plus exactly one recreated window");
assert(JSON.stringify(mockWindows[0]) === originalManyWindow, "the already-open fuzzy-matched many-tab window must not be mutated at all");
assert(!windowUpdates.some(update => update.id === 10), "no geometry/state update may target the already-open many-tab window");
const restoredChatWindow = mockWindow(20);
assert(restoredChatWindow.state === "maximized", "the newly created ChatGPT window itself must receive the saved maximized state");
assert(restoredChatWindow.tabs.length === 1, "the recreated ChatGPT window must contain exactly one tab");
assert(restoredChatWindow.tabs[0]?.url === "https://chatgpt.com/c/example", "the recreated window must contain the saved ChatGPT tab");
assert(windowUpdates.some(update => update.id === 20 && update.changes.state === "maximized"), "maximize must target the recreated window ID, not the pre-existing window");
assert(restoreReport.reused_windows === 1, "the already-open many-tab window should be counted as reused");
assert(restoreReport.created_windows === 1, "only the missing ChatGPT window should be counted as created");

console.log("extension model and restore regression tests passed");
