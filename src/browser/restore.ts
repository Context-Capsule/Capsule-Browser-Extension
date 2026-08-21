import {
  type BrowserTabSnapshot,
  type BrowserWindowSnapshot,
  type ComparableLiveTab,
  type FirefoxSnapshot,
  type RestoreReport,
  isDisposableBootstrapTabs,
  isPortableTabGroup,
  isRestorableUrl,
  restorableUrl,
  savedWindowSimilarity,
} from "./model";

interface TabsGroupingApi {
  group(options: { tabIds: number | number[]; createProperties?: { windowId?: number }; groupId?: number }): Promise<number>;
}

interface TabGroupsApi {
  update(
    groupId: number,
    properties: { title?: string; color?: string; collapsed?: boolean },
  ): Promise<unknown>;
}

export type NativeBlankWindowResult = "created" | "unsupported";

export interface RestoreOptions {
  /**
   * Ask the native host to create an independent browser window when it knows
   * how to do so. Zen uses this to avoid Window Sync cloning/mutating the
   * current Space. Plain Firefox reports "unsupported" and uses the standard
   * WebExtension windows API instead.
   */
  createBlankWindow?: () => Promise<NativeBlankWindowResult>;
}

interface ExistingWindowMatch {
  window: browser.windows.Window;
  exact: boolean;
  score: number;
  overlap: number;
  savedRelevant: number;
  liveRelevant: number;
  liveSubset: boolean;
  weight: number;
}

interface ReusableTabOverlap {
  overlap: number;
  savedRelevant: number;
  liveRelevant: number;
  unpinnedOverlap: number;
  savedUnpinnedRelevant: number;
  liveSubset: boolean;
}

interface ExistingTabMap {
  restoredByIndex: Map<number, browser.tabs.Tab>;
  reusedTabIds: Set<number>;
}

interface NewWindowObservation {
  window?: browser.windows.Window;
  observedNewIds: Set<number>;
  transientDisposableIds: Set<number>;
}

const NEW_WINDOW_SETTLE_MS = 300;
const NATIVE_BLANK_WINDOW_TIMEOUT_MS = 7_000;
const NATIVE_BLANK_WINDOW_POLL_MS = 100;
const NATIVE_BLANK_WINDOW_STABLE_MS = 1_500;
const NORMAL_GEOMETRY_SETTLE_MS = 180;
const NORMAL_GEOMETRY_RETRIES = 5;
const NON_NORMAL_GEOMETRY_RETRIES = 3;
const NORMAL_GEOMETRY_TOLERANCE = 8;
const TAB_ORDER_SETTLE_MS = 60;
const TAB_ORDER_RETRIES = 3;
const WINDOW_REUSE_OVERLAP_WEIGHT = 1_000_000_000_000;

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

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function createTab(
  windowId: number,
  tab: BrowserTabSnapshot,
  warnings: string[],
): Promise<browser.tabs.Tab> {
  const properties: Parameters<typeof browser.tabs.create>[0] = {
    windowId,
    active: false,
    pinned: tab.pinned,
  };
  const url = restorableUrl(tab.url);
  if (url !== undefined) properties.url = url;
  if (tab.cookie_store_id) properties.cookieStoreId = tab.cookie_store_id;

  let created: browser.tabs.Tab;
  try {
    created = await browser.tabs.create(properties);
  } catch (error) {
    if (!tab.cookie_store_id) throw error;
    delete properties.cookieStoreId;
    warnings.push(
      `Container '${tab.cookie_store_id}' was unavailable for '${tab.title ?? tab.url}'; restored in the default container.`,
    );
    created = await browser.tabs.create(properties);
  }

  if (created.id !== undefined && tab.muted) {
    await browser.tabs.update(created.id, { muted: true }).catch(() => undefined);
  }
  return created;
}

function numberClose(actual: number | undefined, expected: number | undefined): boolean {
  if (expected === undefined) return true;
  return actual !== undefined && Math.abs(actual - expected) <= NORMAL_GEOMETRY_TOLERANCE;
}

export function normalWindowGeometryMatches(
  actual: Pick<browser.windows.Window, "left" | "top" | "width" | "height" | "state">,
  saved: Pick<BrowserWindowSnapshot, "left" | "top" | "width" | "height">,
): boolean {
  return (actual.state === undefined || actual.state === "normal")
    && numberClose(actual.left, saved.left)
    && numberClose(actual.top, saved.top)
    && numberClose(actual.width, saved.width)
    && numberClose(actual.height, saved.height);
}

export function savedWindowStateAndMonitorMatch(
  actual: Pick<browser.windows.Window, "left" | "top" | "state">,
  saved: Pick<BrowserWindowSnapshot, "left" | "top" | "state">,
): boolean {
  return actual.state === saved.state
    && numberClose(actual.left, saved.left)
    && numberClose(actual.top, saved.top);
}

function describeGeometry(window: Pick<browser.windows.Window, "left" | "top" | "width" | "height" | "state">): string {
  return `left=${window.left ?? "?"}, top=${window.top ?? "?"}, width=${window.width ?? "?"}, height=${window.height ?? "?"}, state=${window.state ?? "?"}`;
}

