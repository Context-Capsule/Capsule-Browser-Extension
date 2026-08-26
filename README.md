# Context Capsule Browser Extension

Shared WebExtension adapter for Context Capsule. The same TypeScript capture/restore core now builds for **Firefox/Zen** and **Google Chrome** without forking the tab/window restore engine.

It captures normal browser windows, tab URLs/order, pinned and active tabs, portable tab groups, discarded/muted state, and browser-window geometry/state. Firefox/Zen additionally preserves Firefox container IDs and captures Zen split-view relationships. Private/incognito windows are intentionally excluded.

## Build targets

Firefox remains the default build and keeps the existing output path and manifest semantics:

```bash
pnpm install
pnpm build
# equivalent:
pnpm build:firefox
```

Output:

```text
dist/
```

The Firefox artifact still uses:

- Gecko extension ID `firefox@contextcapsule.app`
- native host `com.contextcapsule.host`
- Firefox MV3 `background.scripts`
- Firefox container/cookie-store metadata

Chrome is an additive build target:

```bash
pnpm build:chrome
```

Output:

```text
dist-chrome/
```

The Chrome artifact uses:

- Chrome MV3 `background.service_worker`
- native host `com.contextcapsule.chrome`
- deterministic unpacked extension ID `gmffhdppfaeonombpbbgnldagfeabiof`
- tabs, tab groups, and native messaging without Firefox container fields

Build both:

```bash
pnpm build:all
```

Run the complete regression suite, including both target artifacts:

```bash
pnpm check
```

`pnpm check` still runs the existing Firefox/Zen tests and Firefox `web-ext lint`, then builds Chrome and verifies that the emitted manifests/bundles remain isolated from one another.

## Native messaging hosts

The two browser families deliberately use separate host registrations so Chrome support cannot change the working Firefox registration.

### Firefox / Zen

```powershell
cargo build --bin capsule-firefox-host
cargo run --bin capsule-firefox-host -- --install
cargo run --bin capsule-firefox-host -- --doctor
```

Host name:

```text
com.contextcapsule.host
```

### Chrome

```powershell
cargo build --bin capsule-chrome-host
cargo run --bin capsule-chrome-host -- --install
cargo run --bin capsule-chrome-host -- --doctor
```

Host name:

```text
com.contextcapsule.chrome
```

On Windows the Chrome host registers under Google Chrome's `NativeMessagingHosts` registry path and authorizes only the deterministic Context Capsule Chrome extension origin.

## Loading the Chrome development build

1. Run `pnpm build:chrome`.
2. Open `chrome://extensions`.
3. Enable **Developer mode**.
4. Choose **Load unpacked**.
5. Select `dist-chrome/`.
6. Confirm the extension ID is `gmffhdppfaeonombpbbgnldagfeabiof`.
7. Install/verify `capsule-chrome-host` as shown above.
8. Open the Context Capsule popup; it should report **Chrome workspace adapter** and **Connected**.

The fixed development key is public extension metadata, not a signing/private key. It exists so an unpacked build keeps the same Chrome extension ID and can safely match the native host's `allowed_origins` entry.

## Firefox / Zen development

```bash
pnpm dev
```

`pnpm dev` intentionally remains Firefox/Zen-oriented and continues building `dist/` for `about:debugging`. It does not launch or modify the user's browser profile.

A temporary development add-on is useful for warm restore, but Firefox/Zen removes it when the browser fully exits. Cold-browser restore therefore requires a persistent extension installation.

For a persistent Firefox artifact:

```bash
pnpm package
# or
pnpm package:firefox
```

This creates an XPI under `web-ext-artifacts/`. Install/sign it through a persistent installation method supported by the target Firefox/Zen build.

## Browser-specific behavior

### Shared

Both targets use the same code for:

- browser window capture and geometry;
- URL/title/pinned/active/muted/discarded tab state;
- exact saved tab ordering;
- standard tab-group capture/restore;
- global saved-window/live-window reuse assignment;
- final authoritative tab-order verification;
- native restore-bus synchronization.

### Firefox / Zen only

Firefox/Zen keeps:

- `cookieStoreId` / container identity;
- Zen Essential/pinned-tab protection behavior;
- Zen split relationship capture;
- the Zen native blank-window fallback used by the proven restore path.

Automatic Zen split reconstruction remains intentionally disabled. Split metadata is retained, but restore does not select split members or invoke Zen split shortcuts.

### Chrome only

Chrome deliberately does **not** receive Firefox `cookieStoreId` fields. Chrome also supports legitimate unnamed tab groups, so an empty Chrome group title is preserved as a normal group rather than being interpreted as a Zen split marker.

Chrome uses the standard extension `windows.create()` path; it never calls the Zen native blank-window or split commands.

## Capsule storage

The CLI keeps browser states independent:

```json
{
  "browsers": {
    "firefox": { "browser": "firefox" },
    "chrome": { "browser": "chrome" }
  }
}
```

`browsers.chrome` is added only when a recent Chrome adapter state exists. Firefox-only machines/capsules therefore keep the historical payload shape. A capsule may contain both browser snapshots and the CLI restores each through its own native host/restore-bus channel.

## Persistent diagnostics

High-value lifecycle events are forwarded through native messaging to CLI-owned rotating logs.

On Windows:

```text
%LOCALAPPDATA%\ContextCapsule\logs\firefox.log
%LOCALAPPDATA%\ContextCapsule\logs\chrome.log
```

Diagnostics include native-host connection, capture counts, installation type, restore start/completion, changed/reused resource counts, final ordering corrections, warning counts, and failures. Captured tab URLs are not persisted as diagnostic payloads.

## Restore semantics and safety

The capsule is the target state rather than an additive browser suggestion. Before creating anything, the shared restore core inspects live non-private windows and computes a global maximum-reuse assignment against all saved windows.

For each assigned window, matching tabs are retained, missing restorable tabs are created, mute/active state and portable groups are reconciled, ordinary live extras are removed only after target tabs safely exist, and saved geometry/state is restored.

Tab order has an additional final-authority phase after semantic mutation. The verifier reads each tab's actual `tab.index`. Ordinary ungrouped target tabs are moved as one ordered ID sequence rather than through sequential index-shifting moves. Grouped tabs are moved as blocks and real groups use `tabGroups.move()` where available. The final state is re-read and verified with bounded retries.

Original live windows outside the assignment are cleaned up only after the saved topology has been restored, and only when existing protected pinned state does not make that destructive. If a saved window fails to restore, unrelated live windows are preserved as recovery state.

Privileged browser URLs and local files are retained as non-restorable context but are not reopened. If an exact privileged tab is already open in an assigned window, it may be retained in place.
