export type BrowserTarget = "firefox" | "chrome";

declare const __CAPSULE_BROWSER_TARGET__: BrowserTarget | undefined;

function configuredTarget(): BrowserTarget {
  if (typeof __CAPSULE_BROWSER_TARGET__ === "undefined") return "firefox";
  return __CAPSULE_BROWSER_TARGET__ === "chrome" ? "chrome" : "firefox";
}

export const BROWSER_TARGET: BrowserTarget = configuredTarget();
export const IS_FIREFOX = BROWSER_TARGET === "firefox";
export const IS_CHROME = BROWSER_TARGET === "chrome";

export const BROWSER_LABEL = IS_CHROME ? "Chrome" : "Firefox / Zen";
export const BROWSER_ADAPTER_ID = BROWSER_TARGET;
export const NATIVE_HOST_NAME = IS_CHROME
  ? "com.contextcapsule.chrome"
  : "com.contextcapsule.host";

export const NATIVE_HOST_BINARY = IS_CHROME
  ? "capsule-chrome-host"
  : "capsule-firefox-host";
