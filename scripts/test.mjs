import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdir, readFile, rm, stat } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import {
  browserDisplayName,
  parseRegistryExecutable,
  profilePathFromIni,
  resolveBrowserProfile,
  resolveFirefoxExecutable,
  windowsFirefoxCandidates,
  windowsZenCandidates,
} from "./firefox.mjs";

const registryOutput = `\nHKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\firefox.exe\n    (Default)    REG_SZ    C:\\Program Files\\Mozilla Firefox\\firefox.exe\n`;
assert.equal(
  parseRegistryExecutable(registryOutput),
  "C:\\Program Files\\Mozilla Firefox\\firefox.exe",
);

const windowsEnv = {
  ProgramW6432: "C:\\Program Files",
  ProgramFiles: "C:\\Program Files",
  "ProgramFiles(x86)": "C:\\Program Files (x86)",
  LOCALAPPDATA: "C:\\Users\\test\\AppData\\Local",
  APPDATA: "C:\\Users\\test\\AppData\\Roaming",
};

const firefoxCandidates = windowsFirefoxCandidates(windowsEnv);
assert.equal(firefoxCandidates[0], "C:\\Program Files\\Mozilla Firefox\\firefox.exe");
assert(firefoxCandidates.includes("C:\\Program Files (x86)\\Mozilla Firefox\\firefox.exe"));

const zenCandidates = windowsZenCandidates(windowsEnv);
assert(zenCandidates.includes("C:\\Program Files\\Zen Browser\\zen.exe"));
assert(zenCandidates.includes("C:\\Program Files\\Zen Twilight\\zen.exe"));
assert(zenCandidates.includes("C:\\Users\\test\\AppData\\Local\\Programs\\Zen Browser\\zen.exe"));
assert.equal(browserDisplayName("C:\\Program Files\\Zen Browser\\zen.exe"), "Zen Browser");
assert.equal(browserDisplayName("C:\\Program Files\\Zen Twilight\\zen.exe"), "Zen Twilight");
assert.equal(browserDisplayName("C:\\Program Files\\Mozilla Firefox\\firefox.exe"), "Firefox");

const explicitFirefoxPath = "C:\\Portable Firefox\\firefox.exe";
assert.equal(
  resolveFirefoxExecutable({
    platform: "win32",
    env: { CONTEXT_CAPSULE_FIREFOX: explicitFirefoxPath },
    exists: (candidate) => candidate === explicitFirefoxPath,
  }),
  explicitFirefoxPath,
);

const explicitZenPath = "C:\\Portable Zen\\zen.exe";
assert.equal(
  resolveFirefoxExecutable({
    platform: "win32",
    env: { CONTEXT_CAPSULE_BROWSER: explicitZenPath },
    exists: (candidate) => candidate === explicitZenPath,
  }),
  explicitZenPath,
);

const installedZenPath = "C:\\Program Files\\Zen Browser\\zen.exe";
assert.equal(
  resolveFirefoxExecutable({
    platform: "win32",
    env: windowsEnv,
    exists: (candidate) => candidate === installedZenPath,
  }),
  installedZenPath,
);

const zenRoot = "C:\\Users\\test\\AppData\\Roaming\\zen";
const zenProfilesIni = `${zenRoot}\\profiles.ini`;
const zenProfile = `${zenRoot}\\Profiles\\abc123.default-release`;
const profilesIni = `[Profile0]\nName=default-release\nIsRelative=1\nPath=Profiles/abc123.default-release\nDefault=1\n\n[Install123]\nDefault=Profiles/abc123.default-release\nLocked=1\n`;
assert.equal(profilePathFromIni(profilesIni, zenRoot, "win32"), zenProfile);
assert.equal(
  resolveBrowserProfile({
    executable: installedZenPath,
    platform: "win32",
    env: windowsEnv,
    exists: (candidate) => candidate === zenProfilesIni || candidate === zenProfile,
    readText: (candidate) => {
      assert.equal(candidate, zenProfilesIni);
      return profilesIni;
    },
  }),
  zenProfile,
);

const explicitProfile = "C:\\Users\\test\\ZenProfiles\\work";
assert.equal(
  resolveBrowserProfile({
    executable: installedZenPath,
    platform: "win32",
    env: { CONTEXT_CAPSULE_BROWSER_PROFILE: explicitProfile },
    exists: (candidate) => candidate === explicitProfile,
  }),
  explicitProfile,
);

assert.throws(
  () =>
    resolveFirefoxExecutable({
      platform: "win32",
      env: { CONTEXT_CAPSULE_BROWSER: "C:\\missing\\zen.exe" },
      exists: () => false,
    }),
  /does not exist/,
);

assert.throws(
  () =>
    resolveBrowserProfile({
      executable: installedZenPath,
      platform: "win32",
      env: { CONTEXT_CAPSULE_BROWSER_PROFILE: "C:\\missing-profile" },
      exists: () => false,
    }),
  /profile does not exist/,
);

const logoPath = "src/popup/context-capsule-logo.png";
const logo = await stat(logoPath);
assert(logo.isFile());
assert(logo.size > 0);
const logoBytes = await readFile(logoPath);
assert.equal(logoBytes.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
assert.equal(logoBytes.readUInt32BE(16), 900);
assert.equal(logoBytes.readUInt32BE(20), 900);

const manifest = JSON.parse(await readFile("manifest.json", "utf8"));
assert.equal(manifest.icons["900"], "popup/context-capsule-logo.png");
assert.equal(manifest.action.default_icon, "popup/context-capsule-logo.png");

const popupHtml = await readFile("src/popup/popup.html", "utf8");
assert.match(popupHtml, /class="brand-logo"/);
assert.match(popupHtml, /src="context-capsule-logo\.png"/);
const popupCss = await readFile("src/popup/popup.css", "utf8");
assert.match(popupCss, /--accent:\s*#eaff00/i);
assert.match(popupCss, /\.brand-logo/);

await rm(".test-build", { recursive: true, force: true });
await mkdir(".test-build", { recursive: true });
await build({
  entryPoints: ["tests/index.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: ["node22"],
  outfile: ".test-build/tests.mjs",
});
const result = spawnSync(process.execPath, [".test-build/tests.mjs"], { stdio: "inherit" });
await rm(".test-build", { recursive: true, force: true });
process.exit(result.status ?? 1);
