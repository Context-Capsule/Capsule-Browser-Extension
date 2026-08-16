# Context Capsule Firefox Extension

Firefox WebExtension adapter for Context Capsule. It captures normal Firefox windows, tab URLs/order, pinned and active tabs, tab groups, container IDs, discarded/muted state, and browser-window geometry/state. Private windows are intentionally excluded.

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

## Manual end-to-end test

1. Start Firefox with `pnpm dev`.
2. Open several tabs, create a tab group, pin a tab, and optionally open a second browser window.
3. Open the Context Capsule toolbar popup. It should report `Connected` and the correct window/tab counts.
4. Click **Sync now**.
5. In Capsule-CLI, run `cargo run -- save firefox-test` and then `cargo run -- show firefox-test --json`; the JSON should contain `snapshot.browsers.firefox`.
6. Change/close the test tabs.
7. Enter `firefox-test` in the extension popup and click **Restore capsule**. New Firefox windows are created non-destructively with the saved tab order, pinning, groups, containers when available, active tabs, and window placement/state.

Privileged Firefox URLs such as `about:config`, extension URLs, and local `file:` URLs are captured for visibility but restored as `about:blank`. Existing browser windows are never closed by restore.
