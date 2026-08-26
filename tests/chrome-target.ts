import assert from "node:assert/strict";
import { isCapturedSplitGroup } from "../src/browser/capture";
import { isPortableTabGroup } from "../src/browser/model";
import { NATIVE_HOST_NAME } from "../src/native/protocol";
import { BROWSER_ADAPTER_ID, IS_CHROME, IS_FIREFOX } from "../src/platform";

assert.equal(IS_CHROME, true);
assert.equal(IS_FIREFOX, false);
assert.equal(BROWSER_ADAPTER_ID, "chrome");
assert.equal(NATIVE_HOST_NAME, "com.contextcapsule.chrome");

const twoTabs = [
  { index: 0, pinned: false, active: true },
  { index: 1, pinned: false, active: false },
] as unknown as browser.tabs.Tab[];

assert.equal(
  isCapturedSplitGroup({ title: "" }, twoTabs),
  false,
  "an unnamed Chrome tab group must never be reinterpreted as a Zen split view",
);

assert.equal(
  isPortableTabGroup({ key: "g", title: "", color: "blue", collapsed: false }),
  true,
  "unnamed Chrome tab groups are legitimate portable groups",
);

console.log("Chrome target behavior tests passed.");
