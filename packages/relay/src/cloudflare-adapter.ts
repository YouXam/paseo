/**
 * Cloudflare Durable Objects adapter for the relay.
 *
 * This module provides a Durable Object class that can be deployed to
 * Cloudflare Workers. It uses WebSocket hibernation for cost efficiency.
 *
 * Each session gets its own Durable Object instance, identified by session ID.
 *
 * Wrangler config:
 * ```jsonc
 * {
 *   "durable_objects": {
 *     "bindings": [{ "name": "RELAY", "class_name": "RelayDurableObject" }]
 *   },
 *   "migrations": [{ "tag": "v1", "new_classes": ["RelayDurableObject"] }]
 * }
 * ```
 */

import { createCutoverProxy } from "./cutover-proxy.js";
import type { ConnectionRole, RelaySessionAttachment } from "./types.js";

type RelayProtocolVersion = "1" | "2";

const LEGACY_RELAY_VERSION: RelayProtocolVersion = "1";
const CURRENT_RELAY_VERSION: RelayProtocolVersion = "2";

function resolveRelayVersion(rawValue: string | null): RelayProtocolVersion | null {
  if (rawValue == null) return LEGACY_RELAY_VERSION;
  const value = rawValue.trim();
  if (!value) return LEGACY_RELAY_VERSION;
  if (value === LEGACY_RELAY_VERSION || value === CURRENT_RELAY_VERSION) {
    return value;
  }
  return null;
}

interface WebSocketPair {
  0: WebSocket;
  1: WebSocket;
}

interface DurableObjectStorage {
  get<T = unknown>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<boolean>;
  getAlarm(): Promise<number | null>;
  setAlarm(scheduledTime: number): Promise<void>;
  deleteAlarm(): Promise<void>;
}

interface DurableObjectState {
  acceptWebSocket(ws: WebSocket, tags?: string[]): void;
  getWebSockets(tag?: string): WebSocket[];
  storage: DurableObjectStorage;
}

/**
 * Pending control-liveness check for one connectionId, persisted in DO storage.
 *
 * "nudge" -> resend a sync list; "reset" -> force-close the control socket.
 */
type ControlWatchStage = "nudge" | "reset";

interface ControlWatchEntry {
  stage: ControlWatchStage;
  dueAt: number;
}

type ControlWatchMap = Record<string, ControlWatchEntry>;

const CONTROL_WATCH_KEY = "controlWatch";
const CONTROL_WATCH_NUDGE_DELAY_MS = 10_000;
const CONTROL_WATCH_RESET_DELAY_MS = 5_000;

function isControlWatchStage(value: unknown): value is ControlWatchStage {
  return value === "nudge" || value === "reset";
}

function parseControlWatchMap(raw: unknown): ControlWatchMap {
  if (!isRecord(raw)) return {};
  const out: ControlWatchMap = {};
  for (const [connectionId, entryRaw] of Object.entries(raw)) {
    if (!connectionId || !isRecord(entryRaw)) continue;
    const { stage, dueAt } = entryRaw;
    if (!isControlWatchStage(stage) || typeof dueAt !== "number" || !Number.isFinite(dueAt)) {
      continue;
    }
    out[connectionId] = { stage, dueAt };
  }
  return out;
}

interface WebSocketWithAttachment extends WebSocket {
  serializeAttachment(value: unknown): void;
  deserializeAttachment(): unknown;
}

function hasAttachmentMethods(ws: WebSocket): ws is WebSocketWithAttachment {
  // Type-safe check for attachment methods - required for Cloudflare WebSocket hibernation API
  // Use Reflect to check for methods without type assertions
  return (
    "serializeAttachment" in ws &&
    "deserializeAttachment" in ws &&
    typeof Reflect.get(ws, "serializeAttachment") === "function" &&
    typeof Reflect.get(ws, "deserializeAttachment") === "function"
  );
}

function deserializeAttachment(ws: WebSocket): unknown {
  if (!hasAttachmentMethods(ws)) return null;
  try {
    return ws.deserializeAttachment();
  } catch {
    return null;
  }
}

