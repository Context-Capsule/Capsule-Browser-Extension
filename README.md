# Context Capsule Browser Extension

Shared WebExtension adapter for Context Capsule. One TypeScript capture/restore core targets **Firefox/Zen** and **Google Chrome** without forking the browser-state engine.

This repository owns browser-specific semantic state: windows, tabs, ordering, groups, browser-family metadata, restore reconciliation, and the extension popup. The Rust CLI repository owns capsule persistence, native-host executables/registration, and the wider capture/restore engine.

## Context Capsule ecosystem

Context Capsule is split across four cooperating repositories:

```text
                         user-facing clients

  +----------------------+                 +----------------------+
  | Capsule Desktop App  |                 | Capsule CLI          |
  | Tauri + Svelte       |                 | Rust CLI client      |
  +----------+-----------+                 +----------+-----------+
             | bundled/allow-listed CLI               |
             +--------------------------->             |
                                                       | authenticated
                                                       | loopback IPC
                                                       v
                                             +--------------------+
                                             | Local Agent        |
                                             | worker + engines   |
                                             | SQLite persistence |
                                             +----+-----------+---+
                                                  |           |
                       runtime files/restore bus   |           | native messaging
                                                  |           |
                     +----------------------------+           +--------------------------+
                     |                                                               |
                     v                                                               v
       +---------------------------+                                 +---------------------------+
       | Capsule VS Code Extension |                                 | Capsule Browser Extension |
       | editor semantic adapter   |                                 | this repository           |
       +---------------------------+                                 +-------------+-------------+
                                                                                   |
                                                                       +-----------+-----------+
                                                                       |                       |
                                                                       v                       v
                                                               Firefox / Zen              Google Chrome
                                                               native host                native host
```

### Repository responsibilities

