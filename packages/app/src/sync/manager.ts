import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  buildSyncEventsUrl,
  fetchSyncSalts,
  fetchSyncSnapshot,
  loginSyncUser,
  normalizeSyncEndpoint,
  putSyncSnapshot,
  registerSyncUser,
  type SyncConflictError,
} from "@/sync/api";
import {
  createSyncSalts,
  decryptSyncPayload,
  deriveSyncKeys,
  encryptSyncPayload,
  exportSyncDataKey,
  importSyncDataKey,
  type EncryptedSyncSnapshot,
} from "@/sync/crypto";
import { installSyncDebugPageMarkers, syncDebug } from "@/sync/debug";
import { describeSyncStorageDivergence, mergeSyncStorageSnapshots } from "@/sync/merge";
import {
  applySyncStorageSnapshot,
  fingerprintSyncStorageSnapshot,
  readSyncStorageSnapshot,
  type SyncStorageSnapshot,
} from "@/sync/storage-snapshot";
import { getOrCreateClientId } from "@/utils/client-id";

export type CloudSyncStatus =
  | "disabled"
  | "signed_out"
  | "authenticating"
  | "syncing"
  | "synced"
  | "error";

export interface CloudSyncState {
  endpoint: string;
  savedUsername: string | null;
  sessionUsername: string | null;
  status: CloudSyncStatus;
  lastError: string | null;
  lastSyncAt: number | null;
  remoteRevision: number;
  hasSession: boolean;
}

interface SyncConfig {
  endpoint: string;
  username: string | null;
}

interface CloudSyncSession {
  endpoint: string;
  username: string;
  token: string;
  deviceId: string;
  dataKey: CryptoKey;
  revision: number;
}

interface AuthInput {
  endpoint: string;
  username: string;
  password: string;
}

interface StoredCloudSyncSession {
  version: 1;
  endpoint: string;
  username: string;
  token: string;
  deviceId: string;
  dataKeyB64: string;
  revision: number;
  lastSyncAt: number | null;
}

const CONFIG_STORAGE_KEY = "@paseo:cloud-sync-config";
const SESSION_STORAGE_KEY = "@paseo:cloud-sync-session";
const POLL_INTERVAL_MS = 4_000;
const MAX_SYNC_MERGE_ATTEMPTS = 5;

function getCurrentOrigin(): string {
  if (typeof window !== "undefined" && typeof window.location?.origin === "string") {
    return window.location.origin;
  }
  if (typeof globalThis.location?.origin === "string") {
    return globalThis.location.origin;
  }
  if (typeof document !== "undefined" && typeof document.location?.origin === "string") {
    return document.location.origin;
  }
  return "";
}

export function getDefaultCloudSyncEndpoint(): string {
  const configured = normalizeSyncEndpoint(process.env.EXPO_PUBLIC_PASEO_SYNC_ENDPOINT ?? "");
  if (configured) {
    return configured;
  }
  return normalizeSyncEndpoint(getCurrentOrigin());
}

function normalizeUsername(value: string): string {
  return value.trim().toLowerCase();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isConflictError(error: unknown): error is SyncConflictError {
  return (
    error instanceof Error && "status" in error && (error as { status?: unknown }).status === 409
  );
}

function readConfig(value: string | null): SyncConfig {
  const fallbackEndpoint = getDefaultCloudSyncEndpoint();
  if (!value) {
    return { endpoint: fallbackEndpoint, username: null };
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object") {
      return { endpoint: fallbackEndpoint, username: null };
    }
    const record = parsed as { endpoint?: unknown; username?: unknown };
    const endpoint =
      typeof record.endpoint === "string" ? normalizeSyncEndpoint(record.endpoint) : "";
    return {
      endpoint: endpoint || fallbackEndpoint,
      username: typeof record.username === "string" ? normalizeUsername(record.username) : null,
    };
  } catch {
    return { endpoint: fallbackEndpoint, username: null };
  }
}

