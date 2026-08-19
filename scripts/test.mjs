import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdir, readFile, rm, stat } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { staticFiles } from "./static-files.mjs";
import { assertAcceptedLintReport } from "./lint.mjs";
import {
  browserDisplayName,
  parseRegistryExecutable,
  profilePathFromIni,
  resolveBrowserProfile,
  resolveFirefoxExecutable,
  windowsFirefoxCandidates,
  windowsZenCandidates,
} from "./firefox.mjs";

const registryOutput = `\nHKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\firefox.exe\n    (Default)    REG_SZ    C:\\Program Files\\Mozilla Firefox\\firefox.exe\n`;
assert.equal(parseRegistryExecutable(registryOutput), "C:\\Program Files\\Mozilla Firefox\\firefox.exe");

const windowsEnv = {
  ProgramW6432: "C:\\Program Files",
  ProgramFiles: "C:\\Program Files",
  "ProgramFiles(x86)": "C:\\Program Files (x86)",
  LOCALAPPDATA: "C:\\Users\\test\\AppData\\Local",
  APPDATA: "C:\\Users\\test\\AppData\\Roaming",
};

const firefoxCandidates = windowsFirefoxCandidates(windowsEnv);
assert.equal(firefoxCandidates[0], "C:\\Program Files\\Mozilla Firefox\\firefox.exe");
assert(firefoxCandidates.includes("C:\\Program Files (x86)\\Mozilla Firefox\\firefox.exe"));
const zenCandidates = windowsZenCandidates(windowsEnv);
assert(zenCandidates.includes("C:\\Program Files\\Zen Browser\\zen.exe"));
assert(zenCandidates.includes("C:\\Program Files\\Zen Twilight\\zen.exe"));
assert(zenCandidates.includes("C:\\Users\\test\\AppData\\Local\\Programs\\Zen Browser\\zen.exe"));
assert.equal(browserDisplayName("C:\\Program Files\\Zen Browser\\zen.exe"), "Zen Browser");
assert.equal(browserDisplayName("C:\\Program Files\\Zen Twilight\\zen.exe"), "Zen Twilight");
assert.equal(browserDisplayName("C:\\Program Files\\Mozilla Firefox\\firefox.exe"), "Firefox");

const explicitFirefoxPath = "C:\\Portable Firefox\\firefox.exe";
assert.equal(resolveFirefoxExecutable({ platform: "win32", env: { CONTEXT_CAPSULE_FIREFOX: explicitFirefoxPath }, exists: candidate => candidate === explicitFirefoxPath }), explicitFirefoxPath);
const explicitZenPath = "C:\\Portable Zen\\zen.exe";
assert.equal(resolveFirefoxExecutable({ platform: "win32", env: { CONTEXT_CAPSULE_BROWSER: explicitZenPath }, exists: candidate => candidate === explicitZenPath }), explicitZenPath);
const installedZenPath = "C:\\Program Files\\Zen Browser\\zen.exe";
assert.equal(resolveFirefoxExecutable({ platform: "win32", env: windowsEnv, exists: candidate => candidate === installedZenPath }), installedZenPath);

