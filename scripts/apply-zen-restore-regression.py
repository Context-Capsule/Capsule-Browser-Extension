from pathlib import Path

restore_path = Path("src/browser/restore.ts")
text = restore_path.read_text(encoding="utf-8")


def once(old: str, new: str) -> None:
    global text
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"expected exactly one occurrence, found {count}: {old[:160]!r}")
    text = text.replace(old, new, 1)


once(
    '} from "./model";\n',
    '} from "./model";\nimport { IS_FIREFOX } from "../platform";\n',
)
once(
    "const WINDOW_REUSE_OVERLAP_WEIGHT = 1_000_000_000_000;\n",
    "const WINDOW_REUSE_UNPINNED_OVERLAP_WEIGHT = 1_000_000_000_000;\n"
    "const WINDOW_REUSE_TOTAL_OVERLAP_WEIGHT = 1_000_000_000;\n",
)
once(
    'function semanticTabKey(url: string, cookieStoreId: string | undefined): string {\n'
    '  return `${cookieStoreId ?? ""}\\u0000${url}`;\n'
    '}',
    'function semanticTabKey(url: string, cookieStoreId: string | undefined, pinned: boolean): string {\n'
    '  return `${pinned ? "p" : "u"}\\u0000${cookieStoreId ?? ""}\\u0000${url}`;\n'
    '}',
)
once(
    "const savedKeys = savedRelevant.map((tab) => semanticTabKey(tab.url, tab.cookie_store_id));\n"
    "  const liveKeys = liveRelevant.map((tab) => semanticTabKey(tab.url!, tab.cookieStoreId));",
    "const savedKeys = savedRelevant.map((tab) => semanticTabKey(tab.url, tab.cookie_store_id, tab.pinned));\n"
    "  const liveKeys = liveRelevant.map((tab) => semanticTabKey(tab.url!, tab.cookieStoreId, tab.pinned));",
)
once(
    "savedUnpinned.map((tab) => semanticTabKey(tab.url, tab.cookie_store_id)),\n"
    "    liveUnpinned.map((tab) => semanticTabKey(tab.url!, tab.cookieStoreId)),",
    "savedUnpinned.map((tab) => semanticTabKey(tab.url, tab.cookie_store_id, false)),\n"
    "    liveUnpinned.map((tab) => semanticTabKey(tab.url!, tab.cookieStoreId, false)),",
)
once(
    "  const strongFuzzyIdentity = similarity.score > 0;\n\n  const savedCoverage",
    "  const strongFuzzyIdentity = similarity.score > 0;\n"
    "  // Shared Zen Essentials/pinned tabs exist in more than one Zen window and\n"
    "  // cannot establish which saved window owns a live window. Require real\n"
    "  // semantic evidence (or a disposable blank shell) for global assignment.\n"
    "  if (!(similarity.exact || strongFuzzyIdentity || reuse.liveSubset || disposableBootstrapWindow(current))) {\n"
    "    return undefined;\n"
    "  }\n\n"
    "  const savedCoverage",
)
once(
    "  // The leading term makes total reusable tab count the global objective. The\n"
    "  // smaller terms break ties in favor of exact/subset semantic identity, then\n"
    "  // cheap shells (blank/fewer unrelated tabs), and finally saved geometry. A\n"
    "  // final +1 keeps even a zero-overlap live window preferable to a dummy slot:\n"
    "  // if a real window exists, reuse it before creating another one.\n"
    "  const weight = reuse.overlap * WINDOW_REUSE_OVERLAP_WEIGHT",
    "  // Ordinary user tabs establish window identity. Total overlap is only\n"
    "  // secondary so shared Zen Essentials cannot outweigh unpinned evidence.\n"
    "  const weight = reuse.unpinnedOverlap * WINDOW_REUSE_UNPINNED_OVERLAP_WEIGHT\n"
    "    + reuse.overlap * WINDOW_REUSE_TOTAL_OVERLAP_WEIGHT",
)

old_assign = '''function assignExistingWindows(
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
}'''
new_assign = '''function assignExistingWindows(
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
  const usedCurrentIndexes = new Set<number>();
  assignment.forEach((currentIndex, savedIndex) => {
    if (currentIndex === undefined) return;
    const candidate = candidateGrid[savedIndex]?.[currentIndex];
    if (!candidate) return;
    result.set(savedIndex, candidate);
    usedCurrentIndexes.add(currentIndex);
  });

  // A zero-overlap nonblank shell is safe to reuse only when there is exactly
  // one unmatched saved window and one unused live window. With several saved
  // windows, arbitrary shell assignment can move the survivor into the wrong
  // Zen window's geometry and hide the fact that a window is missing.
  const unmatchedSavedIndexes = savedWindows
    .map((_, index) => index)
    .filter((index) => !result.has(index));
  const unusedCurrentIndexes = currentWindows
    .map((_, index) => index)
    .filter((index) => !usedCurrentIndexes.has(index));
  if (unmatchedSavedIndexes.length === 1 && unusedCurrentIndexes.length === 1) {
    const savedIndex = unmatchedSavedIndexes[0]!;
    const currentIndex = unusedCurrentIndexes[0]!;
    const saved = savedWindows[savedIndex]!;
    const current = currentWindows[currentIndex]!;
    if (current.id !== undefined) {
      const similarity = savedWindowSimilarity(saved, liveTabs(current));
      const reuse = reusableTabOverlap(saved, current);
      result.set(savedIndex, {
        window: current,
        exact: similarity.exact,
        score: similarity.score,
        overlap: reuse.overlap,
        savedRelevant: reuse.savedRelevant,
        liveRelevant: reuse.liveRelevant,
        liveSubset: reuse.liveSubset,
        weight: 1,
      });
    }
  }

  return result;
}'''
once(old_assign, new_assign)

once(
    "&& !(tab.pinned && !savedTab.pinned))",
    "&& !(IS_FIREFOX && tab.pinned && !savedTab.pinned))",
)
once(
    '''  const protectedPinnedIds = new Set(
    (current.tabs ?? [])
      .filter((tab) => tab.id !== undefined && tab.pinned)
      .map((tab) => tab.id as number),
  );''',
    '''  const protectedPinnedIds = IS_FIREFOX
    ? new Set(
        (current.tabs ?? [])
          .filter((tab) => tab.id !== undefined && tab.pinned)
          .map((tab) => tab.id as number),
      )
    : new Set<number>();''',
)
once(
    "if ((current.tabs ?? []).some((tab) => tab.pinned)) {",
    "if (IS_FIREFOX && (current.tabs ?? []).some((tab) => tab.pinned)) {",
)
restore_path.write_text(text, encoding="utf-8")

tests_path = Path("tests/index.ts")
tests = tests_path.read_text(encoding="utf-8")
marker = 'console.log("zero-overlap shell reuse regression test passed");\n'
if tests.count(marker) != 1:
    raise SystemExit("expected zero-overlap regression marker exactly once")
regression = r'''

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
'''
tests = tests.replace(marker, marker + regression, 1)
tests_path.write_text(tests, encoding="utf-8")
