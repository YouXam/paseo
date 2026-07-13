import { describe, expect, it } from "vitest";
import {
  getOpenProjectFailureReason,
  openGithubRepoDirectly,
  openProjectDirectly,
} from "@/hooks/open-project";
import type {
  EmptyProjectDescriptor as ProjectWithoutWorkspacesDescriptor,
  WorkspaceDescriptor,
} from "@/stores/session-store";
import type { NavigateToWorkspaceInput } from "@/stores/navigation-active-workspace-store";

const SERVER_ID = "server-1";
const PROJECT_PATH = "/repo/project";
const WORKTREE_PATH = "/repo-worktrees/feature-a";

function buildProjectPayload() {
  return {
    projectId: "project-1",
    projectDisplayName: "project",
    projectRootPath: PROJECT_PATH,
    projectKind: "git" as const,
  };
}

function buildWorkspacePayload() {
  return {
    id: "1",
    projectId: "1",
    projectDisplayName: "project",
    projectRootPath: PROJECT_PATH,
    workspaceDirectory: PROJECT_PATH,
    projectKind: "git" as const,
    workspaceKind: "checkout" as const,
    name: "project",
    archivingAt: null,
    status: "done" as const,
    statusEnteredAt: null,
    activityAt: null,
    diffStat: null,
    scripts: [],
  };
}

interface RecordedProject {
  serverId: string;
  project: ProjectWithoutWorkspacesDescriptor;
}

interface RecordedMerge {
  serverId: string;
  workspaces: WorkspaceDescriptor[];
}

interface RecordedHydrated {
  serverId: string;
  hydrated: boolean;
}

interface RecordedClone {
  repo: string;
  targetDirectory: string;
  cloneProtocol?: "https" | "ssh";
}

function createFakeSession() {
  const projects: RecordedProject[] = [];
  const merges: RecordedMerge[] = [];
  const hydrated: RecordedHydrated[] = [];
  return {
    projects,
    merges,
    hydrated,
    addEmptyProject: (serverId: string, project: ProjectWithoutWorkspacesDescriptor) => {
      projects.push({ serverId, project });
    },
    mergeWorkspaces: (serverId: string, workspaces: Iterable<WorkspaceDescriptor>) => {
      merges.push({ serverId, workspaces: Array.from(workspaces) });
    },
    setHasHydratedWorkspaces: (serverId: string, value: boolean) => {
      hydrated.push({ serverId, hydrated: value });
    },
  };
}

function createFakeNavigator() {
  const navigations: NavigateToWorkspaceInput[] = [];
  return {
    navigations,
    navigateToWorkspace: (input: NavigateToWorkspaceInput) => {
      navigations.push(input);
      return `/hosts/${input.serverId}/workspaces/${input.workspaceId}`;
    },
  };
}

function createFakeGithubCloneClient(workspace: ReturnType<typeof buildWorkspacePayload>) {
  const clones: RecordedClone[] = [];
  return {
    clones,
    cloneGithubWorkspace: async (input: RecordedClone) => {
      clones.push(input);
      return {
        requestId: "request-3",
        repo: "owner/project",
        checkoutPath: PROJECT_PATH,
        error: null,
        workspace,
      };
    },
  };
}

