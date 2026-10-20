import type { Query } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, test, vi } from "vitest";

import { createTestLogger } from "../../../../test-utils/test-logger.js";
import { ClaudeAgentClient } from "./agent.js";

function createQueryMock(events: unknown[]): Query {
  let index = 0;
  return {
    next: vi.fn(async () =>
      index < events.length
        ? { done: false, value: events[index++] }
        : { done: true, value: undefined },
    ),
    return: vi.fn(async () => ({ done: true, value: undefined })),
    interrupt: vi.fn(async () => undefined),
    close: vi.fn(() => undefined),
    setPermissionMode: vi.fn(async () => undefined),
    setModel: vi.fn(async () => undefined),
    supportedModels: vi.fn(async () => [{ value: "opus", displayName: "Opus" }]),
    supportedCommands: vi.fn(async () => []),
    rewindFiles: vi.fn(async () => ({ canRewind: true })),
    [Symbol.asyncIterator]() {
      return this;
    },
  } as Query;
}

async function runWithInitModel(input: {
  configuredModel?: string;
  runtimeModel: string;
}): Promise<string | null | undefined> {
  const client = new ClaudeAgentClient({
    logger: createTestLogger(),
    resolveBinary: async () => "/test/claude/bin",
    queryFactory: () =>
      createQueryMock([
        {
          type: "system",
          subtype: "init",
          session_id: "runtime-model-session",
          permissionMode: "default",
          model: input.runtimeModel,
        },
        { type: "assistant", message: { content: "done" } },
        {
          type: "result",
          subtype: "success",
          usage: { input_tokens: 1, cache_read_input_tokens: 0, output_tokens: 1 },
          total_cost_usd: 0,
        },
      ]),
  });
  const session = await client.createSession({
    provider: "claude",
    cwd: process.cwd(),
    ...(input.configuredModel ? { model: input.configuredModel } : {}),
  });
  try {
    await session.run("hello");
    return (await session.getRuntimeInfo()).model;
  } finally {
    await session.close();
  }
}

describe("Claude runtime model", () => {
  test("reports the configured gateway model instead of a first-party lookalike", async () => {
    await expect(
      runWithInitModel({
        configuredModel: "anthropic/claude-opus-5.5[1m]",
        runtimeModel: "anthropic/claude-opus-5.5[1m]",
      }),
    ).resolves.toBe("anthropic/claude-opus-5.5[1m]");
  });

  test("normalizes the runtime model when no model is configured", async () => {
    await expect(runWithInitModel({ runtimeModel: "claude-opus-5-20260724" })).resolves.toBe(
      "claude-opus-5",
    );
  });
});