async function restoreNormalGeometry(windowId: number, saved: BrowserWindowSnapshot): Promise<void> {
  await browser.windows.update(windowId, { state: "normal" });
  await delay(NORMAL_GEOMETRY_SETTLE_MS);

  const geometry: Parameters<typeof browser.windows.update>[1] = {};
  if (saved.left !== undefined) geometry.left = saved.left;
  if (saved.top !== undefined) geometry.top = saved.top;
  if (saved.width !== undefined) geometry.width = saved.width;
  if (saved.height !== undefined) geometry.height = saved.height;

  if (Object.keys(geometry).length === 0) return;

  let last: browser.windows.Window | undefined;
  for (let attempt = 0; attempt < NORMAL_GEOMETRY_RETRIES; attempt += 1) {
    await browser.windows.update(windowId, geometry);
    await delay(NORMAL_GEOMETRY_SETTLE_MS * (attempt + 1));
    last = await browser.windows.get(windowId).catch(() => undefined);
    if (last && normalWindowGeometryMatches(last, saved)) return;
  }

  throw new Error(
    `window bounds did not converge to the saved geometry after ${NORMAL_GEOMETRY_RETRIES} attempts; saved ${describeGeometry({ ...saved, state: "normal" })}; observed ${last ? describeGeometry(last) : "window unavailable"}`,
  );
}

async function stageWindowOnSavedMonitor(windowId: number, saved: BrowserWindowSnapshot): Promise<void> {
  await browser.windows.update(windowId, { state: "normal" });
  await delay(NORMAL_GEOMETRY_SETTLE_MS);

  const position: Parameters<typeof browser.windows.update>[1] = {};
  if (saved.left !== undefined) position.left = saved.left;
  if (saved.top !== undefined) position.top = saved.top;
  if (Object.keys(position).length === 0) return;

  let last: browser.windows.Window | undefined;
  for (let attempt = 0; attempt < NORMAL_GEOMETRY_RETRIES; attempt += 1) {
    await browser.windows.update(windowId, position);
    await delay(NORMAL_GEOMETRY_SETTLE_MS * (attempt + 1));
    last = await browser.windows.get(windowId).catch(() => undefined);
    if (
      last
      && (last.state === undefined || last.state === "normal")
      && numberClose(last.left, saved.left)
      && numberClose(last.top, saved.top)
    ) {
      return;
    }
  }

  throw new Error(
    `window did not move to the saved monitor position after ${NORMAL_GEOMETRY_RETRIES} attempts; saved left=${saved.left ?? "?"}, top=${saved.top ?? "?"}; observed ${last ? describeGeometry(last) : "window unavailable"}`,
  );
}

async function restoreNonNormalGeometry(windowId: number, saved: BrowserWindowSnapshot): Promise<void> {
  const current = await browser.windows.get(windowId).catch(() => undefined);
  if (current && savedWindowStateAndMonitorMatch(current, saved)) return;

  if (saved.state === "minimized") {
    await stageWindowOnSavedMonitor(windowId, saved);
    await browser.windows.update(windowId, { state: "minimized" });
    return;
  }

  let last: browser.windows.Window | undefined;
  for (let attempt = 0; attempt < NON_NORMAL_GEOMETRY_RETRIES; attempt += 1) {
    await stageWindowOnSavedMonitor(windowId, saved);
    await browser.windows.update(windowId, { state: saved.state });
    await delay(NORMAL_GEOMETRY_SETTLE_MS * (attempt + 1));
    last = await browser.windows.get(windowId).catch(() => undefined);
    if (last && savedWindowStateAndMonitorMatch(last, saved)) return;
  }

  throw new Error(
    `window did not converge to saved state/monitor after ${NON_NORMAL_GEOMETRY_RETRIES} attempts; saved ${describeGeometry(saved)}; observed ${last ? describeGeometry(last) : "window unavailable"}`,
  );
}

async function restoreGeometry(windowId: number, saved: BrowserWindowSnapshot): Promise<void> {
  if (saved.state === "normal") {
    await restoreNormalGeometry(windowId, saved);
    return;
  }
  await restoreNonNormalGeometry(windowId, saved);
}

