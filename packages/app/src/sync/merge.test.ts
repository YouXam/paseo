import { describe, expect, it } from "vitest";
import { mergeSyncStorageSnapshots, type SyncStorageSnapshot } from "@/sync/merge";

const KEY = "workspace-layout-state";
const OTHER = "paseo-drafts";

function snap(storage: Record<string, string | null>): SyncStorageSnapshot {
  return { version: 1, deviceId: "device", exportedAt: 0, storage };
}

describe("mergeSyncStorageSnapshots", () => {
  it("adopts a key only the remote changed", () => {
    const merged = mergeSyncStorageSnapshots(
      snap({ [KEY]: "base" }),
      snap({ [KEY]: "base" }),
      snap({ [KEY]: "remote" }),
    );
    expect(merged.storage[KEY]).toBe("remote");
  });

  it("keeps a key only the local changed", () => {
    const merged = mergeSyncStorageSnapshots(
      snap({ [KEY]: "base" }),
      snap({ [KEY]: "local" }),
      snap({ [KEY]: "base" }),
    );
    expect(merged.storage[KEY]).toBe("local");
  });

  it("keeps local when both changed the same key (local-wins)", () => {
    const merged = mergeSyncStorageSnapshots(
      snap({ [KEY]: "base" }),
      snap({ [KEY]: "local" }),
      snap({ [KEY]: "remote" }),
    );
    expect(merged.storage[KEY]).toBe("local");
  });

  it("keeps local when there is no base", () => {
    expect(
      mergeSyncStorageSnapshots(null, snap({ [KEY]: "local" }), snap({ [KEY]: "remote" })).storage[
        KEY
      ],
    ).toBe("local");
    // a remote-only change is also dropped without a base (local preserved)
    expect(
      mergeSyncStorageSnapshots(null, snap({ [KEY]: "base" }), snap({ [KEY]: "remote" })).storage[
        KEY
      ],
    ).toBe("base");
  });

  it("preserves each side's change to different keys", () => {
    const merged = mergeSyncStorageSnapshots(
      snap({ [KEY]: "base", [OTHER]: "base" }),
      snap({ [KEY]: "local", [OTHER]: "base" }),
      snap({ [KEY]: "base", [OTHER]: "remote" }),
    );
    expect(merged.storage[KEY]).toBe("local");
    expect(merged.storage[OTHER]).toBe("remote");
  });

  it("takes the shared value when local and remote agree", () => {
    const merged = mergeSyncStorageSnapshots(
      snap({ [KEY]: "base" }),
      snap({ [KEY]: "same" }),
      snap({ [KEY]: "same" }),
    );
    expect(merged.storage[KEY]).toBe("same");
  });
});
