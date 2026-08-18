import {
  type BrowserTabSnapshot,
  type BrowserWindowSnapshot,
  type ComparableLiveTab,
  type FirefoxSnapshot,
  type RestoreReport,
  isDisposableBootstrapTabs,
  isPortableTabGroup,
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
const NORMAL_GEOMETRY_TOLERANCE = 8;

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

function describeGeometry(window: Pick<browser.windows.Window, "left" | "top" | "width" | "height" | "state">): string {
  return `left=${window.left ?? "?"}, top=${window.top ?? "?"}, width=${window.width ?? "?"}, height=${window.height ?? "?"}, state=${window.state ?? "?"}`;
}

async function restoreNormalGeometry(windowId: number, saved: BrowserWindowSnapshot): Promise<void> {
  // Firefox does not allow non-normal state and explicit geometry in the same
  // update. Zen can also re-layout a newborn native window shortly after it is
  // created, so normalize first and verify the saved rectangle until it sticks.
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

async function restoreGeometry(windowId: number, saved: BrowserWindowSnapshot): Promise<void> {
  if (saved.state === "normal") {
    await restoreNormalGeometry(windowId, saved);
    return;
  }

  await browser.windows.update(windowId, { state: saved.state });
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
    // Anonymous group identifiers can also represent Zen-specific relationships
    // such as split views, so only named/portable groups are synthesized.
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

function assignExistingWindows(
  savedWindows: BrowserWindowSnapshot[],
  currentWindows: browser.windows.Window[],
): Map<number, ExistingWindowMatch> {
  const candidates: Array<ExistingWindowMatch & { savedIndex: number; windowId: number }> = [];

  savedWindows.forEach((saved, savedIndex) => {
    for (const current of currentWindows) {
      if (current.id === undefined) continue;
      const similarity = savedWindowSimilarity(saved, liveTabs(current));
      if (similarity.score <= 0) continue;
      candidates.push({
        savedIndex,
        windowId: current.id,
        window: current,
        ...similarity,
      });
    }
  });

  candidates.sort((left, right) =>
    right.score - left.score
    || right.overlap - left.overlap
    || left.savedIndex - right.savedIndex
    || left.windowId - right.windowId);

  const assignedSaved = new Set<number>();
  const assignedWindows = new Set<number>();
  const result = new Map<number, ExistingWindowMatch>();

  for (const candidate of candidates) {
    if (assignedSaved.has(candidate.savedIndex) || assignedWindows.has(candidate.windowId)) continue;
    assignedSaved.add(candidate.savedIndex);
    assignedWindows.add(candidate.windowId);
    result.set(candidate.savedIndex, candidate);
  }

  return result;
}

function mapExistingTabs(saved: BrowserWindowSnapshot, current: browser.windows.Window): Map<number, browser.tabs.Tab> {
  const result = new Map<number, browser.tabs.Tab>();
  const currentTabs = [...(current.tabs ?? [])].sort((a, b) => a.index - b.index);
  const savedTabs = [...saved.tabs].sort((a, b) => a.index - b.index);
  savedTabs.forEach((savedTab, index) => {
    const currentTab = currentTabs[index];
    if (currentTab) result.set(savedTab.index, currentTab);
  });
  return result;
}

async function reconcileTabs(
  saved: BrowserWindowSnapshot,
  restoredByIndex: Map<number, browser.tabs.Tab>,
): Promise<void> {
  for (const savedTab of saved.tabs) {
    const tab = restoredByIndex.get(savedTab.index);
    if (tab?.id === undefined) continue;
    if (tab.mutedInfo?.muted !== savedTab.muted) {
      await browser.tabs.update(tab.id, { muted: savedTab.muted }).catch(() => undefined);
    }
  }

  const activeSaved = saved.tabs.find((tab) => tab.active);
  const activeRestored = activeSaved ? restoredByIndex.get(activeSaved.index) : undefined;
  const fallback = activeRestored ?? [...restoredByIndex.values()][0];
  if (fallback?.id !== undefined) {
    await browser.tabs.update(fallback.id, { active: true }).catch(() => undefined);
  }
}

async function reuseSatisfiedWindow(
  saved: BrowserWindowSnapshot,
  current: browser.windows.Window,
  report: RestoreReport,
): Promise<number> {
  if (current.id === undefined) throw new Error("Firefox returned an existing window without an ID");
  const windowId = current.id;
  const restoredByIndex = mapExistingTabs(saved, current);
  await reconcileTabs(saved, restoredByIndex);
  await restoreGroups(windowId, saved, restoredByIndex, report);
  await restoreGeometry(windowId, saved).catch((error) => {
    report.warnings.push(
      `Could not reconcile geometry for ${saved.key}: ${error instanceof Error ? error.message : String(error)}`,
    );
  });
  report.reused_windows += 1;
  report.reused_tabs += restoredByIndex.size;
  return windowId;
}

async function reuseSimilarWindow(
  saved: BrowserWindowSnapshot,
  match: ExistingWindowMatch,
  report: RestoreReport,
): Promise<number> {
  if (match.window.id === undefined) throw new Error("Firefox returned an existing window without an ID");

  report.reused_windows += 1;
  report.reused_tabs += match.overlap;
  report.warnings.push(
    `Reused ${saved.key} from strong tab overlap (${match.overlap}/${match.savedRelevant} saved restorable tabs, ${match.liveRelevant} live restorable tabs). Because the live window has changed since capture, Context Capsule left its tabs, active tab, groups, state, size, and position untouched rather than risk mutating the wrong Zen window.`,
  );
  return match.window.id;
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

  // Never remove a startup tab until at least one saved tab was created. A
  // partial restore failure must not leave an empty browser window behind.
  if (bootstrapTabId !== undefined && restoredByIndex.size > 0) {
    await browser.tabs.remove(bootstrapTabId).catch(() => undefined);
  }

  await restoreGroups(windowId, saved, restoredByIndex, report);
  await reconcileTabs(saved, restoredByIndex);
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

    // If more than one window appeared during this native attempt, attribution
    // is ambiguous. Do not choose or mutate either one.
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
  // We cannot map a Firefox window ID to the native HWND that --blank-window
  // created. Cleanup therefore happens only when attribution is unusually
  // strong: exactly one new window appeared, it was first observed as the
  // disposable native candidate, and it later became an exact mirror of a
  // window that existed before the attempt. Otherwise fail closed and leave it.
  if (observation.observedNewIds.size !== 1) return 0;

  const [id] = observation.observedNewIds;
  if (id === undefined || !observation.transientDisposableIds.has(id)) return 0;
  const current = await browser.windows.get(id, { populate: true }).catch(() => undefined);
  if (!current) return 0;

  const mirrorsExisting = beforeWindows.some((before) => liveWindowTopologiesMatch(before, current));
  if (!mirrorsExisting) return 0;

  return browser.windows.remove(id).then(() => 1).catch(() => 0);
}

/**
 * Returns "unsupported" only when the native host explicitly says that the
 * current browser is not Zen. Undefined means a native Zen attempt failed and
 * callers must not fall back to browser.windows.create(), because doing so can
 * mutate a synchronized Zen Space.
 */
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

  // Re-read immediately before mutation. A candidate that was blank during the
  // stability interval can still have been changed by Zen Window Sync.
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

  // Match all already-open windows first, before creating anything. This avoids
  // a newly created Zen window competing with a saved window that was already
  // satisfied when restore began.
  const existingMatches = assignExistingWindows(snapshot.windows, currentWindows);
  const reservedWindowIds = new Set(
    [...existingMatches.values()]
      .map((match) => match.window.id)
      .filter((id): id is number => id !== undefined),
  );
  const usedWindowIds = new Set<number>();

  let focusedWindowId: number | undefined;
  for (const [savedIndex, savedWindow] of snapshot.windows.entries()) {
    const existing = existingMatches.get(savedIndex);

    let id: number | undefined;
    if (existing) {
      id = existing.exact
        ? await reuseSatisfiedWindow(savedWindow, existing.window, report)
        : await reuseSimilarWindow(savedWindow, existing, report);
      usedWindowIds.add(id);
    } else {
      const bootstrap = currentWindows.find((window) =>
        window.id !== undefined
        && !usedWindowIds.has(window.id)
        && !reservedWindowIds.has(window.id)
        && disposableBootstrapWindow(window));
      if (bootstrap) {
        id = await reuseBootstrapWindow(savedWindow, bootstrap, report);
        usedWindowIds.add(id);
      } else {
        id = await createSavedWindow(savedWindow, report, options);
      }
    }
    if (id !== undefined) {
      usedWindowIds.add(id);
      if (savedWindow.focused) focusedWindowId = id;
    }
  }

  if (focusedWindowId !== undefined) {
    await browser.windows.update(focusedWindowId, { focused: true }).catch(() => undefined);
  }
  return report;
}
