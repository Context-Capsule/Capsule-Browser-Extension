# Context Capsule Firefox Extension

Firefox/Zen WebExtension adapter for Context Capsule. It captures normal browser windows, tab URLs/order, pinned and active tabs, portable tab groups, container IDs, discarded/muted state, and browser-window geometry/state. Private windows are intentionally excluded.

The extension communicates with the `capsule-firefox-host` native messaging binary from the `Context-Capsule/Capsule-CLI` repository using the host name `com.contextcapsule.host`.

## Development

```bash
pnpm install
pnpm check
pnpm dev
```

`pnpm dev` builds the extension and launches a temporary Firefox profile through `web-ext`.

Before native messaging can connect, build and install the native host from Capsule-CLI:

```powershell
cargo build --bin capsule-firefox-host
cargo run --bin capsule-firefox-host -- --install
```

Then restart the temporary Firefox instance so it sees the native host registration.

## Persistent diagnostics

High-value capture/restore lifecycle events are forwarded through native messaging to the CLI-owned persistent log. The WebExtension itself never needs direct filesystem access.

On Windows:

```text
%LOCALAPPDATA%\ContextCapsule\logs\firefox.log
%LOCALAPPDATA%\ContextCapsule\logs\firefox.log.1
```

Diagnostics include events such as native-host connection, startup/manual capture counts, restore start/completion, changed/reused resource counts, warning counts, and deduplicated failures. They deliberately avoid persisting captured tab URLs as diagnostic payloads.

The CLI native host bounds and rotates these logs. Logging is fail-open: inability to write a diagnostic must not make capture or restore fail.

## Manual end-to-end test

1. Start Firefox/Zen with the extension loaded.
2. Open several tabs, create a named tab group, pin a tab, and optionally open a second browser window.
3. Open the Context Capsule toolbar popup. It should report `Connected` and the correct window/tab counts.
4. Click **Sync now**.
5. In Capsule-CLI, run `cargo run -- save firefox-test` and then `cargo run -- show firefox-test --json`; the JSON should contain `snapshot.browsers.firefox`.
6. Change/close the test tabs.
7. Enter `firefox-test` in the extension popup and click **Restore capsule**. Missing browser resources are restored conservatively; already-satisfied windows are reused instead of duplicated.
8. Inspect `firefox.log` if a capture or restore is partial or fails.

## Restore safety

Privileged Firefox URLs such as `about:config`, extension URLs, and local `file:` URLs are retained as non-restorable context but are **not reopened** during semantic restore.

For Zen, existing changed windows are deliberately left untouched when identity is not exact enough to mutate safely. Missing independent windows use the native blank-window path so Zen Window Sync does not clone or corrupt an existing Space. Maximized/fullscreen windows are staged onto the saved monitor before their non-normal state is applied.

Anonymous group relationships are not synthesized as ordinary Firefox groups because Firefox-derived browsers can expose vendor-specific relationships (including split-style state) through anonymous group identifiers.
