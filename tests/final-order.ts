import assert from "node:assert/strict";
import type { FirefoxSnapshot } from "../src/browser/model";

type LiveTab = Record<string, any> & {
  id: number;
  windowId: number;
  index: number;
  url: string;
  pinned: boolean;
  groupId: number;
  splitViewId: number;
};

const windowId = 10;
let tabs: LiveTab[] = [];
let batchMoves: number[][] = [];
let groupMoves: number[] = [];
let removedIds: number[] = [];

function normalize(): void {
  tabs.forEach((tab, index) => {
    tab.index = index;
  });
}

function setTabs(entries: Array<{ id: number; url: string; groupId?: number; pinned?: boolean }>): void {
  tabs = entries.map((entry, index) => ({
    id: entry.id,
    windowId,
    index,
    url: entry.url,
    pinned: entry.pinned ?? false,
    active: index === 0,
    highlighted: index === 0,
    incognito: false,
    cookieStoreId: "firefox-default",
    groupId: entry.groupId ?? -1,
    splitViewId: -1,
  }));
  batchMoves = [];
  groupMoves = [];
  removedIds = [];
}

function moveIds(ids: number[], index: number): void {
  const idSet = new Set(ids);
  const moving = ids
    .map(id => tabs.find(tab => tab.id === id))
    .filter((tab): tab is LiveTab => tab !== undefined);
  tabs = tabs.filter(tab => !idSet.has(tab.id));
  const target = Math.max(0, Math.min(index, tabs.length));
  tabs.splice(target, 0, ...moving);
  normalize();
}

(globalThis as any).browser = {
  windows: {
    getAll: async () => [{
      id: windowId,
      focused: true,
      incognito: false,
      state: "normal",
      left: 100,
      top: 100,
      width: 1200,
      height: 800,
      tabs: [...tabs],
    }],
    get: async (id: number) => {
      assert.equal(id, windowId);
      return {
        id: windowId,
        focused: true,
        incognito: false,
        state: "normal",
        left: 100,
        top: 100,
        width: 1200,
        height: 800,
        tabs: [...tabs],
      };
    },
  },
  tabs: {
    get: async (id: number) => {
      const tab = tabs.find(candidate => candidate.id === id);
      if (!tab) throw new Error(`missing tab ${id}`);
      return { ...tab };
    },
    move: async (tabIds: number | number[], properties: { index: number; windowId?: number }) => {
      assert.equal(properties.windowId, windowId);
      const ids = Array.isArray(tabIds) ? [...tabIds] : [tabIds];
      batchMoves.push(ids);
      moveIds(ids, properties.index);
      return ids.map(id => ({ ...tabs.find(tab => tab.id === id)! }));
    },
    remove: async (tabIds: number | number[]) => {
      const ids = Array.isArray(tabIds) ? [...tabIds] : [tabIds];
      removedIds.push(...ids);
      const idSet = new Set(ids);
      tabs = tabs.filter(tab => !idSet.has(tab.id));
      normalize();
    },
  },
  tabGroups: {
    move: async (groupId: number, properties: { index: number; windowId?: number }) => {
      assert.equal(properties.windowId, windowId);
      groupMoves.push(groupId);
      const ids = tabs.filter(tab => tab.groupId === groupId).map(tab => tab.id);
      moveIds(ids, properties.index);
      return { id: groupId, windowId, title: "Work", color: "blue", collapsed: false };
    },
  },
};

const { enforceFinalTabOrder, finalOrderTestHelpers } = await import("../src/browser/order");

function snapshot(
  saved: Array<{ id: number; url: string; groupKey?: string; pinned?: boolean }>,
): FirefoxSnapshot {
  return {
    schema_version: 1,
    browser: "firefox",
    extension_version: "0.1.6",
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
      tabs: saved.map((entry, index) => ({
        index,
        url: entry.url,
        pinned: entry.pinned ?? false,
        active: index === 0,
        discarded: false,
        muted: false,
        cookie_store_id: "firefox-default",
        ...(entry.groupKey ? { group_key: entry.groupKey } : {}),
        restorable: true,
      })),
      groups: saved.some(entry => entry.groupKey === "work")
        ? [{ key: "work", title: "Work", color: "blue", collapsed: false }]
        : [],
    }],
  };
}

function urls(): string[] {
  return [...tabs].sort((left, right) => left.index - right.index).map(tab => tab.url);
}

