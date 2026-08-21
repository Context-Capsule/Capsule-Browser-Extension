import {
  type BrowserSplitOrientation,
  type BrowserTabSnapshot,
  type BrowserWindowSnapshot,
  type FirefoxSnapshot,
  isSplitViewGroup,
  splitOrientationFromGroup,
} from "./model";

type ExtendedTab = browser.tabs.Tab & {
  groupId?: number;
  splitViewId?: number;
};

interface TabGroupsApi {
  query(queryInfo: { windowId?: number }): Promise<Array<{ id: number; title: string }>>;
}

export interface SplitRestoreResult {
  restored: number;
  alreadySatisfied: number;
  warnings: string[];
}

export type ZenSplitInvoker = (orientation: BrowserSplitOrientation) => Promise<void>;

const SPLIT_VERIFY_TIMEOUT_MS = 700;
const SPLIT_VERIFY_POLL_MS = 35;
const SPLIT_INVOKE_ATTEMPTS = 3;
const SPLIT_FOCUS_SETTLE_MS = 45;

function delay(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function tabGroupsApi(): TabGroupsApi | undefined {
  return (browser as unknown as { tabGroups?: TabGroupsApi }).tabGroups;
}

function sameSemanticTab(saved: BrowserTabSnapshot, live: ExtendedTab): boolean {
  return live.url === saved.url
    && (live.cookieStoreId ?? undefined) === (saved.cookie_store_id ?? undefined);
}

function mapSavedTabsToLive(
  saved: BrowserWindowSnapshot,
  live: browser.windows.Window,
): Map<number, ExtendedTab> {
  const result = new Map<number, ExtendedTab>();
  const used = new Set<number>();
  const available = (live.tabs ?? []) as ExtendedTab[];

  for (const savedTab of [...saved.tabs].sort((left, right) => left.index - right.index)) {
    const candidates = available
      .filter(tab => tab.id !== undefined && !used.has(tab.id) && sameSemanticTab(savedTab, tab))
      .sort((left, right) => {
        const leftPinPenalty = left.pinned === savedTab.pinned ? 0 : 1;
        const rightPinPenalty = right.pinned === savedTab.pinned ? 0 : 1;
        return leftPinPenalty - rightPinPenalty
          || Math.abs(left.index - savedTab.index) - Math.abs(right.index - savedTab.index)
          || left.index - right.index;
      });
    const chosen = candidates[0];
    if (chosen?.id === undefined) continue;
    used.add(chosen.id);
    result.set(savedTab.index, chosen);
  }
  return result;
}

function geometryDistance(saved: BrowserWindowSnapshot, live: browser.windows.Window): number {
  let distance = 0;
  for (const [expected, actual] of [
    [saved.left, live.left],
    [saved.top, live.top],
    [saved.width, live.width],
    [saved.height, live.height],
  ] as const) {
    if (expected !== undefined && actual !== undefined) distance += Math.abs(expected - actual);
  }
  return distance;
}

function savedSplitGroups(saved: BrowserWindowSnapshot) {
  return saved.groups
    .filter(isSplitViewGroup)
    .map(group => ({
      group,
      orientation: splitOrientationFromGroup(group)!,
      tabs: saved.tabs
        .filter(tab => tab.group_key === group.key)
        .sort((left, right) => left.index - right.index),
    }))
    .filter(split => split.tabs.length >= 2 && split.tabs.length <= 4);
}

async function tabsFormRealSplit(windowId: number, tabs: ExtendedTab[]): Promise<boolean> {
  if (tabs.length < 2) return false;

  const explicit = tabs.map(tab => tab.splitViewId);
  if (
    explicit.every(id => typeof id === "number" && id >= 0)
    && explicit.every(id => id === explicit[0])
  ) {
    return true;
  }

  const groupIds = tabs.map(tab => tab.groupId);
  if (
    !groupIds.every(id => typeof id === "number" && id >= 0)
    || !groupIds.every(id => id === groupIds[0])
  ) {
    return false;
  }

  const groups = await tabGroupsApi()?.query({ windowId }).catch(() => []) ?? [];
  const group = groups.find(candidate => candidate.id === groupIds[0]);
  return group?.title.trim().length === 0;
}

async function refreshedTabs(ids: number[]): Promise<ExtendedTab[]> {
  const result: ExtendedTab[] = [];
  for (const id of ids) {
    const tab = await browser.tabs.get(id).catch(() => undefined) as ExtendedTab | undefined;
    if (tab) result.push(tab);
  }
  return result;
}

async function waitForRealSplit(windowId: number, ids: number[]): Promise<boolean> {
  const deadline = Date.now() + SPLIT_VERIFY_TIMEOUT_MS;
  do {
    const tabs = await refreshedTabs(ids);
    if (tabs.length === ids.length && await tabsFormRealSplit(windowId, tabs)) return true;
    if (Date.now() >= deadline) return false;
    await delay(SPLIT_VERIFY_POLL_MS);
  } while (true);
}

/**
 * Reassert the exact multi-selection before every native attempt. Native input
 * can change focus/selection even when it fails to dispatch the command, so a
 * retry must never inherit the previous attempt's transient UI state.
 */
async function prepareSplitSelection(windowId: number, ids: number[]): Promise<boolean> {
  const current = await refreshedTabs(ids);
  if (current.length !== ids.length) return false;
  const indices = current.map(tab => tab.index).sort((left, right) => left - right);
  await browser.tabs.highlight({ windowId, tabs: indices });
  await browser.windows.update(windowId, { focused: true });

  const selected = await refreshedTabs(ids);
  if (selected.length !== ids.length) return false;
  const highlighted = selected.filter(tab => tab.highlighted).length;
  // Firefox/Zen always has one active tab. `tabs.highlight` should expose all
  // requested members as highlighted; verify that state instead of assuming it.
  if (highlighted !== ids.length) return false;
  await delay(SPLIT_FOCUS_SETTLE_MS);
  return true;
}

export async function restoreSavedSplitViews(
  snapshot: FirefoxSnapshot,
  invokeZenSplit: ZenSplitInvoker,
): Promise<SplitRestoreResult> {
  const result: SplitRestoreResult = { restored: 0, alreadySatisfied: 0, warnings: [] };
  const savedWithSplits = snapshot.windows.filter(window => savedSplitGroups(window).length > 0);
  if (savedWithSplits.length === 0) return result;

  const liveWindows = (await browser.windows.getAll({ populate: true, windowTypes: ["normal"] }))
    .filter(window => !window.incognito && window.id !== undefined);
  const usedLiveWindowIds = new Set<number>();

  for (const saved of savedWithSplits) {
    const splits = savedSplitGroups(saved);
    const candidates = liveWindows
      .filter(window => window.id !== undefined && !usedLiveWindowIds.has(window.id))
      .map(window => {
        const mapping = mapSavedTabsToLive(saved, window);
        const splitMembersPresent = splits.every(split => split.tabs.every(tab => mapping.has(tab.index)));
        return {
          window,
          mapping,
          splitMembersPresent,
          score: mapping.size * 1_000_000_000 - geometryDistance(saved, window),
        };
      })
      .filter(candidate => candidate.splitMembersPresent)
      .sort((left, right) => right.score - left.score);

    const candidate = candidates[0];
    const windowId = candidate?.window.id;
    if (windowId === undefined || !candidate) {
      result.warnings.push(`Could not identify the restored live window for split relationships in ${saved.key}.`);
      continue;
    }
    usedLiveWindowIds.add(windowId);

    for (const split of splits) {
      if (split.tabs.some(tab => tab.pinned)) {
        result.warnings.push(
          `Skipped split '${split.group.key}' in ${saved.key} because it contains pinned tabs; Context Capsule does not modify Zen Essential/pinned semantics.`,
        );
        continue;
      }

      const mapped = split.tabs
        .map(tab => candidate.mapping.get(tab.index))
        .filter((tab): tab is ExtendedTab => tab?.id !== undefined);
      if (mapped.length !== split.tabs.length) {
        result.warnings.push(`Could not map every tab for split '${split.group.key}' in ${saved.key}.`);
        continue;
      }
      const ids = mapped.map(tab => tab.id as number);
      if (await tabsFormRealSplit(windowId, mapped)) {
        result.alreadySatisfied += 1;
        continue;
      }

      let restored = false;
      let lastError: string | undefined;
      for (let attempt = 1; attempt <= SPLIT_INVOKE_ATTEMPTS; attempt += 1) {
        if (!(await prepareSplitSelection(windowId, ids))) {
          lastError = "the exact saved tabs could not be re-selected before invoking Zen";
          break;
        }

        try {
          await invokeZenSplit(split.orientation);
        } catch (error) {
          lastError = error instanceof Error ? error.message : String(error);
          continue;
        }

        if (await waitForRealSplit(windowId, ids)) {
          restored = true;
          break;
        }
        lastError = `Zen accepted native attempt ${attempt}, but the tabs never acquired a shared split identity`;
      }

      if (restored) {
        result.restored += 1;
      } else {
        result.warnings.push(
          `Zen did not form a verified ${split.orientation} split for '${split.group.key}' in ${saved.key} after ${SPLIT_INVOKE_ATTEMPTS} clean attempt(s)${lastError ? `; ${lastError}` : ""}. The tabs were left intact.`,
        );
      }
    }
  }

  return result;
}
