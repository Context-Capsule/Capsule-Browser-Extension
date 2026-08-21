# Context Capsule Firefox Extension

Firefox/Zen WebExtension adapter for Context Capsule. It captures normal browser windows, tab URLs/order, pinned and active tabs, portable tab groups, container IDs, discarded/muted state, and browser-window geometry/state. Private windows are intentionally excluded.

The extension communicates with the `capsule-firefox-host` native messaging binary from the `Context-Capsule/Capsule-CLI` repository using the host name `com.contextcapsule.host`.

## Development

```bash
pnpm install
pnpm check
pnpm dev
```

`pnpm dev` watches/builds the extension for loading through `about:debugging`. A temporary development add-on is useful for fast iteration, but Firefox/Zen removes it when the browser fully exits. That means it can test **warm restore** (the browser stays running), but it cannot by itself test **cold-browser restore** after all browser windows/processes have exited.

The popup reports the extension installation type. If it shows the temporary-development warning, do not expect the adapter to survive a full browser restart.

For a persistent-installation artifact:

```bash
pnpm package
```

This creates an XPI under `web-ext-artifacts/`. Install/sign that package using a persistent installation method supported by the target Firefox/Zen build. Do not modify the browser installation or profile internals just to bypass extension-signing/security policy.

Before native messaging can connect, build and install the native host from Capsule-CLI:

```powershell
cargo build --bin capsule-firefox-host
cargo run --bin capsule-firefox-host -- --install
```

Then restart/reload the extension so it sees the native host registration.

## Persistent diagnostics

High-value capture/restore lifecycle events are forwarded through native messaging to the CLI-owned persistent log. The WebExtension itself never needs direct filesystem access.

On Windows:

```text
%LOCALAPPDATA%\ContextCapsule\logs\firefox.log
%LOCALAPPDATA%\ContextCapsule\logs\firefox.log.1
```

Diagnostics include events such as native-host connection, startup/manual capture counts, extension installation type, restore start/completion, changed/reused resource counts, warning counts, and deduplicated failures. They deliberately avoid persisting captured tab URLs as diagnostic payloads.

The CLI native host bounds and rotates these logs. Logging is fail-open: inability to write a diagnostic must not make capture or restore fail.

## Manual end-to-end test

1. Start Firefox/Zen with the extension loaded.
2. Open several tabs, create a named tab group, pin a tab, and optionally open a second browser window. In Zen, include one or more Essentials if you want to exercise the Essential-preservation path.
3. Open the Context Capsule toolbar popup. It should report `Connected`, the correct window/tab counts, and whether the extension is a temporary development install.
4. Click **Sync now**.
5. In Capsule-CLI, run `cargo run -- save firefox-test` and then `cargo run -- show firefox-test --json`; the JSON should contain `snapshot.browsers.firefox`.
6. Change/close some tabs or windows. For reuse testing, leave live windows whose tabs are subsets of different saved windows, scramble the ordinary tab order, and leave the Zen Essentials in their Essentials section.
7. Enter `firefox-test` in the extension popup and click **Restore capsule**. Context Capsule should globally assign the best live window to each saved window, retain matching tabs, add only missing tabs, restore the saved relative order of ordinary tabs, preserve pre-existing Zen pinned/Essential tabs without moving or unpinning them, and reuse spare live windows as shells before creating new browser windows.
8. Inspect `firefox.log` if a capture or restore is partial or fails.

For a **cold-browser** test, use a persistently installed Context Capsule extension. Capsule-CLI opens a real bootstrap browser window/tab so WebExtensions and native messaging can start even when no Zen windows were open. The restore bus request/completion is the authoritative adapter handshake; the bootstrap is only startup state and is eligible for reuse by the same global restore planner.

## Restore semantics and safety

The capsule is the target state rather than an additive suggestion. Before creating anything, the adapter inspects all live non-private browser windows and computes a global maximum-reuse assignment against all saved windows. The leading objective is the total number of already-open saved tabs that can be retained across the complete restore. Ties favor exact or subset semantic matches, then inexpensive shells with less unrelated state, then saved geometry. A usable live window with no matching tabs is still preferred over creating another window when the saved topology needs a shell.

For each assigned live window, matching tabs are retained in place, missing restorable tabs are created, mute/active state and named tab groups are reconciled, ordinary tabs outside the capsule are removed only after target tabs safely exist, and the saved window geometry/state is restored. Tab ordering is segment-aware: saved pinned targets are ordered within the mutable pinned region and ordinary targets are ordered within the unpinned region. Ordering is verified and retried after creation and again after group restoration so group operations cannot silently leave the tab sequence scrambled.

### Zen Essentials

Zen Essentials carry a private `zen-essential` state in Zen's own session store. The standard Firefox WebExtension `tabs.Tab` API exposes an Essential only as a pinned tab and does not expose a supported operation for setting that private Essential marker. Context Capsule therefore treats every pinned tab that already existed in an assigned Zen window as protected native state: it is not deleted, moved through the generic tab strip, or changed from pinned to unpinned during reconciliation. Matching protected tabs are reused as the same live tab objects, preserving Zen's hidden Essential state.

If a saved ordinary tab has the same URL/container as a protected live pinned/Essential tab, the protected tab is not consumed and demoted; Context Capsule restores a separate ordinary target tab instead. Likewise, a pinned tab that appeared after the capsule was saved is preserved rather than deleted because the WebExtension cannot safely determine whether it is an Essential.

This protection is intentionally asymmetric. Context Capsule can preserve an Essential that Zen already has, but a standard WebExtension cannot reliably manufacture a missing Zen Essential from scratch. If an Essential is completely absent at restore time, a newly created saved pinned tab can only be restored as a normal pinned tab through the supported WebExtension API; promoting it into Zen's private Essentials section remains Zen-owned state.

Original live windows outside the assignment are cleaned up only after the complete saved topology has been restored, and only when they contain no pre-existing pinned tabs. A surplus window containing pinned tabs is preserved with a warning because closing the entire window could otherwise destroy Zen-owned Essential state that the WebExtension cannot distinguish from ordinary pinning. If any saved window fails to restore, unrelated live windows are preserved as recovery state rather than being destructively removed during a partial restore.

Privileged Firefox URLs such as `about:config`, extension URLs, and local `file:` URLs are retained as non-restorable context but are **not reopened** during semantic restore. If the exact privileged tab is already open in an assigned window, it can be retained in place.

Maximized/fullscreen windows are staged onto the saved monitor before their non-normal state is applied. Anonymous group relationships are not synthesized as ordinary Firefox groups because Firefox-derived browsers can expose vendor-specific relationships (including split-style state) through anonymous group identifiers.
