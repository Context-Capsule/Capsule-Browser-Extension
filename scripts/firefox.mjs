import { existsSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

function cleanCandidate(value) {
  if (!value) return undefined;
  const trimmed = value.trim().replace(/^"|"$/g, "");
  return trimmed || undefined;
}

export function parseRegistryExecutable(output) {
  if (!output) return undefined;
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/REG_\w+\s+(.+)$/i);
    if (match) return cleanCandidate(match[1]);
  }
  return undefined;
}

export function windowsFirefoxCandidates(env = process.env) {
  const roots = [env.ProgramW6432, env.ProgramFiles, env["ProgramFiles(x86)"], env.LOCALAPPDATA]
    .map(cleanCandidate)
    .filter(Boolean);

  const result = [];
  for (const root of roots) {
    result.push(path.win32.join(root, "Mozilla Firefox", "firefox.exe"));
    result.push(path.win32.join(root, "Firefox Developer Edition", "firefox.exe"));
  }
  return [...new Set(result)];
}

export function windowsZenCandidates(env = process.env) {
  const machineRoots = [env.ProgramW6432, env.ProgramFiles, env["ProgramFiles(x86)"]]
    .map(cleanCandidate)
    .filter(Boolean);
  const localAppData = cleanCandidate(env.LOCALAPPDATA);

  const result = [];
  for (const root of machineRoots) {
    result.push(path.win32.join(root, "Zen Browser", "zen.exe"));
    result.push(path.win32.join(root, "Zen Twilight", "zen.exe"));
  }

  if (localAppData) {
    result.push(path.win32.join(localAppData, "Zen Browser", "zen.exe"));
    result.push(path.win32.join(localAppData, "Zen Twilight", "zen.exe"));
    result.push(path.win32.join(localAppData, "Programs", "Zen Browser", "zen.exe"));
    result.push(path.win32.join(localAppData, "Programs", "Zen Twilight", "zen.exe"));
  }

  return [...new Set(result)];
}

function commandLines(command, args) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    windowsHide: true,
    timeout: 5_000,
  });
  if (result.status !== 0 || !result.stdout) return [];
  return result.stdout
    .split(/\r?\n/)
    .map(cleanCandidate)
    .filter(Boolean);
}

function windowsRegistryCandidates(executableNames) {
  const result = [];
  for (const executableName of executableNames) {
    const keys = [
      `HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${executableName}`,
      `HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${executableName}`,
      `HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${executableName}`,
    ];

    for (const key of keys) {
      const query = spawnSync("reg.exe", ["query", key, "/ve"], {
        encoding: "utf8",
        windowsHide: true,
        timeout: 5_000,
      });
      if (query.status === 0) {
        const executable = parseRegistryExecutable(query.stdout);
        if (executable) result.push(executable);
      }
    }
  }
  return result;
}

function unixFirefoxCandidates(platform) {
  const names = platform === "darwin"
    ? [
        "/Applications/Firefox.app/Contents/MacOS/firefox-bin",
        "/Applications/Firefox Developer Edition.app/Contents/MacOS/firefox-bin",
        "/Applications/Zen.app/Contents/MacOS/zen",
      ]
    : ["/usr/bin/firefox", "/usr/local/bin/firefox", "/usr/bin/zen-browser", "/usr/local/bin/zen-browser"];

  for (const command of ["firefox", "firefox-developer-edition", "zen", "zen-browser"]) {
    names.push(...commandLines("which", [command]));
  }
  return names;
}

export function browserDisplayName(executable) {
  const normalized = executable.toLowerCase();
  if (normalized.endsWith("zen.exe") || normalized.includes("/zen.app/") || /(^|\/)zen-browser$/.test(normalized)) {
    return normalized.includes("twilight") ? "Zen Twilight" : "Zen Browser";
  }
  return "Firefox";
}

export function resolveFirefoxExecutable({
  platform = process.platform,
  env = process.env,
  exists = existsSync,
} = {}) {
  const explicit = cleanCandidate(
    env.CONTEXT_CAPSULE_BROWSER ?? env.CONTEXT_CAPSULE_FIREFOX ?? env.WEB_EXT_FIREFOX,
  );
  if (explicit) {
    if (exists(explicit)) return explicit;
    throw new Error(
      `Configured Firefox-compatible browser executable does not exist: ${explicit}\n` +
        "Set CONTEXT_CAPSULE_BROWSER to the full path of firefox.exe, zen.exe, or another compatible Firefox-family executable.",
    );
  }

  let candidates;
  if (platform === "win32") {
    candidates = [
      ...windowsRegistryCandidates(["firefox.exe", "zen.exe"]),
      ...commandLines("where.exe", ["firefox.exe"]),
      ...commandLines("where.exe", ["zen.exe"]),
      ...windowsFirefoxCandidates(env),
      ...windowsZenCandidates(env),
    ];
  } else {
    candidates = unixFirefoxCandidates(platform);
  }

  for (const candidate of [...new Set(candidates.map(cleanCandidate).filter(Boolean))]) {
    if (exists(candidate)) return candidate;
  }

  const searched = candidates.length > 0 ? candidates.map((item) => `  - ${item}`).join("\n") : "  (no candidates found)";
  throw new Error(
    "Could not find a usable Firefox-compatible browser installation.\n" +
      `Searched:\n${searched}\n` +
      "Install Firefox/Zen or set CONTEXT_CAPSULE_BROWSER to the full executable path.\n" +
      'Firefox example: $env:CONTEXT_CAPSULE_BROWSER = "C:\\Program Files\\Mozilla Firefox\\firefox.exe"\n' +
      'Zen example:     $env:CONTEXT_CAPSULE_BROWSER = "C:\\Program Files\\Zen Browser\\zen.exe"',
  );
}