function serializeAttachment(ws: WebSocket, value: unknown): void {
  if (!hasAttachmentMethods(ws)) {
    throw new Error("WebSocket does not support attachments");
  }
  ws.serializeAttachment(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function getString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function getGlobalWebSocketPair(): (new () => WebSocketPair) | undefined {
  // Access WebSocketPair from global scope (Cloudflare Workers runtime)
  // Use Reflect to access global property without type assertions
  const WebSocketPair = Reflect.get(globalThis, "WebSocketPair") as unknown;
  if (typeof WebSocketPair === "function") {
    return WebSocketPair as new () => WebSocketPair;
  }
  return undefined;
}

interface Env {
  RELAY: DurableObjectNamespace;
  PASEO_RELAY_UPSTREAM?: string;
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

/**
 * Durable Object that handles WebSocket relay for a single session.
 *
 * v1 WebSockets connect in two shapes:
 * - role=server: daemon socket
 * - role=client: app/client socket
 *
 * v2 WebSockets connect in three shapes:
 * - role=server (no connectionId): daemon control socket (one per serverId)
 * - role=server&connectionId=...: daemon per-connection data socket (one per connectionId)
 * - role=client&connectionId=...: app/client socket (many per connectionId)
 */
interface CFResponseInit extends ResponseInit {
  webSocket?: WebSocket;
}

export class RelayDurableObject {
  private state: DurableObjectState;
  private pendingFrames = new Map<string, Array<string | ArrayBuffer>>();

  constructor(state: DurableObjectState) {
    this.state = state;
  }

  private createWebSocketPair(): [WebSocket, WebSocket] {
    const WebSocketPairCtor = getGlobalWebSocketPair();
    if (!WebSocketPairCtor) {
      throw new Error("WebSocketPair not available in global scope");
    }
    const pair: WebSocketPair = new WebSocketPairCtor();
    return [pair[0], pair[1]];
  }

  private requireWebSocketUpgrade(request: Request): Response | null {
    const upgradeHeader = request.headers.get("Upgrade");
    if (!upgradeHeader || upgradeHeader.toLowerCase() !== "websocket") {
      return new Response("Expected WebSocket upgrade", { status: 426 });
    }
    return null;
  }

  private asSwitchingProtocolsResponse(client: WebSocket): Response {
    return new Response(null, {
      status: 101,
      webSocket: client,
    } as CFResponseInit);
  }

  private hasServerDataSocket(connectionId: string): boolean {
    try {
      return this.state.getWebSockets(`server:${connectionId}`).length > 0;
    } catch {
      return false;
    }
  }

  private hasClientSocket(connectionId: string): boolean {
    try {
      return this.state.getWebSockets(`client:${connectionId}`).length > 0;
    } catch {
      return false;
    }
  }

  private closeExistingServerSockets(args: {
    isServerControl: boolean;
    isServerData: boolean;
    resolvedConnectionId: string;
  }): void {
    if (args.isServerControl) {
      for (const ws of this.state.getWebSockets("server-control")) {
        ws.close(1008, "Replaced by new connection");
      }
    } else if (args.isServerData) {
      for (const ws of this.state.getWebSockets(`server:${args.resolvedConnectionId}`)) {
        ws.close(1008, "Replaced by new connection");
      }
    }
  }

  // COMPAT(relay-json-ping): Old daemons (< v0.1.76) send JSON {type:"ping"} on the control
  // socket and rely on a JSON {type:"pong"} reply to keep controlLastSeenAt fresh. New daemons
  // use WebSocket protocol pings (auto-answered at the edge, DO stays hibernated). Remove this
  // handler once the supported-daemon floor is >= v0.1.76 (target: 2026-11-13).
  private handleControlKeepalive(ws: WebSocket, message: string): void {
    try {
      const parsed: unknown = JSON.parse(message);
      const parsedRecord = isRecord(parsed) ? parsed : null;
      if (parsedRecord?.type !== "ping") return;
      // Logged so the daemon-side e2e idle test can assert no JSON ping reached the DO
      // (which would indicate a regression to app-level pings that wake the DO).
      console.log("[Relay DO] legacy_json_ping_received");
      try {
        ws.send(JSON.stringify({ type: "pong", ts: Date.now() }));
      } catch {
        // ignore
      }
    } catch {
      // ignore non-JSON control payloads
    }
  }

  private async readControlWatch(): Promise<ControlWatchMap> {
    try {
      return parseControlWatchMap(await this.state.storage.get(CONTROL_WATCH_KEY));
    } catch {
      return {};
    }
  }

  private async writeControlWatch(watch: ControlWatchMap): Promise<void> {
    try {
      if (Object.keys(watch).length === 0) {
        await this.state.storage.delete(CONTROL_WATCH_KEY);
        return;
      }
      await this.state.storage.put(CONTROL_WATCH_KEY, watch);
    } catch {
      // ignore storage failures: worst case we lose a liveness check, same as before
    }
  }

  /**
   * Ensure the DO alarm fires no later than `dueAt`.
   *
   * Alarms are per-DO (one pending at a time), so the earliest due entry owns the alarm and
   * `alarm()` re-arms for whatever remains.
   */
  private async ensureAlarmAt(dueAt: number): Promise<void> {
    try {
      const existing = await this.state.storage.getAlarm();
      if (existing != null && existing <= dueAt) return;
      await this.state.storage.setAlarm(dueAt);
    } catch {
      // ignore
    }
  }

  private async nudgeOrResetControlForConnection(connectionId: string): Promise<void> {
    // If the daemon's control WS becomes half-open, the DO can't reliably detect it via ws.send errors
    // (Cloudflare may accept writes even if the other side is no longer reading).
    //
    // Instead, observe whether the daemon reacts by opening the per-connection server-data socket.
    // If it doesn't, nudge with a sync message; if still no reaction, force-close the control
    // socket(s) so the daemon reconnects.
    //
    // This MUST be driven by DO alarms, not setTimeout. Between hibernation-API events the runtime
    // is free to evict this DO instance, and an evicted instance loses every pending setTimeout
    // without running it. The daemon can't cover for us either: its control keepalive is a
    // WebSocket protocol ping that Cloudflare's edge answers without waking the DO, so a control
    // socket the DO no longer knows about still looks perfectly healthy from the daemon side.
    // With setTimeout, that combination stalls a server indefinitely — both ends believe they are
    // connected and neither reconnects. Alarms survive eviction, so the check always runs.
    const dueAt = Date.now() + CONTROL_WATCH_NUDGE_DELAY_MS;
    const watch = await this.readControlWatch();
    watch[connectionId] = { stage: "nudge", dueAt };
    await this.writeControlWatch(watch);
    await this.ensureAlarmAt(dueAt);
  }

  /**
   * Advance one pending control-liveness check.
   *
   * Returns the entry to keep (with its next stage/dueAt), or null when the check is finished or
   * no longer needed.
   */
  private stepControlWatch(
    connectionId: string,
    entry: ControlWatchEntry,
    now: number,
  ): ControlWatchEntry | null {
    // The daemon reacted, or the client gave up waiting: nothing left to check.
    if (!this.hasClientSocket(connectionId)) return null;
    if (this.hasServerDataSocket(connectionId)) return null;

    if (entry.stage === "nudge") {
      // First nudge: send a full sync list.
      this.notifyControls({ type: "sync", connectionIds: this.listConnectedConnectionIds() });
      return { stage: "reset", dueAt: now + CONTROL_WATCH_RESET_DELAY_MS };
    }

    // Still nothing: assume control is stuck and force a reconnect.
    for (const ws of this.state.getWebSockets("server-control")) {
      try {
        ws.close(1011, "Control unresponsive");
      } catch {
        // ignore
      }
    }
    return null;
  }

  /**
   * Alarm handler: runs pending control-liveness checks (see nudgeOrResetControlForConnection).
   *
   * Survives hibernation and instance eviction, which is the whole point of using an alarm here.
   */
  async alarm(): Promise<void> {
    const now = Date.now();
    const watch = await this.readControlWatch();
    const next: ControlWatchMap = {};

    for (const [connectionId, entry] of Object.entries(watch)) {
      if (entry.dueAt > now) {
        // Not due yet (it belongs to a later alarm): keep as-is.
        next[connectionId] = entry;
        continue;
      }
      const stepped = this.stepControlWatch(connectionId, entry, now);
      if (stepped) next[connectionId] = stepped;
    }

    await this.writeControlWatch(next);

    let earliest: number | null = null;
    for (const entry of Object.values(next)) {
      if (earliest == null || entry.dueAt < earliest) earliest = entry.dueAt;
    }
    if (earliest != null) {
      try {
        await this.state.storage.setAlarm(earliest);
      } catch {
        // ignore
      }
    }
  }

  private bufferFrame(connectionId: string, message: string | ArrayBuffer): void {
    const existing = this.pendingFrames.get(connectionId) ?? [];
    existing.push(message);
    // Prevent unbounded memory growth if a daemon never connects.
    if (existing.length > 200) {
      existing.splice(0, existing.length - 200);
    }
    this.pendingFrames.set(connectionId, existing);
  }

  private flushFrames(connectionId: string, serverWs: WebSocket): void {
    const frames = this.pendingFrames.get(connectionId);
    if (!frames || frames.length === 0) return;
    this.pendingFrames.delete(connectionId);
    for (const frame of frames) {
      try {
        serverWs.send(frame);
      } catch {
        // If we can't flush, re-buffer and let the daemon re-establish.
        this.bufferFrame(connectionId, frame);
        break;
      }
    }
  }

  private listConnectedConnectionIds(): string[] {
    const out = new Set<string>();
    for (const ws of this.state.getWebSockets("client")) {
      try {
        const attachmentRaw = deserializeAttachment(ws);
        const attachment = isRecord(attachmentRaw) ? attachmentRaw : null;
        if (
          attachment?.role === "client" &&
          typeof attachment.connectionId === "string" &&
          attachment.connectionId
        ) {
          out.add(attachment.connectionId);
        }
      } catch {
        // ignore
      }
    }
    return Array.from(out);
  }

  private notifyControls(message: unknown): void {
    const text = JSON.stringify(message);
    for (const ws of this.state.getWebSockets("server-control")) {
      try {
        ws.send(text);
      } catch {
        // If the control socket is dead, close it so the daemon can reconnect.
        try {
          ws.close(1011, "Control send failed");
        } catch {
          // ignore
        }
      }
    }
  }

  private fetchV1(request: Request, role: ConnectionRole, serverId: string): Response {
    const upgradeError = this.requireWebSocketUpgrade(request);
    if (upgradeError) return upgradeError;

    for (const ws of this.state.getWebSockets(role)) {
      ws.close(1008, "Replaced by new connection");
    }

    const [client, server] = this.createWebSocketPair();
    this.state.acceptWebSocket(server, [role]);

    const attachment: RelaySessionAttachment = {
      serverId,
      role,
      version: LEGACY_RELAY_VERSION,
      connectionId: null,
      createdAt: Date.now(),
    };
    serializeAttachment(server, attachment);

    console.log(`[Relay DO] v1:${role} connected to session ${serverId}`);

    return this.asSwitchingProtocolsResponse(client);
  }

  private async fetchV2(
    request: Request,
    role: ConnectionRole,
    serverId: string,
    connectionId: string,
  ): Promise<Response> {
    const upgradeError = this.requireWebSocketUpgrade(request);
    if (upgradeError) return upgradeError;

    // If a client didn't provide a connectionId, the relay assigns one for routing.
    const resolvedConnectionId =
      role === "client" && !connectionId
        ? `conn_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`
        : connectionId;

    const isServerControl = role === "server" && !resolvedConnectionId;
    const isServerData = role === "server" && !!resolvedConnectionId;

    // Close any existing server-side connection with the same identity.
    // - server-control: single per serverId
    // - server-data: single per connectionId
    // - client: many sockets per connectionId are allowed
    this.closeExistingServerSockets({ isServerControl, isServerData, resolvedConnectionId });

    const [client, server] = this.createWebSocketPair();

    const tags: string[] = [];
    if (role === "client") {
      tags.push("client", `client:${resolvedConnectionId}`);
    } else if (isServerControl) {
      tags.push("server-control");
    } else {
      tags.push("server", `server:${resolvedConnectionId}`);
    }

    this.state.acceptWebSocket(server, tags);

    const attachment: RelaySessionAttachment = {
      serverId,
      role,
      version: CURRENT_RELAY_VERSION,
      connectionId: resolvedConnectionId || null,
      createdAt: Date.now(),
    };
    serializeAttachment(server, attachment);

    let roleSuffix = "";
    if (isServerControl) {
      roleSuffix = "(control)";
    } else if (isServerData) {
      roleSuffix = `(data:${resolvedConnectionId})`;
    } else if (role === "client") {
      roleSuffix = `(${resolvedConnectionId})`;
    }
    console.log(`[Relay DO] v2:${role}${roleSuffix} connected to session ${serverId}`);

    if (role === "client") {
      this.notifyControls({ type: "connected", connectionId: resolvedConnectionId });
      await this.nudgeOrResetControlForConnection(resolvedConnectionId);
    }

    if (isServerControl) {
      // Send current connection list so the daemon can attach existing connections.
      try {
        server.send(
          JSON.stringify({ type: "sync", connectionIds: this.listConnectedConnectionIds() }),
        );
      } catch {
        // ignore
      }
    }

    if (isServerData && resolvedConnectionId) {
      this.flushFrames(resolvedConnectionId, server);
    }

    return this.asSwitchingProtocolsResponse(client);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const roleRaw = url.searchParams.get("role");
    const role = roleRaw === "server" || roleRaw === "client" ? roleRaw : null;
    const serverId = url.searchParams.get("serverId");
    const connectionIdRaw = url.searchParams.get("connectionId");
    const connectionId = typeof connectionIdRaw === "string" ? connectionIdRaw.trim() : "";
    const version = resolveRelayVersion(url.searchParams.get("v"));

    if (!role || (role !== "server" && role !== "client")) {
      return new Response("Missing or invalid role parameter", { status: 400 });
    }

    if (!serverId) {
      return new Response("Missing serverId parameter", { status: 400 });
    }

    if (!version) {
      return new Response("Invalid v parameter (expected 1 or 2)", { status: 400 });
    }

    if (version === LEGACY_RELAY_VERSION) {
      return this.fetchV1(request, role, serverId);
    }

    return await this.fetchV2(request, role, serverId, connectionId);
  }

  /**
   * Called when a WebSocket message is received (wakes from hibernation).
   */
  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
    const attachmentRaw = deserializeAttachment(ws);
    if (!isRecord(attachmentRaw)) {
      console.error("[Relay DO] Message from WebSocket without attachment");
      return;
    }
    const attachment = attachmentRaw;

    const version = getString(attachment, "version") ?? LEGACY_RELAY_VERSION;

    if (version === LEGACY_RELAY_VERSION) {
      const targetRole = attachment.role === "server" ? "client" : "server";
      const targets = this.state.getWebSockets(targetRole);
      for (const target of targets) {
        try {
          target.send(message);
        } catch (error) {
          console.error(`[Relay DO] Failed to forward to ${targetRole}:`, error);
        }
      }
      return;
    }

    const role = getString(attachment, "role");
    const connectionId = getString(attachment, "connectionId");
    if (!connectionId) {
      // Control channel: support simple app-level keepalive.
      if (typeof message === "string") {
        this.handleControlKeepalive(ws, message);
      }
      return;
    }

    if (role === "client") {
      const servers = this.state.getWebSockets(`server:${connectionId}`);
      if (servers.length === 0) {
        this.bufferFrame(connectionId, message);
        return;
      }
      for (const target of servers) {
        try {
          target.send(message);
        } catch (error) {
          console.error(`[Relay DO] Failed to forward client->server(${connectionId}):`, error);
        }
      }
      return;
    }

    // server data socket -> client
    const targets = this.state.getWebSockets(`client:${connectionId}`);
    for (const target of targets) {
      try {
        target.send(message);
      } catch (error) {
        console.error(`[Relay DO] Failed to forward server->client(${connectionId}):`, error);
      }
    }
  }

  /**
   * Called when a WebSocket closes (wakes from hibernation).
   */
  webSocketClose(ws: WebSocket, code: number, reason: string, _wasClean: boolean): void {
    const attachmentRaw = deserializeAttachment(ws);
    if (!isRecord(attachmentRaw)) return;
    const attachment = attachmentRaw;

    const version = getString(attachment, "version") ?? LEGACY_RELAY_VERSION;
    const role = getString(attachment, "role");
    const connectionId = getString(attachment, "connectionId");
    const serverId = getString(attachment, "serverId");
    console.log(
      `[Relay DO] v${version}:${role ?? "unknown"}${connectionId ? `(${connectionId})` : ""} disconnected from session ${serverId ?? "unknown"} (${code}: ${reason})`,
    );

    if (version === LEGACY_RELAY_VERSION) {
      return;
    }

    if (role === "client" && connectionId) {
      const remainingClientSockets = this.state
        .getWebSockets(`client:${connectionId}`)
        .some((socket) => socket !== ws);
      if (remainingClientSockets) {
        return;
      }

      this.pendingFrames.delete(connectionId);
      // Last socket for this session closed: now clean up matching server-data socket.
      for (const serverWs of this.state.getWebSockets(`server:${connectionId}`)) {
        try {
          serverWs.close(1001, "Client disconnected");
        } catch {
          // ignore
        }
      }
      this.notifyControls({ type: "disconnected", connectionId });
      return;
    }

    if (role === "server" && connectionId) {
      // Force the client to reconnect and re-handshake when the daemon side drops.
      for (const clientWs of this.state.getWebSockets(`client:${connectionId}`)) {
        try {
          clientWs.close(1012, "Server disconnected");
        } catch {
          // ignore
        }
      }
    }
  }

  /**
   * Called on WebSocket error.
   */
  webSocketError(ws: WebSocket, error: unknown): void {
    const attachmentRaw = deserializeAttachment(ws);
    const attachment = isRecord(attachmentRaw) ? attachmentRaw : null;
    const role = attachment ? getString(attachment, "role") : undefined;
    console.error(`[Relay DO] WebSocket error for ${role ?? "unknown"}:`, error);
  }
}

/**
 * Worker entry point that routes requests to the appropriate Durable Object.
 */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (env.PASEO_RELAY_UPSTREAM) {
      return createCutoverProxy(env.PASEO_RELAY_UPSTREAM).fetch(request);
    }

    const url = new URL(request.url);

    // Health check
    if (url.pathname === "/health") {
      return new Response(JSON.stringify({ status: "ok" }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    // Relay endpoint
    if (url.pathname === "/ws") {
      const serverId = url.searchParams.get("serverId");
      if (!serverId) {
        return new Response("Missing serverId parameter", { status: 400 });
      }

      const version = resolveRelayVersion(url.searchParams.get("v"));
      if (!version) {
        return new Response("Invalid v parameter (expected 1 or 2)", { status: 400 });
      }

      // Route to a version-isolated Durable Object instance.
      const id = env.RELAY.idFromName(`relay-v${version}:${serverId}`);
      const stub = env.RELAY.get(id);

      const normalizedUrl = new URL(request.url);
      normalizedUrl.searchParams.set("v", version);
      const normalizedRequest = new Request(normalizedUrl.toString(), request);
      return stub.fetch(normalizedRequest);
    }

    return new Response("Not found", { status: 404 });
  },
};
