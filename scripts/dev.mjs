import { context } from "esbuild";
import { cp, mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import webExt from "web-ext";
import { resolveFirefoxExecutable } from "./firefox.mjs";

const smokeMode = process.argv.includes("--smoke");

await rm("dist", { recursive: true, force: true });
await mkdir("dist/popup", { recursive: true });
await Promise.all([
  cp("manifest.json", "dist/manifest.json"),
  cp("src/popup/popup.html", "dist/popup/popup.html"),
  cp("src/popup/popup.css", "dist/popup/popup.css"),
]);

const buildContext = await context({
  entryPoints: ["src/background.ts", "src/popup/popup.ts"],
  bundle: true,
  format: "iife",
  platform: "browser",
  target: ["firefox142"],
  sourcemap: true,
  outdir: "dist",
  outbase: "src",
});
await buildContext.watch();

let extensionRunner;
let stopping = false;

async function stop(exitCode = 0) {
  if (stopping) return;
  stopping = true;
  await buildContext.dispose().catch(() => undefined);
  if (extensionRunner) {
    await Promise.resolve(extensionRunner.exit()).catch(() => undefined);
  }
  process.exit(exitCode);
}

try {
  const firefoxExecutable = resolveFirefoxExecutable();
  console.log(`[Context Capsule] Using Firefox: ${firefoxExecutable}`);

  extensionRunner = await webExt.cmd.run(
    {
      sourceDir: resolve("dist"),
      firefox: firefoxExecutable,
      noInput: true,
    },
    {
      shouldExitProgram: false,
    },
  );

  console.log("[Context Capsule] Firefox launched and the temporary extension was installed.");

  if (smokeMode) {
    console.log("[Context Capsule] pnpm dev smoke test passed.");
    await stop(0);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  await stop(1);
}

process.on("SIGINT", () => void stop(0));
process.on("SIGTERM", () => void stop(0));
