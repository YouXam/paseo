import type { PluginLinkHandlerContribution } from "@getpaseo/plugin/client";

/**
 * Links plugins take over from Markdown, e.g. a GitLab "new merge request" link that opens the
 * plugin's own form. Handlers belong to the host their plugin is installed on and only see links
 * pressed in that host's workspaces.
 */
interface RegisteredLinkHandler {
  serverId: string;
  pluginId: string;
  contribution: PluginLinkHandlerContribution;
}

const handlers = new Set<RegisteredLinkHandler>();

export function registerPluginLinkHandler(
  serverId: string,
  pluginId: string,
  contribution: PluginLinkHandlerContribution,
  signal: AbortSignal,
): () => void {
  if (
    !contribution ||
    typeof contribution.matches !== "function" ||
    typeof contribution.open !== "function"
  ) {
    throw new Error("addLinkHandler takes { id, matches(url), open({ url, workspaceDirectory }) }");
  }
  const entry: RegisteredLinkHandler = { serverId, pluginId, contribution };
  handlers.add(entry);
  const remove = () => {
    handlers.delete(entry);
    signal.removeEventListener("abort", remove);
  };
  signal.addEventListener("abort", remove);
  return remove;
}

/** Offers `url` to the plugins on `serverId`; true when one of them handled it. */
export function openPluginLink(input: {
  url: string;
  serverId: string | null | undefined;
  workspaceDirectory: string | null | undefined;
}): boolean {
  if (!input.serverId || !/^https?:\/\//i.test(input.url)) return false;
  for (const handler of handlers) {
    if (handler.serverId !== input.serverId) continue;
    try {
      if (!handler.contribution.matches(input.url)) continue;
      if (
        handler.contribution.open({
          url: input.url,
          workspaceDirectory: input.workspaceDirectory ?? null,
        }) === true
      ) {
        return true;
      }
    } catch (error) {
      console.warn(`[plugins] ${handler.pluginId} link handler failed`, error);
    }
  }
  return false;
}
