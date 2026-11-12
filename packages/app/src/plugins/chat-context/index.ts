import type { PluginChatContextApi, PluginChatContextItem } from "@getpaseo/plugin/client";
import type { PullRequestContextAttachment } from "@/attachments/types";
import {
  buildWorkspaceAttachmentScopeKey,
  useWorkspaceAttachmentsStore,
} from "@/attachments/workspace-attachments-store";
import { dispatchComposerAgentMessage } from "@/composer/actions";
import { createMessageSubmissionWriter } from "@/composer/submission/writer";
import { queryClient } from "@/data/query-client";
import type { AppSettings } from "@/hooks/use-settings";
import { APP_SETTINGS_QUERY_KEY } from "@/hooks/use-settings/storage";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import { selectAgentTurnPresentation, useSessionStore } from "@/stores/session-store";

/**
 * Plugins add context to a workspace's chat the way the pull request panel does: as composer
 * attachments the user can annotate and send with their message, or send at once from the
 * plugin. A plugin only sees and removes the items it added.
 */
const KINDS = {
  comment: "forge.change_request_comment",
  review: "forge.change_request_review",
  check: "forge.change_request_check",
} as const satisfies Record<PluginChatContextItem["kind"], PullRequestContextAttachment["kind"]>;

export function createPluginChatContext(input: {
  serverId: string;
  pluginId: string;
  signal: AbortSignal;
}): PluginChatContextApi {
  const { serverId, pluginId, signal } = input;
  const prefix = `plugin:${pluginId}:`;
  const scopeKey = (workspaceId: string) =>
    buildWorkspaceAttachmentScopeKey({ serverId, workspaceId, cwd: "" });
  const ownAttachments = (workspaceId: string) =>
    (
      useWorkspaceAttachmentsStore.getState().attachmentsByScope[scopeKey(workspaceId)] ?? []
    ).filter(
      (attachment): attachment is PullRequestContextAttachment =>
        "id" in attachment &&
        typeof attachment.id === "string" &&
        attachment.id.startsWith(prefix) &&
        (Object.values(KINDS) as string[]).includes(attachment.kind),
    );
  const toItem = (attachment: PullRequestContextAttachment): PluginChatContextItem => ({
    id: attachment.id.slice(prefix.length),
    kind: (Object.keys(KINDS) as PluginChatContextItem["kind"][]).find(
      (kind) => KINDS[kind] === attachment.kind,
    )!,
    title: attachment.title,
    subtitle: attachment.subtitle,
    text: attachment.text,
    url: attachment.url ?? undefined,
  });
  const removeIds = (workspaceId: string, ids: Set<string>) => {
    const store = useWorkspaceAttachmentsStore.getState();
    const key = scopeKey(workspaceId);
    const current = store.attachmentsByScope[key] ?? [];
    store.setWorkspaceAttachments({
      scopeKey: key,
      attachments: current.filter(
        (attachment) =>
          !("id" in attachment && typeof attachment.id === "string" && ids.has(attachment.id)),
      ),
    });
  };

  return {
    add({ workspaceId, item }) {
      if (signal.aborted) return;
      const attachment = {
        kind: KINDS[item.kind],
        id: `${prefix}${item.id}`,
        title: item.title,
        ...(item.subtitle ? { subtitle: item.subtitle } : {}),
        text: item.text,
        url: item.url ?? null,
      } as PullRequestContextAttachment;
      useWorkspaceAttachmentsStore
        .getState()
        .addWorkspaceAttachment({ scopeKey: scopeKey(workspaceId), attachment });
    },
    list(workspaceId) {
      return ownAttachments(workspaceId).map(toItem);
    },
    subscribe(workspaceId, listener) {
      let previous = ownAttachments(workspaceId);
      const unsubscribe = useWorkspaceAttachmentsStore.subscribe(() => {
        const next = ownAttachments(workspaceId);
        if (
          next.length === previous.length &&
          next.every((attachment, index) => attachment === previous[index])
        )
          return;
        previous = next;
        listener(next.map(toItem));
      });
      signal.addEventListener("abort", unsubscribe, { once: true });
      return unsubscribe;
    },
    remove(workspaceId, id) {
      removeIds(workspaceId, new Set([`${prefix}${id}`]));
    },
    clear(workspaceId) {
      removeIds(
        workspaceId,
        new Set(ownAttachments(workspaceId).map((attachment) => attachment.id)),
      );
    },
    async send({ workspaceId, agentId, text }) {
      const client = getHostRuntimeStore().getSnapshot(serverId)?.client ?? null;
      if (!client) throw new Error("The host is disconnected.");
      const attachments = ownAttachments(workspaceId);
      if (attachments.length === 0) return;
      const sendBehavior =
        queryClient.getQueryData<AppSettings>(APP_SETTINGS_QUERY_KEY)?.sendBehavior ?? "steer";
      const activeTurnBehavior = sendBehavior === "steer" ? "steer" : "interrupt";
      await dispatchComposerAgentMessage({
        client,
        agentId,
        text,
        attachments: [...attachments],
        encodeImages: async () => [],
        submission: createMessageSubmissionWriter(serverId),
        activeTurnBehavior,
        activeTurnId:
          activeTurnBehavior === "steer"
            ? (selectAgentTurnPresentation(useSessionStore.getState().sessions[serverId], agentId)
                .turnId ?? undefined)
            : undefined,
      });
      removeIds(workspaceId, new Set(attachments.map((attachment) => attachment.id)));
    },
  };
}
