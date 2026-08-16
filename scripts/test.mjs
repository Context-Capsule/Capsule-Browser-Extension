import { build } from "esbuild";
import { mkdir, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";

await rm(".test-build", { recursive: true, force: true });
await mkdir(".test-build", { recursive: true });
await build({ entryPoints: ["tests/index.ts"], bundle: true, platform: "node", format: "esm", target: ["node22"], outfile: ".test-build/tests.mjs" });
const result = spawnSync(process.execPath, [".test-build/tests.mjs"], { stdio: "inherit" });
await rm(".test-build", { recursive: true, force: true });
process.exit(result.status ?? 1);
