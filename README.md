# Context Capsule Firefox Extension

Firefox/Zen WebExtension adapter for Context Capsule. It captures normal browser windows, tab URLs/order, pinned and active tabs, portable tab groups, Zen split-view relationships, container IDs, discarded/muted state, and browser-window geometry/state. Private windows are intentionally excluded.

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

Diagnostics include events such as native-host connection, startup/manual capture counts, extension installation type, restore start/completion, changed/reused resource counts, final tab-order corrections, warning counts, and deduplicated failures. They deliberately avoid persisting captured tab URLs as diagnostic payloads.

The CLI native host bounds and rotates these logs. Logging is fail-open: inability to write a diagnostic must not make capture or restore fail.

## Manual end-to-end test

1. Start Zen with the persistently installed extension and current native host.
2. Open at least four ordinary tabs in a memorable order, for example `A, B, C, D`. A named Firefox tab group may be included to exercise block-aware ordering.
3. Open the Context Capsule toolbar popup. It should report `Connected`, the correct window/tab counts, and whether the extension is a temporary development install.
4. Click **Sync now**.
5. In Capsule-CLI, run `cargo run -- save order-test1` and then `cargo run -- show order-test1 --json`; the Firefox snapshot should preserve each tab's index.
6. Deliberately scramble the live tabs, especially the edges: for example change `A, B, C, D` to `B, A, D, C`, or reverse the whole sequence.
7. Run `cargo run -- restore order-test1`. Context Capsule should globally reuse the best live windows/tabs, complete missing tabs, restore groups and geometry, and then run one final authoritative ordering pass. The ordinary tabs must finish in exactly `A, B, C, D` relative order.
8. Inspect `firefox.log` if capture or restore is partial. A failed final-order convergence is reported explicitly rather than silently accepted.

For a **cold-browser** test, use a persistently installed Context Capsule extension. Capsule-CLI opens a real bootstrap browser window/tab so WebExtensions and native messaging can start even when no Zen windows were open. The restore bus request/completion is the authoritative adapter handshake; the bootstrap is only startup state and is eligible for reuse by the same global restore planner.

## Restore semantics and safety

The capsule is the target state rather than an additive suggestion. Before creating anything, the adapter inspects all live non-private browser windows and computes a global maximum-reuse assignment against all saved windows. The leading objective is the total number of already-open saved tabs that can be retained across the complete restore. Ties favor exact or subset semantic matches, then inexpensive shells with less unrelated state, then saved geometry. A usable live window with no matching tabs is still preferred over creating another window when the saved topology needs a shell.

For each assigned live window, matching tabs are retained in place, missing restorable tabs are created, mute/active state and named tab groups are reconciled, ordinary tabs outside the capsule are removed only after target tabs safely exist, and the saved window geometry/state is restored.

Tab order has an additional final-authority phase after all of those operations. The verifier sorts live tabs by their actual `tab.index`; it never trusts array iteration order. For ordinary ungrouped target tabs, the adapter sends the entire saved tab-ID sequence to one `tabs.move()` call at the first-unpinned boundary, avoiding sequential index-shift races. If groups are present, saved groups are treated as blocks and moved from right to left; real groups use `tabGroups.move()` where possible so their member order and grouping are not destroyed. The result is re-read and compared against the exact saved relative ID sequence, with bounded retries and an explicit warning if the browser refuses to converge.

### Zen split views

Zen split relationships are still captured so a capsule does not lose the information. Automatic split reconstruction is intentionally disabled in the current restore path while the Zen-specific invocation mechanism is investigated. Restore therefore does not select split members or send Zen split shortcuts after the final tab-order phase.

Split markers remain non-portable group metadata and are never synthesized as ordinary named Firefox groups. Tabs that belonged to a saved split are restored as ordinary tabs in their saved relative order for now.

Original live windows outside the assignment are cleaned up only after the complete saved topology has been restored, and only when they contain no pre-existing pinned tabs. If any saved window fails to restore, unrelated live windows are preserved as recovery state rather than being destructively removed during a partial restore.

Privileged Firefox URLs such as `about:config`, extension URLs, and local `file:` URLs are retained as non-restorable context but are **not reopened** during semantic restore. If the exact privileged tab is already open in an assigned window, it can be retained in place.

Maximized/fullscreen windows are staged onto the saved monitor before their non-normal state is applied. Named Firefox tab groups remain portable groups; Zen split markers are captured but currently left unapplied during restore.