describe("openProjectDirectly", () => {
  it("adds the project and marks workspaces hydrated without opening a workspace", async () => {
    const session = createFakeSession();
    const projectPayload = buildProjectPayload();

    const result = await openProjectDirectly({
      serverId: SERVER_ID,
      projectPath: PROJECT_PATH,
      isConnected: true,
      canAddProject: true,
      client: {
        getCheckoutStatus: async () =>
          ({
            isGit: true,
            mainRepoRoot: null,
          }) as never,
        createWorkspace: async () => {
          throw new Error("createWorkspace should not be called");
        },
        addProject: async () => ({
          requestId: "request-1",
          error: null,
          project: projectPayload,
        }),
      },
      addEmptyProject: session.addEmptyProject,
      mergeWorkspaces: session.mergeWorkspaces,
      setHasHydratedWorkspaces: session.setHasHydratedWorkspaces,
    });

    expect(result).toEqual({ ok: true, workspaceId: null });
    expect(session.projects).toEqual([
      {
        serverId: SERVER_ID,
        project: {
          projectId: "project-1",
          projectDisplayName: "project",
          projectCustomName: null,
          projectKind: "git",
          projectRootPath: PROJECT_PATH,
        },
      },
    ]);
    expect(session.merges).toEqual([]);
    expect(session.hydrated).toEqual([{ serverId: SERVER_ID, hydrated: true }]);
  });

  it("opens an existing git worktree as a workspace instead of adding the project again", async () => {
    const session = createFakeSession();
    let addProjectCalled = false;

    const result = await openProjectDirectly({
      serverId: SERVER_ID,
      projectPath: WORKTREE_PATH,
      isConnected: true,
      canAddProject: true,
      client: {
        getCheckoutStatus: async () =>
          ({
            isGit: true,
            mainRepoRoot: "/repo/project",
          }) as never,
        createWorkspace: async () => ({
          requestId: "request-worktree",
          error: null,
          setupTerminalId: null,
          workspace: {
            id: "wks_feature_a",
            projectId: "project-1",
            projectDisplayName: "project",
            projectCustomName: null,
            projectRootPath: "/repo/project",
            workspaceDirectory: WORKTREE_PATH,
            projectKind: "git",
            workspaceKind: "worktree",
            name: "feature-a",
            title: null,
            archivingAt: null,
            status: "done",
            statusEnteredAt: null,
            activityAt: null,
            diffStat: null,
            scripts: [],
            gitRuntime: null,
            githubRuntime: null,
          },
        }),
        addProject: async () => {
          addProjectCalled = true;
          return {
            requestId: "request-unexpected",
            error: null,
            project: buildProjectPayload(),
          };
        },
      },
      addEmptyProject: session.addEmptyProject,
      mergeWorkspaces: session.mergeWorkspaces,
      setHasHydratedWorkspaces: session.setHasHydratedWorkspaces,
    });

    expect(result).toEqual({ ok: true, workspaceId: "wks_feature_a" });
    expect(addProjectCalled).toBe(false);
    expect(session.projects).toEqual([]);
    expect(session.merges).toEqual([
      {
        serverId: SERVER_ID,
        workspaces: [
          expect.objectContaining({
            id: "wks_feature_a",
            workspaceDirectory: WORKTREE_PATH,
            workspaceKind: "worktree",
          }),
        ],
      },
    ]);
    expect(session.hydrated).toEqual([{ serverId: SERVER_ID, hydrated: true }]);
  });

  it("fails before sending when the host does not support adding projects without workspaces", async () => {
    const session = createFakeSession();
    const result = await openProjectDirectly({
      serverId: SERVER_ID,
      projectPath: PROJECT_PATH,
      isConnected: true,
      canAddProject: false,
      client: {
        getCheckoutStatus: async () => {
          throw new Error("getCheckoutStatus should not be called");
        },
        createWorkspace: async () => {
          throw new Error("createWorkspace should not be called");
        },
        addProject: async () => ({
          requestId: "request-unsupported",
          error: null,
          project: buildProjectPayload(),
        }),
      },
      addEmptyProject: session.addEmptyProject,
      mergeWorkspaces: session.mergeWorkspaces,
      setHasHydratedWorkspaces: session.setHasHydratedWorkspaces,
    });

    expect(result).toEqual({
      ok: false,
      errorCode: null,
      error: "Update the host to add projects without creating a workspace.",
    });
    expect(session.projects).toEqual([]);
    expect(session.hydrated).toEqual([]);
  });

  it("does not add a project when addProject fails", async () => {
    const session = createFakeSession();

    const result = await openProjectDirectly({
      serverId: SERVER_ID,
      projectPath: PROJECT_PATH,
      isConnected: true,
      canAddProject: true,
      client: {
        getCheckoutStatus: async () =>
          ({
            isGit: true,
            mainRepoRoot: null,
          }) as never,
        createWorkspace: async () => {
          throw new Error("createWorkspace should not be called");
        },
        addProject: async () => ({
          requestId: "request-2",
          error: "Directory not found: /repo/project",
          errorCode: "directory_not_found" as const,
          project: null,
        }),
      },
      addEmptyProject: session.addEmptyProject,
      mergeWorkspaces: session.mergeWorkspaces,
      setHasHydratedWorkspaces: session.setHasHydratedWorkspaces,
    });

    expect(result).toEqual({
      ok: false,
      errorCode: "directory_not_found",
      error: "Directory not found: /repo/project",
    });
    expect(session.projects).toEqual([]);
    expect(session.hydrated).toEqual([]);
  });
});