async function restoreGroups(
  windowId: number,
  saved: BrowserWindowSnapshot,
  restoredByIndex: Map<number, browser.tabs.Tab>,
  report: RestoreReport,
): Promise<void> {
  const { tabs: tabsGrouping, groups: groupsApi } = groupingApis();
  if (!tabsGrouping || !groupsApi) {
    if (saved.groups.some(isPortableTabGroup)) {
      report.warnings.push("This Firefox version does not expose the tabGroups API; named tab groups were restored ungrouped.");
    }
    return;
  }

  for (const group of saved.groups) {
    if (!isPortableTabGroup(group)) continue;

    const tabIds = saved.tabs
      .filter((tab) => tab.group_key === group.key && !tab.pinned)
      .sort((a, b) => a.index - b.index)
      .map((tab) => restoredByIndex.get(tab.index)?.id)
      .filter((id): id is number => id !== undefined);
    if (tabIds.length === 0) continue;

    try {
      const groupId = await tabsGrouping.group({ tabIds, createProperties: { windowId } });
      await groupsApi.update(groupId, {
        title: group.title,
        color: group.color,
        collapsed: group.collapsed,
      });
      report.created_groups += 1;
    } catch (error) {
      report.warnings.push(
        `Failed to restore tab group '${group.title || group.key}': ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

function comparableLiveTab(tab: browser.tabs.Tab): ComparableLiveTab {
  const comparable: ComparableLiveTab = {
    index: tab.index,
    pinned: tab.pinned,
  };
  if (tab.url !== undefined) comparable.url = tab.url;
  if (tab.cookieStoreId !== undefined) comparable.cookieStoreId = tab.cookieStoreId;
  return comparable;
}

function liveTabs(current: browser.windows.Window): ComparableLiveTab[] {
  return (current.tabs ?? []).map(comparableLiveTab);
}

function disposableBootstrapWindow(current: browser.windows.Window): boolean {
  return isDisposableBootstrapTabs(liveTabs(current));
}

function liveWindowTopologiesMatch(left: browser.windows.Window, right: browser.windows.Window): boolean {
  const leftTabs = liveTabs(left).sort((a, b) => a.index - b.index);
  const rightTabs = liveTabs(right).sort((a, b) => a.index - b.index);
  if (leftTabs.length !== rightTabs.length) return false;

  return leftTabs.every((tab, index) => {
    const other = rightTabs[index];
    if (!other) return false;
    return (tab.url ?? "about:blank") === (other.url ?? "about:blank")
      && tab.pinned === other.pinned
      && (tab.cookieStoreId ?? undefined) === (other.cookieStoreId ?? undefined);
  });
}

function semanticTabKey(url: string, cookieStoreId: string | undefined): string {
  return `${cookieStoreId ?? ""}\u0000${url}`;
}

function multisetOverlap(left: string[], right: string[]): number {
  const counts = new Map<string, number>();
  for (const value of right) counts.set(value, (counts.get(value) ?? 0) + 1);

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

function reusableTabOverlap(saved: BrowserWindowSnapshot, current: browser.windows.Window): ReusableTabOverlap {
  const savedRelevant = saved.tabs.filter((tab) => tab.restorable && isRestorableUrl(tab.url));
  const liveRelevant = (current.tabs ?? []).filter((tab) => tab.url !== undefined && isRestorableUrl(tab.url));

  const savedKeys = savedRelevant.map((tab) => semanticTabKey(tab.url, tab.cookie_store_id));
  const liveKeys = liveRelevant.map((tab) => semanticTabKey(tab.url!, tab.cookieStoreId));
  const overlap = multisetOverlap(savedKeys, liveKeys);

  const savedUnpinned = savedRelevant.filter((tab) => !tab.pinned);
  const liveUnpinned = liveRelevant.filter((tab) => !tab.pinned);
  const unpinnedOverlap = multisetOverlap(
    savedUnpinned.map((tab) => semanticTabKey(tab.url, tab.cookie_store_id)),
    liveUnpinned.map((tab) => semanticTabKey(tab.url!, tab.cookieStoreId)),
  );

  // The user's common restore case is a live window that is literally a subset
  // of a saved window. Shared pinned Zen Essentials are not sufficient evidence
  // when the saved window also has ordinary tabs.
  const liveSubset = liveKeys.length > 0
    && overlap === liveKeys.length
    && (savedUnpinned.length === 0 || unpinnedOverlap > 0);

  return {
    overlap,
    savedRelevant: savedKeys.length,
    liveRelevant: liveKeys.length,
    unpinnedOverlap,
    savedUnpinnedRelevant: savedUnpinned.length,
    liveSubset,
  };
}

function geometryDistance(saved: BrowserWindowSnapshot, live: browser.windows.Window): number {
  let distance = 0;
  let observed = 0;
  for (const [savedValue, liveValue] of [
    [saved.left, live.left],
    [saved.top, live.top],
    [saved.width, live.width],
    [saved.height, live.height],
  ] as const) {
    if (savedValue === undefined || liveValue === undefined) continue;
    distance += Math.abs(savedValue - liveValue);
    observed += 1;
  }
  return observed > 0 ? distance : 1_000_000;
}

function buildExistingWindowMatch(
  saved: BrowserWindowSnapshot,
  current: browser.windows.Window,
): ExistingWindowMatch | undefined {
  if (current.id === undefined) return undefined;

  const similarity = savedWindowSimilarity(saved, liveTabs(current));
  const reuse = reusableTabOverlap(saved, current);
  const strongFuzzyIdentity = similarity.score > 0;

  const savedCoverage = reuse.savedRelevant > 0 ? reuse.overlap / reuse.savedRelevant : (similarity.exact ? 1 : 0);
  const liveCoverage = reuse.liveRelevant > 0 ? reuse.overlap / reuse.liveRelevant : (similarity.exact ? 1 : 0);
  const geometryScore = Math.max(0, 1_000_000 - Math.min(1_000_000, geometryDistance(saved, current)));
  const liveTabCount = current.tabs?.length ?? 0;
  const shellPreservationScore = Math.max(
    0,
    10_000_000 - Math.min(10_000_000, reuse.liveRelevant * 100_000 + liveTabCount * 10_000),
  );

  // The leading term makes total reusable tab count the global objective. The
  // smaller terms break ties in favor of exact/subset semantic identity, then
  // cheap shells (blank/fewer unrelated tabs), and finally saved geometry. A
  // final +1 keeps even a zero-overlap live window preferable to a dummy slot:
  // if a real window exists, reuse it before creating another one.
  const weight = reuse.overlap * WINDOW_REUSE_OVERLAP_WEIGHT
    + (similarity.exact ? 500_000_000 : 0)
    + (reuse.liveSubset ? 200_000_000 : 0)
    + (strongFuzzyIdentity ? 50_000_000 : 0)
    + Math.round(savedCoverage * 1_000) * 100_000
    + Math.round(liveCoverage * 1_000) * 100
    + shellPreservationScore
    + geometryScore
    + 1;

  return {
    window: current,
    exact: similarity.exact,
    score: similarity.score,
    overlap: reuse.overlap,
    savedRelevant: reuse.savedRelevant,
    liveRelevant: reuse.liveRelevant,
    liveSubset: reuse.liveSubset,
    weight,
  };
}

/**
 * Maximum-weight rectangular assignment (Hungarian algorithm). Each row may
 * choose one real column or its own zero-weight dummy column. This makes window
 * reuse a global optimization instead of a greedy first-match decision.
 */
export function maximumWeightAssignment(weights: number[][]): Array<number | undefined> {
  const rowCount = weights.length;
  if (rowCount === 0) return [];
  const realColumnCount = weights.reduce((maximum, row) => Math.max(maximum, row.length), 0);
  if (realColumnCount === 0) return Array<number | undefined>(rowCount).fill(undefined);

  const columnCount = realColumnCount + rowCount;
  let maximum = 0;
  for (const row of weights) {
    for (const weight of row) maximum = Math.max(maximum, weight);
  }

  const u = Array<number>(rowCount + 1).fill(0);
  const v = Array<number>(columnCount + 1).fill(0);
  const p = Array<number>(columnCount + 1).fill(0);
  const way = Array<number>(columnCount + 1).fill(0);

  for (let i = 1; i <= rowCount; i += 1) {
    p[0] = i;
    let j0 = 0;
    const minv = Array<number>(columnCount + 1).fill(Number.POSITIVE_INFINITY);
    const used = Array<boolean>(columnCount + 1).fill(false);

    do {
      used[j0] = true;
      const i0 = p[j0] ?? 0;
      let delta = Number.POSITIVE_INFINITY;
      let j1 = 0;

      for (let j = 1; j <= columnCount; j += 1) {
        if (used[j]) continue;
        const weight = j <= realColumnCount ? (weights[i0 - 1]?.[j - 1] ?? 0) : 0;
        const current = (maximum - weight) - (u[i0] ?? 0) - (v[j] ?? 0);
        if (current < (minv[j] ?? Number.POSITIVE_INFINITY)) {
          minv[j] = current;
          way[j] = j0;
        }
        if ((minv[j] ?? Number.POSITIVE_INFINITY) < delta) {
          delta = minv[j] ?? Number.POSITIVE_INFINITY;
          j1 = j;
        }
      }

      for (let j = 0; j <= columnCount; j += 1) {
        if (used[j]) {
          const row = p[j] ?? 0;
          u[row] = (u[row] ?? 0) + delta;
          v[j] = (v[j] ?? 0) - delta;
        } else {
          minv[j] = (minv[j] ?? Number.POSITIVE_INFINITY) - delta;
        }
      }
      j0 = j1;
    } while ((p[j0] ?? 0) !== 0);

    do {
      const j1 = way[j0] ?? 0;
      p[j0] = p[j1] ?? 0;
      j0 = j1;
    } while (j0 !== 0);
  }

  const result = Array<number | undefined>(rowCount).fill(undefined);
  for (let j = 1; j <= realColumnCount; j += 1) {
    const assignedRow = (p[j] ?? 0) - 1;
    if (assignedRow < 0) continue;
    const weight = weights[assignedRow]?.[j - 1] ?? 0;
    if (weight > 0) result[assignedRow] = j - 1;
  }
  return result;
}

function assignExistingWindows(
  savedWindows: BrowserWindowSnapshot[],
  currentWindows: browser.windows.Window[],
): Map<number, ExistingWindowMatch> {
  const candidateGrid = savedWindows.map((saved) =>
    currentWindows.map((current) => buildExistingWindowMatch(saved, current)),
  );
  const assignment = maximumWeightAssignment(
    candidateGrid.map((row) => row.map((candidate) => candidate?.weight ?? 0)),
  );

  const result = new Map<number, ExistingWindowMatch>();
  assignment.forEach((currentIndex, savedIndex) => {
    if (currentIndex === undefined) return;
    const candidate = candidateGrid[savedIndex]?.[currentIndex];
    if (candidate) result.set(savedIndex, candidate);
  });
  return result;
}

function sameTabSemanticIdentity(saved: BrowserTabSnapshot, live: browser.tabs.Tab): boolean {
  if (live.url === undefined || live.url !== saved.url) return false;
  return (live.cookieStoreId ?? undefined) === (saved.cookie_store_id ?? undefined);
}

function mapExistingTabs(saved: BrowserWindowSnapshot, current: browser.windows.Window): ExistingTabMap {
  const restoredByIndex = new Map<number, browser.tabs.Tab>();
  const reusedTabIds = new Set<number>();
  const available = (current.tabs ?? []).filter((tab) => tab.id !== undefined);

  for (const savedTab of [...saved.tabs].sort((a, b) => a.index - b.index)) {
    const candidates = available
      .filter((tab) =>
        tab.id !== undefined
        && !reusedTabIds.has(tab.id)
        && sameTabSemanticIdentity(savedTab, tab)
        // Zen Essentials are surfaced to WebExtensions only as ordinary pinned
        // tabs; their private zen-essential bit is not exposed. Never consume a
        // live pinned tab as an unpinned target, because doing so would require
        // unpinning it and could silently demote an Essential.
        && !(tab.pinned && !savedTab.pinned))
      .sort((left, right) => {
        const leftPinPenalty = left.pinned === savedTab.pinned ? 0 : 1;
        const rightPinPenalty = right.pinned === savedTab.pinned ? 0 : 1;
        return leftPinPenalty - rightPinPenalty
          || Math.abs(left.index - savedTab.index) - Math.abs(right.index - savedTab.index)
          || left.index - right.index;
      });
    const chosen = candidates[0];
    if (chosen?.id === undefined) continue;
    reusedTabIds.add(chosen.id);
    restoredByIndex.set(savedTab.index, chosen);
  }

  return { restoredByIndex, reusedTabIds };
}

async function reconcileTabs(
  saved: BrowserWindowSnapshot,
  restoredByIndex: Map<number, browser.tabs.Tab>,
  protectedPinnedIds: ReadonlySet<number> = new Set<number>(),
): Promise<void> {
  for (const savedTab of saved.tabs) {
    const tab = restoredByIndex.get(savedTab.index);
    if (tab?.id === undefined) continue;
    const changes: Parameters<typeof browser.tabs.update>[1] = {};
    if (tab.pinned !== savedTab.pinned) {
      // A tab that was already pinned before restore may be a Zen Essential.
      // Preserve that exact native tab object and its hidden Zen section state.
      if (!(protectedPinnedIds.has(tab.id) && tab.pinned && !savedTab.pinned)) {
        changes.pinned = savedTab.pinned;
      }
    }
    if (tab.mutedInfo?.muted !== savedTab.muted) changes.muted = savedTab.muted;
    if (Object.keys(changes).length > 0) {
      await browser.tabs.update(tab.id, changes).catch(() => undefined);
    }
  }

  const activeSaved = saved.tabs.find((tab) => tab.active);
  const activeRestored = activeSaved ? restoredByIndex.get(activeSaved.index) : undefined;
  const fallback = activeRestored ?? [...restoredByIndex.values()][0];
  if (fallback?.id !== undefined) {
    await browser.tabs.update(fallback.id, { active: true }).catch(() => undefined);
  }
}

function sameNumberOrder(actual: number[], expected: number[]): boolean {
  return actual.length === expected.length && actual.every((value, index) => value === expected[index]);
}

async function orderRestoredTabs(
  saved: BrowserWindowSnapshot,
  restoredByIndex: Map<number, browser.tabs.Tab>,
  windowId: number,
  protectedPinnedIds: ReadonlySet<number> = new Set<number>(),
): Promise<boolean> {
  const sortedSaved = [...saved.tabs].sort((a, b) => a.index - b.index);
  const desiredMutablePinnedIds: number[] = [];
  const desiredUnpinnedIds: number[] = [];

  for (const savedTab of sortedSaved) {
    const tab = restoredByIndex.get(savedTab.index);
    if (tab?.id === undefined || protectedPinnedIds.has(tab.id)) continue;
    if (savedTab.pinned) desiredMutablePinnedIds.push(tab.id);
    else desiredUnpinnedIds.push(tab.id);
  }

  for (let attempt = 0; attempt < TAB_ORDER_RETRIES; attempt += 1) {
    let current = await browser.windows.get(windowId, { populate: true }).catch(() => undefined);
    if (!current) return false;

    // Do not move original pinned tabs at all. Zen keeps Essentials at the
    // beginning of its pinned region using a private attribute; moving those
    // tabs through the generic WebExtension API can collapse that distinction.
    const protectedPinnedCount = (current.tabs ?? []).filter(
      (tab) => tab.id !== undefined && tab.pinned && protectedPinnedIds.has(tab.id),
    ).length;
    for (const [rank, id] of desiredMutablePinnedIds.entries()) {
      await browser.tabs.move(id, { windowId, index: protectedPinnedCount + rank }).catch(() => undefined);
    }

    current = await browser.windows.get(windowId, { populate: true }).catch(() => undefined);
    if (!current) return false;
    const pinnedCount = (current.tabs ?? []).filter((tab) => tab.pinned).length;
    for (const [rank, id] of desiredUnpinnedIds.entries()) {
      await browser.tabs.move(id, { windowId, index: pinnedCount + rank }).catch(() => undefined);
    }

    await delay(TAB_ORDER_SETTLE_MS * (attempt + 1));
    current = await browser.windows.get(windowId, { populate: true }).catch(() => undefined);
    if (!current) return false;

    const mutablePinnedSet = new Set(desiredMutablePinnedIds);
    const unpinnedSet = new Set(desiredUnpinnedIds);
    const actualMutablePinned = (current.tabs ?? [])
      .filter((tab) => tab.id !== undefined && tab.pinned && mutablePinnedSet.has(tab.id))
      .map((tab) => tab.id as number);
    const actualUnpinned = (current.tabs ?? [])
      .filter((tab) => tab.id !== undefined && !tab.pinned && unpinnedSet.has(tab.id))
      .map((tab) => tab.id as number);

    if (
      sameNumberOrder(actualMutablePinned, desiredMutablePinnedIds)
      && sameNumberOrder(actualUnpinned, desiredUnpinnedIds)
    ) {
      return true;
    }
  }

  return false;
}

async function reuseAssignedWindow(
  saved: BrowserWindowSnapshot,
  match: ExistingWindowMatch,
  report: RestoreReport,
): Promise<number> {
  if (match.window.id === undefined) throw new Error("Firefox returned an existing window without an ID");
  const windowId = match.window.id;
  const current = await browser.windows.get(windowId, { populate: true });
  const { restoredByIndex, reusedTabIds } = mapExistingTabs(saved, current);
  const originalTabIds = (current.tabs ?? [])
    .map((tab) => tab.id)
    .filter((id): id is number => id !== undefined);
  const protectedPinnedIds = new Set(
    (current.tabs ?? [])
      .filter((tab) => tab.id !== undefined && tab.pinned)
      .map((tab) => tab.id as number),
  );
  const reusedCount = restoredByIndex.size;

  for (const savedTab of [...saved.tabs].sort((a, b) => a.index - b.index)) {
    if (restoredByIndex.has(savedTab.index)) continue;
    if (!savedTab.restorable) {
      report.warnings.push(
        `Could not recreate non-restorable tab '${savedTab.title ?? savedTab.url}' in ${saved.key}; any already-open matching privileged tab would have been reused.`,
      );
      continue;
    }

    try {
      const restored = await createTab(windowId, savedTab, report.warnings);
      restoredByIndex.set(savedTab.index, restored);
      report.created_tabs += 1;
    } catch (error) {
      report.warnings.push(
        `Failed to complete '${savedTab.title ?? savedTab.url}' in reused ${saved.key}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  // Only delete live extras once at least one target tab is known to be present.
  // Existing pinned tabs are deliberately excluded: Zen does not expose the
  // private zen-essential flag through the WebExtension tabs API, so deleting a
  // pinned "extra" could destroy an Essential that Zen itself is responsible
  // for persisting across Spaces/windows.
  const extraTabIds = originalTabIds.filter(
    (id) => !reusedTabIds.has(id) && !protectedPinnedIds.has(id),
  );
  if (restoredByIndex.size > 0) {
    for (const id of extraTabIds) {
      await browser.tabs.remove(id).catch(() => undefined);
    }
  } else if (extraTabIds.length > 0) {
    report.warnings.push(
      `Context Capsule could not establish any target tab in ${saved.key}; its existing tabs were left untouched instead of risking an empty window.`,
    );
  }

  await reconcileTabs(saved, restoredByIndex, protectedPinnedIds);
  const preGroupOrder = await orderRestoredTabs(saved, restoredByIndex, windowId, protectedPinnedIds);
  await restoreGroups(windowId, saved, restoredByIndex, report);
  const finalOrder = await orderRestoredTabs(saved, restoredByIndex, windowId, protectedPinnedIds);
  if (!preGroupOrder || !finalOrder) {
    report.warnings.push(
      `Tab order for ${saved.key} did not fully converge after ${TAB_ORDER_RETRIES} verified placement attempts; existing Zen pinned/Essential tabs were preserved rather than moved destructively.`,
    );
  }
  await restoreGeometry(windowId, saved).catch((error) => {
    report.warnings.push(
      `Could not reconcile geometry for ${saved.key}: ${error instanceof Error ? error.message : String(error)}`,
    );
  });

  report.reused_windows += 1;
  report.reused_tabs += reusedCount;

  return windowId;
}

async function populateWindow(
  windowId: number,
  bootstrapTabId: number | undefined,
  saved: BrowserWindowSnapshot,
  report: RestoreReport,
): Promise<void> {
  const restoredByIndex = new Map<number, browser.tabs.Tab>();
  for (const savedTab of [...saved.tabs].sort((a, b) => a.index - b.index)) {
    if (!savedTab.restorable) continue;

    try {
      const restored = await createTab(windowId, savedTab, report.warnings);
      restoredByIndex.set(savedTab.index, restored);
      report.created_tabs += 1;
    } catch (error) {
      report.warnings.push(
        `Failed to restore '${savedTab.title ?? savedTab.url}': ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  if (bootstrapTabId !== undefined && restoredByIndex.size > 0) {
    await browser.tabs.remove(bootstrapTabId).catch(() => undefined);
  }

  await reconcileTabs(saved, restoredByIndex);
  const preGroupOrder = await orderRestoredTabs(saved, restoredByIndex, windowId);
  await restoreGroups(windowId, saved, restoredByIndex, report);
  const finalOrder = await orderRestoredTabs(saved, restoredByIndex, windowId);
  if (!preGroupOrder || !finalOrder) {
    report.warnings.push(
      `Tab order for ${saved.key} did not fully converge after ${TAB_ORDER_RETRIES} verified placement attempts.`,
    );
  }
  await restoreGeometry(windowId, saved).catch((error) => {
    report.warnings.push(
      `Could not restore geometry for ${saved.key}: ${error instanceof Error ? error.message : String(error)}`,
    );
  });
}

async function reuseBootstrapWindow(
  saved: BrowserWindowSnapshot,
  current: browser.windows.Window,
  report: RestoreReport,
): Promise<number> {
  if (current.id === undefined) throw new Error("Firefox returned a bootstrap window without an ID");
  const bootstrapTabId = current.tabs?.[0]?.id;
  await populateWindow(current.id, bootstrapTabId, saved, report);
  report.reused_windows += 1;
  return current.id;
}

async function waitForStableNewDisposableWindow(
  before: Set<number>,
  timeoutMs = NATIVE_BLANK_WINDOW_TIMEOUT_MS,
): Promise<NewWindowObservation> {
  const deadline = Date.now() + timeoutMs;
  const observedNewIds = new Set<number>();
  const transientDisposableIds = new Set<number>();
  let stableId: number | undefined;
  let stableSince = 0;

  while (Date.now() < deadline) {
    const windows = await browser.windows.getAll({ populate: true, windowTypes: ["normal"] });
    const fresh = windows.filter((window) =>
      window.id !== undefined
      && !before.has(window.id)
      && !window.incognito);

    for (const window of fresh) {
      if (window.id !== undefined) observedNewIds.add(window.id);
    }

    if (observedNewIds.size > 1) {
      stableId = undefined;
      stableSince = 0;
      await delay(NATIVE_BLANK_WINDOW_POLL_MS);
      continue;
    }

    const candidate = fresh.find(disposableBootstrapWindow);
    if (candidate?.id !== undefined) {
      transientDisposableIds.add(candidate.id);
      if (stableId !== candidate.id) {
        stableId = candidate.id;
        stableSince = Date.now();
      } else if (Date.now() - stableSince >= NATIVE_BLANK_WINDOW_STABLE_MS) {
        return { window: candidate, observedNewIds, transientDisposableIds };
      }
    } else {
      stableId = undefined;
      stableSince = 0;
    }

    await delay(NATIVE_BLANK_WINDOW_POLL_MS);
  }

  return { observedNewIds, transientDisposableIds };
}

async function cleanupUnsafeNativeWindows(
  observation: NewWindowObservation,
  beforeWindows: browser.windows.Window[],
): Promise<number> {
  if (observation.observedNewIds.size !== 1) return 0;

  const [id] = observation.observedNewIds;
  if (id === undefined || !observation.transientDisposableIds.has(id)) return 0;
  const current = await browser.windows.get(id, { populate: true }).catch(() => undefined);
  if (!current) return 0;

  const mirrorsExisting = beforeWindows.some((before) => liveWindowTopologiesMatch(before, current));
  if (!mirrorsExisting) return 0;

  return browser.windows.remove(id).then(() => 1).catch(() => 0);
}

async function tryCreateNativeBlankWindow(
  saved: BrowserWindowSnapshot,
  report: RestoreReport,
  options: RestoreOptions,
): Promise<number | "unsupported" | undefined> {
  if (!options.createBlankWindow) return "unsupported";

  const beforeWindows = (await browser.windows.getAll({ populate: true, windowTypes: ["normal"] }))
    .filter((window) => !window.incognito);
  const before = new Set(beforeWindows.map((window) => window.id).filter((id): id is number => id !== undefined));

  let outcome: NativeBlankWindowResult;
  try {
    outcome = await options.createBlankWindow();
  } catch (error) {
    report.warnings.push(
      `Could not create the independent browser window for ${saved.key}: ${error instanceof Error ? error.message : String(error)}. Existing tabs were left untouched.`,
    );
    return undefined;
  }
  if (outcome === "unsupported") return "unsupported";

  const observation = await waitForStableNewDisposableWindow(before);
  const blank = observation.window;
  if (blank?.id === undefined) {
    const closed = await cleanupUnsafeNativeWindows(observation, beforeWindows);
    report.warnings.push(
      `Zen did not produce one stable isolated blank window for ${saved.key}. Context Capsule refused to inject saved tabs into a synchronized, mirrored, or ambiguous new window${closed > 0 ? " and closed the single attributable mirrored window created by the attempt" : ""}. Existing browser state was left untouched.`,
    );
    return undefined;
  }

  const confirmed = await browser.windows.get(blank.id, { populate: true }).catch(() => undefined);
  const confirmedId = confirmed?.id;
  if (confirmedId === undefined || !confirmed || !disposableBootstrapWindow(confirmed)) {
    const closed = await cleanupUnsafeNativeWindows(observation, beforeWindows);
    report.warnings.push(
      `Zen changed the new blank window before ${saved.key} could be populated. Context Capsule aborted the restore${closed > 0 ? " and closed the single attributable mirrored window" : ""} rather than risk changing an existing synchronized Space.`,
    );
    return undefined;
  }

  await populateWindow(confirmedId, confirmed.tabs?.[0]?.id, saved, report);
  report.created_windows += 1;
  return confirmedId;
}

async function createStandardFirefoxWindow(
  saved: BrowserWindowSnapshot,
  report: RestoreReport,
): Promise<number | undefined> {
  const created = await browser.windows.create({ url: "about:blank", focused: false, state: "normal" });
  if (created.id === undefined) throw new Error("Firefox created a window without an ID");

  await delay(NEW_WINDOW_SETTLE_MS);
  const settled = await browser.windows.get(created.id, { populate: true }).catch(() => created);
  if (!disposableBootstrapWindow(settled)) {
    report.warnings.push(
      `Firefox created ${saved.key} with unexpected user tabs; the new window was closed without modifying them.`,
    );
    await browser.windows.remove(created.id).catch(() => undefined);
    return undefined;
  }

  await populateWindow(created.id, settled.tabs?.[0]?.id, saved, report);
  report.created_windows += 1;
  return created.id;
}

async function createSavedWindow(
  saved: BrowserWindowSnapshot,
  report: RestoreReport,
  options: RestoreOptions,
): Promise<number | undefined> {
  const nativeResult = await tryCreateNativeBlankWindow(saved, report, options);
  if (nativeResult !== "unsupported") return nativeResult;
  return createStandardFirefoxWindow(saved, report);
}

export async function restoreFirefoxSnapshot(
  snapshot: FirefoxSnapshot,
  options: RestoreOptions = {},
): Promise<RestoreReport> {
  const report: RestoreReport = {
    created_windows: 0,
    created_tabs: 0,
    created_groups: 0,
    reused_windows: 0,
    reused_tabs: 0,
    warnings: [],
  };

  const currentWindows = (await browser.windows.getAll({ populate: true, windowTypes: ["normal"] }))
    .filter((window) => !window.incognito);

  // Compute all semantic window candidates before creating anything. The
  // Hungarian assignment maximizes total already-open tab reuse across the
  // complete restore, so an early saved window cannot steal a better candidate
  // from a later one.
  const existingMatches = assignExistingWindows(snapshot.windows, currentWindows);
  const reservedWindowIds = new Set(
    [...existingMatches.values()]
      .map((match) => match.window.id)
      .filter((id): id is number => id !== undefined),
  );
  const usedWindowIds = new Set<number>();

  let focusedWindowId: number | undefined;
  let restoredWindowCount = 0;
  for (const [savedIndex, savedWindow] of snapshot.windows.entries()) {
    const existing = existingMatches.get(savedIndex);

    let id: number | undefined;
    if (existing) {
      id = await reuseAssignedWindow(savedWindow, existing, report);
    } else {
      const bootstrap = currentWindows.find((window) =>
        window.id !== undefined
        && !usedWindowIds.has(window.id)
        && !reservedWindowIds.has(window.id)
        && disposableBootstrapWindow(window));
      if (bootstrap) {
        id = await reuseBootstrapWindow(savedWindow, bootstrap, report);
      } else {
        id = await createSavedWindow(savedWindow, report, options);
      }
    }

    if (id !== undefined) {
      usedWindowIds.add(id);
      restoredWindowCount += 1;
      if (savedWindow.focused) focusedWindowId = id;
    }
  }

  // Preserve unrelated windows if any saved window failed. Once the complete
  // target topology exists, remove only original live windows that are both
  // unassigned and free of pinned state. A pinned tab may be a Zen Essential,
  // and the WebExtension API cannot tell us safely whether closing its entire
  // window would destroy private Zen-owned state.
  if (snapshot.windows.length > 0 && restoredWindowCount === snapshot.windows.length) {
    let preservedPinnedWindows = 0;
    for (const current of currentWindows) {
      if (current.id === undefined || usedWindowIds.has(current.id)) continue;
      if ((current.tabs ?? []).some((tab) => tab.pinned)) {
        preservedPinnedWindows += 1;
        continue;
      }
      await browser.windows.remove(current.id).catch(() => undefined);
    }
    if (preservedPinnedWindows > 0) {
      report.warnings.push(
        `Preserved ${preservedPinnedWindows} unassigned live browser window(s) because they contain pre-existing pinned tabs that may carry Zen Essential state.`,
      );
    }
  } else if (currentWindows.some((window) => window.id !== undefined && !usedWindowIds.has(window.id))) {
    report.warnings.push(
      "Some saved browser windows could not be restored, so unrelated live windows were preserved instead of being closed during a partial restore.",
    );
  }

  if (focusedWindowId !== undefined) {
    await browser.windows.update(focusedWindowId, { focused: true }).catch(() => undefined);
  }
  return report;
}
