import assert from "node:assert/strict";
import {
  isPortableTabGroup,
  isSplitViewGroup,
  splitGroupTitle,
  splitOrientationFromGroup,
  type FirefoxSnapshot,
} from "../src/browser/model";
import { inferSplitOrientation, isCapturedSplitGroup } from "../src/browser/capture";
import { restoreSavedSplitViews } from "../src/browser/splits";

const splitVertical = { key: "split-0", title: splitGroupTitle("vertical"), color: "blue" as const, collapsed: false };
assert(isSplitViewGroup(splitVertical));
assert.equal(splitOrientationFromGroup(splitVertical), "vertical");
assert.equal(isPortableTabGroup(splitVertical), false, "split markers must never be recreated as ordinary Firefox groups");
assert.equal(splitOrientationFromGroup({ title: splitGroupTitle("horizontal") }), "horizontal");
assert.equal(splitOrientationFromGroup({ title: splitGroupTitle("grid") }), "grid");

assert.equal(
  inferSplitOrientation(
    { width: 1200, height: 800 },
    [{ width: 600, height: 800 }, { width: 600, height: 800 }],
  ),
  "vertical",
  "two viewports that pack across the browser width should capture as side-by-side/vertical split",
);
assert.equal(
  inferSplitOrientation(
    { width: 1200, height: 800 },
    [{ width: 1200, height: 400 }, { width: 1200, height: 400 }],
  ),
  "horizontal",
  "two viewports that pack across the browser height should capture as top/bottom split",
);
assert.equal(
  inferSplitOrientation(
    { width: 1200, height: 800 },
    [{ width: 600, height: 400 }, { width: 600, height: 400 }, { width: 600, height: 400 }],
  ),
  "grid",
  "three- and four-tab split layouts should use Zen grid restore",
);

assert.equal(
  isCapturedSplitGroup(
    { title: "" },
    [
      { index: 0, pinned: false, active: true, highlighted: true, incognito: false, splitViewId: 7 } as any,
      { index: 1, pinned: false, active: false, highlighted: true, incognito: false, splitViewId: 7 } as any,
    ],
  ),
  true,
  "shared splitViewId is authoritative split membership",
);
assert.equal(
  isCapturedSplitGroup(
    { title: "" },
    [
      { index: 0, pinned: false, active: true, highlighted: true, incognito: false } as any,
      { index: 1, pinned: false, active: false, highlighted: true, incognito: false } as any,
    ],
  ),
  true,
  "Zen anonymous 2-4 tab groups remain a fallback split signal",
);
assert.equal(
  isCapturedSplitGroup(
    { title: "Work" },
    [
      { index: 0, pinned: false, active: true, highlighted: true, incognito: false } as any,
      { index: 1, pinned: false, active: false, highlighted: true, incognito: false } as any,
    ],
  ),
  false,
  "named Firefox groups must not be mistaken for Zen splits",
);

const liveTabs: Array<Record<string, any>> = [
  {
    id: 101,
    windowId: 10,
    index: 0,
    url: "https://a.test/",
    pinned: false,
    active: true,
    highlighted: false,
    incognito: false,
    cookieStoreId: "firefox-default",
    groupId: -1,
    splitViewId: -1,
  },
  {
    id: 102,
    windowId: 10,
    index: 1,
    url: "https://b.test/",
    pinned: false,
    active: false,
    highlighted: false,
    incognito: false,
    cookieStoreId: "firefox-default",
    groupId: -1,
    splitViewId: -1,
  },
];
const liveWindow: Record<string, any> = {
  id: 10,
  focused: false,
  incognito: false,
  state: "normal",
  left: 100,
  top: 100,
  width: 1200,
  height: 800,
  tabs: liveTabs,
};
let liveGroups: Array<{ id: number; title: string }> = [];
let highlighted: number[] = [];
let focusedWindow: number | undefined;
let invoked: string[] = [];

(globalThis as any).browser = {
  windows: {
    getAll: async () => [liveWindow],
    update: async (id: number, changes: Record<string, any>) => {
      if (changes.focused) focusedWindow = id;
      Object.assign(liveWindow, changes);
      return liveWindow;
    },
  },
  tabs: {
    get: async (id: number) => {
      const tab = liveTabs.find(candidate => candidate.id === id);
      if (!tab) throw new Error(`missing tab ${id}`);
      return tab;
    },
    highlight: async ({ windowId, tabs }: { windowId: number; tabs: number[] }) => {
      assert.equal(windowId, 10);
      highlighted = [...tabs];
      for (const tab of liveTabs) tab.highlighted = tabs.includes(tab.index);
      return liveWindow;
    },
  },
  tabGroups: {
    query: async () => liveGroups,
  },
};

const snapshot: FirefoxSnapshot = {
  schema_version: 1,
  browser: "firefox",
  extension_version: "0.1.4",
  captured_at_unix_ms: 1,
  skipped_private_windows: 0,
  windows: [{
    key: "window-0",
    focused: true,
    state: "normal",
    left: 100,
    top: 100,
    width: 1200,
    height: 800,
    tabs: [
      {
        index: 0,
        url: "https://a.test/",
        pinned: false,
        active: true,
        discarded: false,
        muted: false,
        cookie_store_id: "firefox-default",
        group_key: "split-0",
        restorable: true,
      },
      {
        index: 1,
        url: "https://b.test/",
        pinned: false,
        active: false,
        discarded: false,
        muted: false,
        cookie_store_id: "firefox-default",
        group_key: "split-0",
        restorable: true,
      },
    ],
    groups: [{
      key: "split-0",
      title: splitGroupTitle("vertical"),
      color: "blue",
      collapsed: false,
    }],
  }],
};

const restored = await restoreSavedSplitViews(snapshot, async (orientation) => {
  invoked.push(orientation);
  assert.deepEqual(highlighted, [0, 1], "both saved split members must be multi-selected before invoking Zen");
  for (const tab of liveTabs) {
    tab.splitViewId = 77;
    tab.groupId = 88;
  }
  liveGroups = [{ id: 88, title: "" }];
});

assert.deepEqual(invoked, ["vertical"]);
assert.equal(focusedWindow, 10, "the exact restored Zen window must be focused before synthetic split input");
assert.equal(restored.restored, 1);
assert.equal(restored.alreadySatisfied, 0);
assert.deepEqual(restored.warnings, []);
assert.deepEqual(liveTabs.map(tab => tab.url), ["https://a.test/", "https://b.test/"], "split restoration must not replace the restored tab objects");

invoked = [];
const already = await restoreSavedSplitViews(snapshot, async (orientation) => {
  invoked.push(orientation);
});
assert.equal(already.restored, 0);
assert.equal(already.alreadySatisfied, 1, "an already-real split should be a semantic no-op");
assert.deepEqual(invoked, [], "already-satisfied splits must not receive another shortcut");

console.log("Zen split-view capture and verified restore regressions passed");
