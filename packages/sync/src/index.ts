type JsonObject = Record<string, unknown>;

interface WebSocketPair {
  0: WebSocket;
  1: WebSocket;
}

interface CFResponseInit extends ResponseInit {
  webSocket?: WebSocket;
}

interface Env {
  USER_SYNC: DurableObjectNamespace;
  ALLOWED_ORIGINS?: string;
  SESSION_TTL_SECONDS?: string;
}

interface DurableObjectNamespace {
  idFromName(name: string): DurableObjectId;
  get(id: DurableObjectId): DurableObjectStub;
}

interface DurableObjectId {
  toString(): string;
}

interface DurableObjectStub {
  fetch(request: Request): Promise<Response>;
}

interface DurableObjectState {
  acceptWebSocket(ws: WebSocket, tags?: string[]): void;
  getWebSockets(tag?: string): WebSocket[];
  storage: DurableObjectStorage;
}

interface DurableObjectStorage {
  sql: DurableObjectSqlStorage;
}

interface DurableObjectSqlStorage {
  exec<T = unknown>(query: string, ...bindings: unknown[]): DurableObjectSqlResult<T>;
}

interface DurableObjectSqlResult<T> {
  one(): T;
  toArray(): T[];
}

interface WebSocketWithAttachment extends WebSocket {
  serializeAttachment(value: unknown): void;
  deserializeAttachment(): unknown;
}

interface AccountRow {
  username: string;
  auth_salt_b64: string;
  data_salt_b64: string;
  auth_verifier_hash_b64: string;
  created_at: number;
  updated_at: number;
}

interface SnapshotRow {
  revision: number;
  snapshot_json: string;
  updated_at: number;
  updated_by_device_id: string | null;
}

interface SessionRow {
  token_hash_b64: string;
  device_id: string | null;
  expires_at: number;
}

interface RegisterRequest {
  username: string;
  authSaltB64: string;
  dataSaltB64: string;
  authVerifierB64: string;
  deviceId?: string;
  snapshot?: unknown;
}

interface LoginRequest {
  username: string;
  authVerifierB64: string;
  deviceId?: string;
}

interface PutSnapshotRequest {
  baseRevision: number;
  snapshot: unknown;
  deviceId?: string;
}

const USERNAME_PATTERN = /^[a-z0-9][a-z0-9_.-]{2,62}$/;
const DEFAULT_SESSION_TTL_SECONDS = 60 * 60 * 24 * 30;
const MAX_JSON_BODY_BYTES = 1024 * 1024;

function normalizeUsername(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const username = value.trim().toLowerCase();
  return USERNAME_PATTERN.test(username) ? username : null;
}

