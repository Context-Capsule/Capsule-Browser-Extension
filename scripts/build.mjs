import { build } from "esbuild";
import { cp, mkdir, rm } from "node:fs/promises";
import { staticFiles } from "./static-files.mjs";

const target = process.argv[2] ?? "firefox";
if (target !== "firefox" && target !== "chrome") {
  throw new Error(`Unknown browser build target '${target}'. Expected 'firefox' or 'chrome'.`);
}

const chrome = target === "chrome";
const outputDir = chrome ? "dist-chrome" : "dist";
const manifestSource = chrome ? "manifest.chrome.json" : "manifest.json";

await rm(outputDir, { recursive: true, force: true });
await mkdir(`${outputDir}/popup`, { recursive: true });

const common = {
  bundle: true,
  format: "iife",
  platform: "browser",
  target: [chrome ? "chrome105" : "firefox142"],
  sourcemap: true,
  logLevel: "info",
  define: {
    __CAPSULE_BROWSER_TARGET__: JSON.stringify(target),
    ...(chrome ? { browser: "chrome" } : {}),
  },
};

const targetStaticFiles = staticFiles.map(([source, destination]) => [
  source === "manifest.json" ? manifestSource : source,
  destination.replace(/^dist(?=\/|$)/, outputDir),
]);

await Promise.all([
  build({ ...common, entryPoints: ["src/background.ts"], outfile: `${outputDir}/background.js` }),
  build({ ...common, entryPoints: ["src/popup/popup.tsx"], outfile: `${outputDir}/popup/popup.js` }),
  ...targetStaticFiles.map(([source, destination]) => cp(source, destination)),
]);

console.log(`[Context Capsule] Built ${target} extension -> ${outputDir}`);
