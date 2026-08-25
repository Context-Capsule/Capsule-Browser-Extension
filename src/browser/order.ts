import {
  isDisposableBootstrapTabs,
  type BrowserTabSnapshot,
  type BrowserWindowSnapshot,
  type FirefoxSnapshot,
} from "./model";
import { maximumWeightAssignment } from "./restore";

type ExtendedTab = browser.tabs.Tab & {
  groupId?: number;
  splitViewId?: number;
};

interface TabGroupsApi {
  move?(
    groupId: number,
    moveProperties: { index: number; windowId?: number },
  ): Promise<unknown>;
}

interface SavedWindowMatch {
  window: browser.windows.Window;
  mappedBySavedIndex: Map<number, ExtendedTab>;
  overlap: number;
  unpinnedOverlap: number;
  weight: number;
}

interface OrderBlock {
  ids: number[];
  groupKey?: string;
}

export interface FinalTabOrderResult {
  correctedWindows: number;
  warnings: string[];
}

const FINAL_ORDER_RETRIES = 3;
const FINAL_ORDER_SETTLE_MS = 40;
const WINDOW_UNPINNED_OVERLAP_WEIGHT = 1_000_000_000_000;
const WINDOW_OVERLAP_WEIGHT = 1_000_000_000;
const TAB_GROUP_ID_NONE = -1;

