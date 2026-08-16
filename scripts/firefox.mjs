import { existsSync, readFileSync } from "node:fs";
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

function parseIniSections(contents) {
  const sections = [];
  let current;

  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith(";") || line.startsWith("#")) continue;

    const sectionMatch = line.match(/^\[([^\]]+)\]$/);
    if (sectionMatch) {
      current = { name: sectionMatch[1], values: {} };
      sections.push(current);
      continue;
    }

    if (!current) continue;
    const equals = line.indexOf("=");
    if (equals <= 0) continue;
    current.values[line.slice(0, equals).trim()] = line.slice(equals + 1).trim();
  }

  return sections;
}

export function profilePathFromIni(contents, root, platform = process.platform) {
  const sections = parseIniSections(contents);
  const pathApi = platform === "win32" ? path.win32 : path.posix;

  const installDefault = sections.find(
    (section) => section.name.startsWith("Install") && section.values.Default,
  );
  if (installDefault) {
    const value = cleanCandidate(installDefault.values.Default);
    if (value) return pathApi.isAbsolute(value) ? value : pathApi.join(root, value);
  }

  const profileDefault = sections.find(
    (section) => section.name.startsWith("Profile") && section.values.Default === "1" && section.values.Path,
  );
  if (profileDefault) {
    const value = cleanCandidate(profileDefault.values.Path);
    if (!value) return undefined;
    if (profileDefault.values.IsRelative === "0" || pathApi.isAbsolute(value)) return value;
    return pathApi.join(root, value);
  }

  const firstProfile = sections.find(
    (section) => section.name.startsWith("Profile") && section.values.Path,
  );
  if (!firstProfile) return undefined;

  const value = cleanCandidate(firstProfile.values.Path);
  if (!value) return undefined;
  if (firstProfile.values.IsRelative === "0" || pathApi.isAbsolute(value)) return value;
  return pathApi.join(root, value);
}

function profileRoots(executable, platform, env) {
  const isZen = browserDisplayName(executable).startsWith("Zen");
  const home = cleanCandidate(env.HOME ?? env.USERPROFILE);

  if (platform === "win32") {
    const roaming = cleanCandidate(env.APPDATA);
    if (!roaming) return [];
    return [
      isZen
        ? path.win32.join(roaming, "zen")
        : path.win32.join(roaming, "Mozilla", "Firefox"),
    ];
  }

  if (platform === "darwin") {
    if (!home) return [];
    return [
      isZen
        ? path.posix.join(home, "Library", "Application Support", "zen")
        : path.posix.join(home, "Library", "Application Support", "Firefox"),
    ];
  }

  if (!home) return [];
  return [
    isZen ? path.posix.join(home, ".zen") : path.posix.join(home, ".mozilla", "firefox"),
  ];
}

export function resolveBrowserProfile({
  executable,
  platform = process.platform,
  env = process.env,
  exists = existsSync,
  readText = (filePath) => readFileSync(filePath, "utf8"),
} = {}) {
  if (!executable) return undefined;

  const explicit = cleanCandidate(env.CONTEXT_CAPSULE_BROWSER_PROFILE ?? env.WEB_EXT_FIREFOX_PROFILE);
  if (explicit) {
    if (exists(explicit)) return explicit;
    throw new Error(
      `Configured browser profile does not exist: ${explicit}\n` +
        "Set CONTEXT_CAPSULE_BROWSER_PROFILE to an existing Firefox/Zen profile directory.",
    );
  }

  for (const root of profileRoots(executable, platform, env)) {
    const iniPath = platform === "win32"
      ? path.win32.join(root, "profiles.ini")
      : path.posix.join(root, "profiles.ini");
    if (!exists(iniPath)) continue;

    try {
      const candidate = profilePathFromIni(readText(iniPath), root, platform);
      if (candidate && exists(candidate)) return candidate;
    } catch {
      // A malformed or temporarily unreadable profile file should not prevent
      // extension development. web-ext can still fall back to a fresh profile.
    }
  }

  return undefined;
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
