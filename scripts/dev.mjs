import { watch } from "node:fs";
import { cp, mkdir, rm } from "node:fs/promises";
import { context } from "esbuild";
import { staticFiles } from "./static-files.mjs";

await rm("dist", { recursive: true, force: true });
await mkdir("dist/popup", { recursive: true });
await Promise.all(staticFiles.map(([source, destination]) => cp(source, destination)));

const buildContext = await context({
  entryPoints: ["src/background.ts", "src/popup/popup.ts"],
  bundle: true,
  format: "iife",
  platform: "browser",
  target: ["firefox142"],
  sourcemap: true,
  outdir: "dist",
  outbase: "src",
  logLevel: "info",
});
await buildContext.watch();

const staticWatchers = staticFiles.map(([source, destination]) =>
  watch(source, { persistent: true }, () => {
    void cp(source, destination).then(
      () => console.log(`[Context Capsule] Updated ${destination}`),
      (error) => console.error(`[Context Capsule] Could not update ${destination}: ${error}`),
    );
  }),
);

let stopping = false;
async function stop(exitCode = 0) {
  if (stopping) return;
  stopping = true;
  for (const watcher of staticWatchers) watcher.close();
  await buildContext.dispose().catch(() => undefined);
  process.exitCode = exitCode;
}

process.on("SIGINT", () => void stop(0));
process.on("SIGTERM", () => void stop(0));

console.log("[Context Capsule] Development watch ready.");
console.log("[Context Capsule] This command does not launch or modify your Firefox/Zen profile.");
console.log("[Context Capsule] In your existing browser open about:debugging#/runtime/this-firefox, choose 'Load Temporary Add-on', and select dist/manifest.json once.");
console.log("[Context Capsule] After source changes are rebuilt, press Reload for Context Capsule in about:debugging.");
console.log("[Context Capsule] Use 'pnpm dev:isolated' only when you explicitly want web-ext to launch an isolated browser profile.");
