import { build } from "esbuild";
import { mkdir, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";

await rm(".test-tab-order", { recursive: true, force: true });
await mkdir(".test-tab-order", { recursive: true });

try {
  await build({
    entryPoints: ["tests/tab-order-essentials.ts"],
    bundle: true,
    platform: "node",
    format: "esm",
    target: ["node22"],
    outfile: ".test-tab-order/test.mjs",
  });

  const result = spawnSync(process.execPath, [".test-tab-order/test.mjs"], { stdio: "inherit" });
  process.exitCode = result.status ?? 1;
} finally {
  await rm(".test-tab-order", { recursive: true, force: true });
}
