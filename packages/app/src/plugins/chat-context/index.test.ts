import { beforeEach, describe, expect, it, vi } from "vitest";

const dispatch = vi.fn(async (_input: unknown) => undefined);
vi.mock("@/composer/actions", () => ({
  dispatchComposerAgentMessage: (input: unknown) => dispatch(input),
}));
vi.mock("@/composer/submission/writer", () => ({ createMessageSubmissionWriter: () => ({}) }));
vi.mock("@/runtime/host-runtime", () => ({
  getHostRuntimeStore: () => ({ getSnapshot: () => ({ client: { sendAgentMessage: vi.fn() } }) }),
}));
vi.mock("@/stores/session-store", () => ({
  useSessionStore: { getState: () => ({ sessions: {} }) },
  selectAgentTurnPresentation: () => ({ turnId: null }),
}));

import {
  buildWorkspaceAttachmentScopeKey,
  resetWorkspaceAttachmentsStore,
  useWorkspaceAttachmentsStore,
} from "@/attachments/workspace-attachments-store";
import { createPluginChatContext } from "./index";

const item = (id: string) => ({
  id,
  kind: "comment" as const,
  title: `Comment ${id}`,
  text: `body ${id}`,
  url: "https://gl/x",
});

beforeEach(() => {
  resetWorkspaceAttachmentsStore();
  dispatch.mockClear();
});

describe("plugin chat context", () => {
  it("adds composer attachments for the workspace and lists only its own items", () => {
    const lifetime = new AbortController();
    const chat = createPluginChatContext({
      serverId: "srv",
      pluginId: "gitlab-mr",
      signal: lifetime.signal,
    });
    const other = createPluginChatContext({
      serverId: "srv",
      pluginId: "other",
      signal: lifetime.signal,
    });
    chat.add({ workspaceId: "wks", item: item("1") });
    chat.add({ workspaceId: "wks", item: item("1") });
    chat.add({ workspaceId: "wks", item: { ...item("2"), kind: "check" } });
    other.add({ workspaceId: "wks", item: item("1") });

    const key = buildWorkspaceAttachmentScopeKey({ serverId: "srv", workspaceId: "wks", cwd: "" });
    const attachments = useWorkspaceAttachmentsStore.getState().attachmentsByScope[key]!;
    expect(attachments.map((attachment) => attachment.kind)).toEqual([
      "forge.change_request_comment",
      "forge.change_request_check",
      "forge.change_request_comment",
    ]);
    expect(chat.list("wks").map((entry) => [entry.id, entry.kind])).toEqual([
      ["1", "comment"],
      ["2", "check"],
    ]);

    chat.remove("wks", "1");
    expect(chat.list("wks").map((entry) => entry.id)).toEqual(["2"]);
    chat.clear("wks");
    expect(chat.list("wks")).toEqual([]);
    expect(other.list("wks")).toHaveLength(1);
    lifetime.abort();
  });

  it("notifies subscribers and stops when the plugin stops", () => {
    const lifetime = new AbortController();
    const chat = createPluginChatContext({
      serverId: "srv",
      pluginId: "gitlab-mr",
      signal: lifetime.signal,
    });
    const listener = vi.fn();
    chat.subscribe("wks", listener);
    chat.add({ workspaceId: "wks", item: item("1") });
    expect(listener).toHaveBeenLastCalledWith([expect.objectContaining({ id: "1" })]);
    lifetime.abort();
    chat.add({ workspaceId: "wks", item: item("2") });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("sends its items to an agent with the text, then removes them", async () => {
    const lifetime = new AbortController();
    const chat = createPluginChatContext({
      serverId: "srv",
      pluginId: "gitlab-mr",
      signal: lifetime.signal,
    });
    chat.add({ workspaceId: "wks", item: item("1") });
    chat.add({ workspaceId: "wks", item: item("2") });
    await chat.send({ workspaceId: "wks", agentId: "agent-1", text: "Please handle these." });
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "agent-1",
        text: "Please handle these.",
        attachments: [
          expect.objectContaining({
            id: "plugin:gitlab-mr:1",
            kind: "forge.change_request_comment",
          }),
          expect.objectContaining({ id: "plugin:gitlab-mr:2" }),
        ],
      }),
    );
    expect(chat.list("wks")).toEqual([]);
    lifetime.abort();
  });
});