function readStoredSession(value: string | null): StoredCloudSyncSession | null {
  if (!value) {
    return null;
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object") {
      return null;
    }
    const record = parsed as {
      version?: unknown;
      endpoint?: unknown;
      username?: unknown;
      token?: unknown;
      deviceId?: unknown;
      dataKeyB64?: unknown;
      revision?: unknown;
      lastSyncAt?: unknown;
    };
    if (
      record.version !== 1 ||
      typeof record.endpoint !== "string" ||
      typeof record.username !== "string" ||
      typeof record.token !== "string" ||
      typeof record.deviceId !== "string" ||
      typeof record.dataKeyB64 !== "string" ||
      typeof record.revision !== "number"
    ) {
      return null;
    }
    const endpoint = normalizeSyncEndpoint(record.endpoint);
    const username = normalizeUsername(record.username);
    if (!endpoint || !username || !record.token || !record.deviceId || !record.dataKeyB64) {
      return null;
    }
    return {
      version: 1,
      endpoint,
      username,
      token: record.token,
      deviceId: record.deviceId,
      dataKeyB64: record.dataKeyB64,
      revision: record.revision,
      lastSyncAt: typeof record.lastSyncAt === "number" ? record.lastSyncAt : null,
    };
  } catch {
    return null;
  }
}

function isInvalidStoredSessionError(error: unknown): boolean {
  const message = errorMessage(error);
  return message === "Invalid bearer token" || message === "Missing bearer token";
}

