import { build } from "esbuild";
import { mkdir, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";

await rm(".test-splits", { recursive: true, force: true });
await mkdir(".test-splits", { recursive: true });

try {
  await build({
    entryPoints: ["tests/split-views.ts"],
    bundle: true,
    platform: "node",
    format: "esm",
    target: ["node22"],
    outfile: ".test-splits/test.mjs",
  });

  const result = spawnSync(process.execPath, [".test-splits/test.mjs"], { stdio: "inherit" });
  process.exitCode = result.status ?? 1;
} finally {
  await rm(".test-splits", { recursive: true, force: true });
}