function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(record: JsonObject, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function readOptionalString(record: JsonObject, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function readNumber(record: JsonObject, key: string): number | null {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function json(data: unknown, status = 200, headers?: HeadersInit): Response {
  return Response.json(data, { status, headers });
}

function errorJson(message: string, status: number): Response {
  return json({ error: message }, status);
}

function getGlobalWebSocketPair(): (new () => WebSocketPair) | undefined {
  const WebSocketPairCtor = Reflect.get(globalThis, "WebSocketPair") as unknown;
  return typeof WebSocketPairCtor === "function"
    ? (WebSocketPairCtor as new () => WebSocketPair)
    : undefined;
}

function getBearerToken(request: Request): string | null {
  const header = request.headers.get("Authorization") ?? "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || null;
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    const chunk = bytes.subarray(index, index + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlDecode(value: string): Uint8Array | null {
  try {
    const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  } catch {
    return null;
  }
}

function randomToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

async function sha256Base64Url(value: string): Promise<string> {
  const data = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return base64UrlEncode(new Uint8Array(digest));
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBytes = new TextEncoder().encode(left);
  const rightBytes = new TextEncoder().encode(right);
  let diff = leftBytes.length ^ rightBytes.length;
  const length = Math.max(leftBytes.length, rightBytes.length);
  for (let index = 0; index < length; index += 1) {
    diff |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }
  return diff === 0;
}

function parseTokenUsername(token: string): string | null {
  const decoded = base64UrlDecode(token);
  if (!decoded) return null;
  try {
    const raw = new TextDecoder().decode(decoded);
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) return null;
    return normalizeUsername(parsed.username);
  } catch {
    return null;
  }
}

function createToken(username: string, secret: string): string {
  const raw = JSON.stringify({ username, secret });
  return base64UrlEncode(new TextEncoder().encode(raw));
}

function parseTokenSecret(token: string): string | null {
  const decoded = base64UrlDecode(token);
  if (!decoded) return null;
  try {
    const raw = new TextDecoder().decode(decoded);
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) return null;
    return readString(parsed, "secret");
  } catch {
    return null;
  }
}

async function readJsonBody(request: Request): Promise<unknown> {
  const contentLength = Number(request.headers.get("Content-Length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > MAX_JSON_BODY_BYTES) {
    throw new Error("Request body too large");
  }
  return await request.json();
}

function corsHeaders(request: Request, env: Env): HeadersInit {
  const requestOrigin = request.headers.get("Origin");
  const allowed = (env.ALLOWED_ORIGINS ?? "*")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  let allowOrigin = allowed[0] ?? "*";
  if (allowed.includes("*") || !requestOrigin) {
    allowOrigin = "*";
  } else if (allowed.includes(requestOrigin)) {
    allowOrigin = requestOrigin;
  }

  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
  };
}

function withCors(response: Response, request: Request, env: Env): Response {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(corsHeaders(request, env))) {
    headers.set(key, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function routeUserStub(env: Env, username: string): DurableObjectStub {
  return env.USER_SYNC.get(env.USER_SYNC.idFromName(username));
}

function createUserDoRequest(request: Request, path: string): Request {
  const url = new URL(request.url);
  url.pathname = path;
  url.search = new URL(request.url).search;
  return new Request(url.toString(), request);
}

function createJsonForwardRequest(request: Request, raw: unknown): Request {
  const headers = new Headers(request.headers);
  headers.set("Content-Type", "application/json");
  headers.delete("Content-Length");
  return new Request(request.url, {
    method: request.method,
    headers,
    body: JSON.stringify(raw),
  });
}

async function forwardToUserDo(
  request: Request,
  env: Env,
  username: string,
  path: string,
): Promise<Response> {
  return await routeUserStub(env, username).fetch(createUserDoRequest(request, path));
}

function readSaltsUsername(pathname: string): string | null {
  if (!pathname.startsWith("/api/users/") || !pathname.endsWith("/salts")) {
    return null;
  }
  const parts = pathname.split("/");
  return normalizeUsername(decodeURIComponent(parts[3] ?? ""));
}

async function forwardJsonBodyByUsername(
  request: Request,
  env: Env,
  path: string,
): Promise<Response> {
  const raw = await readJsonBody(request.clone());
  const username = isRecord(raw) ? normalizeUsername(raw.username) : null;
  if (!username) {
    return errorJson("Invalid username", 400);
  }
  return await forwardToUserDo(createJsonForwardRequest(request, raw), env, username, path);
}

async function forwardByBearerToken(
  request: Request,
  env: Env,
  path: string,
  token: string | null,
): Promise<Response> {
  const username = token ? parseTokenUsername(token) : null;
  if (!username) {
    return errorJson("Invalid bearer token", 401);
  }
  return await forwardToUserDo(request, env, username, path);
}

async function routeSyncRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === "/health") {
    return json({ status: "ok" });
  }

  const saltsUsername = readSaltsUsername(url.pathname);
  if (saltsUsername) {
    return await forwardToUserDo(request, env, saltsUsername, "/salts");
  }

  if (url.pathname === "/api/register" && request.method === "POST") {
    return await forwardJsonBodyByUsername(request, env, "/register");
  }

  if (url.pathname === "/api/login" && request.method === "POST") {
    return await forwardJsonBodyByUsername(request, env, "/login");
  }

  if (url.pathname === "/api/snapshot") {
    return await forwardByBearerToken(request, env, "/snapshot", getBearerToken(request));
  }

  if (url.pathname === "/api/events") {
    const token = url.searchParams.get("token")?.trim() ?? null;
    return await forwardByBearerToken(request, env, "/events", token);
  }

  return errorJson("Not found", 404);
}

export class UserSyncDurableObject {
  private state: DurableObjectState;

  constructor(state: DurableObjectState) {
    this.state = state;
    this.migrate();
  }

  private migrate(): void {
    this.state.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS account (
        username TEXT PRIMARY KEY,
        auth_salt_b64 TEXT NOT NULL,
        data_salt_b64 TEXT NOT NULL,
        auth_verifier_hash_b64 TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS snapshot (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        revision INTEGER NOT NULL,
        snapshot_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        updated_by_device_id TEXT
      );
      CREATE TABLE IF NOT EXISTS sessions (
        token_hash_b64 TEXT PRIMARY KEY,
        device_id TEXT,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);
    `);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (url.pathname === "/salts" && request.method === "GET") {
        return this.handleSalts();
      }
      if (url.pathname === "/register" && request.method === "POST") {
        return await this.handleRegister(request);
      }
      if (url.pathname === "/login" && request.method === "POST") {
        return await this.handleLogin(request);
      }
      if (url.pathname === "/snapshot" && request.method === "GET") {
        return await this.handleGetSnapshot(request);
      }
      if (url.pathname === "/snapshot" && request.method === "PUT") {
        return await this.handlePutSnapshot(request);
      }
      if (url.pathname === "/events" && request.method === "GET") {
        return await this.handleEvents(request);
      }
      return errorJson("Not found", 404);
    } catch (error) {
      console.error("[UserSyncDO] request failed", error);
      return errorJson("Internal server error", 500);
    }
  }

  private getAccount(): AccountRow | null {
    const rows = this.state.storage.sql.exec<AccountRow>("SELECT * FROM account LIMIT 1").toArray();
    return rows[0] ?? null;
  }

  private getSnapshot(): SnapshotRow | null {
    const rows = this.state.storage.sql
      .exec<SnapshotRow>(
        "SELECT revision, snapshot_json, updated_at, updated_by_device_id FROM snapshot WHERE id = 1",
      )
      .toArray();
    return rows[0] ?? null;
  }

  private async requireSession(request: Request): Promise<SessionRow | Response> {
    const token = getBearerToken(request);
    if (!token) {
      return errorJson("Missing bearer token", 401);
    }
    return await this.validateToken(token);
  }

  private async validateToken(token: string): Promise<SessionRow | Response> {
    const secret = parseTokenSecret(token);
    if (!secret) {
      return errorJson("Invalid bearer token", 401);
    }
    const tokenHash = await sha256Base64Url(secret);
    const now = Date.now();
    const rows = this.state.storage.sql
      .exec<SessionRow>(
        "SELECT token_hash_b64, device_id, expires_at FROM sessions WHERE token_hash_b64 = ? LIMIT 1",
        tokenHash,
      )
      .toArray();
    const session = rows[0] ?? null;
    if (!session || session.expires_at <= now) {
      return errorJson("Invalid bearer token", 401);
    }
    return session;
  }

  private handleSalts(): Response {
    const account = this.getAccount();
    if (!account) {
      return errorJson("User not found", 404);
    }
    return json({
      username: account.username,
      authSaltB64: account.auth_salt_b64,
      dataSaltB64: account.data_salt_b64,
    });
  }

  private async handleRegister(request: Request): Promise<Response> {
    const raw = await readJsonBody(request);
    if (!isRecord(raw)) {
      return errorJson("Invalid JSON body", 400);
    }
    const input: RegisterRequest = {
      username: String(raw.username ?? ""),
      authSaltB64: String(raw.authSaltB64 ?? ""),
      dataSaltB64: String(raw.dataSaltB64 ?? ""),
      authVerifierB64: String(raw.authVerifierB64 ?? ""),
      deviceId: readOptionalString(raw, "deviceId"),
      snapshot: raw.snapshot,
    };
    const username = normalizeUsername(input.username);
    if (!username) {
      return errorJson("Invalid username", 400);
    }
    if (!input.authSaltB64 || !input.dataSaltB64 || !input.authVerifierB64) {
      return errorJson("Missing registration fields", 400);
    }
    if (this.getAccount()) {
      return errorJson("User already exists", 409);
    }

    const now = Date.now();
    const verifierHash = await sha256Base64Url(input.authVerifierB64);
    const snapshotJson = input.snapshot === undefined ? null : JSON.stringify(input.snapshot);
    this.state.storage.sql.exec(
      "INSERT INTO account (username, auth_salt_b64, data_salt_b64, auth_verifier_hash_b64, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      username,
      input.authSaltB64,
      input.dataSaltB64,
      verifierHash,
      now,
      now,
    );
    if (snapshotJson) {
      this.state.storage.sql.exec(
        "INSERT INTO snapshot (id, revision, snapshot_json, updated_at, updated_by_device_id) VALUES (1, 1, ?, ?, ?)",
        snapshotJson,
        now,
        input.deviceId ?? null,
      );
    }

    const auth = await this.createSession(username, input.deviceId);
    return json({
      username,
      token: auth.token,
      revision: snapshotJson ? 1 : 0,
      snapshot: input.snapshot ?? null,
    });
  }

  private async handleLogin(request: Request): Promise<Response> {
    const raw = await readJsonBody(request);
    if (!isRecord(raw)) {
      return errorJson("Invalid JSON body", 400);
    }
    const input: LoginRequest = {
      username: String(raw.username ?? ""),
      authVerifierB64: String(raw.authVerifierB64 ?? ""),
      deviceId: readOptionalString(raw, "deviceId"),
    };
    const username = normalizeUsername(input.username);
    const account = this.getAccount();
    if (!username || !account || account.username !== username) {
      return errorJson("User not found", 404);
    }
    if (!input.authVerifierB64) {
      return errorJson("Missing auth verifier", 400);
    }
    const verifierHash = await sha256Base64Url(input.authVerifierB64);
    if (!constantTimeEqual(verifierHash, account.auth_verifier_hash_b64)) {
      return errorJson("Invalid username or password", 401);
    }

    const session = await this.createSession(username, input.deviceId);
    const snapshot = this.getSnapshot();
    return json({
      username,
      token: session.token,
      authSaltB64: account.auth_salt_b64,
      dataSaltB64: account.data_salt_b64,
      revision: snapshot?.revision ?? 0,
      snapshot: snapshot ? JSON.parse(snapshot.snapshot_json) : null,
      updatedAt: snapshot?.updated_at ?? null,
    });
  }

  private async createSession(
    username: string,
    deviceId: string | undefined,
  ): Promise<{
    token: string;
    tokenHash: string;
  }> {
    const secret = randomToken();
    const token = createToken(username, secret);
    const tokenHash = await sha256Base64Url(secret);
    const now = Date.now();
    const expiresAt = now + DEFAULT_SESSION_TTL_SECONDS * 1000;
    this.state.storage.sql.exec("DELETE FROM sessions WHERE expires_at <= ?", now);
    this.state.storage.sql.exec(
      "INSERT INTO sessions (token_hash_b64, device_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
      tokenHash,
      deviceId ?? null,
      now,
      expiresAt,
    );
    return { token, tokenHash };
  }

  private async handleGetSnapshot(request: Request): Promise<Response> {
    const session = await this.requireSession(request);
    if (session instanceof Response) {
      return session;
    }
    const snapshot = this.getSnapshot();
    return json({
      revision: snapshot?.revision ?? 0,
      snapshot: snapshot ? JSON.parse(snapshot.snapshot_json) : null,
      updatedAt: snapshot?.updated_at ?? null,
      updatedByDeviceId: snapshot?.updated_by_device_id ?? null,
    });
  }

  private async handlePutSnapshot(request: Request): Promise<Response> {
    const session = await this.requireSession(request);
    if (session instanceof Response) {
      return session;
    }
    const raw = await readJsonBody(request);
    if (!isRecord(raw)) {
      return errorJson("Invalid JSON body", 400);
    }
    const baseRevision = readNumber(raw, "baseRevision");
    if (baseRevision === null || baseRevision < 0) {
      return errorJson("Invalid base revision", 400);
    }
    const input: PutSnapshotRequest = {
      baseRevision,
      snapshot: raw.snapshot,
      deviceId: readOptionalString(raw, "deviceId"),
    };
    if (input.snapshot === undefined || input.snapshot === null) {
      return errorJson("Missing snapshot", 400);
    }
    const current = this.getSnapshot();
    const currentRevision = current?.revision ?? 0;
    if (currentRevision !== input.baseRevision) {
      return json(
        {
          error: "Revision conflict",
          revision: currentRevision,
          snapshot: current ? JSON.parse(current.snapshot_json) : null,
        },
        409,
      );
    }

    const now = Date.now();
    const nextRevision = currentRevision + 1;
    const snapshotJson = JSON.stringify(input.snapshot);
    this.state.storage.sql.exec(
      "INSERT INTO snapshot (id, revision, snapshot_json, updated_at, updated_by_device_id) VALUES (1, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET revision = excluded.revision, snapshot_json = excluded.snapshot_json, updated_at = excluded.updated_at, updated_by_device_id = excluded.updated_by_device_id",
      nextRevision,
      snapshotJson,
      now,
      input.deviceId ?? session.device_id ?? null,
    );
    this.broadcast({
      type: "snapshot_updated",
      revision: nextRevision,
      updatedAt: now,
      deviceId: input.deviceId ?? session.device_id ?? null,
    });
    return json({
      revision: nextRevision,
      snapshot: input.snapshot,
      updatedAt: now,
    });
  }

  private async handleEvents(request: Request): Promise<Response> {
    const token = new URL(request.url).searchParams.get("token")?.trim() ?? "";
    const session = await this.validateToken(token);
    if (session instanceof Response) {
      return session;
    }
    const upgradeHeader = request.headers.get("Upgrade");
    if (!upgradeHeader || upgradeHeader.toLowerCase() !== "websocket") {
      return new Response("Expected WebSocket upgrade", { status: 426 });
    }
    const pairCtor = getGlobalWebSocketPair();
    if (!pairCtor) {
      return errorJson("WebSocketPair unavailable", 500);
    }
    const pair = new pairCtor();
    const server = pair[1];
    if (hasAttachmentMethods(server)) {
      server.serializeAttachment({
        deviceId: session.device_id,
      });
    }
    this.state.acceptWebSocket(server);
    const snapshot = this.getSnapshot();
    server.send(
      JSON.stringify({
        type: "hello",
        revision: snapshot?.revision ?? 0,
      }),
    );
    return new Response(null, { status: 101, webSocket: pair[0] } as CFResponseInit);
  }

  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
    if (typeof message !== "string") {
      return;
    }
    if (message === "ping") {
      ws.send("pong");
    }
  }

  webSocketClose(_ws: WebSocket): void {
    // No in-memory connection map; hibernation tracks accepted sockets.
  }

  private broadcast(payload: unknown): void {
    const encoded = JSON.stringify(payload);
    for (const ws of this.state.getWebSockets()) {
      try {
        ws.send(encoded);
      } catch {
        // Ignore stale sockets; Cloudflare will close them eventually.
      }
    }
  }
}

function hasAttachmentMethods(ws: WebSocket): ws is WebSocketWithAttachment {
  return (
    "serializeAttachment" in ws &&
    "deserializeAttachment" in ws &&
    typeof Reflect.get(ws, "serializeAttachment") === "function" &&
    typeof Reflect.get(ws, "deserializeAttachment") === "function"
  );
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders(request, env) });
    }

    let response: Response;
    try {
      response = await routeSyncRequest(request, env);
    } catch (error) {
      console.error("[SyncWorker] request failed", error);
      response = errorJson("Internal server error", 500);
    }

    if (response.status === 101) {
      return response;
    }
    return withCors(response, request, env);
  },
};
