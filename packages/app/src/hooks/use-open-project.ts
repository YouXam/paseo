import { useCallback } from "react";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import { navigateToWorkspace } from "@/stores/navigation-active-workspace-store";
import {
  openGithubRepoDirectly,
  openProjectDirectly,
  type OpenProjectResult,
  type WorkspaceGithubCloneProtocol,
} from "@/hooks/open-project";

export function useOpenProject(
  serverId: string | null,
): (path: string) => Promise<OpenProjectResult> {
  const normalizedServerId = serverId?.trim() ?? "";
  const client = useHostRuntimeClient(normalizedServerId);
  const isConnected = useHostRuntimeIsConnected(normalizedServerId);
  const canAddProject = useSessionStore((state) =>
    normalizedServerId
      ? state.sessions[normalizedServerId]?.serverInfo?.features?.projectAdd === true
      : false,
  );
  const addEmptyProject = useSessionStore((state) => state.addEmptyProject);
  const mergeWorkspaces = useSessionStore((state) => state.mergeWorkspaces);
  const setHasHydratedWorkspaces = useSessionStore((state) => state.setHasHydratedWorkspaces);

  return useCallback(
    async (path: string) => {
      const result = await openProjectDirectly({
        serverId: normalizedServerId,
        projectPath: path,
        isConnected,
        canAddProject,
        client,
        addEmptyProject,
        mergeWorkspaces,
        setHasHydratedWorkspaces,
      });
      if (result.ok && result.workspaceId) {
        navigateToWorkspace({
          serverId: normalizedServerId,
          workspaceId: result.workspaceId,
        });
      }
      return result;
    },
    [
      addEmptyProject,
      canAddProject,
      client,
      isConnected,
      mergeWorkspaces,
      normalizedServerId,
      setHasHydratedWorkspaces,
    ],
  );
}

export function useOpenGithubRepo(
  serverId: string | null,
): (
  repo: string,
  targetDirectory: string,
  cloneProtocol?: WorkspaceGithubCloneProtocol,
) => Promise<boolean> {
  const normalizedServerId = serverId?.trim() ?? "";
  const client = useHostRuntimeClient(normalizedServerId);
  const isConnected = useHostRuntimeIsConnected(normalizedServerId);
  const mergeWorkspaces = useSessionStore((state) => state.mergeWorkspaces);
  const setHasHydratedWorkspaces = useSessionStore((state) => state.setHasHydratedWorkspaces);

  return useCallback(
    async (repo: string, targetDirectory: string, cloneProtocol?: WorkspaceGithubCloneProtocol) => {
      return openGithubRepoDirectly({
        serverId: normalizedServerId,
        repo,
        targetDirectory,
        ...(cloneProtocol ? { cloneProtocol } : {}),
        isConnected,
        client,
        mergeWorkspaces,
        setHasHydratedWorkspaces,
        navigateToWorkspace,
      });
    },
    [client, isConnected, mergeWorkspaces, normalizedServerId, setHasHydratedWorkspaces],
  );
}
