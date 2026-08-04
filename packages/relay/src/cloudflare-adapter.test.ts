import { afterEach, describe, expect, it, vi } from "vitest";
import relayWorker, { RelayDurableObject } from "./cloudflare-adapter.js";

type DurableObjectStateArg = ConstructorParameters<typeof RelayDurableObject>[0];
type RelayEnvArg = Parameters<typeof relayWorker.fetch>[1];

type MockSocket = WebSocket & {
  send: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  serializeAttachment: ReturnType<typeof vi.fn>;
  deserializeAttachment: ReturnType<typeof vi.fn>;
};

function createMockSocket(attachment: unknown = null): MockSocket {
  let storedAttachment = attachment;
  return {
    send: vi.fn(),
    close: vi.fn(),
    serializeAttachment: vi.fn((value: unknown) => {
      storedAttachment = value;
    }),
    deserializeAttachment: vi.fn(() => storedAttachment),
  } as unknown as MockSocket;
}

function createMockState() {
  const socketsByTag = new Map<string, WebSocket[]>();
  const kv = new Map<string, unknown>();
  let scheduledAlarm: number | null = null;

  const storage = {
    get: vi.fn(async (key: string) => kv.get(key)),
    put: vi.fn(async (key: string, value: unknown) => {
      // Cloudflare structured-clones stored values; round-trip so tests can't accidentally
      // depend on holding a live reference to the DO's in-memory object.
      kv.set(key, JSON.parse(JSON.stringify(value)) as unknown);
    }),
    delete: vi.fn(async (key: string) => kv.delete(key)),
    getAlarm: vi.fn(async () => scheduledAlarm),
    setAlarm: vi.fn(async (scheduledTime: number) => {
      scheduledAlarm = scheduledTime;
    }),
    deleteAlarm: vi.fn(async () => {
      scheduledAlarm = null;
    }),
  };

  const state = {
    acceptWebSocket: vi.fn(),
    getWebSockets: vi.fn((tag?: string): WebSocket[] => {
      if (!tag) {
        const out: WebSocket[] = [];
        for (const sockets of socketsByTag.values()) out.push(...sockets);
        return out;
      }
      return socketsByTag.get(tag) ?? [];
    }),
    storage,
  };

  return {
    state,
    storage,
    setTagSockets: (tag: string, sockets: WebSocket[]) => {
      socketsByTag.set(tag, sockets);
    },
    getScheduledAlarm: () => scheduledAlarm,
    /**
     * Simulate the runtime firing a due alarm: clear it (as Cloudflare does before invoking the
     * handler) and run `alarm()`. Returns false when nothing was due.
     */
    fireDueAlarm: async (relay: { alarm(): Promise<void> }, now: number): Promise<boolean> => {
      if (scheduledAlarm == null || scheduledAlarm > now) return false;
      scheduledAlarm = null;
      await relay.alarm();
      return true;
    },
  };
}

async function withMockWebSocketPair(
  run: (sockets: { clientWs: MockSocket; serverWs: MockSocket }) => Promise<void> | void,
): Promise<void> {
  const serverWs = createMockSocket();
  const clientWs = createMockSocket();
  const WebSocketPairMock = class {
    [index: number]: WebSocket;
    constructor() {
      this[0] = clientWs as unknown as WebSocket;
      this[1] = serverWs as unknown as WebSocket;
    }
  };

  const previousPair = (globalThis as unknown as { WebSocketPair?: unknown }).WebSocketPair;
  (globalThis as unknown as { WebSocketPair: unknown }).WebSocketPair = WebSocketPairMock;
  try {
    await run({ clientWs, serverWs });
  } finally {
    if (previousPair === undefined) {
      delete (globalThis as unknown as { WebSocketPair?: unknown }).WebSocketPair;
    } else {
      (globalThis as unknown as { WebSocketPair: unknown }).WebSocketPair = previousPair;
    }
  }
}

const swallow = () => undefined;

