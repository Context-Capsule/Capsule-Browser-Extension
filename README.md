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

Diagnostics include events such as native-host connection, startup/manual capture counts, extension installation type, restore start/completion, changed/reused resource counts, split restore results, warning counts, and deduplicated failures. They deliberately avoid persisting captured tab URLs as diagnostic payloads.

The CLI native host bounds and rotates these logs. Logging is fail-open: inability to write a diagnostic must not make capture or restore fail.

## Manual end-to-end test

1. Start Zen with the persistently installed extension and current native host.
2. Open several ordinary tabs and put two of them into a real Zen split view. A left/right split is the primary regression case; horizontal and grid layouts are also represented.
3. Open the Context Capsule toolbar popup. It should report `Connected`, the correct window/tab counts, and whether the extension is a temporary development install.
4. Click **Sync now**.
5. In Capsule-CLI, run `cargo run -- save split-test1` and then `cargo run -- show split-test1 --json`; the Firefox snapshot should contain the split members linked to the same internal split group marker.
6. Unsplit those tabs, close one of them, reorder other tabs, or otherwise disturb the saved browser state.
7. Run `cargo run -- restore split-test1`. Context Capsule should globally reuse the best live windows/tabs, complete missing tabs, restore ordinary tab order, then multi-select the exact saved split members and invoke Zen's own split command. The restore is accepted only if the extension re-queries the tabs and verifies that Zen formed one real split relationship.
8. Inspect `firefox.log` if capture or restore is partial or a split command is rejected.

For a **cold-browser** test, use a persistently installed Context Capsule extension. Capsule-CLI opens a real bootstrap browser window/tab so WebExtensions and native messaging can start even when no Zen windows were open. The restore bus request/completion is the authoritative adapter handshake; the bootstrap is only startup state and is eligible for reuse by the same global restore planner.

## Restore semantics and safety

The capsule is the target state rather than an additive suggestion. Before creating anything, the adapter inspects all live non-private browser windows and computes a global maximum-reuse assignment against all saved windows. The leading objective is the total number of already-open saved tabs that can be retained across the complete restore. Ties favor exact or subset semantic matches, then inexpensive shells with less unrelated state, then saved geometry. A usable live window with no matching tabs is still preferred over creating another window when the saved topology needs a shell.

For each assigned live window, matching tabs are retained in place, missing restorable tabs are created, mute/active state and named tab groups are reconciled, ordinary tabs outside the capsule are removed only after target tabs safely exist, and the saved window geometry/state is restored. Tab ordering is segment-aware and verified/retried after creation and again after group restoration so group operations cannot silently leave the tab sequence scrambled.

### Zen split views

Zen split views are not ordinary adjacent tabs. Zen backs a split with browser tab-group state plus its own split-view metadata and commands. Context Capsule therefore records the relationship separately from portable named Firefox groups. The snapshot schema remains version 1 by encoding the split marker through the existing group-key/title fields, which the CLI already persists losslessly.

During restore, Context Capsule first converges window identity, tab identity, order, and geometry. It then maps each saved split back to the exact restored live tabs. If those tabs already form the saved split, no command is sent. Otherwise the extension multi-selects only those tabs and focuses their Zen window, then the native host invokes Zen's own Vertical, Horizontal, or Grid split command. The extension re-queries the tabs after the command and accepts the restore only when the members share a real split identity. A failed command leaves the tabs intact and produces a warning rather than silently representing the split as an ordinary tab group.

On Windows the native host checks that the foreground executable is actually `zen.exe` before emitting the split shortcut. It reads `zen-keyboard-shortcuts.json` from the active Zen profile when available, so customized bindings for `cmd_zenSplitViewVertical`, `cmd_zenSplitViewHorizontal`, and `cmd_zenSplitViewGrid` are respected. If the profile shortcut exists but is disabled or unsupported, restore fails closed instead of guessing a key. When no profile shortcut file exists, the native host uses Zen's standard Ctrl+Alt+V/H/G bindings.

The current portable split representation preserves membership and the major layout orientation. Zen's private arbitrary splitter-size/layout tree is not exposed through the standard WebExtension API, so Context Capsule currently recreates the real split using Zen's normal layout for that orientation rather than pretending it can round-trip an inaccessible divider tree.

Split restoration deliberately skips saved split members that are pinned. Context Capsule does not modify Zen Essential/pinned semantics while reconstructing split views.

Original live windows outside the assignment are cleaned up only after the complete saved topology has been restored, and only when they contain no pre-existing pinned tabs. If any saved window fails to restore, unrelated live windows are preserved as recovery state rather than being destructively removed during a partial restore.

Privileged Firefox URLs such as `about:config`, extension URLs, and local `file:` URLs are retained as non-restorable context but are **not reopened** during semantic restore. If the exact privileged tab is already open in an assigned window, it can be retained in place.

Maximized/fullscreen windows are staged onto the saved monitor before their non-normal state is applied. Named Firefox tab groups remain portable groups; Zen split markers are handled only by the verified split restoration phase and are never synthesized as ordinary groups.