| Repository | Primary responsibility |
| --- | --- |
| [Capsule-CLI](https://github.com/Context-Capsule/Capsule-CLI) | Core domain engine, Local Agent/worker, SQLite/revisions, generic terminals/Docker/Windows state, browser native-host binaries and runtime channels |
| [Capsule-Desktop-App](https://github.com/Context-Capsule/Capsule-Desktop-App) | Desktop/tray UX and safe Tauri-to-CLI bridge; can install/verify bundled browser hosts |
| **Capsule-Browser-Extension** | Browser window/tab/group capture and semantic restore for Firefox/Zen and Chrome, plus popup UX |
| [Capsule-VSCode-Extension](https://github.com/Context-Capsule/Capsule-VSCode-Extension) | VS Code workspace/editor/integrated-terminal semantic state |

## Where should a feature be implemented?

| Change | Repository / layer |
| --- | --- |
| Capture another browser tab/window/group property | This repo, primarily `src/browser/capture.ts` + `model.ts` |
| Change browser restore/reuse/reconciliation behavior | This repo, `src/browser/restore.ts` |
| Change final tab/group ordering logic | This repo, `src/browser/order.ts` |
| Change Zen split metadata handling | This repo, `src/browser/splits.ts` |
| Add browser-family capability differences | This repo, `src/platform.ts` and the focused capture/restore code using it |
| Change extension <-> native-host request/response shape | This repo `src/native/protocol.ts` **and** `Capsule-CLI` native-host implementation |
| Change native-host installation, registry/manifest paths, host executable behavior, or doctor checks | `Capsule-CLI` |
| Add browser state to capsule persistence/history/diff | `Capsule-CLI` after this adapter exposes the semantic data |
| Add/change extension popup UI | This repo, `src/popup/` |
| Add desktop UI for browser integration health/setup | `Capsule-Desktop-App`, backed by CLI/native-host capabilities |
| VS Code editor semantics | `Capsule-VSCode-Extension`, not this repo |

A useful rule: **browser API behavior lives here; native operating-system integration and capsule persistence live in the CLI.**

## What is captured

The shared adapter captures normal, non-private browser state including:

- browser windows and saved geometry/state;
- tab URLs and exact tab order;
- active and pinned tabs;
- muted/discarded state where supported;
- portable tab groups;
- browser-family-specific metadata needed for a safe semantic restore.

Private/incognito windows are intentionally excluded.

Firefox/Zen additionally preserves Firefox container IDs and captures Zen split-view relationships. Chrome deliberately does not receive Firefox `cookieStoreId` fields and supports legitimate unnamed Chrome tab groups.

## Runtime architecture

```text
manifest.json / manifest.chrome.json
              |
              v
      src/background.ts
              |
      +-------+--------------------+
      |                            |
      v                            v
src/browser/*                 src/native/*
capture/model/                native messaging
restore/order/splits          client + protocol
      |                            |
      |                            v
      |                  Firefox/Chrome native host
      |                            |
      +----------------------------+
                   |
                   v
      Context Capsule runtime state
                   |
                   v
         Capsule CLI / Local Agent
                   |
                   v
            SQLite revision
```

### Capture flow

1. The background adapter observes browser state.
2. `src/browser/capture.ts` builds the semantic model defined in `src/browser/model.ts`.
3. The extension sends state through the browser-family native messaging host.
4. The CLI-owned host writes the canonical recent browser state into the Context Capsule runtime area.
5. `capsule save`/`update` reads recent browser state into the capsule revision.

### Restore flow

1. `capsule restore` selects the saved browser snapshot.
2. The CLI/native host publishes a restore request on the browser-specific runtime channel.
3. `src/background.ts` receives it through `src/native/client.ts`.
4. `src/browser/restore.ts` computes semantic reuse/reconciliation against live non-private windows.
5. `src/browser/order.ts` performs final authoritative ordering and verification.
6. The adapter reports restore outcome/diagnostics back through native messaging.

Firefox and Chrome are restored independently. A capsule may contain one or both browser snapshots.

## Repository architecture

```text
Capsule-Browser-Extension/
├─ src/
│  ├─ background.ts               extension lifecycle, native connection, orchestration
│  ├─ platform.ts                 browser-family/capability abstraction
│  ├─ browser/
│  │  ├─ model.ts                 shared semantic browser state model
│  │  ├─ capture.ts               live -> semantic snapshot
│  │  ├─ restore.ts               semantic reconciliation/restore engine
│  │  ├─ order.ts                 authoritative tab/group ordering
│  │  └─ splits.ts                Zen split metadata handling
│  ├─ native/
│  │  ├─ client.ts                browser native-messaging client
│  │  └─ protocol.ts              extension/native-host message contract
│  └─ popup/
│     ├─ popup.tsx                React popup UI
│     ├─ popup.css                popup styling
│     └─ popup.html               popup entry document
├─ scripts/
│  ├─ build.mjs                   target-aware build
│  ├─ dev.mjs                     Firefox/Zen development build loop
│  └─ test*.mjs / lint helpers    regression/build-target checks
├─ manifest.json                  Firefox/Zen MV3 manifest source
├─ manifest.chrome.json           Chrome MV3 manifest source
├─ package.json                   pnpm scripts/dependencies
├─ dist/                          generated Firefox/Zen build
└─ dist-chrome/                   generated Chrome build
```

### Shared core vs browser-specific behavior

Do not fork the full restore engine just to add a browser target. Prefer a shared semantic model and isolate differences through capability/platform checks.

**Shared behavior includes:**

- browser-window capture and geometry;
- URL/title/pinned/active/muted/discarded tab state;
- exact tab ordering;
- standard tab-group capture/restore;
- global saved-window/live-window reuse assignment;
- final authoritative ordering verification;
- native restore-bus synchronization.

**Firefox/Zen-specific behavior includes:**

- `cookieStoreId` / container identity;
- Zen Essential/pinned-tab protection behavior;
- Zen split relationship capture;
- the Zen native blank-window fallback used by the proven restore path.

Automatic Zen split reconstruction remains intentionally disabled: split metadata is retained without automatically selecting split members or invoking Zen split shortcuts.

**Chrome-specific behavior includes:**

- no Firefox container fields;
- legitimate unnamed Chrome tab groups;
- standard Chrome `windows.create()` behavior rather than Zen-native fallback operations.

## Build targets

This repository uses pnpm.

### Install dependencies

```bash
pnpm install
```

### Firefox / Zen

Firefox remains the default target:

```bash
pnpm build
# equivalent
pnpm build:firefox
```

Output:

```text
dist/
```

The Firefox artifact uses:

- Gecko extension ID `firefox@contextcapsule.app`;
- native host `com.contextcapsule.host`;
- Firefox MV3 `background.scripts`;
- Firefox container/cookie-store metadata.

### Chrome

```bash
pnpm build:chrome
```

Output:

```text
dist-chrome/
```

The Chrome artifact uses:

- Chrome MV3 `background.service_worker`;
- native host `com.contextcapsule.chrome`;
- deterministic unpacked extension ID `gmffhdppfaeonombpbbgnldagfeabiof`;
- tabs, tab groups, and native messaging without Firefox container fields.

### Build both

```bash
pnpm build:all
```

## Development

### Firefox / Zen development

```bash
pnpm dev
```

This remains Firefox/Zen-oriented and builds `dist/` for loading through `about:debugging`. It does not modify the user's normal browser profile.

A temporary development add-on is useful for warm restore, but Firefox/Zen removes it after a full browser exit. Cold-browser restore therefore requires a persistent extension installation.

### Chrome development

1. Run `pnpm build:chrome`.
2. Open `chrome://extensions`.
3. Enable **Developer mode**.
4. Choose **Load unpacked**.
5. Select `dist-chrome/`.
6. Confirm the extension ID is `gmffhdppfaeonombpbbgnldagfeabiof`.
7. Install/verify the Chrome native host from `Capsule-CLI`.
8. Open the popup and confirm the adapter reports a working native connection.

The checked-in Chrome development key is public extension metadata used to make the unpacked development ID deterministic; it is not a private signing key.

## Native messaging hosts

The host executables live in **Capsule-CLI**, not this repository. The two browser families intentionally use separate registrations and runtime channels.

### Firefox / Zen host

From `Capsule-CLI`:

```powershell
cargo build --bin capsule-firefox-host
cargo run --bin capsule-firefox-host -- --install
cargo run --bin capsule-firefox-host -- --doctor
```

Host name:

```text
com.contextcapsule.host
```

### Chrome host

```powershell
cargo build --bin capsule-chrome-host
cargo run --bin capsule-chrome-host -- --install
cargo run --bin capsule-chrome-host -- --doctor
```

Host name:

```text
com.contextcapsule.chrome
```

When changing `src/native/protocol.ts`, update and test the corresponding Rust host in `Capsule-CLI` in the same coordinated feature. Treat the native-message schema as an integration contract.

## Validation

Run the complete repository checks:

```bash
pnpm check
```

The check pipeline performs type checking, regression tests, Firefox/Zen build/lint validation, Chrome build validation, and cross-target artifact checks.

Useful individual commands:

```bash
pnpm typecheck
pnpm test
pnpm lint
pnpm test:build-targets
```

For changes to the native protocol, also build/test the affected `capsule-*-host` binary in `Capsule-CLI` and perform a real extension connection/restore cycle.

## Packaging Firefox / Zen

Create the Firefox artifact with:

```bash
pnpm package
# equivalent
pnpm package:firefox
```

The XPI is written under:

```text
web-ext-artifacts/
```

Persistent installation/signing depends on the target Firefox/Zen environment.

## Capsule storage contract

The CLI stores browser states independently, conceptually:

```json
{
  "browsers": {
    "firefox": { "browser": "firefox" },
    "chrome": { "browser": "chrome" }
  }
}
```

`browsers.chrome` is present only when recent Chrome adapter state exists, so Firefox-only machines retain the historical payload shape. Persistence/schema ownership remains in `Capsule-CLI`; this extension owns the browser semantic payload it supplies.

## Restore semantics

The capsule is treated as the target browser state, not an instruction to blindly append duplicate tabs.

The shared restore engine:

- inspects live non-private windows first;
- computes a global saved-window/live-window reuse assignment;
- retains matching tabs where safe;
- creates missing restorable tabs;
- reconciles active/muted/group state;
- removes ordinary live extras only after required target state safely exists;
- restores saved geometry/state;
- re-reads actual tab indices and verifies final ordering with bounded retries;
- preserves unrelated live recovery state when a saved window cannot be restored safely.

Privileged browser URLs and local files can be retained as non-restorable context but are not reopened. If an exact privileged tab is already open, restore may preserve it in place rather than recreating it.

## Diagnostics

High-value lifecycle events are forwarded through native messaging to CLI-owned rotating logs. On Windows:

```text
%LOCALAPPDATA%\ContextCapsule\logs\firefox.log
%LOCALAPPDATA%\ContextCapsule\logs\chrome.log
```

Diagnostics include native-host connection state, capture counts, restore start/completion, changed/reused resource counts, ordering corrections, warning counts, and failures. Captured tab URLs are intentionally not persisted as diagnostic payloads.

## Developing a cross-repo browser feature

For a feature that affects both the adapter and persisted Context Capsule behavior:

1. Define/capture the browser semantic state in this repo.
2. Update `src/browser/model.ts` and capture/restore logic.
3. If transport changes, update `src/native/protocol.ts` and the matching Rust native host in `Capsule-CLI` together.
4. If capsule persistence/diff/doctor behavior changes, update `Capsule-CLI` and tests.
5. If setup/health needs desktop UI, expose the capability through the CLI and then update `Capsule-Desktop-App`.
6. Run `pnpm check` and an end-to-end save/restore test in every affected browser family.

## Safety invariants

- Private/incognito windows are excluded from capture.
- Privileged/local-file URLs are not arbitrarily reopened.
- Browser-family-specific metadata is not copied blindly across targets.
- Native hosts are separate and narrowly authorized per browser family.
- Restore verifies real browser state instead of assuming API mutation order succeeded.
- Diagnostics avoid persisting captured tab URLs.
- A failed restore should preserve useful live recovery state rather than destructively cleaning unrelated windows.

Preserve these boundaries when extending the adapter.