describe("RelayDurableObject versioning", () => {
  it("accepts legacy v1 client sockets without connectionId", async () => {
    const { state } = createMockState();
    await withMockWebSocketPair(async () => {
      const relay = new RelayDurableObject(state as unknown as DurableObjectStateArg);
      const req = new Request("https://relay.test/ws?role=client&serverId=srv_test&v=1", {
        headers: {
          Upgrade: "websocket",
        },
      });
      await relay.fetch(req).catch(swallow);
      expect(state.acceptWebSocket).toHaveBeenCalled();
    });
  });

  it("assigns a connectionId when v2 client connects without one", async () => {
    const { state } = createMockState();
    await withMockWebSocketPair(async ({ serverWs }) => {
      const relay = new RelayDurableObject(state as unknown as DurableObjectStateArg);
      const req = new Request("https://relay.test/ws?role=client&serverId=srv_test&v=2", {
        headers: { Upgrade: "websocket" },
      });
      await relay.fetch(req).catch(swallow);
      expect(state.acceptWebSocket).toHaveBeenCalled();
      const attachment = serverWs.deserializeAttachment();
      expect(attachment).toMatchObject({
        role: "client",
        connectionId: expect.stringMatching(/^conn_/),
      });
    });
  });
});

describe("RelayDurableObject control nudge/reset behavior", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not nudge or reset control after the client already disconnected", async () => {
    vi.useFakeTimers();
    const clientId = "clt_stale_timer";
    const control = createMockSocket();
    const { state, setTagSockets, fireDueAlarm } = createMockState();

    setTagSockets("server-control", [control]);
    setTagSockets("client", []);
    setTagSockets(`client:${clientId}`, []);
    setTagSockets(`server:${clientId}`, []);

    const relay = new RelayDurableObject(state as unknown as DurableObjectStateArg);
    await (
      relay as unknown as { nudgeOrResetControlForConnection(id: string): Promise<void> }
    ).nudgeOrResetControlForConnection(clientId);

    vi.advanceTimersByTime(15_000);
    await fireDueAlarm(relay, Date.now());

    expect(control.send).not.toHaveBeenCalled();
    expect(control.close).not.toHaveBeenCalled();
  });

  it("resets control when the client remains connected but no server-data socket appears", async () => {
    vi.useFakeTimers();
    const clientId = "clt_waiting_for_daemon";
    const control = createMockSocket();
    const client = createMockSocket({
      role: "client",
      connectionId: clientId,
      serverId: "srv_test",
      createdAt: Date.now(),
    });
    const { state, setTagSockets, fireDueAlarm } = createMockState();

    setTagSockets("server-control", [control]);
    setTagSockets("client", [client]);
    setTagSockets(`client:${clientId}`, [client]);
    setTagSockets(`server:${clientId}`, []);

    const relay = new RelayDurableObject(state as unknown as DurableObjectStateArg);
    await (
      relay as unknown as { nudgeOrResetControlForConnection(id: string): Promise<void> }
    ).nudgeOrResetControlForConnection(clientId);

    vi.advanceTimersByTime(10_000);
    expect(await fireDueAlarm(relay, Date.now())).toBe(true);
    expect(control.send).toHaveBeenCalledTimes(1);
    expect(control.close).not.toHaveBeenCalled();

    vi.advanceTimersByTime(5_000);
    expect(await fireDueAlarm(relay, Date.now())).toBe(true);
    expect(control.close).toHaveBeenCalledWith(1011, "Control unresponsive");
  });

  it("runs the control check on a fresh instance after the DO is evicted", async () => {
    // Regression: the check used to run on setTimeout, which the runtime discards when it evicts a
    // hibernating DO. Nothing then reset a control socket the DO had forgotten about, so a stalled
    // server stayed stalled. Persisted state + alarm must survive losing the instance entirely.
    vi.useFakeTimers();
    const clientId = "clt_survives_eviction";
    const control = createMockSocket();
    const client = createMockSocket({
      role: "client",
      connectionId: clientId,
      serverId: "srv_test",
      createdAt: Date.now(),
    });
    const { state, setTagSockets, getScheduledAlarm, fireDueAlarm } = createMockState();

    setTagSockets("server-control", [control]);
    setTagSockets("client", [client]);
    setTagSockets(`client:${clientId}`, [client]);
    setTagSockets(`server:${clientId}`, []);

    await (
      new RelayDurableObject(state as unknown as DurableObjectStateArg) as unknown as {
        nudgeOrResetControlForConnection(id: string): Promise<void>;
      }
    ).nudgeOrResetControlForConnection(clientId);
    expect(getScheduledAlarm()).not.toBeNull();

    // The instance that armed the alarm is gone; every later step runs on a new one.
    vi.advanceTimersByTime(10_000);
    const afterEviction = new RelayDurableObject(state as unknown as DurableObjectStateArg);
    expect(await fireDueAlarm(afterEviction, Date.now())).toBe(true);
    expect(control.send).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(5_000);
    const afterSecondEviction = new RelayDurableObject(state as unknown as DurableObjectStateArg);
    expect(await fireDueAlarm(afterSecondEviction, Date.now())).toBe(true);
    expect(control.close).toHaveBeenCalledWith(1011, "Control unresponsive");
  });

  it("stops the control check once the daemon opens its data socket", async () => {
    vi.useFakeTimers();
    const clientId = "clt_daemon_reacts";
    const control = createMockSocket();
    const client = createMockSocket({
      role: "client",
      connectionId: clientId,
      serverId: "srv_test",
      createdAt: Date.now(),
    });
    const { state, setTagSockets, getScheduledAlarm, fireDueAlarm } = createMockState();

    setTagSockets("server-control", [control]);
    setTagSockets("client", [client]);
    setTagSockets(`client:${clientId}`, [client]);
    setTagSockets(`server:${clientId}`, []);

    const relay = new RelayDurableObject(state as unknown as DurableObjectStateArg);
    await (
      relay as unknown as { nudgeOrResetControlForConnection(id: string): Promise<void> }
    ).nudgeOrResetControlForConnection(clientId);

    // Daemon attaches before the first check is due.
    setTagSockets(`server:${clientId}`, [createMockSocket()]);

    vi.advanceTimersByTime(10_000);
    expect(await fireDueAlarm(relay, Date.now())).toBe(true);

    expect(control.send).not.toHaveBeenCalled();
    expect(control.close).not.toHaveBeenCalled();
    // Nothing pending, so no alarm is left armed to bill for.
    expect(getScheduledAlarm()).toBeNull();
  });

  it("keeps the earliest alarm when several connections are waiting", async () => {
    vi.useFakeTimers();
    const control = createMockSocket();
    const { state, setTagSockets, getScheduledAlarm, fireDueAlarm } = createMockState();
    setTagSockets("server-control", [control]);

    const relay = new RelayDurableObject(state as unknown as DurableObjectStateArg);
    const nudge = (id: string) =>
      (
        relay as unknown as { nudgeOrResetControlForConnection(id: string): Promise<void> }
      ).nudgeOrResetControlForConnection(id);

    const firstClient = createMockSocket({
      role: "client",
      connectionId: "clt_first",
      serverId: "srv_test",
      createdAt: Date.now(),
    });
    setTagSockets("client", [firstClient]);
    setTagSockets("client:clt_first", [firstClient]);
    await nudge("clt_first");
    const firstDueAt = getScheduledAlarm();

    // A later arrival must not push the pending check back.
    vi.advanceTimersByTime(4_000);
    const secondClient = createMockSocket({
      role: "client",
      connectionId: "clt_second",
      serverId: "srv_test",
      createdAt: Date.now(),
    });
    setTagSockets("client", [firstClient, secondClient]);
    setTagSockets("client:clt_second", [secondClient]);
    await nudge("clt_second");
    expect(getScheduledAlarm()).toBe(firstDueAt);

    // First connection's nudge fires; the second is still pending and re-arms the alarm.
    vi.advanceTimersByTime(6_000);
    expect(await fireDueAlarm(relay, Date.now())).toBe(true);
    expect(control.send).toHaveBeenCalledTimes(1);
    expect(getScheduledAlarm()).not.toBeNull();

    // Eventually both escalate to a reset.
    vi.advanceTimersByTime(10_000);
    expect(await fireDueAlarm(relay, Date.now())).toBe(true);
    expect(control.close).toHaveBeenCalledWith(1011, "Control unresponsive");
  });

  it("does not replace existing client sockets for the same connectionId", async () => {
    const existingClient = createMockSocket({
      version: "2",
      role: "client",
      connectionId: "clt_same_session",
      serverId: "srv_test",
      createdAt: Date.now(),
    });
    const { state, setTagSockets } = createMockState();
    setTagSockets("client:clt_same_session", [existingClient]);
    setTagSockets("client", [existingClient]);

    await withMockWebSocketPair(async () => {
      const relay = new RelayDurableObject(state as unknown as DurableObjectStateArg);
      const req = new Request(
        "https://relay.test/ws?role=client&serverId=srv_test&connectionId=clt_same_session&v=2",
        {
          headers: {
            Upgrade: "websocket",
          },
        },
      );

      await relay.fetch(req).catch(swallow);
      expect(existingClient.close).not.toHaveBeenCalled();
    });
  });

  it("keeps server data socket alive while at least one client socket remains", () => {
    const clientId = "clt_multi";
    const disconnectedClient = createMockSocket({
      version: "2",
      role: "client",
      connectionId: clientId,
      serverId: "srv_test",
      createdAt: Date.now(),
    });
    const stillConnectedClient = createMockSocket({
      version: "2",
      role: "client",
      connectionId: clientId,
      serverId: "srv_test",
      createdAt: Date.now(),
    });
    const serverData = createMockSocket();
    const control = createMockSocket();
    const { state, setTagSockets } = createMockState();

    setTagSockets("server-control", [control]);
    setTagSockets(`server:${clientId}`, [serverData]);
    setTagSockets("client", [stillConnectedClient]);
    setTagSockets(`client:${clientId}`, [stillConnectedClient]);

    const relay = new RelayDurableObject(state as unknown as DurableObjectStateArg);
    relay.webSocketClose(
      disconnectedClient as unknown as WebSocket,
      1001,
      "Client disconnected",
      true,
    );

    expect(serverData.close).not.toHaveBeenCalled();
    expect(control.send).not.toHaveBeenCalledWith(
      JSON.stringify({ type: "disconnected", connectionId: clientId }),
    );
  });
});

