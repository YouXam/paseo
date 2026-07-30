// Lightweight debug trace for diagnosing cloud-sync-driven UI resets. Writes a
// capped ring buffer to localStorage so it survives full page reloads (which
// wipe the console). Read it after a reset with:
//   JSON.parse(localStorage["paseo:sync-debug"]).slice(-40)
// Web-only; a no-op where localStorage/window are unavailable. Remove once the
// reset cause is confirmed.
const KEY = "paseo:sync-debug";
const MAX = 400;

export function syncDebug(event: string, detail?: Record<string, unknown>): void {
  console.info("[SyncDebug]", event, detail ?? "");
  if (typeof localStorage === "undefined") {
    return;
  }
  try {
    const raw = localStorage.getItem(KEY);
    const arr = raw ? (JSON.parse(raw) as unknown[]) : [];
    arr.push({ t: new Date().toISOString(), event, ...detail });
    if (arr.length > MAX) {
      arr.splice(0, arr.length - MAX);
    }
    localStorage.setItem(KEY, JSON.stringify(arr));
  } catch {
    // best-effort tracing only
  }
}

let installed = false;

export function installSyncDebugPageMarkers(): void {
  if (installed || typeof window === "undefined") {
    return;
  }
  installed = true;
  try {
    const nav = performance.getEntriesByType?.("navigation")?.[0] as
      | PerformanceNavigationTiming
      | undefined;
    syncDebug("page:load", { navType: nav?.type ?? "unknown", url: window.location?.href });
    window.addEventListener("pagehide", () => syncDebug("page:hide"));
    window.addEventListener("beforeunload", () => syncDebug("page:beforeunload"));
  } catch {
    // best-effort tracing only
  }
}
