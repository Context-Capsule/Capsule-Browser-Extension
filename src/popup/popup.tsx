import { Glass } from "@samasante/liquid-glass";
import { useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { BROWSER_LABEL, NATIVE_HOST_BINARY } from "../platform";

interface PopupStatus {
  native: { connected: boolean; host_version?: string; last_error?: string };
  last_sync_unix_ms?: number;
  install_type?: string;
  windows: number;
  tabs: number;
  skipped_private_windows: number;
  syncing: boolean;
  restoring: boolean;
  last_error?: string;
  last_restore?: {
    created_windows: number;
    created_tabs: number;
    created_groups: number;
    reused_windows?: number;
    reused_tabs?: number;
    warnings: string[];
  };
}

async function request<T>(message: unknown): Promise<T> {
  return browser.runtime.sendMessage(message) as Promise<T>;
}

function details(status: PopupStatus): string[] {
  const messages: string[] = [];
  if (status.last_sync_unix_ms) messages.push(`Synced ${new Date(status.last_sync_unix_ms).toLocaleTimeString()}`);
  if (status.install_type === "development") {
    messages.push("Development install: a full browser quit can unload this adapter. Cold-browser restore requires a persistent extension installation.");
  }
  if (status.skipped_private_windows > 0) messages.push(`${status.skipped_private_windows} private window(s) intentionally skipped`);
  if (status.native.host_version) messages.push(`Host ${status.native.host_version}`);
  if (status.last_restore) {
    const reusedWindows = status.last_restore.reused_windows ?? 0;
    const reusedTabs = status.last_restore.reused_tabs ?? 0;
    messages.push(
      `Last restore: ${status.last_restore.created_windows} new window(s), ${status.last_restore.created_tabs} new tab(s), ${status.last_restore.created_groups} group(s)`,
    );
    if (reusedWindows > 0 || reusedTabs > 0) {
      messages.push(`${reusedWindows} window(s) · ${reusedTabs} tab(s) already satisfied and reused`);
    }
    if (status.last_restore.warnings.length > 0) messages.push(`${status.last_restore.warnings.length} restore warning(s)`);
  }
  if (!status.native.connected) {
    if (status.native.last_error) messages.push(`Native messaging: ${status.native.last_error}`);
    messages.push(`Native host setup is required once. In Capsule-CLI run ${NATIVE_HOST_BINARY} --install, then --doctor.`);
  }
  if (status.last_error && status.last_error !== status.native.last_error) messages.push(status.last_error);
  return messages;
}

function Popup(): React.JSX.Element {
  const [status, setStatus] = useState<PopupStatus>();
  const [capsuleName, setCapsuleName] = useState("");
  const [localError, setLocalError] = useState<string>();

  const refresh = useCallback(async () => {
    try {
      setStatus(await request<PopupStatus>({ type: "status" }));
      setLocalError(undefined);
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : String(error));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const sync = useCallback(async () => {
    try {
      setStatus(await request<PopupStatus>({ type: "capture-now" }));
      setLocalError(undefined);
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : String(error));
    }
  }, []);

  const restore = useCallback(async () => {
    try {
      setStatus(await request<PopupStatus>({ type: "restore-capsule", capsule_name: capsuleName }));
      setLocalError(undefined);
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : String(error));
    }
  }, [capsuleName]);

  const connected = status?.native.connected ?? false;
  const busy = Boolean(status?.syncing || status?.restoring);
  const messages = status ? details(status) : [];
  if (localError) messages.push(localError);

  return (
    <Glass
      className="liquid-shell"
      optics={{
        strength: 0.2,
        depth: 0.64,
        curvature: 0.22,
        dispersion: 0.14,
        bend: 0.26,
        frost: 8,
        sheen: 0,
        glow: 0,
        specular: 0,
      }}
    >
      <main>
        <div className="ambient ambient-one" aria-hidden="true" />
        <div className="ambient ambient-two" aria-hidden="true" />
        <header>
          <div className="brand">
            <img className="brand-logo" src="capsule-bgless.png" alt="" />
            <div className="brand-copy">
              <h1>Context Capsule</h1>
              <p>{BROWSER_LABEL} workspace adapter</p>
            </div>
          </div>
          <span className="connection" data-connected={connected ? "true" : "false"}>
            {connected ? "Connected" : "Native host unavailable"}
          </span>
        </header>

        <section className="snapshot glass-section">
          <div className="counts">
            {status ? `${status.windows} window${status.windows === 1 ? "" : "s"} · ${status.tabs} tab${status.tabs === 1 ? "" : "s"}` : "Inspecting browser…"}
          </div>
          <button className="primary-action" type="button" disabled={busy} onClick={() => void sync()}>
            {status?.syncing ? "Syncing…" : "Sync now"}
          </button>
        </section>

        <section className="restore glass-section">
          <label htmlFor="capsule-name">Saved capsule</label>
          <div className="restore-row">
            <input
              id="capsule-name"
              type="text"
              value={capsuleName}
              onChange={event => setCapsuleName(event.currentTarget.value)}
              placeholder="my-workspace"
              autoComplete="off"
            />
            <button type="button" disabled={Boolean(status?.restoring) || !connected} onClick={() => void restore()}>
              {status?.restoring ? "Restoring…" : "Restore capsule"}
            </button>
          </div>
        </section>

        <pre aria-live="polite">{messages.join("\n")}</pre>
        <footer>
          <span className="privacy-dot" aria-hidden="true" />
          Private windows are never captured.
        </footer>
      </main>
    </Glass>
  );
}

const root = document.querySelector<HTMLDivElement>("#root");
if (!root) throw new Error("Context Capsule popup root is missing");
createRoot(root).render(<Popup />);
