import { useEffect, useSyncExternalStore } from "react";
import { getCloudSyncManager } from "@/sync/manager";

export function CloudSyncProvider() {
  useEffect(() => {
    const manager = getCloudSyncManager();
    manager.start();
    return () => {
      manager.stop();
    };
  }, []);

  return null;
}

export function useCloudSyncState() {
  const manager = getCloudSyncManager();
  return useSyncExternalStore(manager.subscribe, manager.getSnapshot, manager.getSnapshot);
}
