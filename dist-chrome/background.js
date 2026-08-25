"use strict";
(() => {
  // src/platform.ts
  function configuredTarget() {
    if (false) return "firefox";
    return true ? "chrome" : "firefox";
  }
  var BROWSER_TARGET = configuredTarget();
  var IS_FIREFOX = BROWSER_TARGET === "firefox";
  var IS_CHROME = BROWSER_TARGET === "chrome";
  var BROWSER_LABEL = IS_CHROME ? "Chrome" : "Firefox / Zen";
  var BROWSER_ADAPTER_ID = BROWSER_TARGET;
  var NATIVE_HOST_NAME = IS_CHROME ? "com.contextcapsule.chrome" : "com.contextcapsule.host";

  // src/browser/model.ts
  var BROWSER_SNAPSHOT_SCHEMA_VERSION = 1;
  var SPLIT_GROUP_TITLE_PREFIX = "__context_capsule_split_v1__:";
  function splitGroupTitle(orientation) {
    return `${SPLIT_GROUP_TITLE_PREFIX}${orientation}`;
  }
  function splitOrientationFromGroup(group) {
    if (!group.title.startsWith(SPLIT_GROUP_TITLE_PREFIX)) return void 0;
    const orientation = group.title.slice(SPLIT_GROUP_TITLE_PREFIX.length);
    return orientation === "vertical" || orientation === "horizontal" || orientation === "grid" ? orientation : void 0;
  }
  function isSplitViewGroup(group) {
    return splitOrientationFromGroup(group) !== void 0;
  }
  function savedTabsMatchLiveTabs(saved, live) {
    const currentTabs = [...live].sort((a, b) => a.index - b.index);
    const savedTabs = [...saved.tabs].sort((a, b) => a.index - b.index);
    if (currentTabs.length !== savedTabs.length) return false;
    return savedTabs.every((savedTab, index) => {
      const tab = currentTabs[index];
      if (!tab) return false;
      return (tab.url ?? "about:blank") === savedTab.url && tab.pinned === savedTab.pinned && (tab.cookieStoreId ?? void 0) === (savedTab.cookie_store_id ?? void 0);
    });
  }
  function isDisposableBootstrapTabs(live) {
    if (live.length === 0) return true;
    if (live.length !== 1) return false;
    const tab = live[0];
    if (!tab || tab.pinned) return false;
    const url = tab.url ?? "about:blank";
    return url === "about:blank" || url === "about:newtab" || url === "about:home" || url === "chrome://newtab/";
  }
  function isPortableTabGroup(group) {
    return !isSplitViewGroup(group) && (IS_CHROME || group.title.trim().length > 0);
  }
  function tabCount(snapshot) {
    return snapshot.windows.reduce((total, window) => total + window.tabs.length, 0);
  }
  function currentBrowserAdapterId() {
    return BROWSER_TARGET;
  }
  function isRestorableUrl(url) {
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
  function restorableUrl(url) {
    if (url === "about:newtab" || url === "chrome://newtab/") {
      return void 0;
    }
    return isRestorableUrl(url) ? url : void 0;
  }
  function savedTabIdentity(tab) {
    if (!tab.restorable || !isRestorableUrl(tab.url)) return void 0;
    return `${tab.pinned ? "p" : "u"}\0${tab.cookie_store_id ?? ""}\0${tab.url}`;
  }
  function liveTabIdentity(tab) {
    if (!tab.url || !isRestorableUrl(tab.url)) return void 0;
    return `${tab.pinned ? "p" : "u"}\0${tab.cookieStoreId ?? ""}\0${tab.url}`;
  }
  function multisetOverlap(left, right) {
    const counts = /* @__PURE__ */ new Map();
    for (const value of right) {
      counts.set(value, (counts.get(value) ?? 0) + 1);
    }
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
  function savedWindowSimilarity(saved, live) {
    const exact = savedTabsMatchLiveTabs(saved, live);
    if (exact) {
      return {
        score: 1e5 + saved.tabs.length,
        exact: true,
        overlap: saved.tabs.length,
        savedRelevant: saved.tabs.length,
        liveRelevant: live.length
      };
    }
    const savedRelevantTabs = saved.tabs.filter((tab) => savedTabIdentity(tab) !== void 0);
    const liveRelevantTabs = live.filter((tab) => liveTabIdentity(tab) !== void 0);
    const savedIds = savedRelevantTabs.map((tab) => savedTabIdentity(tab)).filter(Boolean);
    const liveIds = liveRelevantTabs.map((tab) => liveTabIdentity(tab)).filter(Boolean);
    const overlap = multisetOverlap(savedIds, liveIds);
    const empty = {
      score: 0,
      exact: false,
      overlap,
      savedRelevant: savedIds.length,
      liveRelevant: liveIds.length
    };
    if (savedIds.length === 0 || liveIds.length === 0 || overlap === 0) return empty;
    if (savedIds.length === 1) {
      return overlap === 1 && liveIds.length === 1 ? { ...empty, score: 5e3 } : empty;
    }
    const savedUnpinnedIds = savedRelevantTabs.filter((tab) => !tab.pinned).map((tab) => savedTabIdentity(tab));
    const liveUnpinnedIds = liveRelevantTabs.filter((tab) => !tab.pinned).map((tab) => liveTabIdentity(tab));
    if (savedUnpinnedIds.length === 0) return empty;
    const unpinnedOverlap = multisetOverlap(savedUnpinnedIds, liveUnpinnedIds);
    const requiredUnpinnedOverlap = Math.min(2, savedUnpinnedIds.length);
    const savedCoverage = overlap / savedIds.length;
    const liveCoverage = overlap / liveIds.length;
    const unpinnedCoverage = unpinnedOverlap / savedUnpinnedIds.length;
    if (overlap < 2 || unpinnedOverlap < requiredUnpinnedOverlap || savedCoverage < 0.6 || liveCoverage < 0.45 || unpinnedCoverage < 0.6) {
      return empty;
    }
    const countDelta = Math.abs(savedIds.length - liveIds.length);
    return {
      ...empty,
      score: 1e3 + overlap * 100 + unpinnedOverlap * 50 + Math.round(savedCoverage * 100) + Math.round(liveCoverage * 100) - countDelta * 5
    };
  }

  // src/browser/capture.ts
  function tabGroupsApi() {
    return chrome.tabGroups;
  }
  function windowState(state) {
    return state === "minimized" || state === "maximized" || state === "fullscreen" ? state : "normal";
  }
  function optionalNumber(value) {
    return Number.isFinite(value) ? value : void 0;
  }
  function inferSplitOrientation(source, members) {
    if (members.length !== 2) return "grid";
    const windowWidth = source.width ?? 0;
    const windowHeight = source.height ?? 0;
    const widths = members.map((tab) => tab.width ?? 0);
    const heights = members.map((tab) => tab.height ?? 0);
    if (windowWidth <= 0 || windowHeight <= 0 || widths.some((value) => value <= 0) || heights.some((value) => value <= 0)) {
      return "vertical";
    }
    const widthPackingError = Math.abs(widths.reduce((sum, value) => sum + value, 0) / windowWidth - 1);
    const heightPackingError = Math.abs(heights.reduce((sum, value) => sum + value, 0) / windowHeight - 1);
    return widthPackingError <= heightPackingError ? "vertical" : "horizontal";
  }
  function isCapturedSplitGroup(group, members) {
    if (!IS_FIREFOX) return false;
    if (members.length < 2 || members.length > 4) return false;
    const explicitIds = members.map((tab) => tab.splitViewId).filter((id) => typeof id === "number" && id >= 0);
    if (explicitIds.length === members.length && explicitIds.every((id) => id === explicitIds[0])) return true;
    return group.title.trim().length === 0;
  }
  async function captureWindow(source, windowIndex) {
    if (source.id === void 0 || source.incognito) return void 0;
    const tabs = [...source.tabs ?? []].sort((left2, right) => left2.index - right.index);
    const groupsApi = tabGroupsApi();
    const groups = groupsApi ? await groupsApi.query({ windowId: source.id }).catch(() => []) : [];
    const groupKeyById = /* @__PURE__ */ new Map();
    const capturedGroups = groups.map((group, groupIndex) => {
      const key = `group-${groupIndex}`;
      groupKeyById.set(group.id, key);
      const members = tabs.filter((tab) => tab.groupId === group.id);
      const title = group.title ?? "";
      const split = isCapturedSplitGroup({ title }, members);
      return {
        key,
        title: split ? splitGroupTitle(inferSplitOrientation(source, members)) : title,
        color: group.color,
        collapsed: group.collapsed
      };
    });
    const capturedTabs = tabs.map((tab) => {
      const url = tab.url ?? "about:blank";
      const groupKey = tab.groupId === void 0 || tab.groupId < 0 ? void 0 : groupKeyById.get(tab.groupId);
      const cookieStoreId = IS_FIREFOX ? tab.cookieStoreId : void 0;
      const snapshot = {
        index: tab.index,
        url,
        pinned: tab.pinned,
        active: tab.active,
        discarded: tab.discarded ?? false,
        muted: tab.mutedInfo?.muted ?? false,
        restorable: isRestorableUrl(url)
      };
      if (tab.title) snapshot.title = tab.title;
      if (cookieStoreId) snapshot.cookie_store_id = cookieStoreId;
      if (groupKey) snapshot.group_key = groupKey;
      return snapshot;
    });
    const result = {
      key: `window-${windowIndex}`,
      focused: source.focused,
      state: windowState(source.state),
      tabs: capturedTabs,
      groups: capturedGroups
    };
    const left = optionalNumber(source.left);
    const top = optionalNumber(source.top);
    const width = optionalNumber(source.width);
    const height = optionalNumber(source.height);
    if (left !== void 0) result.left = left;
    if (top !== void 0) result.top = top;
    if (width !== void 0) result.width = width;
    if (height !== void 0) result.height = height;
    return result;
  }
  async function extensionInstallType() {
    try {
      const extension = await chrome.management.getSelf();
      return extension.installType || void 0;
    } catch {
      return void 0;
    }
  }
  async function captureBrowserSnapshot() {
    const extension = chrome.runtime.getManifest();
    const [windows, installType] = await Promise.all([
      chrome.windows.getAll({ populate: true, windowTypes: ["normal"] }),
      extensionInstallType()
    ]);
    const privateCount = windows.filter((window) => window.incognito).length;
    const captured = await Promise.all(windows.map((window, index) => captureWindow(window, index)));
    const snapshot = {
      schema_version: BROWSER_SNAPSHOT_SCHEMA_VERSION,
      browser: currentBrowserAdapterId(),
      extension_version: extension.version,
      captured_at_unix_ms: Date.now(),
      skipped_private_windows: privateCount,
      windows: captured.filter((window) => window !== void 0)
    };
    if (installType) snapshot.install_type = installType;
    return snapshot;
  }

  // src/browser/restore.ts
  var NEW_WINDOW_SETTLE_MS = 300;
  var NATIVE_BLANK_WINDOW_TIMEOUT_MS = 7e3;
  var NATIVE_BLANK_WINDOW_POLL_MS = 100;
  var NATIVE_BLANK_WINDOW_STABLE_MS = 1500;
  var NORMAL_GEOMETRY_SETTLE_MS = 180;
  var NORMAL_GEOMETRY_RETRIES = 5;
  var NON_NORMAL_GEOMETRY_RETRIES = 3;
  var NORMAL_GEOMETRY_TOLERANCE = 8;
  var TAB_ORDER_SETTLE_MS = 60;
  var TAB_ORDER_RETRIES = 3;
  var WINDOW_REUSE_OVERLAP_WEIGHT = 1e12;
  function groupingApis() {
    const root = chrome;
    const result = {};
    if (typeof root.tabs.group === "function") result.tabs = root.tabs;
    if (root.tabGroups) result.groups = root.tabGroups;
    return result;
  }
  function delay(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
  }
  async function createTab(windowId, tab, warnings) {
    const properties = {
      windowId,
      active: false,
      pinned: tab.pinned
    };
    const url = restorableUrl(tab.url);
    if (url !== void 0) properties.url = url;
    if (tab.cookie_store_id) properties.cookieStoreId = tab.cookie_store_id;
    let created;
    try {
      created = await chrome.tabs.create(properties);
    } catch (error) {
      if (!tab.cookie_store_id) throw error;
      delete properties.cookieStoreId;
      warnings.push(
        `Container '${tab.cookie_store_id}' was unavailable for '${tab.title ?? tab.url}'; restored in the default container.`
      );
      created = await chrome.tabs.create(properties);
    }
    if (created.id !== void 0 && tab.muted) {
      await chrome.tabs.update(created.id, { muted: true }).catch(() => void 0);
    }
    return created;
  }
  function numberClose(actual, expected) {
    if (expected === void 0) return true;
    return actual !== void 0 && Math.abs(actual - expected) <= NORMAL_GEOMETRY_TOLERANCE;
  }
  function normalWindowGeometryMatches(actual, saved) {
    return (actual.state === void 0 || actual.state === "normal") && numberClose(actual.left, saved.left) && numberClose(actual.top, saved.top) && numberClose(actual.width, saved.width) && numberClose(actual.height, saved.height);
  }
  function savedWindowStateAndMonitorMatch(actual, saved) {
    return actual.state === saved.state && numberClose(actual.left, saved.left) && numberClose(actual.top, saved.top);
  }
  function describeGeometry(window) {
    return `left=${window.left ?? "?"}, top=${window.top ?? "?"}, width=${window.width ?? "?"}, height=${window.height ?? "?"}, state=${window.state ?? "?"}`;
  }
  async function restoreNormalGeometry(windowId, saved) {
    await chrome.windows.update(windowId, { state: "normal" });
    await delay(NORMAL_GEOMETRY_SETTLE_MS);
    const geometry = {};
    if (saved.left !== void 0) geometry.left = saved.left;
    if (saved.top !== void 0) geometry.top = saved.top;
    if (saved.width !== void 0) geometry.width = saved.width;
    if (saved.height !== void 0) geometry.height = saved.height;
    if (Object.keys(geometry).length === 0) return;
    let last;
    for (let attempt = 0; attempt < NORMAL_GEOMETRY_RETRIES; attempt += 1) {
      await chrome.windows.update(windowId, geometry);
      await delay(NORMAL_GEOMETRY_SETTLE_MS * (attempt + 1));
      last = await chrome.windows.get(windowId).catch(() => void 0);
      if (last && normalWindowGeometryMatches(last, saved)) return;
    }
    throw new Error(
      `window bounds did not converge to the saved geometry after ${NORMAL_GEOMETRY_RETRIES} attempts; saved ${describeGeometry({ ...saved, state: "normal" })}; observed ${last ? describeGeometry(last) : "window unavailable"}`
    );
  }
  async function stageWindowOnSavedMonitor(windowId, saved) {
    await chrome.windows.update(windowId, { state: "normal" });
    await delay(NORMAL_GEOMETRY_SETTLE_MS);
    const position = {};
    if (saved.left !== void 0) position.left = saved.left;
    if (saved.top !== void 0) position.top = saved.top;
    if (Object.keys(position).length === 0) return;
    let last;
    for (let attempt = 0; attempt < NORMAL_GEOMETRY_RETRIES; attempt += 1) {
      await chrome.windows.update(windowId, position);
      await delay(NORMAL_GEOMETRY_SETTLE_MS * (attempt + 1));
      last = await chrome.windows.get(windowId).catch(() => void 0);
      if (last && (last.state === void 0 || last.state === "normal") && numberClose(last.left, saved.left) && numberClose(last.top, saved.top)) {
        return;
      }
    }
    throw new Error(
      `window did not move to the saved monitor position after ${NORMAL_GEOMETRY_RETRIES} attempts; saved left=${saved.left ?? "?"}, top=${saved.top ?? "?"}; observed ${last ? describeGeometry(last) : "window unavailable"}`
    );
  }
  async function restoreNonNormalGeometry(windowId, saved) {
    const current = await chrome.windows.get(windowId).catch(() => void 0);
    if (current && savedWindowStateAndMonitorMatch(current, saved)) return;
    if (saved.state === "minimized") {
      await stageWindowOnSavedMonitor(windowId, saved);
      await chrome.windows.update(windowId, { state: "minimized" });
      return;
    }
    let last;
    for (let attempt = 0; attempt < NON_NORMAL_GEOMETRY_RETRIES; attempt += 1) {
      await stageWindowOnSavedMonitor(windowId, saved);
      await chrome.windows.update(windowId, { state: saved.state });
      await delay(NORMAL_GEOMETRY_SETTLE_MS * (attempt + 1));
      last = await chrome.windows.get(windowId).catch(() => void 0);
      if (last && savedWindowStateAndMonitorMatch(last, saved)) return;
    }
    throw new Error(
      `window did not converge to saved state/monitor after ${NON_NORMAL_GEOMETRY_RETRIES} attempts; saved ${describeGeometry(saved)}; observed ${last ? describeGeometry(last) : "window unavailable"}`
    );
  }
  async function restoreGeometry(windowId, saved) {
    if (saved.state === "normal") {
      await restoreNormalGeometry(windowId, saved);
      return;
    }
    await restoreNonNormalGeometry(windowId, saved);
  }
  async function restoreGroups(windowId, saved, restoredByIndex, report) {
    const { tabs: tabsGrouping, groups: groupsApi } = groupingApis();
    if (!tabsGrouping || !groupsApi) {
      if (saved.groups.some(isPortableTabGroup)) {
        report.warnings.push("This Firefox version does not expose the tabGroups API; named tab groups were restored ungrouped.");
      }
      return;
    }
    for (const group of saved.groups) {
      if (!isPortableTabGroup(group)) continue;
      const tabIds = saved.tabs.filter((tab) => tab.group_key === group.key && !tab.pinned).sort((a, b) => a.index - b.index).map((tab) => restoredByIndex.get(tab.index)?.id).filter((id) => id !== void 0);
      if (tabIds.length === 0) continue;
      try {
        const groupId = await tabsGrouping.group({ tabIds, createProperties: { windowId } });
        await groupsApi.update(groupId, {
          title: group.title,
          color: group.color,
          collapsed: group.collapsed
        });
        report.created_groups += 1;
      } catch (error) {
        report.warnings.push(
          `Failed to restore tab group '${group.title || group.key}': ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
  }
  function comparableLiveTab(tab) {
    const comparable = {
      index: tab.index,
      pinned: tab.pinned
    };
    if (tab.url !== void 0) comparable.url = tab.url;
    if (tab.cookieStoreId !== void 0) comparable.cookieStoreId = tab.cookieStoreId;
    return comparable;
  }
  function liveTabs(current) {
    return (current.tabs ?? []).map(comparableLiveTab);
  }
  function disposableBootstrapWindow(current) {
    return isDisposableBootstrapTabs(liveTabs(current));
  }
  function liveWindowTopologiesMatch(left, right) {
    const leftTabs = liveTabs(left).sort((a, b) => a.index - b.index);
    const rightTabs = liveTabs(right).sort((a, b) => a.index - b.index);
    if (leftTabs.length !== rightTabs.length) return false;
    return leftTabs.every((tab, index) => {
      const other = rightTabs[index];
      if (!other) return false;
      return (tab.url ?? "about:blank") === (other.url ?? "about:blank") && tab.pinned === other.pinned && (tab.cookieStoreId ?? void 0) === (other.cookieStoreId ?? void 0);
    });
  }
  function semanticTabKey(url, cookieStoreId) {
    return `${cookieStoreId ?? ""}\0${url}`;
  }
  function multisetOverlap2(left, right) {
    const counts = /* @__PURE__ */ new Map();
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
  function reusableTabOverlap(saved, current) {
    const savedRelevant = saved.tabs.filter((tab) => tab.restorable && isRestorableUrl(tab.url));
    const liveRelevant = (current.tabs ?? []).filter((tab) => tab.url !== void 0 && isRestorableUrl(tab.url));
    const savedKeys = savedRelevant.map((tab) => semanticTabKey(tab.url, tab.cookie_store_id));
    const liveKeys = liveRelevant.map((tab) => semanticTabKey(tab.url, tab.cookieStoreId));
    const overlap = multisetOverlap2(savedKeys, liveKeys);
    const savedUnpinned = savedRelevant.filter((tab) => !tab.pinned);
    const liveUnpinned = liveRelevant.filter((tab) => !tab.pinned);
    const unpinnedOverlap = multisetOverlap2(
      savedUnpinned.map((tab) => semanticTabKey(tab.url, tab.cookie_store_id)),
      liveUnpinned.map((tab) => semanticTabKey(tab.url, tab.cookieStoreId))
    );
    const liveSubset = liveKeys.length > 0 && overlap === liveKeys.length && (savedUnpinned.length === 0 || unpinnedOverlap > 0);
    return {
      overlap,
      savedRelevant: savedKeys.length,
      liveRelevant: liveKeys.length,
      unpinnedOverlap,
      savedUnpinnedRelevant: savedUnpinned.length,
      liveSubset
    };
  }
  function geometryDistance(saved, live) {
    let distance = 0;
    let observed = 0;
    for (const [savedValue, liveValue] of [
      [saved.left, live.left],
      [saved.top, live.top],
      [saved.width, live.width],
      [saved.height, live.height]
    ]) {
      if (savedValue === void 0 || liveValue === void 0) continue;
      distance += Math.abs(savedValue - liveValue);
      observed += 1;
    }
    return observed > 0 ? distance : 1e6;
  }
  function buildExistingWindowMatch(saved, current) {
    if (current.id === void 0) return void 0;
    const similarity = savedWindowSimilarity(saved, liveTabs(current));
    const reuse = reusableTabOverlap(saved, current);
    const strongFuzzyIdentity = similarity.score > 0;
    const savedCoverage = reuse.savedRelevant > 0 ? reuse.overlap / reuse.savedRelevant : similarity.exact ? 1 : 0;
    const liveCoverage = reuse.liveRelevant > 0 ? reuse.overlap / reuse.liveRelevant : similarity.exact ? 1 : 0;
    const geometryScore = Math.max(0, 1e6 - Math.min(1e6, geometryDistance(saved, current)));
    const liveTabCount = current.tabs?.length ?? 0;
    const shellPreservationScore = Math.max(
      0,
      1e7 - Math.min(1e7, reuse.liveRelevant * 1e5 + liveTabCount * 1e4)
    );
    const weight = reuse.overlap * WINDOW_REUSE_OVERLAP_WEIGHT + (similarity.exact ? 5e8 : 0) + (reuse.liveSubset ? 2e8 : 0) + (strongFuzzyIdentity ? 5e7 : 0) + Math.round(savedCoverage * 1e3) * 1e5 + Math.round(liveCoverage * 1e3) * 100 + shellPreservationScore + geometryScore + 1;
    return {
      window: current,
      exact: similarity.exact,
      score: similarity.score,
      overlap: reuse.overlap,
      savedRelevant: reuse.savedRelevant,
      liveRelevant: reuse.liveRelevant,
      liveSubset: reuse.liveSubset,
      weight
    };
  }
  function maximumWeightAssignment(weights) {
    const rowCount = weights.length;
    if (rowCount === 0) return [];
    const realColumnCount = weights.reduce((maximum2, row) => Math.max(maximum2, row.length), 0);
    if (realColumnCount === 0) return Array(rowCount).fill(void 0);
    const columnCount = realColumnCount + rowCount;
    let maximum = 0;
    for (const row of weights) {
      for (const weight of row) maximum = Math.max(maximum, weight);
    }
    const u = Array(rowCount + 1).fill(0);
    const v = Array(columnCount + 1).fill(0);
    const p = Array(columnCount + 1).fill(0);
    const way = Array(columnCount + 1).fill(0);
    for (let i = 1; i <= rowCount; i += 1) {
      p[0] = i;
      let j0 = 0;
      const minv = Array(columnCount + 1).fill(Number.POSITIVE_INFINITY);
      const used = Array(columnCount + 1).fill(false);
      do {
        used[j0] = true;
        const i0 = p[j0] ?? 0;
        let delta = Number.POSITIVE_INFINITY;
        let j1 = 0;
        for (let j = 1; j <= columnCount; j += 1) {
          if (used[j]) continue;
          const weight = j <= realColumnCount ? weights[i0 - 1]?.[j - 1] ?? 0 : 0;
          const current = maximum - weight - (u[i0] ?? 0) - (v[j] ?? 0);
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
    const result = Array(rowCount).fill(void 0);
    for (let j = 1; j <= realColumnCount; j += 1) {
      const assignedRow = (p[j] ?? 0) - 1;
      if (assignedRow < 0) continue;
      const weight = weights[assignedRow]?.[j - 1] ?? 0;
      if (weight > 0) result[assignedRow] = j - 1;
    }
    return result;
  }
  function assignExistingWindows(savedWindows, currentWindows) {
    const candidateGrid = savedWindows.map(
      (saved) => currentWindows.map((current) => buildExistingWindowMatch(saved, current))
    );
    const assignment = maximumWeightAssignment(
      candidateGrid.map((row) => row.map((candidate) => candidate?.weight ?? 0))
    );
    const result = /* @__PURE__ */ new Map();
    assignment.forEach((currentIndex, savedIndex) => {
      if (currentIndex === void 0) return;
      const candidate = candidateGrid[savedIndex]?.[currentIndex];
      if (candidate) result.set(savedIndex, candidate);
    });
    return result;
  }
  function sameTabSemanticIdentity(saved, live) {
    if (live.url === void 0 || live.url !== saved.url) return false;
    return (live.cookieStoreId ?? void 0) === (saved.cookie_store_id ?? void 0);
  }
  function mapExistingTabs(saved, current) {
    const restoredByIndex = /* @__PURE__ */ new Map();
    const reusedTabIds = /* @__PURE__ */ new Set();
    const available = (current.tabs ?? []).filter((tab) => tab.id !== void 0);
    for (const savedTab of [...saved.tabs].sort((a, b) => a.index - b.index)) {
      const candidates = available.filter((tab) => tab.id !== void 0 && !reusedTabIds.has(tab.id) && sameTabSemanticIdentity(savedTab, tab) && !(tab.pinned && !savedTab.pinned)).sort((left, right) => {
        const leftPinPenalty = left.pinned === savedTab.pinned ? 0 : 1;
        const rightPinPenalty = right.pinned === savedTab.pinned ? 0 : 1;
        return leftPinPenalty - rightPinPenalty || Math.abs(left.index - savedTab.index) - Math.abs(right.index - savedTab.index) || left.index - right.index;
      });
      const chosen = candidates[0];
      if (chosen?.id === void 0) continue;
      reusedTabIds.add(chosen.id);
      restoredByIndex.set(savedTab.index, chosen);
    }
    return { restoredByIndex, reusedTabIds };
  }
  async function reconcileTabs(saved, restoredByIndex, protectedPinnedIds = /* @__PURE__ */ new Set()) {
    for (const savedTab of saved.tabs) {
      const tab = restoredByIndex.get(savedTab.index);
      if (tab?.id === void 0) continue;
      const changes = {};
      if (tab.pinned !== savedTab.pinned) {
        if (!(protectedPinnedIds.has(tab.id) && tab.pinned && !savedTab.pinned)) {
          changes.pinned = savedTab.pinned;
        }
      }
      if (tab.mutedInfo?.muted !== savedTab.muted) changes.muted = savedTab.muted;
      if (Object.keys(changes).length > 0) {
        await chrome.tabs.update(tab.id, changes).catch(() => void 0);
      }
    }
    const activeSaved = saved.tabs.find((tab) => tab.active);
    const activeRestored = activeSaved ? restoredByIndex.get(activeSaved.index) : void 0;
    const fallback = activeRestored ?? [...restoredByIndex.values()][0];
    if (fallback?.id !== void 0) {
      await chrome.tabs.update(fallback.id, { active: true }).catch(() => void 0);
    }
  }
  function sameNumberOrder(actual, expected) {
    return actual.length === expected.length && actual.every((value, index) => value === expected[index]);
  }
  async function orderRestoredTabs(saved, restoredByIndex, windowId, protectedPinnedIds = /* @__PURE__ */ new Set()) {
    const sortedSaved = [...saved.tabs].sort((a, b) => a.index - b.index);
    const desiredMutablePinnedIds = [];
    const desiredUnpinnedIds2 = [];
    for (const savedTab of sortedSaved) {
      const tab = restoredByIndex.get(savedTab.index);
      if (tab?.id === void 0 || protectedPinnedIds.has(tab.id)) continue;
      if (savedTab.pinned) desiredMutablePinnedIds.push(tab.id);
      else desiredUnpinnedIds2.push(tab.id);
    }
    for (let attempt = 0; attempt < TAB_ORDER_RETRIES; attempt += 1) {
      let current = await chrome.windows.get(windowId, { populate: true }).catch(() => void 0);
      if (!current) return false;
      const protectedPinnedCount = (current.tabs ?? []).filter(
        (tab) => tab.id !== void 0 && tab.pinned && protectedPinnedIds.has(tab.id)
      ).length;
      for (const [rank, id] of desiredMutablePinnedIds.entries()) {
        await chrome.tabs.move(id, { windowId, index: protectedPinnedCount + rank }).catch(() => void 0);
      }
      current = await chrome.windows.get(windowId, { populate: true }).catch(() => void 0);
      if (!current) return false;
      const pinnedCount = (current.tabs ?? []).filter((tab) => tab.pinned).length;
      for (const [rank, id] of desiredUnpinnedIds2.entries()) {
        await chrome.tabs.move(id, { windowId, index: pinnedCount + rank }).catch(() => void 0);
      }
      await delay(TAB_ORDER_SETTLE_MS * (attempt + 1));
      current = await chrome.windows.get(windowId, { populate: true }).catch(() => void 0);
      if (!current) return false;
      const mutablePinnedSet = new Set(desiredMutablePinnedIds);
      const unpinnedSet = new Set(desiredUnpinnedIds2);
      const actualMutablePinned = (current.tabs ?? []).filter((tab) => tab.id !== void 0 && tab.pinned && mutablePinnedSet.has(tab.id)).map((tab) => tab.id);
      const actualUnpinned = (current.tabs ?? []).filter((tab) => tab.id !== void 0 && !tab.pinned && unpinnedSet.has(tab.id)).map((tab) => tab.id);
      if (sameNumberOrder(actualMutablePinned, desiredMutablePinnedIds) && sameNumberOrder(actualUnpinned, desiredUnpinnedIds2)) {
        return true;
      }
    }
    return false;
  }
  async function reuseAssignedWindow(saved, match, report) {
    if (match.window.id === void 0) throw new Error("Firefox returned an existing window without an ID");
    const windowId = match.window.id;
    const current = await chrome.windows.get(windowId, { populate: true });
    const { restoredByIndex, reusedTabIds } = mapExistingTabs(saved, current);
    const originalTabIds = (current.tabs ?? []).map((tab) => tab.id).filter((id) => id !== void 0);
    const protectedPinnedIds = new Set(
      (current.tabs ?? []).filter((tab) => tab.id !== void 0 && tab.pinned).map((tab) => tab.id)
    );
    const reusedCount = restoredByIndex.size;
    for (const savedTab of [...saved.tabs].sort((a, b) => a.index - b.index)) {
      if (restoredByIndex.has(savedTab.index)) continue;
      if (!savedTab.restorable) {
        report.warnings.push(
          `Could not recreate non-restorable tab '${savedTab.title ?? savedTab.url}' in ${saved.key}; any already-open matching privileged tab would have been reused.`
        );
        continue;
      }
      try {
        const restored = await createTab(windowId, savedTab, report.warnings);
        restoredByIndex.set(savedTab.index, restored);
        report.created_tabs += 1;
      } catch (error) {
        report.warnings.push(
          `Failed to complete '${savedTab.title ?? savedTab.url}' in reused ${saved.key}: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
    const extraTabIds = originalTabIds.filter(
      (id) => !reusedTabIds.has(id) && !protectedPinnedIds.has(id)
    );
    if (restoredByIndex.size > 0) {
      for (const id of extraTabIds) {
        await chrome.tabs.remove(id).catch(() => void 0);
      }
    } else if (extraTabIds.length > 0) {
      report.warnings.push(
        `Context Capsule could not establish any target tab in ${saved.key}; its existing tabs were left untouched instead of risking an empty window.`
      );
    }
    await reconcileTabs(saved, restoredByIndex, protectedPinnedIds);
    const preGroupOrder = await orderRestoredTabs(saved, restoredByIndex, windowId, protectedPinnedIds);
    await restoreGroups(windowId, saved, restoredByIndex, report);
    const finalOrder = await orderRestoredTabs(saved, restoredByIndex, windowId, protectedPinnedIds);
    if (!preGroupOrder || !finalOrder) {
      report.warnings.push(
        `Tab order for ${saved.key} did not fully converge after ${TAB_ORDER_RETRIES} verified placement attempts; existing Zen pinned/Essential tabs were preserved rather than moved destructively.`
      );
    }
    await restoreGeometry(windowId, saved).catch((error) => {
      report.warnings.push(
        `Could not reconcile geometry for ${saved.key}: ${error instanceof Error ? error.message : String(error)}`
      );
    });
    report.reused_windows += 1;
    report.reused_tabs += reusedCount;
    return windowId;
  }
  async function populateWindow(windowId, bootstrapTabId, saved, report) {
    const restoredByIndex = /* @__PURE__ */ new Map();
    for (const savedTab of [...saved.tabs].sort((a, b) => a.index - b.index)) {
      if (!savedTab.restorable) continue;
      try {
        const restored = await createTab(windowId, savedTab, report.warnings);
        restoredByIndex.set(savedTab.index, restored);
        report.created_tabs += 1;
      } catch (error) {
        report.warnings.push(
          `Failed to restore '${savedTab.title ?? savedTab.url}': ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
    if (bootstrapTabId !== void 0 && restoredByIndex.size > 0) {
      await chrome.tabs.remove(bootstrapTabId).catch(() => void 0);
    }
    await reconcileTabs(saved, restoredByIndex);
    const preGroupOrder = await orderRestoredTabs(saved, restoredByIndex, windowId);
    await restoreGroups(windowId, saved, restoredByIndex, report);
    const finalOrder = await orderRestoredTabs(saved, restoredByIndex, windowId);
    if (!preGroupOrder || !finalOrder) {
      report.warnings.push(
        `Tab order for ${saved.key} did not fully converge after ${TAB_ORDER_RETRIES} verified placement attempts.`
      );
    }
    await restoreGeometry(windowId, saved).catch((error) => {
      report.warnings.push(
        `Could not restore geometry for ${saved.key}: ${error instanceof Error ? error.message : String(error)}`
      );
    });
  }
  async function reuseBootstrapWindow(saved, current, report) {
    if (current.id === void 0) throw new Error("Firefox returned a bootstrap window without an ID");
    const bootstrapTabId = current.tabs?.[0]?.id;
    await populateWindow(current.id, bootstrapTabId, saved, report);
    report.reused_windows += 1;
    return current.id;
  }
  async function waitForStableNewDisposableWindow(before, timeoutMs = NATIVE_BLANK_WINDOW_TIMEOUT_MS) {
    const deadline = Date.now() + timeoutMs;
    const observedNewIds = /* @__PURE__ */ new Set();
    const transientDisposableIds = /* @__PURE__ */ new Set();
    let stableId;
    let stableSince = 0;
    while (Date.now() < deadline) {
      const windows = await chrome.windows.getAll({ populate: true, windowTypes: ["normal"] });
      const fresh = windows.filter((window) => window.id !== void 0 && !before.has(window.id) && !window.incognito);
      for (const window of fresh) {
        if (window.id !== void 0) observedNewIds.add(window.id);
      }
      if (observedNewIds.size > 1) {
        stableId = void 0;
        stableSince = 0;
        await delay(NATIVE_BLANK_WINDOW_POLL_MS);
        continue;
      }
      const candidate = fresh.find(disposableBootstrapWindow);
      if (candidate?.id !== void 0) {
        transientDisposableIds.add(candidate.id);
        if (stableId !== candidate.id) {
          stableId = candidate.id;
          stableSince = Date.now();
        } else if (Date.now() - stableSince >= NATIVE_BLANK_WINDOW_STABLE_MS) {
          return { window: candidate, observedNewIds, transientDisposableIds };
        }
      } else {
        stableId = void 0;
        stableSince = 0;
      }
      await delay(NATIVE_BLANK_WINDOW_POLL_MS);
    }
    return { observedNewIds, transientDisposableIds };
  }
  async function cleanupUnsafeNativeWindows(observation, beforeWindows) {
    if (observation.observedNewIds.size !== 1) return 0;
    const [id] = observation.observedNewIds;
    if (id === void 0 || !observation.transientDisposableIds.has(id)) return 0;
    const current = await chrome.windows.get(id, { populate: true }).catch(() => void 0);
    if (!current) return 0;
    const mirrorsExisting = beforeWindows.some((before) => liveWindowTopologiesMatch(before, current));
    if (!mirrorsExisting) return 0;
    return chrome.windows.remove(id).then(() => 1).catch(() => 0);
  }
  async function tryCreateNativeBlankWindow(saved, report, options) {
    if (!options.createBlankWindow) return "unsupported";
    const beforeWindows = (await chrome.windows.getAll({ populate: true, windowTypes: ["normal"] })).filter((window) => !window.incognito);
    const before = new Set(beforeWindows.map((window) => window.id).filter((id) => id !== void 0));
    let outcome;
    try {
      outcome = await options.createBlankWindow();
    } catch (error) {
      report.warnings.push(
        `Could not create the independent browser window for ${saved.key}: ${error instanceof Error ? error.message : String(error)}. Existing tabs were left untouched.`
      );
      return void 0;
    }
    if (outcome === "unsupported") return "unsupported";
    const observation = await waitForStableNewDisposableWindow(before);
    const blank = observation.window;
    if (blank?.id === void 0) {
      const closed = await cleanupUnsafeNativeWindows(observation, beforeWindows);
      report.warnings.push(
        `Zen did not produce one stable isolated blank window for ${saved.key}. Context Capsule refused to inject saved tabs into a synchronized, mirrored, or ambiguous new window${closed > 0 ? " and closed the single attributable mirrored window created by the attempt" : ""}. Existing browser state was left untouched.`
      );
      return void 0;
    }
    const confirmed = await chrome.windows.get(blank.id, { populate: true }).catch(() => void 0);
    const confirmedId = confirmed?.id;
    if (confirmedId === void 0 || !confirmed || !disposableBootstrapWindow(confirmed)) {
      const closed = await cleanupUnsafeNativeWindows(observation, beforeWindows);
      report.warnings.push(
        `Zen changed the new blank window before ${saved.key} could be populated. Context Capsule aborted the restore${closed > 0 ? " and closed the single attributable mirrored window" : ""} rather than risk changing an existing synchronized Space.`
      );
      return void 0;
    }
    await populateWindow(confirmedId, confirmed.tabs?.[0]?.id, saved, report);
    report.created_windows += 1;
    return confirmedId;
  }
  async function createStandardFirefoxWindow(saved, report) {
    const created = await chrome.windows.create({ url: "about:blank", focused: false, state: "normal" });
    if (created.id === void 0) throw new Error("Firefox created a window without an ID");
    await delay(NEW_WINDOW_SETTLE_MS);
    const settled = await chrome.windows.get(created.id, { populate: true }).catch(() => created);
    if (!disposableBootstrapWindow(settled)) {
      report.warnings.push(
        `Firefox created ${saved.key} with unexpected user tabs; the new window was closed without modifying them.`
      );
      await chrome.windows.remove(created.id).catch(() => void 0);
      return void 0;
    }
    await populateWindow(created.id, settled.tabs?.[0]?.id, saved, report);
    report.created_windows += 1;
    return created.id;
  }
  async function createSavedWindow(saved, report, options) {
    const nativeResult = await tryCreateNativeBlankWindow(saved, report, options);
    if (nativeResult !== "unsupported") return nativeResult;
    return createStandardFirefoxWindow(saved, report);
  }
  async function restoreFirefoxSnapshot(snapshot, options = {}) {
    const report = {
      created_windows: 0,
      created_tabs: 0,
      created_groups: 0,
      reused_windows: 0,
      reused_tabs: 0,
      warnings: []
    };
    const currentWindows = (await chrome.windows.getAll({ populate: true, windowTypes: ["normal"] })).filter((window) => !window.incognito);
    const existingMatches = assignExistingWindows(snapshot.windows, currentWindows);
    const reservedWindowIds = new Set(
      [...existingMatches.values()].map((match) => match.window.id).filter((id) => id !== void 0)
    );
    const usedWindowIds = /* @__PURE__ */ new Set();
    let focusedWindowId;
    let restoredWindowCount = 0;
    for (const [savedIndex, savedWindow] of snapshot.windows.entries()) {
      const existing = existingMatches.get(savedIndex);
      let id;
      if (existing) {
        id = await reuseAssignedWindow(savedWindow, existing, report);
      } else {
        const bootstrap = currentWindows.find((window) => window.id !== void 0 && !usedWindowIds.has(window.id) && !reservedWindowIds.has(window.id) && disposableBootstrapWindow(window));
        if (bootstrap) {
          id = await reuseBootstrapWindow(savedWindow, bootstrap, report);
        } else {
          id = await createSavedWindow(savedWindow, report, options);
        }
      }
      if (id !== void 0) {
        usedWindowIds.add(id);
        restoredWindowCount += 1;
        if (savedWindow.focused) focusedWindowId = id;
      }
    }
    if (snapshot.windows.length > 0 && restoredWindowCount === snapshot.windows.length) {
      let preservedPinnedWindows = 0;
      for (const current of currentWindows) {
        if (current.id === void 0 || usedWindowIds.has(current.id)) continue;
        if ((current.tabs ?? []).some((tab) => tab.pinned)) {
          preservedPinnedWindows += 1;
          continue;
        }
        await chrome.windows.remove(current.id).catch(() => void 0);
      }
      if (preservedPinnedWindows > 0) {
        report.warnings.push(
          `Preserved ${preservedPinnedWindows} unassigned live browser window(s) because they contain pre-existing pinned tabs that may carry Zen Essential state.`
        );
      }
    } else if (currentWindows.some((window) => window.id !== void 0 && !usedWindowIds.has(window.id))) {
      report.warnings.push(
        "Some saved browser windows could not be restored, so unrelated live windows were preserved instead of being closed during a partial restore."
      );
    }
    if (focusedWindowId !== void 0) {
      await chrome.windows.update(focusedWindowId, { focused: true }).catch(() => void 0);
    }
    return report;
  }

  // src/browser/order.ts
  var FINAL_ORDER_RETRIES = 3;
  var FINAL_ORDER_SETTLE_MS = 40;
  var WINDOW_UNPINNED_OVERLAP_WEIGHT = 1e12;
  var WINDOW_OVERLAP_WEIGHT = 1e9;
  var TAB_GROUP_ID_NONE = -1;
  function delay2(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
  }
  function tabGroupsApi2() {
    return chrome.tabGroups;
  }
  function sameSavedAndLiveTab(saved, live) {
    if (live.url !== saved.url) return false;
    if ((live.cookieStoreId ?? void 0) !== (saved.cookie_store_id ?? void 0)) return false;
    if (!saved.pinned && live.pinned) return false;
    return true;
  }
  function mapSavedTabs(saved, live) {
    const available = (live.tabs ?? []).filter((tab) => tab.id !== void 0);
    const used = /* @__PURE__ */ new Set();
    const result = /* @__PURE__ */ new Map();
    for (const savedTab of [...saved.tabs].sort((left, right) => left.index - right.index)) {
      const candidate = available.filter((tab) => tab.id !== void 0 && !used.has(tab.id) && sameSavedAndLiveTab(savedTab, tab)).sort((left, right) => {
        const pinPenaltyLeft = left.pinned === savedTab.pinned ? 0 : 1;
        const pinPenaltyRight = right.pinned === savedTab.pinned ? 0 : 1;
        return pinPenaltyLeft - pinPenaltyRight || Math.abs(left.index - savedTab.index) - Math.abs(right.index - savedTab.index) || left.index - right.index;
      })[0];
      if (candidate?.id === void 0) continue;
      used.add(candidate.id);
      result.set(savedTab.index, candidate);
    }
    return result;
  }
  function geometryDistance2(saved, live) {
    let total = 0;
    let observed = 0;
    for (const [expected, actual] of [
      [saved.left, live.left],
      [saved.top, live.top],
      [saved.width, live.width],
      [saved.height, live.height]
    ]) {
      if (expected === void 0 || actual === void 0) continue;
      total += Math.abs(expected - actual);
      observed += 1;
    }
    return observed === 0 ? 1e6 : total;
  }
  function buildWindowMatch(saved, live) {
    if (live.id === void 0) return void 0;
    const mappedBySavedIndex = mapSavedTabs(saved, live);
    const overlap = mappedBySavedIndex.size;
    if (overlap === 0) return void 0;
    const unpinnedOverlap = saved.tabs.reduce((count, tab) => count + (!tab.pinned && mappedBySavedIndex.has(tab.index) ? 1 : 0), 0);
    const exactCountBonus = overlap === saved.tabs.length && overlap === (live.tabs?.length ?? 0) ? 1e7 : 0;
    const geometryBonus = Math.max(0, 1e6 - Math.min(1e6, geometryDistance2(saved, live)));
    return {
      window: live,
      mappedBySavedIndex,
      overlap,
      unpinnedOverlap,
      // Final ordering exists specifically for ordinary tabs. Give their overlap
      // overwhelming priority so shared Zen pinned/Essential tabs cannot make the
      // finalizer attach a saved topology to the wrong live window.
      weight: unpinnedOverlap * WINDOW_UNPINNED_OVERLAP_WEIGHT + overlap * WINDOW_OVERLAP_WEIGHT + exactCountBonus + geometryBonus
    };
  }
  function assignSavedWindows(savedWindows, liveWindows) {
    const grid = savedWindows.map((saved) => liveWindows.map((live) => buildWindowMatch(saved, live)));
    const assignment = maximumWeightAssignment(
      grid.map((row) => row.map((candidate) => candidate?.weight ?? 0))
    );
    const result = /* @__PURE__ */ new Map();
    assignment.forEach((liveIndex, savedIndex) => {
      if (liveIndex === void 0) return;
      const candidate = grid[savedIndex]?.[liveIndex];
      if (candidate) result.set(savedIndex, candidate);
    });
    return result;
  }
  function desiredUnpinnedIds(saved, mappedBySavedIndex) {
    return [...saved.tabs].sort((left, right) => left.index - right.index).filter((tab) => !tab.pinned).map((tab) => mappedBySavedIndex.get(tab.index)?.id).filter((id) => id !== void 0);
  }
  function buildSavedBlocks(saved, mappedBySavedIndex) {
    const blocks = [];
    const sorted = [...saved.tabs].sort((left, right) => left.index - right.index).filter((tab) => !tab.pinned && mappedBySavedIndex.get(tab.index)?.id !== void 0);
    for (const savedTab of sorted) {
      const id = mappedBySavedIndex.get(savedTab.index)?.id;
      if (id === void 0) continue;
      const previous = blocks[blocks.length - 1];
      if (savedTab.group_key && previous?.groupKey === savedTab.group_key) {
        previous.ids.push(id);
      } else {
        const block = { ids: [id] };
        if (savedTab.group_key) block.groupKey = savedTab.group_key;
        blocks.push(block);
      }
    }
    return blocks;
  }
  async function liveWindowTabs(windowId) {
    const current = await chrome.windows.get(windowId, { populate: true }).catch(() => void 0);
    if (!current) return void 0;
    return (current.tabs ?? []).sort((left, right) => left.index - right.index);
  }
  function exactRelativeOrder(tabs, desiredIds) {
    const desiredSet = new Set(desiredIds);
    const actual = [...tabs].sort((left, right) => left.index - right.index).filter((tab) => tab.id !== void 0 && !tab.pinned && desiredSet.has(tab.id)).map((tab) => tab.id);
    return actual.length === desiredIds.length && actual.every((id, index) => id === desiredIds[index]);
  }
  function allOrdinaryAndUngrouped(tabs, desiredIds) {
    const desiredSet = new Set(desiredIds);
    const targets = tabs.filter((tab) => tab.id !== void 0 && desiredSet.has(tab.id));
    return targets.length === desiredIds.length && targets.every((tab) => !tab.pinned && (tab.groupId === void 0 || tab.groupId === TAB_GROUP_ID_NONE) && (tab.splitViewId === void 0 || tab.splitViewId === TAB_GROUP_ID_NONE));
  }
  async function moveBlockToFrontBoundary(block, windowId, firstUnpinnedIndex) {
    const current = await Promise.all(
      block.ids.map((id) => chrome.tabs.get(id).catch(() => void 0))
    );
    const present = current.filter((tab) => tab?.id !== void 0);
    if (present.length !== block.ids.length) return;
    const groupIds = present.map((tab) => tab.groupId).filter((id) => id !== void 0 && id >= 0);
    const sharedGroupId = groupIds.length === present.length && groupIds.every((id) => id === groupIds[0]) ? groupIds[0] : void 0;
    const groups = tabGroupsApi2();
    if (sharedGroupId !== void 0 && groups?.move) {
      try {
        await groups.move(sharedGroupId, { windowId, index: firstUnpinnedIndex });
        return;
      } catch {
      }
    }
    const tabIds = block.ids.length === 1 ? block.ids[0] : block.ids;
    await chrome.tabs.move(tabIds, { windowId, index: firstUnpinnedIndex });
  }
  async function enforceWindowOrder(saved, match) {
    const windowId = match.window.id;
    if (windowId === void 0) return false;
    const desiredIds = desiredUnpinnedIds(saved, match.mappedBySavedIndex);
    if (desiredIds.length <= 1) return true;
    for (let attempt = 0; attempt < FINAL_ORDER_RETRIES; attempt += 1) {
      const before = await liveWindowTabs(windowId);
      if (!before) return false;
      if (exactRelativeOrder(before, desiredIds)) return true;
      const firstUnpinnedIndex = before.filter((tab) => tab.pinned).length;
      if (allOrdinaryAndUngrouped(before, desiredIds)) {
        await chrome.tabs.move(desiredIds, { windowId, index: firstUnpinnedIndex }).catch(() => void 0);
      } else {
        const blocks = buildSavedBlocks(saved, match.mappedBySavedIndex);
        for (const block of [...blocks].reverse()) {
          await moveBlockToFrontBoundary(block, windowId, firstUnpinnedIndex).catch(() => void 0);
        }
      }
      await delay2(FINAL_ORDER_SETTLE_MS * (attempt + 1));
      const after = await liveWindowTabs(windowId);
      if (after && exactRelativeOrder(after, desiredIds)) return true;
    }
    return false;
  }
  async function enforceFinalTabOrder(snapshot) {
    const result = { correctedWindows: 0, warnings: [] };
    const liveWindows = (await chrome.windows.getAll({ populate: true, windowTypes: ["normal"] })).filter((window) => !window.incognito && window.id !== void 0);
    const assignment = assignSavedWindows(snapshot.windows, liveWindows);
    for (const [savedIndex, saved] of snapshot.windows.entries()) {
      const match = assignment.get(savedIndex);
      if (!match || match.window.id === void 0) {
        result.warnings.push(`Could not identify the restored live window for final tab ordering in ${saved.key}.`);
        continue;
      }
      const windowId = match.window.id;
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
          `Final tab order for ${saved.key} did not converge to the saved relative order after ${FINAL_ORDER_RETRIES} authoritative attempts.`
        );
      }
    }
    return result;
  }

  // src/native/protocol.ts
  var NATIVE_HOST_NAME2 = NATIVE_HOST_NAME;
  var NATIVE_PROTOCOL_VERSION = 1;
  function requestId() {
    return `${Date.now().toString(36)}-${crypto.randomUUID()}`;
  }

  // src/native/client.ts
  var ZEN_NOT_RUNNING = "no running zen.exe application was detected";
  var NativeClient = class {
    constructor(onStatusChange) {
      this.onStatusChange = onStatusChange;
    }
    onStatusChange;
    port;
    pending = /* @__PURE__ */ new Map();
    status = { connected: false };
    reconnectTimer;
    connect() {
      if (this.port) return;
      try {
        const port = chrome.runtime.connectNative(NATIVE_HOST_NAME2);
        this.port = port;
        port.onMessage.addListener((message) => this.onMessage(message));
        port.onDisconnect.addListener(() => this.onDisconnect());
        this.setStatus({ connected: true });
        void this.ping().catch((error) => this.failConnection(error));
      } catch (error) {
        this.failConnection(error);
      }
    }
    currentStatus() {
      return { ...this.status };
    }
    async appendLog(level, message) {
      if (!message.trim()) return;
      await this.request({
        protocol_version: NATIVE_PROTOCOL_VERSION,
        request_id: requestId(),
        type: "browser.log.append",
        log_level: level,
        log_message: message
      });
    }
    async updateState(snapshot, completion) {
      const request = {
        protocol_version: NATIVE_PROTOCOL_VERSION,
        request_id: requestId(),
        type: "browser.state.update",
        snapshot
      };
      if (completion) {
        request.restore_request_id = completion.requestId;
        request.restore_changed = completion.report ? completion.report.created_windows + completion.report.created_tabs + completion.report.created_groups : 0;
        request.restore_skipped = completion.report ? completion.report.reused_windows + completion.report.reused_tabs : 0;
        request.restore_warnings = completion.report?.warnings ?? [];
        if (completion.error) request.restore_error = completion.error;
      }
      return this.request(request);
    }
    async pollRestoreRequest() {
      const response = await this.ping();
      return response.restore_request;
    }
    async getCapsule(name) {
      const response = await this.request({
        protocol_version: NATIVE_PROTOCOL_VERSION,
        request_id: requestId(),
        type: "browser.capsule.get",
        capsule_name: name
      });
      if (!response.snapshot) throw new Error("Native host returned no browser snapshot");
      return response.snapshot;
    }
    async createBlankBrowserWindow() {
      if (!IS_FIREFOX) return "unsupported";
      try {
        await this.request({
          protocol_version: NATIVE_PROTOCOL_VERSION,
          request_id: requestId(),
          type: "browser.window.blank.create"
        });
        return "created";
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.toLocaleLowerCase("en-US").includes(ZEN_NOT_RUNNING)) return "unsupported";
        throw error;
      }
    }
    /** Zen-only compatibility command. Split restore is currently disabled. */
    async invokeZenSplit(orientation) {
      if (!IS_FIREFOX) {
        throw new Error("Zen split commands are unavailable in the Chrome adapter");
      }
      const request = {
        protocol_version: NATIVE_PROTOCOL_VERSION,
        request_id: requestId(),
        type: "browser.zen.split.invoke",
        split_orientation: orientation
      };
      const response = await chrome.runtime.sendNativeMessage(
        NATIVE_HOST_NAME2,
        request
      );
      if (!response?.ok) {
        throw new Error(response?.error ?? "Fresh Context Capsule native host rejected the Zen split command");
      }
    }
    async ping() {
      const response = await this.request({
        protocol_version: NATIVE_PROTOCOL_VERSION,
        request_id: requestId(),
        type: "ping"
      });
      const status2 = { connected: true };
      if (response.host_version) status2.host_version = response.host_version;
      this.setStatus(status2);
      return response;
    }
    request(request) {
      if (!this.port) this.connect();
      const port = this.port;
      if (!port) return Promise.reject(new Error("Context Capsule native host is not connected"));
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          this.pending.delete(request.request_id);
          reject(new Error(`Native request '${request.type}' timed out`));
        }, 1e4);
        this.pending.set(request.request_id, { resolve, reject, timeout });
        try {
          port.postMessage(request);
        } catch (error) {
          clearTimeout(timeout);
          this.pending.delete(request.request_id);
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      });
    }
    onMessage(message) {
      if (!message || typeof message !== "object") return;
      const response = message;
      if (typeof response.request_id !== "string") return;
      const pending = this.pending.get(response.request_id);
      if (!pending) return;
      clearTimeout(pending.timeout);
      this.pending.delete(response.request_id);
      if (!response.ok) {
        pending.reject(new Error(response.error ?? "Native host request failed"));
        return;
      }
      pending.resolve(response);
    }
    onDisconnect() {
      const runtimeError = chrome.runtime.lastError?.message;
      this.port = void 0;
      this.rejectPending(new Error(runtimeError ?? "Context Capsule native host disconnected"));
      const status2 = { connected: false };
      if (runtimeError) status2.last_error = runtimeError;
      this.setStatus(status2);
      this.scheduleReconnect();
    }
    failConnection(error) {
      const message = error instanceof Error ? error.message : String(error);
      this.port = void 0;
      this.setStatus({ connected: false, last_error: message });
      this.scheduleReconnect();
    }
    scheduleReconnect() {
      if (this.reconnectTimer) return;
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = void 0;
        this.connect();
      }, 5e3);
    }
    rejectPending(error) {
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timeout);
        pending.reject(error);
      }
      this.pending.clear();
    }
    setStatus(status2) {
      this.status = status2;
      this.onStatusChange(this.currentStatus());
    }
  };

  // src/background.ts
  var latestSnapshot;
  var syncTimer;
  var syncing = false;
  var restoring = false;
  var nativeStatus = { connected: false };
  var lastSyncUnixMs;
  var lastError;
  var lastRestore;
  var lastHandledRestoreRequestId;
  var lastLoggedError;
  var RESTORE_POLL_MS = 350;
  var native = new NativeClient((status2) => {
    const wasConnected = nativeStatus.connected;
    nativeStatus = status2;
    if (status2.connected && !wasConnected) {
      queueMicrotask(() => persistDiagnostic("info", `${BROWSER_LABEL} adapter connected to native host`));
    }
  });
  function persistDiagnostic(level, message) {
    if (!native.currentStatus().connected) return;
    void native.appendLog(level, message).catch(() => {
    });
  }
  function recordError(context, error) {
    const message = error instanceof Error ? error.message : String(error);
    lastError = message;
    const signature = `${context}:${message}`;
    if (signature !== lastLoggedError) {
      lastLoggedError = signature;
      persistDiagnostic("error", `${context}; ${message}`);
    }
    return message;
  }
  function clearError() {
    lastError = void 0;
    lastLoggedError = void 0;
  }
  function status() {
    const value = {
      native: nativeStatus,
      windows: latestSnapshot?.windows.length ?? 0,
      tabs: latestSnapshot ? tabCount(latestSnapshot) : 0,
      skipped_private_windows: latestSnapshot?.skipped_private_windows ?? 0,
      syncing,
      restoring
    };
    if (latestSnapshot?.install_type) value.install_type = latestSnapshot.install_type;
    if (lastSyncUnixMs !== void 0) value.last_sync_unix_ms = lastSyncUnixMs;
    if (lastError) value.last_error = lastError;
    if (lastRestore) value.last_restore = lastRestore;
    return value;
  }
  async function syncSnapshot(reason = "automatic") {
    if (syncing || restoring) return status();
    syncing = true;
    try {
      const snapshot = await captureBrowserSnapshot();
      latestSnapshot = snapshot;
      await native.updateState(snapshot);
      lastSyncUnixMs = Date.now();
      clearError();
      if (reason !== "automatic") {
        persistDiagnostic(
          "info",
          `${BROWSER_LABEL} semantic capture completed; reason=${reason} install_type=${snapshot.install_type ?? "unknown"} windows=${snapshot.windows.length} tabs=${tabCount(snapshot)} private_skipped=${snapshot.skipped_private_windows}`
        );
      }
    } catch (error) {
      recordError(`${BROWSER_LABEL} semantic capture failed; reason=${reason}`, error);
    } finally {
      syncing = false;
    }
    return status();
  }
  function scheduleSync(delay3 = 500, reason = "automatic") {
    if (restoring) return;
    if (syncTimer) clearTimeout(syncTimer);
    syncTimer = setTimeout(() => {
      syncTimer = void 0;
      void syncSnapshot(reason);
    }, delay3);
  }
  function restoreOptions() {
    return IS_FIREFOX ? { createBlankWindow: () => native.createBlankBrowserWindow() } : {};
  }
  function restoreSummary(report) {
    return `created_windows=${report.created_windows} created_tabs=${report.created_tabs} created_groups=${report.created_groups} reused_windows=${report.reused_windows} reused_tabs=${report.reused_tabs} warnings=${report.warnings.length}`;
  }
  async function finalizeTabOrder(snapshot, report) {
    const ordering = await enforceFinalTabOrder(snapshot);
    report.warnings.push(...ordering.warnings);
    if (ordering.correctedWindows > 0 || ordering.warnings.length > 0) {
      persistDiagnostic(
        ordering.warnings.length > 0 ? "warn" : "info",
        `Final browser tab ordering completed; corrected_windows=${ordering.correctedWindows} warnings=${ordering.warnings.length}`
      );
    }
  }
  async function prepareAuthoritativeRestore(snapshot) {
    persistDiagnostic(
      "info",
      `${BROWSER_LABEL} authoritative restore delegated to global reuse planner; saved_windows=${snapshot.windows.length} saved_tabs=${tabCount(snapshot)}`
    );
    return snapshot;
  }
  async function restoreCapsule(name) {
    const trimmed = name.trim();
    if (!trimmed) throw new Error("Enter a capsule name to restore");
    restoring = true;
    clearError();
    persistDiagnostic("info", `Popup-requested ${BROWSER_LABEL} semantic restore started`);
    try {
      const snapshot = await native.getCapsule(trimmed);
      if (snapshot.browser !== BROWSER_ADAPTER_ID) {
        throw new Error(`Capsule returned ${snapshot.browser} state to the ${BROWSER_ADAPTER_ID} adapter`);
      }
      const prepared = await prepareAuthoritativeRestore(snapshot);
      lastRestore = await restoreFirefoxSnapshot(prepared, restoreOptions());
      await finalizeTabOrder(prepared, lastRestore);
      persistDiagnostic(
        lastRestore.warnings.length > 0 ? "warn" : "info",
        `Popup-requested ${BROWSER_LABEL} semantic restore completed; ${restoreSummary(lastRestore)}`
      );
    } catch (error) {
      recordError(`Popup-requested ${BROWSER_LABEL} semantic restore failed`, error);
      throw error;
    } finally {
      restoring = false;
      scheduleSync(1e3);
    }
    return status();
  }
  async function completeNativeRestore(request) {
    if (restoring || request.request_id === lastHandledRestoreRequestId) return;
    restoring = true;
    clearError();
    let report;
    let restoreError;
    persistDiagnostic(
      "info",
      `CLI-requested ${BROWSER_LABEL} semantic restore started; windows=${request.payload.windows.length} tabs=${tabCount(request.payload)}`
    );
    try {
      if (request.adapter !== BROWSER_ADAPTER_ID || request.schema_version !== 1) {
        throw new Error(`Unsupported Context Capsule ${BROWSER_LABEL} restore request`);
      }
      if (request.payload.browser !== BROWSER_ADAPTER_ID) {
        throw new Error(`Restore payload belongs to '${request.payload.browser}', not '${BROWSER_ADAPTER_ID}'`);
      }
      const prepared = await prepareAuthoritativeRestore(request.payload);
      report = await restoreFirefoxSnapshot(prepared, restoreOptions());
      await finalizeTabOrder(prepared, report);
      lastRestore = report;
      persistDiagnostic(
        report.warnings.length > 0 ? "warn" : "info",
        `CLI-requested ${BROWSER_LABEL} semantic restore applied; ${restoreSummary(report)}`
      );
    } catch (error) {
      restoreError = recordError(`CLI-requested ${BROWSER_LABEL} semantic restore failed`, error);
    }
    try {
      const snapshot = await captureBrowserSnapshot();
      latestSnapshot = snapshot;
      const completion = { requestId: request.request_id };
      if (report) completion.report = report;
      if (restoreError) completion.error = restoreError;
      await native.updateState(snapshot, completion);
      lastSyncUnixMs = Date.now();
      lastHandledRestoreRequestId = request.request_id;
    } catch (completionError) {
      recordError(`${BROWSER_LABEL} restore completion synchronization failed`, completionError);
    } finally {
      restoring = false;
    }
  }
  async function pollNativeRestore() {
    if (restoring || !native.currentStatus().connected) return;
    try {
      const request = await native.pollRestoreRequest();
      if (request) await completeNativeRestore(request);
    } catch {
    }
  }
  function messageError(error) {
    return {
      __context_capsule_error: error instanceof Error ? error.message : String(error)
    };
  }
  if (IS_FIREFOX) {
    chrome.runtime.onMessage.addListener((message) => {
      const request = message;
      switch (request.type) {
        case "status":
          return Promise.resolve(status());
        case "capture-now":
          return syncSnapshot("manual");
        case "restore-capsule":
          return restoreCapsule(request.capsule_name ?? "");
        default:
          return void 0;
      }
    });
  } else {
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      const request = message;
      switch (request.type) {
        case "status":
          sendResponse(status());
          return false;
        case "capture-now":
          void syncSnapshot("manual").then(sendResponse, (error) => sendResponse(messageError(error)));
          return true;
        case "restore-capsule":
          void restoreCapsule(request.capsule_name ?? "").then(sendResponse, (error) => sendResponse(messageError(error)));
          return true;
        default:
          return false;
      }
    });
  }
  chrome.tabs.onCreated.addListener(() => scheduleSync());
  chrome.tabs.onRemoved.addListener(() => scheduleSync());
  chrome.tabs.onMoved.addListener(() => scheduleSync());
  chrome.tabs.onActivated.addListener(() => scheduleSync());
  chrome.tabs.onAttached.addListener(() => scheduleSync());
  chrome.tabs.onDetached.addListener(() => scheduleSync());
  chrome.tabs.onUpdated.addListener(() => scheduleSync());
  chrome.windows.onCreated.addListener(() => scheduleSync());
  chrome.windows.onRemoved.addListener(() => scheduleSync());
  chrome.windows.onFocusChanged.addListener(() => scheduleSync());
  var maybeGroups = chrome.tabGroups;
  for (const event of [maybeGroups?.onCreated, maybeGroups?.onMoved, maybeGroups?.onRemoved, maybeGroups?.onUpdated]) {
    event?.addListener(() => scheduleSync());
  }
  native.connect();
  scheduleSync(100, "startup");
  setInterval(() => scheduleSync(0), 3e4);
  setInterval(() => void pollNativeRestore(), RESTORE_POLL_MS);
})();
//# sourceMappingURL=background.js.map