const A = { id: 1, url: "https://a.test/" };
const B = { id: 2, url: "https://b.test/" };
const C = { id: 3, url: "https://c.test/" };
const D = { id: 4, url: "https://d.test/" };
const savedPlain = [A, B, C, D];

setTabs([B, A, D, C]);
let result = await enforceFinalTabOrder(snapshot(savedPlain));
assert.deepEqual(urls(), savedPlain.map(tab => tab.url), "edge swaps must converge exactly");
assert.equal(result.correctedWindows, 1);
assert.deepEqual(result.warnings, []);
assert.deepEqual(batchMoves, [[1, 2, 3, 4]], "ordinary tabs should be ordered in one batch, not one-by-one");

setTabs([D, C, B, A]);
result = await enforceFinalTabOrder(snapshot(savedPlain));
assert.deepEqual(urls(), savedPlain.map(tab => tab.url), "a full reversal must converge exactly");
assert.equal(result.correctedWindows, 1);
assert.deepEqual(batchMoves, [[1, 2, 3, 4]], "full reversal should still require one authoritative batch move");

setTabs([A, C, B, D]);
result = await enforceFinalTabOrder(snapshot(savedPlain));
assert.deepEqual(urls(), savedPlain.map(tab => tab.url), "middle swaps must converge exactly");
assert.equal(result.correctedWindows, 1);

setTabs([
  { ...D },
  { ...B, groupId: 9 },
  { ...C, groupId: 9 },
  { ...A },
]);
const groupedSnapshot = snapshot([
  A,
  { ...B, groupKey: "work" },
  { ...C, groupKey: "work" },
  D,
]);
result = await enforceFinalTabOrder(groupedSnapshot);
assert.deepEqual(urls(), savedPlain.map(tab => tab.url), "grouped tabs must converge without scrambling group members");
assert.equal(result.correctedWindows, 1);
assert.ok(groupMoves.includes(9), "a real tab group should move as one block");
assert.deepEqual(
  tabs.filter(tab => tab.groupId === 9).map(tab => tab.url),
  [B.url, C.url],
  "group member order must remain B,C",
);

setTabs(savedPlain);
result = await enforceFinalTabOrder(snapshot(savedPlain));
assert.equal(result.correctedWindows, 0, "already-correct order must be a no-op");
assert.deepEqual(batchMoves, [], "already-correct tabs must not move");
assert.deepEqual(removedIds, [], "already-correct target tabs must not be removed");

// Regression: Zen may materialize a bootstrap blank while restore operations
// are in flight. It did not exist in the initial live-tab inventory, so the main
// restore cleanup could not know its ID. The final pass must remove that one
// transient without touching any saved target.
const transientBlank = { id: 90, url: "about:blank" };
setTabs([A, B, C, D, transientBlank]);
result = await enforceFinalTabOrder(snapshot(savedPlain));
assert.deepEqual(urls(), savedPlain.map(tab => tab.url), "unsaved transient blank must be removed after restore");
assert.deepEqual(removedIds, [transientBlank.id], "only the transient blank should be removed");
assert.equal(result.correctedWindows, 0, "blank cleanup alone must not masquerade as an ordering correction");

// Counter-regression: an about:blank that genuinely belonged to the saved
// capsule is a mapped target and must survive the same finalizer.
const savedBlank = { id: 91, url: "about:blank" };
setTabs([A, savedBlank]);
result = await enforceFinalTabOrder(snapshot([A, savedBlank]));
assert.deepEqual(urls(), [A.url, savedBlank.url], "a saved blank target must be preserved");
assert.deepEqual(removedIds, [], "saved blank target must never be treated as transient residue");

// Pinned blanks are also never disposable here; Zen can hide Essential state
// behind an otherwise ordinary-looking pinned tab.
const pinnedBlank = { id: 92, url: "about:blank", pinned: true };
setTabs([A, pinnedBlank]);
result = await enforceFinalTabOrder(snapshot([A]));
assert.deepEqual(removedIds, [], "pinned/Essential-like blank tabs must remain protected");

const helperTabs = [
  { id: 100, index: 0, url: A.url, pinned: false },
  { id: 101, index: 1, url: "about:newtab", pinned: false },
  { id: 102, index: 2, url: "https://unrelated.test/", pinned: false },
] as any[];
assert.deepEqual(
  finalOrderTestHelpers.unexpectedDisposableTabIds(helperTabs, new Set([100])),
  [101],
  "pure cleanup selector must reject real unrelated user content",
);

console.log("authoritative final tab-order regressions passed");