const zenRoot = "C:\\Users\\test\\AppData\\Roaming\\zen";
const zenProfilesIni = `${zenRoot}\\profiles.ini`;
const zenProfile = `${zenRoot}\\Profiles\\abc123.default-release`;
const profilesIni = `[Profile0]\nName=default-release\nIsRelative=1\nPath=Profiles/abc123.default-release\nDefault=1\n\n[Install123]\nDefault=Profiles/abc123.default-release\nLocked=1\n`;
assert.equal(profilePathFromIni(profilesIni, zenRoot, "win32"), zenProfile);
assert.equal(resolveBrowserProfile({ executable: installedZenPath, platform: "win32", env: windowsEnv, exists: candidate => candidate === zenProfilesIni || candidate === zenProfile, readText: candidate => { assert.equal(candidate, zenProfilesIni); return profilesIni; } }), zenProfile);
const explicitProfile = "C:\\Users\\test\\ZenProfiles\\work";
assert.equal(resolveBrowserProfile({ executable: installedZenPath, platform: "win32", env: { CONTEXT_CAPSULE_BROWSER_PROFILE: explicitProfile }, exists: candidate => candidate === explicitProfile }), explicitProfile);
assert.throws(() => resolveFirefoxExecutable({ platform: "win32", env: { CONTEXT_CAPSULE_BROWSER: "C:\\missing\\zen.exe" }, exists: () => false }), /does not exist/);
assert.throws(() => resolveBrowserProfile({ executable: installedZenPath, platform: "win32", env: { CONTEXT_CAPSULE_BROWSER_PROFILE: "C:\\missing-profile" }, exists: () => false }), /profile does not exist/);