function delay(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function tabGroupsApi(): TabGroupsApi | undefined {
  return (browser as unknown as { tabGroups?: TabGroupsApi }).tabGroups;
}

function sameSavedAndLiveTab(saved: BrowserTabSnapshot, live: ExtendedTab): boolean {
  if (live.url !== saved.url) return false;
  if ((live.cookieStoreId ?? undefined) !== (saved.cookie_store_id ?? undefined)) return false;
  // Never consume a protected/live pinned tab as an ordinary saved tab. This
  // mirrors the main restore planner and avoids turning a Zen Essential into an
  // ordering target.
  if (!saved.pinned && live.pinned) return false;
  return true;
}

function mapSavedTabs(
  saved: BrowserWindowSnapshot,
  live: browser.windows.Window,
): Map<number, ExtendedTab> {
  const available = ((live.tabs ?? []) as ExtendedTab[])
    .filter(tab => tab.id !== undefined);
  const used = new Set<number>();
  const result = new Map<number, ExtendedTab>();

  for (const savedTab of [...saved.tabs].sort((left, right) => left.index - right.index)) {
    const candidate = available
      .filter(tab => tab.id !== undefined && !used.has(tab.id) && sameSavedAndLiveTab(savedTab, tab))
      .sort((left, right) => {
        const pinPenaltyLeft = left.pinned === savedTab.pinned ? 0 : 1;
        const pinPenaltyRight = right.pinned === savedTab.pinned ? 0 : 1;
        return pinPenaltyLeft - pinPenaltyRight
          || Math.abs(left.index - savedTab.index) - Math.abs(right.index - savedTab.index)
          || left.index - right.index;
      })[0];

    if (candidate?.id === undefined) continue;
    used.add(candidate.id);
    result.set(savedTab.index, candidate);
  }

  return result;
}

function geometryDistance(saved: BrowserWindowSnapshot, live: browser.windows.Window): number {
  let total = 0;
  let observed = 0;
  for (const [expected, actual] of [
    [saved.left, live.left],
    [saved.top, live.top],
    [saved.width, live.width],
    [saved.height, live.height],
  ] as const) {
    if (expected === undefined || actual === undefined) continue;
    total += Math.abs(expected - actual);
    observed += 1;
  }
  return observed === 0 ? 1_000_000 : total;
}

function buildWindowMatch(
  saved: BrowserWindowSnapshot,
  live: browser.windows.Window,
): SavedWindowMatch | undefined {
  if (live.id === undefined) return undefined;
  const mappedBySavedIndex = mapSavedTabs(saved, live);
  const overlap = mappedBySavedIndex.size;
  if (overlap === 0) return undefined;

  const unpinnedOverlap = saved.tabs.reduce((count, tab) =>
    count + (!tab.pinned && mappedBySavedIndex.has(tab.index) ? 1 : 0), 0);
  const exactCountBonus = overlap === saved.tabs.length && overlap === (live.tabs?.length ?? 0)
    ? 10_000_000
    : 0;
  const geometryBonus = Math.max(0, 1_000_000 - Math.min(1_000_000, geometryDistance(saved, live)));
  return {
    window: live,
    mappedBySavedIndex,
    overlap,
    unpinnedOverlap,
    // Final ordering exists specifically for ordinary tabs. Give their overlap
    // overwhelming priority so shared Zen pinned/Essential tabs cannot make the
    // finalizer attach a saved topology to the wrong live window.
    weight: unpinnedOverlap * WINDOW_UNPINNED_OVERLAP_WEIGHT
      + overlap * WINDOW_OVERLAP_WEIGHT
      + exactCountBonus
      + geometryBonus,
  };
}

function assignSavedWindows(
  savedWindows: BrowserWindowSnapshot[],
  liveWindows: browser.windows.Window[],
): Map<number, SavedWindowMatch> {
  const grid = savedWindows.map(saved => liveWindows.map(live => buildWindowMatch(saved, live)));
  const assignment = maximumWeightAssignment(
    grid.map(row => row.map(candidate => candidate?.weight ?? 0)),
  );
  const result = new Map<number, SavedWindowMatch>();

  assignment.forEach((liveIndex, savedIndex) => {
    if (liveIndex === undefined) return;
    const candidate = grid[savedIndex]?.[liveIndex];
    if (candidate) result.set(savedIndex, candidate);
  });
  return result;
}

function desiredUnpinnedIds(
  saved: BrowserWindowSnapshot,
  mappedBySavedIndex: Map<number, ExtendedTab>,
): number[] {
  return [...saved.tabs]
    .sort((left, right) => left.index - right.index)
    .filter(tab => !tab.pinned)
    .map(tab => mappedBySavedIndex.get(tab.index)?.id)
    .filter((id): id is number => id !== undefined);
}

function mappedTargetIds(mappedBySavedIndex: Map<number, ExtendedTab>): Set<number> {
  return new Set(
    [...mappedBySavedIndex.values()]
      .map(tab => tab.id)
      .filter((id): id is number => id !== undefined),
  );
}

/**
 * Return only disposable bootstrap tabs that are not part of the saved target.
 *
 * Zen can materialize an unpinned about:blank/about:newtab while generic tab
 * operations are in flight. The main restore pass only knows the IDs that
 * existed before it began, so a bootstrap created during reconciliation can
 * survive as an extra empty tab. The final pass runs after every restore
 * mutation and can safely remove that residue as long as:
 * - at least one mapped saved target is present;
 * - the candidate is not one of those mapped targets;
 * - the candidate is unpinned (never touch a Zen Essential/pinned tab); and
 * - the candidate is exactly a disposable browser bootstrap shape.
 *
 * A blank/new-tab that was actually saved maps to a target ID and is therefore
 * intentionally preserved.
 */
function unexpectedDisposableTabIds(
  tabs: ExtendedTab[],
  targetIds: ReadonlySet<number>,
): number[] {
  if (targetIds.size === 0) return [];
  const hasMappedTarget = tabs.some(tab => tab.id !== undefined && targetIds.has(tab.id));
  if (!hasMappedTarget) return [];

  return tabs
    .filter(tab =>
      tab.id !== undefined
      && !targetIds.has(tab.id)
      && !tab.pinned
      && isDisposableBootstrapTabs([tab]),
    )
    .map(tab => tab.id as number);
}

async function removeUnexpectedDisposableTabs(
  windowId: number,
  mappedBySavedIndex: Map<number, ExtendedTab>,
): Promise<number> {
  const targetIds = mappedTargetIds(mappedBySavedIndex);
  if (targetIds.size === 0) return 0;
  const tabs = await liveWindowTabs(windowId);
  if (!tabs) return 0;
  const ids = unexpectedDisposableTabIds(tabs, targetIds);
  let removed = 0;
  for (const id of ids) {
    const ok = await browser.tabs.remove(id).then(() => true).catch(() => false);
    if (ok) removed += 1;
  }
  return removed;
}

function buildSavedBlocks(
  saved: BrowserWindowSnapshot,
  mappedBySavedIndex: Map<number, ExtendedTab>,
): OrderBlock[] {
  const blocks: OrderBlock[] = [];
  const sorted = [...saved.tabs]
    .sort((left, right) => left.index - right.index)
    .filter(tab => !tab.pinned && mappedBySavedIndex.get(tab.index)?.id !== undefined);

  for (const savedTab of sorted) {
    const id = mappedBySavedIndex.get(savedTab.index)?.id;
    if (id === undefined) continue;
    const previous = blocks[blocks.length - 1];
    if (savedTab.group_key && previous?.groupKey === savedTab.group_key) {
      previous.ids.push(id);
    } else {
      const block: OrderBlock = { ids: [id] };
      if (savedTab.group_key) block.groupKey = savedTab.group_key;
      blocks.push(block);
    }
  }
  return blocks;
}

async function liveWindowTabs(windowId: number): Promise<ExtendedTab[] | undefined> {
  const current = await browser.windows.get(windowId, { populate: true }).catch(() => undefined);
  if (!current) return undefined;
  return ((current.tabs ?? []) as ExtendedTab[]).sort((left, right) => left.index - right.index);
}

function exactRelativeOrder(tabs: ExtendedTab[], desiredIds: number[]): boolean {
  const desiredSet = new Set(desiredIds);
  const actual = [...tabs]
    .sort((left, right) => left.index - right.index)
    .filter(tab => tab.id !== undefined && !tab.pinned && desiredSet.has(tab.id))
    .map(tab => tab.id as number);
  return actual.length === desiredIds.length
    && actual.every((id, index) => id === desiredIds[index]);
}

function allOrdinaryAndUngrouped(tabs: ExtendedTab[], desiredIds: number[]): boolean {
  const desiredSet = new Set(desiredIds);
  const targets = tabs.filter(tab => tab.id !== undefined && desiredSet.has(tab.id));
  return targets.length === desiredIds.length
    && targets.every(tab =>
      !tab.pinned
      && (tab.groupId === undefined || tab.groupId === TAB_GROUP_ID_NONE)
      && (tab.splitViewId === undefined || tab.splitViewId === TAB_GROUP_ID_NONE));
}

async function moveBlockToFrontBoundary(
  block: OrderBlock,
  windowId: number,
  firstUnpinnedIndex: number,
): Promise<void> {
  const current = await Promise.all(
    block.ids.map(id => browser.tabs.get(id).catch(() => undefined) as Promise<ExtendedTab | undefined>),
  );
  const present = current.filter((tab): tab is ExtendedTab => tab?.id !== undefined);
  if (present.length !== block.ids.length) return;

  const groupIds = present
    .map(tab => tab.groupId)
    .filter((id): id is number => id !== undefined && id >= 0);
  const sharedGroupId = groupIds.length === present.length
    && groupIds.every(id => id === groupIds[0])
    ? groupIds[0]
    : undefined;

  const groups = tabGroupsApi();
  if (sharedGroupId !== undefined && groups?.move) {
    try {
      await groups.move(sharedGroupId, { windowId, index: firstUnpinnedIndex });
      return;
    } catch {
      // Fall through to a multi-tab move. Passing every member in saved order
      // avoids the edge swaps caused by moving group members one at a time.
    }
  }

  const tabIds: number | number[] = block.ids.length === 1 ? block.ids[0]! : block.ids;
  await browser.tabs.move(tabIds, { windowId, index: firstUnpinnedIndex });
}

/**
 * Final, authoritative tab-order pass.
 *
 * The main restore engine performs creation/reuse/group reconciliation. This
 * pass runs after all of that browser mutation has finished and establishes one
 * simple invariant: mapped ordinary tabs appear in exactly the saved relative
 * order according to their live `tab.index` values.
 *
 * Fast path: if all target tabs are ordinary/ungrouped, Firefox can move the
 * complete ID array in one operation. The WebExtension API guarantees that the
 * first ID lands at `index` and the remaining IDs follow it in the supplied
 * order, avoiding sequential index-shift races.
 *
 * Group-aware fallback: saved groups are treated as blocks and moved from right
 * to left to the first-unpinned boundary. Real tab groups are moved as groups;
 * otherwise all IDs in the block move together. No target tab is moved to an
 * interior group index.
 */
async function enforceWindowOrder(
  saved: BrowserWindowSnapshot,
  match: SavedWindowMatch,
): Promise<boolean> {
  const windowId = match.window.id;
  if (windowId === undefined) return false;
  const desiredIds = desiredUnpinnedIds(saved, match.mappedBySavedIndex);
  if (desiredIds.length <= 1) return true;

  for (let attempt = 0; attempt < FINAL_ORDER_RETRIES; attempt += 1) {
    const before = await liveWindowTabs(windowId);
    if (!before) return false;
    if (exactRelativeOrder(before, desiredIds)) return true;

    const firstUnpinnedIndex = before.filter(tab => tab.pinned).length;

    if (allOrdinaryAndUngrouped(before, desiredIds)) {
      await browser.tabs.move(desiredIds, { windowId, index: firstUnpinnedIndex }).catch(() => undefined);
    } else {
      const blocks = buildSavedBlocks(saved, match.mappedBySavedIndex);
      for (const block of [...blocks].reverse()) {
        await moveBlockToFrontBoundary(block, windowId, firstUnpinnedIndex).catch(() => undefined);
      }
    }

    await delay(FINAL_ORDER_SETTLE_MS * (attempt + 1));
    const after = await liveWindowTabs(windowId);
    if (after && exactRelativeOrder(after, desiredIds)) return true;
  }

  return false;
}

export async function enforceFinalTabOrder(snapshot: FirefoxSnapshot): Promise<FinalTabOrderResult> {
  const result: FinalTabOrderResult = { correctedWindows: 0, warnings: [] };
  const liveWindows = (await browser.windows.getAll({ populate: true, windowTypes: ["normal"] }))
    .filter(window => !window.incognito && window.id !== undefined);
  const assignment = assignSavedWindows(snapshot.windows, liveWindows);

  for (const [savedIndex, saved] of snapshot.windows.entries()) {
    const match = assignment.get(savedIndex);
    if (!match || match.window.id === undefined) {
      result.warnings.push(`Could not identify the restored live window for final tab ordering in ${saved.key}.`);
      continue;
    }
    const windowId = match.window.id;

    // Remove only unsaved disposable tabs after all restore mutations have
    // completed. This catches Zen-created transient about:blank tabs that did
    // not exist when the main restore pass captured its original tab IDs.
    await removeUnexpectedDisposableTabs(windowId, match.mappedBySavedIndex);

    const desiredIds = desiredUnpinnedIds(saved, match.mappedBySavedIndex);
    const before = await liveWindowTabs(windowId);
    if (!before) {
      result.warnings.push(`Restored window ${saved.key} disappeared before final tab ordering.`);
      continue;
    }
    if (exactRelativeOrder(before, desiredIds)) continue;

    if (await enforceWindowOrder(saved, match)) {
      result.correctedWindows += 1;
    } else {
      result.warnings.push(
        `Final tab order for ${saved.key} did not converge to the saved relative order after ${FINAL_ORDER_RETRIES} authoritative attempts.`,
      );
    }
  }

  return result;
}

// Exported for focused regression tests without exposing browser mutation details.
export const finalOrderTestHelpers = {
  exactRelativeOrder,
  buildSavedBlocks,
  unexpectedDisposableTabIds,
};