import { context } from "esbuild";
import { cp, mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import webExt from "web-ext";
import {
  browserDisplayName,
  resolveBrowserProfile,
  resolveFirefoxExecutable,
} from "./firefox.mjs";

const smokeMode = process.argv.includes("--smoke");
const sleep = (milliseconds) => new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));

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

async function stop(exitCode = 0, { bounded = false } = {}) {
  if (stopping) return;
  stopping = true;

  if (extensionRunner) {
    await Promise.resolve(extensionRunner.exit()).catch(() => undefined);
  }
  await buildContext.dispose().catch(() => undefined);

  if (bounded) {
    await sleep(2_000);
    process.exit(exitCode);
  }

  process.exitCode = exitCode;
}

try {
  const browserExecutable = resolveFirefoxExecutable();
  const browserName = browserDisplayName(browserExecutable);
  const browserProfile = resolveBrowserProfile({ executable: browserExecutable });

  console.log(`[Context Capsule] Using ${browserName}: ${browserExecutable}`);
  if (browserProfile) {
    console.log(`[Context Capsule] Using ${browserName} profile as isolated base: ${browserProfile}`);
    console.log("[Context Capsule] web-ext will copy this profile; your real daily profile is not modified.");
  } else {
    console.warn(
      `[Context Capsule] No existing ${browserName} profile was found; web-ext will use a fresh temporary profile.`,
    );
  }

  const runOptions = {
    sourceDir: resolve("dist"),
    firefox: browserExecutable,
    noInput: true,
  };
  if (browserProfile) runOptions.firefoxProfile = browserProfile;

  extensionRunner = await webExt.cmd.run(
    runOptions,
    {
      shouldExitProgram: false,
    },
  );

  console.log(`[Context Capsule] ${browserName} launched and the temporary extension was installed.`);
  console.log("[Context Capsule] Browser launch validation passed.");

  if (smokeMode) {
    console.log("[Context Capsule] pnpm dev smoke test passed.");
    await stop(0, { bounded: true });
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  await stop(1, { bounded: smokeMode });
}

process.on("SIGINT", () => void stop(0));
process.on("SIGTERM", () => void stop(0));
