import { spawn } from "node:child_process";
import { context } from "esbuild";
import { cp, mkdir, rm } from "node:fs/promises";
import { pnpmProcessSpec } from "./process.mjs";

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

const webExtSpec = pnpmProcessSpec([
  "exec",
  "web-ext",
  "run",
  "--source-dir",
  "dist",
  "--no-input",
]);
const firefox = spawn(webExtSpec.command, webExtSpec.args, { stdio: "inherit" });

let stopping = false;
async function stop(exitCode = 0) {
  if (stopping) return;
  stopping = true;
  await buildContext.dispose().catch(() => undefined);
  if (firefox.exitCode === null) firefox.kill();
  process.exit(exitCode);
}

firefox.on("error", (error) => {
  console.error(`Failed to start web-ext: ${error.message}`);
  void stop(1);
});
firefox.on("exit", (code) => {
  void stop(code ?? 0);
});
process.on("SIGINT", () => void stop(0));
process.on("SIGTERM", () => void stop(0));