class CloudSyncManager {
  private state: CloudSyncState = {
    endpoint: getDefaultCloudSyncEndpoint(),
    savedUsername: null,
    sessionUsername: null,
    status: getDefaultCloudSyncEndpoint() ? "signed_out" : "disabled",
    lastError: null,
    lastSyncAt: null,
    remoteRevision: 0,
    hasSession: false,
  };
  private listeners = new Set<() => void>();
  private session: CloudSyncSession | null = null;
  private pollHandle: ReturnType<typeof setInterval> | null = null;
  private websocket: WebSocket | null = null;
  private lastLocalFingerprint: string | null = null;
  private lastSyncedSnapshot: SyncStorageSnapshot | null = null;
  private applyingRemote = false;
  private bootPromise: Promise<void> | null = null;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): CloudSyncState => this.state;

  start(): void {
    if (!this.bootPromise) {
      this.bootPromise = this.loadConfig();
    }
  }

  stop(): void {
    this.stopBackgroundSync();
  }

  async setEndpoint(endpoint: string): Promise<void> {
    const normalized = normalizeSyncEndpoint(endpoint) || getDefaultCloudSyncEndpoint();
    let status = this.state.status;
    if (!this.session) {
      status = normalized ? "signed_out" : "disabled";
    }
    this.setState({
      endpoint: normalized,
      status,
      lastError: null,
    });
    await this.saveConfig({ endpoint: normalized, username: this.state.savedUsername });
  }

  async register(input: AuthInput): Promise<void> {
    await this.authenticate("register", input);
  }

  async login(input: AuthInput): Promise<void> {
    await this.authenticate("login", input);
  }

  logout(): void {
    this.session = null;
    this.lastLocalFingerprint = null;
    this.lastSyncedSnapshot = null;
    this.stopBackgroundSync();
    void this.clearStoredSession();
    this.setState({
      sessionUsername: null,
      hasSession: false,
      status: this.state.endpoint ? "signed_out" : "disabled",
      remoteRevision: 0,
      lastError: null,
    });
  }

  async syncNow(): Promise<void> {
    const session = this.requireSession();
    await this.pushLocalSnapshot(session, { force: true });
  }

  async pullNow(): Promise<void> {
    const session = this.requireSession();
    await this.pullRemoteSnapshot(session);
  }

  private async loadConfig(): Promise<void> {
    const [rawConfig, rawSession] = await Promise.all([
      AsyncStorage.getItem(CONFIG_STORAGE_KEY),
      AsyncStorage.getItem(SESSION_STORAGE_KEY),
    ]);
    const config = readConfig(rawConfig);
    this.setState({
      endpoint: config.endpoint,
      savedUsername: config.username,
      status: config.endpoint ? "signed_out" : "disabled",
    });

    const storedSession = readStoredSession(rawSession);
    if (storedSession) {
      await this.restoreStoredSession(storedSession);
    }
  }

  private async saveConfig(config: SyncConfig): Promise<void> {
    await AsyncStorage.setItem(CONFIG_STORAGE_KEY, JSON.stringify(config));
  }

  private async saveStoredSession(
    session: CloudSyncSession,
    lastSyncAt: number | null = this.state.lastSyncAt,
  ): Promise<void> {
    const stored: StoredCloudSyncSession = {
      version: 1,
      endpoint: session.endpoint,
      username: session.username,
      token: session.token,
      deviceId: session.deviceId,
      dataKeyB64: await exportSyncDataKey(session.dataKey),
      revision: session.revision,
      lastSyncAt,
    };
    await AsyncStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(stored));
  }

  private async clearStoredSession(): Promise<void> {
    await AsyncStorage.removeItem(SESSION_STORAGE_KEY);
  }

  private async restoreStoredSession(stored: StoredCloudSyncSession): Promise<void> {
    let sessionImported = false;
    try {
      const dataKey = await importSyncDataKey(stored.dataKeyB64);
      const session: CloudSyncSession = {
        endpoint: stored.endpoint,
        username: stored.username,
        token: stored.token,
        deviceId: stored.deviceId,
        dataKey,
        revision: stored.revision,
      };
      this.session = session;
      sessionImported = true;
      this.setState({
        endpoint: stored.endpoint,
        savedUsername: stored.username,
        sessionUsername: stored.username,
        hasSession: true,
        status: "syncing",
        lastError: null,
        lastSyncAt: stored.lastSyncAt,
        remoteRevision: stored.revision,
      });
      await this.saveConfig({ endpoint: stored.endpoint, username: stored.username });
      await this.pullRemoteSnapshot(session);
      this.startBackgroundSync();
    } catch (error) {
      console.warn("[CloudSync] Stored session could not be restored", error);
      if (!sessionImported || isInvalidStoredSessionError(error)) {
        this.session = null;
        this.lastLocalFingerprint = null;
        this.lastSyncedSnapshot = null;
        await this.clearStoredSession();
        this.setState({
          sessionUsername: null,
          hasSession: false,
          status: stored.endpoint ? "signed_out" : "disabled",
          remoteRevision: 0,
          lastError: null,
        });
        return;
      }
      if (this.session) {
        this.startBackgroundSync();
      }
    }
  }

  private requireSession(): CloudSyncSession {
    if (!this.session) {
      throw new Error("Sign in before syncing.");
    }
    return this.session;
  }

  private async authenticate(mode: "register" | "login", input: AuthInput): Promise<void> {
    const endpoint = normalizeSyncEndpoint(input.endpoint) || getDefaultCloudSyncEndpoint();
    const username = normalizeUsername(input.username);
    if (!endpoint) {
      this.setState({ status: "error", lastError: "Sync endpoint is required." });
      return;
    }
    if (!username) {
      this.setState({ status: "error", lastError: "Username is required." });
      return;
    }
    if (!input.password) {
      this.setState({ status: "error", lastError: "Password is required." });
      return;
    }

    this.stopBackgroundSync();
    this.setState({ status: "authenticating", lastError: null });

    try {
      const deviceId = await getOrCreateClientId();
      const salts =
        mode === "register"
          ? createSyncSalts()
          : await fetchSyncSalts({
              endpoint,
              username,
            });
      const keys = await deriveSyncKeys({
        password: input.password,
        authSaltB64: salts.authSaltB64,
        dataSaltB64: salts.dataSaltB64,
      });

      if (mode === "register") {
        const localSnapshot = await readSyncStorageSnapshot(deviceId);
        const encryptedSnapshot = await encryptSyncPayload(keys.dataKey, localSnapshot);
        const response = await registerSyncUser({
          endpoint,
          username,
          authSaltB64: salts.authSaltB64,
          dataSaltB64: salts.dataSaltB64,
          authVerifierB64: keys.authVerifierB64,
          deviceId,
          snapshot: encryptedSnapshot,
        });
        this.session = {
          endpoint,
          username: response.username,
          token: response.token,
          deviceId,
          dataKey: keys.dataKey,
          revision: response.revision,
        };
        this.lastSyncedSnapshot = localSnapshot;
        this.lastLocalFingerprint = fingerprintSyncStorageSnapshot(localSnapshot);
      } else {
        const response = await loginSyncUser({
          endpoint,
          username,
          authVerifierB64: keys.authVerifierB64,
          deviceId,
        });
        this.session = {
          endpoint,
          username: response.username,
          token: response.token,
          deviceId,
          dataKey: keys.dataKey,
          revision: response.revision,
        };

        if (response.snapshot) {
          try {
            await this.applyEncryptedSnapshot(keys.dataKey, response.snapshot);
            const applied = await readSyncStorageSnapshot(deviceId);
            this.lastSyncedSnapshot = applied;
            this.lastLocalFingerprint = fingerprintSyncStorageSnapshot(applied);
          } catch (error) {
            console.warn("[CloudSync] Remote snapshot could not be decrypted; replacing it", error);
            await this.pushLocalSnapshot(this.session, { force: true });
          }
        } else {
          await this.pushLocalSnapshot(this.session, { force: true });
        }
      }

      await this.saveConfig({ endpoint, username });
      const lastSyncAt = Date.now();
      await this.saveStoredSession(this.session, lastSyncAt);
      this.setState({
        endpoint,
        savedUsername: username,
        sessionUsername: username,
        hasSession: true,
        status: "synced",
        lastError: null,
        lastSyncAt,
        remoteRevision: this.session.revision,
      });
      this.startBackgroundSync();
    } catch (error) {
      this.session = null;
      this.lastLocalFingerprint = null;
      this.lastSyncedSnapshot = null;
      await this.clearStoredSession();
      this.setState({
        status: "error",
        hasSession: false,
        sessionUsername: null,
        lastError: errorMessage(error),
      });
    }
  }

  private async applyEncryptedSnapshot(
    dataKey: CryptoKey,
    encryptedSnapshot: EncryptedSyncSnapshot,
  ): Promise<SyncStorageSnapshot> {
    this.applyingRemote = true;
    try {
      const plaintext = await decryptSyncPayload<SyncStorageSnapshot>(dataKey, encryptedSnapshot);
      return await applySyncStorageSnapshot(plaintext);
    } finally {
      this.applyingRemote = false;
    }
  }

  private startBackgroundSync(): void {
    this.stopBackgroundSync();
    this.pollHandle = setInterval(() => {
      void this.syncIfLocalChanged();
    }, POLL_INTERVAL_MS);
    this.connectEvents();
  }

  private stopBackgroundSync(): void {
    if (this.pollHandle) {
      clearInterval(this.pollHandle);
      this.pollHandle = null;
    }
    if (this.websocket) {
      this.websocket.close();
      this.websocket = null;
    }
  }

  private connectEvents(): void {
    const session = this.session;
    if (!session || typeof WebSocket === "undefined") {
      return;
    }
    try {
      const ws = new WebSocket(buildSyncEventsUrl(session.endpoint, session.token));
      this.websocket = ws;
      ws.addEventListener("message", (event) => {
        this.handleEventMessage(event.data);
      });
      ws.addEventListener("close", () => {
        if (this.websocket !== ws || !this.session) {
          return;
        }
        this.websocket = null;
        setTimeout(() => this.connectEvents(), 2_000);
      });
    } catch (error) {
      console.warn("[CloudSync] Failed to connect events socket", error);
    }
  }

  private handleEventMessage(data: unknown): void {
    if (typeof data !== "string") {
      return;
    }
    try {
      const parsed = JSON.parse(data) as {
        type?: unknown;
        revision?: unknown;
        deviceId?: unknown;
      };
      const session = this.session;
      if (
        parsed.type === "snapshot_updated" &&
        typeof parsed.revision === "number" &&
        session &&
        parsed.deviceId !== session.deviceId &&
        parsed.revision > session.revision
      ) {
        void this.reconcileFromRemote(session);
      }
    } catch {
      // Ignore non-JSON keepalive frames.
    }
  }

  private async syncIfLocalChanged(): Promise<void> {
    const session = this.session;
    if (
      !session ||
      this.applyingRemote ||
      this.state.status === "authenticating" ||
      this.state.status === "syncing"
    ) {
      return;
    }
    try {
      const snapshot = await readSyncStorageSnapshot(session.deviceId);
      const fingerprint = fingerprintSyncStorageSnapshot(snapshot);
      if (fingerprint === this.lastLocalFingerprint) {
        return;
      }
      await this.pushLocalSnapshot(session, { force: true, precomputedSnapshot: snapshot });
    } catch (error) {
      console.warn("[CloudSync] Background sync failed", error);
      this.setState({ status: "error", lastError: errorMessage(error) });
    }
  }

  private async pushLocalSnapshot(
    session: CloudSyncSession,
    input: {
      force?: boolean;
      precomputedSnapshot?: SyncStorageSnapshot;
    } = {},
  ): Promise<void> {
    const initial = input.precomputedSnapshot ?? (await readSyncStorageSnapshot(session.deviceId));
    if (!input.force && fingerprintSyncStorageSnapshot(initial) === this.lastLocalFingerprint) {
      return;
    }

    this.setState({ status: "syncing", lastError: null });
    try {
      let snapshot = initial;
      for (let attempt = 0; ; attempt += 1) {
        const encrypted = await encryptSyncPayload(session.dataKey, snapshot);
        try {
          const response = await putSyncSnapshot({
            endpoint: session.endpoint,
            token: session.token,
            baseRevision: session.revision,
            deviceId: session.deviceId,
            snapshot: encrypted,
          });
          session.revision = response.revision;
          this.lastSyncedSnapshot = snapshot;
          this.lastLocalFingerprint = fingerprintSyncStorageSnapshot(snapshot);
          const lastSyncAt = Date.now();
          await this.saveStoredSession(session, lastSyncAt);
          this.setState({
            status: "synced",
            lastError: null,
            lastSyncAt,
            remoteRevision: response.revision,
          });
          return;
        } catch (error) {
          if (!isConflictError(error) || attempt >= MAX_SYNC_MERGE_ATTEMPTS) {
            throw error;
          }
          snapshot = await this.mergeRemoteConflict(session, error, snapshot);
        }
      }
    } catch (error) {
      this.setState({ status: "error", lastError: errorMessage(error) });
      throw error;
    }
  }

  // Resolve a revision conflict by merging the remote snapshot into the local one
  // (adopt a key only the remote changed; otherwise keep local) and retrying the
  // push — instead of overwriting in-flight local work with the server copy.
  private async mergeRemoteConflict(
    session: CloudSyncSession,
    conflict: SyncConflictError,
    local: SyncStorageSnapshot,
  ): Promise<SyncStorageSnapshot> {
    session.revision = conflict.revision;
    const remote = conflict.snapshot
      ? await decryptSyncPayload<SyncStorageSnapshot>(session.dataKey, conflict.snapshot)
      : null;
    if (!remote) {
      return local;
    }
    syncDebug("push-conflict", {
      revision: conflict.revision,
      keys: describeSyncStorageDivergence(this.lastSyncedSnapshot, local, remote),
    });
    const merged = mergeSyncStorageSnapshots(this.lastSyncedSnapshot, local, remote);
    this.lastSyncedSnapshot = remote;
    // Only touch storage / rehydrate the app when the merge brings in remote-only
    // changes. In the common same-key conflict (local-wins) merged === local, so
    // just re-push without resetting the UI (which reloads the host runtime and
    // bounces the user to the welcome screen).
    if (fingerprintSyncStorageSnapshot(merged) === fingerprintSyncStorageSnapshot(local)) {
      return merged;
    }
    await this.applyLocalSnapshot(merged);
    return await readSyncStorageSnapshot(session.deviceId);
  }

  private async applyLocalSnapshot(snapshot: SyncStorageSnapshot): Promise<void> {
    syncDebug("apply-snapshot");
    this.applyingRemote = true;
    try {
      await applySyncStorageSnapshot(snapshot);
    } finally {
      this.applyingRemote = false;
    }
  }

  // Keepalive-driven reconcile: another device advanced the revision. Merge the
  // remote snapshot into local (local-wins) instead of overwriting, and rehydrate
  // only when the merge changes local state — otherwise the UI would reset (host
  // runtime reload -> welcome screen) on every remote write.
  private async reconcileFromRemote(session: CloudSyncSession): Promise<void> {
    if (this.applyingRemote || this.state.status === "syncing") {
      return;
    }
    this.setState({ status: "syncing", lastError: null });
    try {
      const response = await fetchSyncSnapshot({
        endpoint: session.endpoint,
        token: session.token,
      });
      session.revision = response.revision;
      if (response.snapshot) {
        const remote = await decryptSyncPayload<SyncStorageSnapshot>(
          session.dataKey,
          response.snapshot,
        );
        const local = await readSyncStorageSnapshot(session.deviceId);
        const base = this.lastSyncedSnapshot;
        const merged = mergeSyncStorageSnapshots(base, local, remote);
        this.lastSyncedSnapshot = remote;
        const willApply =
          fingerprintSyncStorageSnapshot(merged) !== fingerprintSyncStorageSnapshot(local);
        syncDebug("keepalive-reconcile", {
          revision: response.revision,
          keys: describeSyncStorageDivergence(base, local, remote),
          willApply,
        });
        if (willApply) {
          await this.applyLocalSnapshot(merged);
        }
        // Match the fingerprint to the merged local state so a keepalive never
        // triggers a push on its own. Otherwise two sessions with divergent
        // values for one key (e.g. per-tab drafts) ping-pong forever. Real local
        // edits still change the fingerprint and push, converging on next edit.
        this.lastLocalFingerprint = fingerprintSyncStorageSnapshot(merged);
      } else {
        const applied = await readSyncStorageSnapshot(session.deviceId);
        this.lastSyncedSnapshot = applied;
        this.lastLocalFingerprint = fingerprintSyncStorageSnapshot(applied);
      }
      const lastSyncAt = Date.now();
      await this.saveStoredSession(session, lastSyncAt);
      this.setState({
        status: "synced",
        lastError: null,
        lastSyncAt,
        remoteRevision: session.revision,
      });
    } catch (error) {
      this.setState({ status: "error", lastError: errorMessage(error) });
    }
  }

  private async pullRemoteSnapshot(session: CloudSyncSession): Promise<void> {
    this.setState({ status: "syncing", lastError: null });
    try {
      const response = await fetchSyncSnapshot({
        endpoint: session.endpoint,
        token: session.token,
      });
      session.revision = response.revision;
      if (response.snapshot) {
        await this.applyEncryptedSnapshot(session.dataKey, response.snapshot);
      }
      const applied = await readSyncStorageSnapshot(session.deviceId);
      this.lastSyncedSnapshot = applied;
      this.lastLocalFingerprint = fingerprintSyncStorageSnapshot(applied);
      const lastSyncAt = Date.now();
      await this.saveStoredSession(session, lastSyncAt);
      this.setState({
        status: "synced",
        lastError: null,
        lastSyncAt,
        remoteRevision: response.revision,
      });
    } catch (error) {
      this.setState({ status: "error", lastError: errorMessage(error) });
      throw error;
    }
  }

  private setState(patch: Partial<CloudSyncState>): void {
    this.state = {
      ...this.state,
      ...patch,
    };
    for (const listener of this.listeners) {
      listener();
    }
  }
}

const cloudSyncManager = new CloudSyncManager();
installSyncDebugPageMarkers();

export function getCloudSyncManager(): CloudSyncManager {
  return cloudSyncManager;
}
