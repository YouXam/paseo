import type { EncryptedSyncSnapshot } from "@/sync/crypto";

export interface SyncSaltsResponse {
  username: string;
  authSaltB64: string;
  dataSaltB64: string;
}

export interface SyncAuthResponse {
  username: string;
  token: string;
  authSaltB64?: string;
  dataSaltB64?: string;
  revision: number;
  snapshot: EncryptedSyncSnapshot | null;
  updatedAt?: number | null;
}

export interface SyncSnapshotResponse {
  revision: number;
  snapshot: EncryptedSyncSnapshot | null;
  updatedAt: number | null;
  updatedByDeviceId: string | null;
}

export interface SyncConflictError extends Error {
  status: 409;
  revision: number;
  snapshot: EncryptedSyncSnapshot | null;
}

export function normalizeSyncEndpoint(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }
  return trimmed.replace(/\/+$/, "");
}

async function parseJsonResponse(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) {
    return null;
  }
  return JSON.parse(text) as unknown;
}

function errorMessageFromBody(body: unknown, fallback: string): string {
  if (body && typeof body === "object" && "error" in body) {
    const message = (body as { error?: unknown }).error;
    if (typeof message === "string" && message.trim()) {
      return message;
    }
  }
  return fallback;
}

function createConflictError(body: unknown): SyncConflictError | null {
  if (!body || typeof body !== "object") {
    return null;
  }
  const record = body as {
    revision?: unknown;
    snapshot?: unknown;
    error?: unknown;
  };
  if (typeof record.revision !== "number") {
    return null;
  }
  const error = new Error(errorMessageFromBody(body, "Revision conflict")) as SyncConflictError;
  error.status = 409;
  error.revision = record.revision;
  error.snapshot = (record.snapshot ?? null) as EncryptedSyncSnapshot | null;
  return error;
}

async function requestJson<T>(endpoint: string, path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${endpoint}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...init?.headers,
    },
  });
  const body = await parseJsonResponse(response);
  if (!response.ok) {
    if (response.status === 409) {
      const conflict = createConflictError(body);
      if (conflict) {
        throw conflict;
      }
    }
    throw new Error(errorMessageFromBody(body, `Sync request failed (${response.status})`));
  }
  return body as T;
}

export async function fetchSyncSalts(input: {
  endpoint: string;
  username: string;
}): Promise<SyncSaltsResponse> {
  return await requestJson<SyncSaltsResponse>(
    input.endpoint,
    `/api/users/${encodeURIComponent(input.username)}/salts`,
  );
}

export async function registerSyncUser(input: {
  endpoint: string;
  username: string;
  authSaltB64: string;
  dataSaltB64: string;
  authVerifierB64: string;
  deviceId: string;
  snapshot: EncryptedSyncSnapshot;
}): Promise<SyncAuthResponse> {
  return await requestJson<SyncAuthResponse>(input.endpoint, "/api/register", {
    method: "POST",
    body: JSON.stringify({
      username: input.username,
      authSaltB64: input.authSaltB64,
      dataSaltB64: input.dataSaltB64,
      authVerifierB64: input.authVerifierB64,
      deviceId: input.deviceId,
      snapshot: input.snapshot,
    }),
  });
}

export async function loginSyncUser(input: {
  endpoint: string;
  username: string;
  authVerifierB64: string;
  deviceId: string;
}): Promise<SyncAuthResponse> {
  return await requestJson<SyncAuthResponse>(input.endpoint, "/api/login", {
    method: "POST",
    body: JSON.stringify({
      username: input.username,
      authVerifierB64: input.authVerifierB64,
      deviceId: input.deviceId,
    }),
  });
}

export async function fetchSyncSnapshot(input: {
  endpoint: string;
  token: string;
}): Promise<SyncSnapshotResponse> {
  return await requestJson<SyncSnapshotResponse>(input.endpoint, "/api/snapshot", {
    headers: { Authorization: `Bearer ${input.token}` },
  });
}

export async function putSyncSnapshot(input: {
  endpoint: string;
  token: string;
  baseRevision: number;
  deviceId: string;
  snapshot: EncryptedSyncSnapshot;
}): Promise<SyncSnapshotResponse> {
  return await requestJson<SyncSnapshotResponse>(input.endpoint, "/api/snapshot", {
    method: "PUT",
    headers: { Authorization: `Bearer ${input.token}` },
    body: JSON.stringify({
      baseRevision: input.baseRevision,
      deviceId: input.deviceId,
      snapshot: input.snapshot,
    }),
  });
}

export function buildSyncEventsUrl(endpoint: string, token: string): string {
  const url = new URL(endpoint);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/api/events";
  url.search = `?token=${encodeURIComponent(token)}`;
  return url.toString();
}
