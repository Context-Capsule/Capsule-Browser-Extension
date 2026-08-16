interface PopupStatus {
  native: { connected: boolean; host_version?: string; last_error?: string };
  last_sync_unix_ms?: number;
  windows: number;
  tabs: number;
  skipped_private_windows: number;
  syncing: boolean;
  restoring: boolean;
  last_error?: string;
  last_restore?: { created_windows: number; created_tabs: number; created_groups: number; warnings: string[] };
}

const connection = document.querySelector<HTMLSpanElement>("#connection")!;
const counts = document.querySelector<HTMLDivElement>("#counts")!;
const detail = document.querySelector<HTMLDivElement>("#detail")!;
const syncButton = document.querySelector<HTMLButtonElement>("#sync")!;
const restoreButton = document.querySelector<HTMLButtonElement>("#restore")!;
const capsuleName = document.querySelector<HTMLInputElement>("#capsule-name")!;

async function request<T>(message: unknown): Promise<T> {
  return browser.runtime.sendMessage(message) as Promise<T>;
}

function render(status: PopupStatus): void {
  connection.textContent = status.native.connected ? "Connected" : "Native host unavailable";
  connection.dataset.connected = status.native.connected ? "true" : "false";
  counts.textContent = `${status.windows} window${status.windows === 1 ? "" : "s"} · ${status.tabs} tab${status.tabs === 1 ? "" : "s"}`;

  const messages: string[] = [];
  if (status.last_sync_unix_ms) messages.push(`Synced ${new Date(status.last_sync_unix_ms).toLocaleTimeString()}`);
  if (status.skipped_private_windows > 0) messages.push(`${status.skipped_private_windows} private window(s) intentionally skipped`);
  if (status.native.host_version) messages.push(`Host ${status.native.host_version}`);
  if (status.last_restore) {
    messages.push(
      `Last restore: ${status.last_restore.created_windows} windows, ${status.last_restore.created_tabs} tabs, ${status.last_restore.created_groups} groups`,
    );
    if (status.last_restore.warnings.length > 0) messages.push(`${status.last_restore.warnings.length} restore warning(s)`);
  }

  if (!status.native.connected) {
    if (status.native.last_error) messages.push(`Native messaging: ${status.native.last_error}`);
    messages.push("Native host setup is required once. In Capsule-CLI run capsule-firefox-host --install, then --doctor.");
  }
  if (status.last_error && status.last_error !== status.native.last_error) {
    messages.push(status.last_error);
  }
  detail.textContent = messages.join("\n");

  syncButton.disabled = status.syncing || status.restoring;
  syncButton.textContent = status.syncing ? "Syncing…" : "Sync now";
  restoreButton.disabled = status.restoring || !status.native.connected;
  restoreButton.textContent = status.restoring ? "Restoring…" : "Restore capsule";
}

async function refresh(): Promise<void> {
  render(await request<PopupStatus>({ type: "status" }));
}

syncButton.addEventListener("click", async () => {
  render(await request<PopupStatus>({ type: "capture-now" }));
});

restoreButton.addEventListener("click", async () => {
  try {
    const status = await request<PopupStatus>({
      type: "restore-capsule",
      capsule_name: capsuleName.value,
    });
    render(status);
  } catch (error) {
    detail.textContent = error instanceof Error ? error.message : String(error);
  }
});

void refresh();
