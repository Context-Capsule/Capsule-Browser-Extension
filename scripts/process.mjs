export function pnpmProcessSpec(args, options = {}) {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;

  if (platform === "win32") {
    const command = env.ComSpec ?? env.COMSPEC ?? "cmd.exe";
    return {
      command,
      args: ["/d", "/s", "/c", ["pnpm", ...args].join(" ")],
    };
  }

  return { command: "pnpm", args };
}
