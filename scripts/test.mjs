import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdir, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import {
  browserDisplayName,
  parseRegistryExecutable,
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

assert.throws(
  () =>
    resolveFirefoxExecutable({
      platform: "win32",
      env: { CONTEXT_CAPSULE_BROWSER: "C:\\missing\\zen.exe" },
      exists: () => false,
    }),
  /does not exist/,
);

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
