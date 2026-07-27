export interface SyncStorageSnapshot {
  version: 1;
  deviceId: string;
  exportedAt: number;
  storage: Record<string, string | null>;
}

// Three-way per-key merge of two snapshots against their last-synced ancestor.
// A key is taken from remote only when remote changed it and local did not;
// otherwise local wins (so a device never loses its own in-flight work, and
// same-key concurrent edits resolve last-writer = local). With no known base,
// local always wins.
export function mergeSyncStorageSnapshots(
  base: SyncStorageSnapshot | null,
  local: SyncStorageSnapshot,
  remote: SyncStorageSnapshot,
): SyncStorageSnapshot {
  const storage: Record<string, string | null> = {};
  const keys = new Set<string>([...Object.keys(local.storage), ...Object.keys(remote.storage)]);
  for (const key of keys) {
    const localValue = local.storage[key] ?? null;
    const remoteValue = remote.storage[key] ?? null;
    if (localValue === remoteValue) {
      storage[key] = localValue;
      continue;
    }
    const baseValue =
      base && Object.prototype.hasOwnProperty.call(base.storage, key)
        ? (base.storage[key] ?? null)
        : undefined;
    const remoteOnly =
      baseValue !== undefined && localValue === baseValue && remoteValue !== baseValue;
    storage[key] = remoteOnly ? remoteValue : localValue;
  }
  return {
    version: 1,
    deviceId: local.deviceId,
    exportedAt: Date.now(),
    storage,
  };
}
