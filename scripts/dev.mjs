import { spawn } from "node:child_process";
import { build } from "esbuild";
import { cp, mkdir, rm } from "node:fs/promises";

await rm("dist", { recursive: true, force: true });
await mkdir("dist/popup", { recursive: true });
await Promise.all([
  cp("manifest.json", "dist/manifest.json"),
  cp("src/popup/popup.html", "dist/popup/popup.html"),
  cp("src/popup/popup.css", "dist/popup/popup.css"),
  build({ entryPoints: ["src/background.ts"], bundle: true, format: "iife", platform: "browser", target: ["firefox142"], sourcemap: true, outfile: "dist/background.js" }),
  build({ entryPoints: ["src/popup/popup.ts"], bundle: true, format: "iife", platform: "browser", target: ["firefox142"], sourcemap: true, outfile: "dist/popup/popup.js" }),
]);
const executable = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const watcher = spawn(executable, ["exec", "esbuild", "src/background.ts", "src/popup/popup.ts", "--bundle", "--format=iife", "--platform=browser", "--target=firefox142", "--sourcemap", "--outdir=dist", "--outbase=src", "--watch"], { stdio: "inherit" });
const firefox = spawn(executable, ["exec", "web-ext", "run", "--source-dir", "dist", "--no-input"], { stdio: "inherit" });
function stop() { watcher.kill(); firefox.kill(); }
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
firefox.on("exit", (code) => { watcher.kill(); process.exit(code ?? 0); });
