import { isRestorableUrl, restorableUrl, tabCount, type FirefoxSnapshot } from "../src/browser/model";

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
const snapshot: FirefoxSnapshot = {
  schema_version: 1,
  browser: "firefox",
  extension_version: "0.1.0",
  captured_at_unix_ms: 1,
  skipped_private_windows: 0,
  windows: [
    { key: "one", focused: true, state: "normal", tabs: [{ index: 0, url: "https://a.test", pinned: false, active: true, discarded: false, muted: false, restorable: true }], groups: [] },
    { key: "two", focused: false, state: "maximized", tabs: [{ index: 0, url: "https://b.test", pinned: true, active: true, discarded: false, muted: false, restorable: true }, { index: 1, url: "https://c.test", pinned: false, active: false, discarded: true, muted: true, restorable: true }], groups: [] },
  ],
};
assert(tabCount(snapshot) === 3, "tabCount should sum every window");
console.log("extension model tests passed");
