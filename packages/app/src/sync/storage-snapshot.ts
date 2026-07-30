import AsyncStorage from "@react-native-async-storage/async-storage";
import { queryClient } from "@/data/query-client";
import { CHANGES_PREFERENCES_QUERY_KEY } from "@/hooks/use-changes-preferences/storage";
import { APP_SETTINGS_QUERY_KEY } from "@/hooks/use-settings/storage";
import { getHostRuntimeStore, HOST_REGISTRY_STORAGE_KEY } from "@/runtime/host-runtime";
import { useBrowserStore } from "@/stores/browser-store";
import { useDraftStore } from "@/stores/draft-store";
import { usePanelStore } from "@/stores/panel-store";
import { useSidebarOrderStore } from "@/stores/sidebar-order-store";
import { useSidebarCollapsedSectionsStore } from "@/stores/sidebar-collapsed-sections-store";
import { useSidebarViewStore } from "@/stores/sidebar-view-store";
import { useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import { usePinnedTargetsStore } from "@/workspace-pins/store";
import { useReviewDraftStore } from "@/review/store";
import { type SyncStorageSnapshot } from "@/sync/merge";

export type { SyncStorageSnapshot };

const DRAFTS_STORAGE_KEY = "paseo-drafts";

export const SYNC_STORAGE_KEYS = [
  HOST_REGISTRY_STORAGE_KEY,
  // COMPAT(workspace-tabs-state): legacy key from the pre-layout-store tabs
  // store; kept in snapshots so older devices can still import them.
  "workspace-tabs-state",
  "workspace-layout-state",
  DRAFTS_STORAGE_KEY,
  "@paseo:app-settings",
  "@paseo:keyboard-shortcut-overrides",
  "@paseo:preferred-editor",
  "@paseo:changes-preferences",
  "@paseo:create-agent-preferences",
  "@paseo:review-draft-store",
  "sidebar-project-workspace-order",
  "paseo:last-workspace-route-selection",
  "panel-state",
  "workspace-browser-store",
  "sidebar-view",
  "sidebar-collapsed-sections",
  "pinned-tab-targets",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function scrubDraftRecord(value: unknown): void {
  if (!isRecord(value)) {
    return;
  }
  const input = value.input;
  if (!isRecord(input)) {
    return;
  }
  if (Array.isArray(input.attachments)) {
    input.attachments = [];
  }
  if (Array.isArray(input.images)) {
    input.images = [];
  }
}

function sanitizeDraftStoreValue(value: string): string {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!isRecord(parsed) || !isRecord(parsed.state)) {
      return value;
    }
    const drafts = parsed.state.drafts;
    if (isRecord(drafts)) {
      for (const record of Object.values(drafts)) {
        scrubDraftRecord(record);
      }
    }
    scrubDraftRecord(parsed.state.createModalDraft);
    return JSON.stringify(parsed);
  } catch {
    return value;
  }
}

function sanitizeStorageValue(key: string, value: string | null): string | null {
  if (value === null) {
    return null;
  }
  if (key === DRAFTS_STORAGE_KEY) {
    return sanitizeDraftStoreValue(value);
  }
  return value;
}

export async function readSyncStorageSnapshot(deviceId: string): Promise<SyncStorageSnapshot> {
  const storage: Record<string, string | null> = {};
  for (const key of SYNC_STORAGE_KEYS) {
    const value = await AsyncStorage.getItem(key);
    storage[key] = sanitizeStorageValue(key, value);
  }
  return {
    version: 1,
    deviceId,
    exportedAt: Date.now(),
    storage,
  };
}

function normalizeSyncStorageSnapshot(value: unknown): SyncStorageSnapshot {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.storage)) {
    throw new Error("Invalid cloud sync snapshot.");
  }
  const storage: Record<string, string | null> = {};
  for (const key of SYNC_STORAGE_KEYS) {
    const stored = value.storage[key];
    storage[key] = typeof stored === "string" ? sanitizeStorageValue(key, stored) : null;
  }
  return {
    version: 1,
    deviceId: typeof value.deviceId === "string" ? value.deviceId : "unknown",
    exportedAt: typeof value.exportedAt === "number" ? value.exportedAt : 0,
    storage,
  };
}

// Side effect to refresh the store/query backing a key after it changes. Keys
// absent here are read on demand and need no live refresh. Running only the
// effects for keys that actually changed is what stops an unrelated change (e.g.
// a remote draft edit) from reloading the host runtime and bouncing the whole
// app to the welcome screen.
const KEY_EFFECTS: Record<string, () => void | Promise<void>> = {
  [HOST_REGISTRY_STORAGE_KEY]: () => getHostRuntimeStore().reloadFromStorage(),
  "workspace-layout-state": () => useWorkspaceLayoutStore.persist.rehydrate(),
  [DRAFTS_STORAGE_KEY]: () => useDraftStore.persist.rehydrate(),
  "@paseo:review-draft-store": () => useReviewDraftStore.persist.rehydrate(),
  "sidebar-project-workspace-order": () => useSidebarOrderStore.persist.rehydrate(),
  "panel-state": () => usePanelStore.persist.rehydrate(),
  "workspace-browser-store": () => useBrowserStore.persist.rehydrate(),
  "sidebar-view": () => useSidebarViewStore.persist.rehydrate(),
  "sidebar-collapsed-sections": () => useSidebarCollapsedSectionsStore.persist.rehydrate(),
  "pinned-tab-targets": () => usePinnedTargetsStore.persist.rehydrate(),
  "@paseo:app-settings": () => queryClient.invalidateQueries({ queryKey: APP_SETTINGS_QUERY_KEY }),
  "@paseo:changes-preferences": () =>
    queryClient.invalidateQueries({ queryKey: CHANGES_PREFERENCES_QUERY_KEY }),
  "@paseo:keyboard-shortcut-overrides": () =>
    queryClient.invalidateQueries({ queryKey: ["keyboard-shortcut-overrides"] }),
  "@paseo:preferred-editor": () =>
    queryClient.invalidateQueries({ queryKey: ["preferred-editor"] }),
};

export async function applySyncStorageSnapshot(snapshot: unknown): Promise<SyncStorageSnapshot> {
  const normalized = normalizeSyncStorageSnapshot(snapshot);
  const changedKeys: string[] = [];
  for (const key of SYNC_STORAGE_KEYS) {
    const next = normalized.storage[key];
    const current = sanitizeStorageValue(key, await AsyncStorage.getItem(key));
    if (current === next) {
      continue;
    }
    if (next === null) {
      await AsyncStorage.removeItem(key);
    } else {
      await AsyncStorage.setItem(key, next);
    }
    changedKeys.push(key);
  }
  await Promise.all(changedKeys.map((key) => Promise.resolve(KEY_EFFECTS[key]?.())));
  return normalized;
}

export function fingerprintSyncStorageSnapshot(snapshot: SyncStorageSnapshot): string {
  return JSON.stringify(
    SYNC_STORAGE_KEYS.map((key) => [key, snapshot.storage[key] ?? null] as const),
  );
}