describe("relay worker endpoint routing", () => {
  it("routes missing v to legacy v1 isolated DO ids", async () => {
    const fetch = vi.fn(
      async (request: Request) => new Response(`ok:${new URL(request.url).searchParams.get("v")}`),
    );
    const get = vi.fn(() => ({ fetch }));
    const idFromName = vi.fn(() => ({ toString: () => "id" }));

    const response = await relayWorker.fetch(
      new Request("https://relay.test/ws?serverId=srv_test&role=server"),
      { RELAY: { idFromName, get } } as unknown as RelayEnvArg,
    );

    expect(idFromName).toHaveBeenCalledWith("relay-v1:srv_test");
    expect(fetch).toHaveBeenCalledTimes(1);
    await expect(response.text()).resolves.toBe("ok:1");
  });

  it("routes v=2 to v2 isolated DO ids", async () => {
    const fetch = vi.fn(
      async (request: Request) => new Response(`ok:${new URL(request.url).searchParams.get("v")}`),
    );
    const get = vi.fn(() => ({ fetch }));
    const idFromName = vi.fn(() => ({ toString: () => "id" }));

    const response = await relayWorker.fetch(
      new Request("https://relay.test/ws?serverId=srv_test&role=server&v=2"),
      { RELAY: { idFromName, get } } as unknown as RelayEnvArg,
    );

    expect(idFromName).toHaveBeenCalledWith("relay-v2:srv_test");
    expect(fetch).toHaveBeenCalledTimes(1);
    await expect(response.text()).resolves.toBe("ok:2");
  });

  it("rejects invalid v values", async () => {
    const fetch = vi.fn();
    const get = vi.fn(() => ({ fetch }));
    const idFromName = vi.fn(() => ({ toString: () => "id" }));

    const response = await relayWorker.fetch(
      new Request("https://relay.test/ws?serverId=srv_test&role=server&v=nope"),
      { RELAY: { idFromName, get } } as unknown as RelayEnvArg,
    );

    expect(response.status).toBe(400);
    await expect(response.text()).resolves.toBe("Invalid v parameter (expected 1 or 2)");
    expect(idFromName).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
});
