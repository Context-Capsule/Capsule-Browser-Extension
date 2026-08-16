import { isRestorableUrl, restorableUrl, tabCount, type BrowserTabSnapshot, type FirefoxSnapshot } from "../src/browser/model";
import { tabMatchesSnapshot, windowReuseScore } from "../src/browser/restore";

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
assert(restorableUrl("about:config") === "about:blank", "privileged URL should fall back to blank");

const savedTab: BrowserTabSnapshot = {
  index: 0,
  url: "https://example.com/work",
  pinned: false,
  active: true,
  discarded: false,
  muted: false,
  cookie_store_id: "firefox-container-2",
  restorable: true,
};
assert(
  tabMatchesSnapshot(savedTab, {
    url: "https://example.com/work",
    cookieStoreId: "firefox-container-2",
  }),
  "same URL and container should be reused",
);
assert(
  !tabMatchesSnapshot(savedTab, {
    url: "https://example.com/work",
    cookieStoreId: "firefox-default",
  }),
  "same URL in a different container must not be treated as the same tab",
);
assert(
  !tabMatchesSnapshot(savedTab, {
    url: "https://example.com/other",
    cookieStoreId: "firefox-container-2",
  }),
  "different URLs must not be reused",
);

const savedWindow = {
  key: "work-window",
  focused: true,
  state: "normal" as const,
  left: 100,
  top: 100,
  width: 1200,
  height: 800,
  tabs: [savedTab],
  groups: [],
};
const matchingScore = windowReuseScore(savedWindow, {
  tabs: [{
    url: savedTab.url,
    cookieStoreId: savedTab.cookie_store_id,
    pinned: false,
  }],
  left: 100,
  top: 100,
  width: 1200,
  height: 800,
});
const unrelatedScore = windowReuseScore(savedWindow, {
  tabs: [{
    url: "https://unrelated.example/",
    cookieStoreId: savedTab.cookie_store_id,
    pinned: false,
  }],
  left: 100,
  top: 100,
  width: 1200,
  height: 800,
});
const blankScore = windowReuseScore(savedWindow, {
  tabs: [{
    url: "about:newtab",
    cookieStoreId: "firefox-default",
    pinned: false,
  }],
  left: 110,
  top: 105,
  width: 1190,
  height: 795,
});
assert(matchingScore > blankScore, "a window with a saved tab should be preferred over a disposable blank window");
assert(blankScore > 0, "a disposable blank window should be reusable rather than creating another window");
assert(unrelatedScore === 0, "an unrelated user window must never be reused only because its geometry matches");

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
      tabs: [{
        index: 0,
        url: "https://a.test",
        pinned: false,
        active: true,
        discarded: false,
        muted: false,
        restorable: true,
      }],
      groups: [],
    },
    {
      key: "two",
      focused: false,
      state: "maximized",
      tabs: [
        {
          index: 0,
          url: "https://b.test",
          pinned: true,
          active: true,
          discarded: false,
          muted: false,
          restorable: true,
        },
        {
          index: 1,
          url: "https://c.test",
          pinned: false,
          active: false,
          discarded: true,
          muted: true,
          restorable: true,
        },
      ],
      groups: [],
    },
  ],
};
assert(tabCount(snapshot) === 3, "tabCount should sum every window");
console.log("extension model and convergent restore tests passed");
