import { build } from "esbuild";
import { mkdir, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";

await rm(".test-chrome-target", { recursive: true, force: true });
await mkdir(".test-chrome-target", { recursive: true });

try {
  await build({
    entryPoints: ["tests/chrome-target.ts"],
    bundle: true,
    platform: "node",
    format: "esm",
    target: ["node22"],
    outfile: ".test-chrome-target/test.mjs",
    define: {
      __CAPSULE_BROWSER_TARGET__: JSON.stringify("chrome"),
    },
  });

  const result = spawnSync(process.execPath, [".test-chrome-target/test.mjs"], { stdio: "inherit" });
  process.exitCode = result.status ?? 1;
} finally {
  await rm(".test-chrome-target", { recursive: true, force: true });
}
