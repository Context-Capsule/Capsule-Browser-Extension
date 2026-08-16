import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdir, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import {
  parseRegistryExecutable,
  resolveFirefoxExecutable,
  windowsFirefoxCandidates,
} from "./firefox.mjs";

const registryOutput = `\nHKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\firefox.exe\n    (Default)    REG_SZ    C:\\Program Files\\Mozilla Firefox\\firefox.exe\n`;
assert.equal(
  parseRegistryExecutable(registryOutput),
  "C:\\Program Files\\Mozilla Firefox\\firefox.exe",
);

const candidates = windowsFirefoxCandidates({
  ProgramW6432: "C:\\Program Files",
  ProgramFiles: "C:\\Program Files",
  "ProgramFiles(x86)": "C:\\Program Files (x86)",
  LOCALAPPDATA: "C:\\Users\\test\\AppData\\Local",
});
assert.equal(candidates[0], "C:\\Program Files\\Mozilla Firefox\\firefox.exe");
assert(candidates.includes("C:\\Program Files (x86)\\Mozilla Firefox\\firefox.exe"));

const explicitPath = "C:\\Portable Firefox\\firefox.exe";
assert.equal(
  resolveFirefoxExecutable({
    platform: "win32",
    env: { CONTEXT_CAPSULE_FIREFOX: explicitPath },
    exists: (candidate) => candidate === explicitPath,
  }),
  explicitPath,
);
assert.throws(
  () =>
    resolveFirefoxExecutable({
      platform: "win32",
      env: { CONTEXT_CAPSULE_FIREFOX: "C:\\missing\\firefox.exe" },
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