describe("openGithubRepoDirectly", () => {
  it("opens a cloned GitHub workspace and seeds a draft tab", async () => {
    const session = createFakeSession();
    const navigator = createFakeNavigator();
    const workspacePayload = buildWorkspacePayload();
    const github = createFakeGithubCloneClient(workspacePayload);

    const result = await openGithubRepoDirectly({
      serverId: SERVER_ID,
      repo: "owner/project",
      targetDirectory: "~/workspace",
      cloneProtocol: "https",
      isConnected: true,
      client: github,
      mergeWorkspaces: session.mergeWorkspaces,
      setHasHydratedWorkspaces: session.setHasHydratedWorkspaces,
      navigateToWorkspace: navigator.navigateToWorkspace,
    });

    expect(result).toBe(true);
    expect(github.clones).toEqual([
      {
        repo: "owner/project",
        targetDirectory: "~/workspace",
        cloneProtocol: "https",
      },
    ]);
    expect(session.merges).toHaveLength(1);
    expect(session.merges[0]?.serverId).toBe(SERVER_ID);
    expect(session.merges[0]?.workspaces[0]).toMatchObject({
      id: "1",
      projectId: "1",
      projectRootPath: PROJECT_PATH,
      workspaceDirectory: PROJECT_PATH,
    });
    expect(session.hydrated).toEqual([{ serverId: SERVER_ID, hydrated: true }]);
    expect(navigator.navigations).toEqual([
      {
        serverId: SERVER_ID,
        workspaceId: "1",
        target: { kind: "draft", draftId: expect.any(String) },
      },
    ]);
  });

  it("rejects a workspace without an identity before changing app state", async () => {
    const session = createFakeSession();
    const navigator = createFakeNavigator();
    const github = createFakeGithubCloneClient({ ...buildWorkspacePayload(), id: " " });

    const result = await openGithubRepoDirectly({
      serverId: SERVER_ID,
      repo: "owner/project",
      targetDirectory: "~/workspace",
      cloneProtocol: "https",
      isConnected: true,
      client: github,
      mergeWorkspaces: session.mergeWorkspaces,
      setHasHydratedWorkspaces: session.setHasHydratedWorkspaces,
      navigateToWorkspace: navigator.navigateToWorkspace,
    });

    expect(result).toBe(false);
    expect(session.merges).toEqual([]);
    expect(session.hydrated).toEqual([]);
    expect(navigator.navigations).toEqual([]);
  });
});

describe("getOpenProjectFailureReason", () => {
  it("keeps the known directory-not-found failure reason", () => {
    expect(
      getOpenProjectFailureReason({
        ok: false,
        errorCode: "directory_not_found",
        error: "Directory not found: /missing",
      }),
    ).toBe("directory_not_found");
  });

  it("uses the generic failure reason for untyped project-open failures", () => {
    expect(getOpenProjectFailureReason({ ok: false, errorCode: null, error: "boom" })).toBe(
      "open_failed",
    );
  });
});
