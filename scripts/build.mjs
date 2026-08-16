import { build } from "esbuild";
import { cp, mkdir, rm } from "node:fs/promises";

await rm("dist", { recursive: true, force: true });
await mkdir("dist/popup", { recursive: true });
const common = {
  bundle: true,
  format: "iife",
  platform: "browser",
  target: ["firefox142"],
  sourcemap: true,
  logLevel: "info",
};
await Promise.all([
  build({ ...common, entryPoints: ["src/background.ts"], outfile: "dist/background.js" }),
  build({ ...common, entryPoints: ["src/popup/popup.ts"], outfile: "dist/popup/popup.js" }),
  cp("manifest.json", "dist/manifest.json"),
  cp("src/popup/popup.html", "dist/popup/popup.html"),
  cp("src/popup/popup.css", "dist/popup/popup.css"),
]);
