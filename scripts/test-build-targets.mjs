import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

function extensionIdFromKey(key) {
  const hash = createHash("sha256").update(Buffer.from(key, "base64")).digest().subarray(0, 16);
  return [...hash]
    .flatMap(byte => [byte >> 4, byte & 0x0f])
    .map(nibble => String.fromCharCode("a".charCodeAt(0) + nibble))
    .join("");
}

const [firefoxManifest, chromeManifest, firefoxBackground, chromeBackground] = await Promise.all([
  readFile("dist/manifest.json", "utf8").then(JSON.parse),
  readFile("dist-chrome/manifest.json", "utf8").then(JSON.parse),
  readFile("dist/background.js", "utf8"),
  readFile("dist-chrome/background.js", "utf8"),
]);

assert.equal(firefoxManifest.manifest_version, 3);
assert.equal(firefoxManifest.browser_specific_settings?.gecko?.id, "firefox@contextcapsule.app");
assert.deepEqual(firefoxManifest.background, { scripts: ["background.js"] });
assert.ok(firefoxManifest.permissions.includes("cookies"));
assert.ok(firefoxManifest.permissions.includes("nativeMessaging"));
assert.equal(firefoxManifest.background.service_worker, undefined);

assert.equal(chromeManifest.manifest_version, 3);
assert.equal(chromeManifest.minimum_chrome_version, "105");
assert.equal(chromeManifest.browser_specific_settings, undefined);
assert.deepEqual(chromeManifest.background, { service_worker: "background.js" });
assert.ok(chromeManifest.permissions.includes("tabs"));
assert.ok(chromeManifest.permissions.includes("tabGroups"));
assert.ok(chromeManifest.permissions.includes("nativeMessaging"));
assert.ok(!chromeManifest.permissions.includes("cookies"));
assert.equal(extensionIdFromKey(chromeManifest.key), "gmffhdppfaeonombpbbgnldagfeabiof");

assert.match(firefoxBackground, /browser\.runtime/);
assert.doesNotMatch(chromeBackground, /\bbrowser\.runtime/);
assert.match(chromeBackground, /chrome\.runtime/);
assert.match(chromeBackground, /com\.contextcapsule\.chrome/);
assert.match(firefoxBackground, /com\.contextcapsule\.host/);

console.log("Firefox/Chrome build-target artifact tests passed.");
