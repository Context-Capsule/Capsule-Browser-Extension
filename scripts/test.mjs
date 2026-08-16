import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdir, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { pnpmProcessSpec } from "./process.mjs";

const windowsSpec = pnpmProcessSpec(["exec", "web-ext", "run"], {
  platform: "win32",
  env: { ComSpec: "C:\\Windows\\System32\\cmd.exe" },
});
assert.equal(windowsSpec.command, "C:\\Windows\\System32\\cmd.exe");
assert.deepEqual(windowsSpec.args.slice(0, 3), ["/d", "/s", "/c"]);
assert.equal(windowsSpec.args[3], "pnpm exec web-ext run");

const unixSpec = pnpmProcessSpec(["exec", "web-ext", "run"], { platform: "linux", env: {} });
assert.equal(unixSpec.command, "pnpm");
assert.deepEqual(unixSpec.args, ["exec", "web-ext", "run"]);

if (process.platform === "win32") {
  const smoke = spawnSync(
    process.env.ComSpec ?? process.env.COMSPEC ?? "cmd.exe",
    ["/d", "/s", "/c", "pnpm --version"],
    { encoding: "utf8" },
  );
  assert.equal(smoke.status, 0, `cmd.exe could not launch pnpm: ${smoke.stderr || smoke.error?.message || "unknown error"}`);
}

await rm(".test-build", { recursive: true, force: true });
await mkdir(".test-build", { recursive: true });
await build({ entryPoints: ["tests/index.ts"], bundle: true, platform: "node", format: "esm", target: ["node22"], outfile: ".test-build/tests.mjs" });
const result = spawnSync(process.execPath, [".test-build/tests.mjs"], { stdio: "inherit" });
await rm(".test-build", { recursive: true, force: true });
process.exit(result.status ?? 1);