const logoPath = "src/popup/capsule-bgless.png";
const logo = await stat(logoPath);
assert(logo.isFile());
assert(logo.size > 0);
const logoBytes = await readFile(logoPath);
assert.equal(logoBytes.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
const logoWidth = logoBytes.readUInt32BE(16);
const logoHeight = logoBytes.readUInt32BE(20);
assert(logoWidth > 0 && logoHeight > 0, "PNG IHDR dimensions must be valid");
assert(staticFiles.some(([source, destination]) => source === logoPath && destination === "dist/popup/capsule-bgless.png"), "development/build static asset list must include the backgroundless logo");
assert(!staticFiles.some(([source]) => source.endsWith("context-capsule-logo.png")), "the retired logo must not be copied into the production bundle");

const manifest = JSON.parse(await readFile("manifest.json", "utf8"));
assert.equal(manifest.icons[String(logoWidth)], "popup/capsule-bgless.png", "manifest icon size key must match the PNG width reported to Firefox");
assert.equal(manifest.action.default_icon, "popup/capsule-bgless.png");

const popupHtml = await readFile("src/popup/popup.html", "utf8");
assert.match(popupHtml, /id="root"/);
assert.match(popupHtml, /popup\.js/);
assert.doesNotMatch(popupHtml, /context-capsule-logo\.png/);
const popupSource = await readFile("src/popup/popup.tsx", "utf8");
assert.match(popupSource, /from\s+["']@samasante\/liquid-glass["']/);
assert.match(popupSource, /<Glass/);
assert.match(popupSource, /capsule-bgless\.png/);
assert.match(popupSource, /sheen:\s*0\b/, "directional liquid-glass sheen must stay disabled");
assert.match(popupSource, /glow:\s*0\b/, "liquid-glass edge glow must stay disabled");
assert.match(popupSource, /specular:\s*0\b/, "liquid-glass master specular rim must stay disabled");
assert.match(popupSource, /install_type\s*===\s*["']development["']/, "popup must warn when the running adapter is a temporary development install");
assert.match(popupSource, /Cold-browser restore requires a persistent extension installation/, "temporary-install warning must explain the cold-restore consequence");
const popupCss = await readFile("src/popup/popup.css", "utf8");
assert.match(popupCss, /--accent:\s*#eaff00/i);
assert.match(popupCss, /background:\s*transparent\s*!important/i);
assert.match(popupCss, /\.liquid-shell/);
assert.match(popupCss, /\.brand-logo/);

const protocolSource = await readFile("src/native/protocol.ts", "utf8");
const clientSource = await readFile("src/native/client.ts", "utf8");
const backgroundSource = await readFile("src/background.ts", "utf8");
const captureSource = await readFile("src/browser/capture.ts", "utf8");
const modelSource = await readFile("src/browser/model.ts", "utf8");
const devSource = await readFile("scripts/dev.mjs", "utf8");
assert.match(protocolSource, /type:\s*["']browser\.log\.append["']/, "native protocol must expose bounded persistent diagnostics");
assert.match(clientSource, /appendLog\(/, "native client must expose diagnostic append without coupling it to capture state");
assert.match(backgroundSource, /persistDiagnostic\(/, "background restore/capture lifecycle must emit high-value diagnostics");
assert.match(backgroundSource, /lastLoggedError/, "repeated automatic capture failures must be deduplicated before persistent logging");
assert.doesNotMatch(backgroundSource, /persistDiagnostic\([^)]*\.url/s, "persistent diagnostics must not deliberately log browser tab URLs");
assert.match(captureSource, /browser\.management\.getSelf\(\)/, "capture must inspect its own Firefox installation type without broad management enumeration");
assert.match(modelSource, /install_type\?:\s*string/, "install type metadata must remain backward-compatible and optional");
assert.match(devSource, /temporary about:debugging add-on/i, "development workflow must explain that the temporary adapter does not survive browser exit");
assert.match(devSource, /pnpm package/, "development workflow must point to the persistent-package artifact path");

const packageJson = JSON.parse(await readFile("package.json", "utf8"));
assert.equal(packageJson.dependencies["@samasante/liquid-glass"], "0.1.1");
assert.ok(packageJson.dependencies.react);
assert.ok(packageJson.dependencies["react-dom"]);

const knownGeneratedWarning = {
  code: "UNSAFE_VAR_ASSIGNMENT",
  message: "Unsafe assignment to innerHTML",
  description: "generated ReactDOM runtime",
  file: "popup/popup.js",
};
assert.doesNotThrow(() => assertAcceptedLintReport({
  errors: [],
  notices: [],
  warnings: [
    { ...knownGeneratedWarning, line: 156 },
    { ...knownGeneratedWarning, line: 158 },
    { ...knownGeneratedWarning, line: 160 },
  ],
}), "the exact pinned generated ReactDOM warning set should be accepted");
assert.throws(() => assertAcceptedLintReport({
  errors: [],
  notices: [],
  warnings: [
    { ...knownGeneratedWarning, line: 156 },
    { ...knownGeneratedWarning, line: 158 },
    { ...knownGeneratedWarning, line: 160 },
    { code: "ICON_SIZE_INVALID", file: "manifest.json", message: "wrong icon" },
  ],
}), /unexpected warnings/, "any unrelated web-ext warning must still fail lint");
assert.throws(() => assertAcceptedLintReport({
  errors: [],
  notices: [],
  warnings: [
    { ...knownGeneratedWarning, line: 156 },
    { ...knownGeneratedWarning, line: 158 },
  ],
}), /Expected exactly 3/, "the generated warning count is pinned so dependency changes cannot silently expand the exception");

const productionBuild = spawnSync(process.execPath, ["scripts/build.mjs"], { stdio: "inherit" });
assert.equal(productionBuild.status, 0, "production build should succeed");
const builtLogo = await stat("dist/popup/capsule-bgless.png");
assert.equal(builtLogo.size, logo.size, "built backgroundless logo must exist and match the source asset");
const builtHtml = await readFile("dist/popup/popup.html", "utf8");
assert.match(builtHtml, /id="root"/);
assert.doesNotMatch(builtHtml, /context-capsule-logo\.png/);
const builtPopup = await readFile("dist/popup/popup.js", "utf8");
assert.match(builtPopup, /Context Capsule/);
assert.ok(builtPopup.length > 10_000, "React/liquid-glass popup bundle should contain the real component runtime");

await rm(".test-build", { recursive: true, force: true });
await mkdir(".test-build", { recursive: true });
await build({ entryPoints: ["tests/index.ts"], bundle: true, platform: "node", format: "esm", target: ["node22"], outfile: ".test-build/tests.mjs" });
const result = spawnSync(process.execPath, [".test-build/tests.mjs"], { stdio: "inherit" });
await rm(".test-build", { recursive: true, force: true });
process.exit(result.status ?? 1);
