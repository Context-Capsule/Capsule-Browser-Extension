import {
  isDisposableBootstrapTabs,
  isPortableTabGroup,
  isRestorableUrl,
  restorableUrl,
  savedTabsMatchLiveTabs,
  tabCount,
  type FirefoxSnapshot,
} from "../src/browser/model";
import { normalWindowGeometryMatches } from "../src/browser/restore";

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
  "extra live tabs must not cause a saved window to be reused",
);
assert(
  !savedTabsMatchLiveTabs(savedWindow, [{
    index: 0,
    url: "https://different.test",
    pinned: false,
    cookieStoreId: "firefox-container-1",
  }]),
  "different URL topology must not be reused",
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

console.log("extension model tests passed");
