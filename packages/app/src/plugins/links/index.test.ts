import { describe, expect, it, vi } from "vitest";
import { openPluginLink, registerPluginLinkHandler } from "./index";

const NEW_MR =
  "https://gitlab.example.com/group/project/-/merge_requests/new?merge_request%5Bsource_branch%5D=x";

describe("plugin link handlers", () => {
  it("offers links only to handlers of the host they were pressed on", () => {
    const lifetime = new AbortController();
    const open = vi.fn(() => true);
    registerPluginLinkHandler(
      "srv-a",
      "gitlab-mr",
      { id: "new", matches: (url) => url.includes("/merge_requests/new"), open },
      lifetime.signal,
    );

    expect(openPluginLink({ url: NEW_MR, serverId: "srv-b", workspaceDirectory: "/repo" })).toBe(
      false,
    );
    expect(openPluginLink({ url: NEW_MR, serverId: "srv-a", workspaceDirectory: "/repo" })).toBe(
      true,
    );
    expect(open).toHaveBeenCalledWith({ url: NEW_MR, workspaceDirectory: "/repo" });
    expect(
      openPluginLink({
        url: "https://example.com/other",
        serverId: "srv-a",
        workspaceDirectory: "/repo",
      }),
    ).toBe(false);
    expect(
      openPluginLink({ url: "src/app.ts", serverId: "srv-a", workspaceDirectory: "/repo" }),
    ).toBe(false);
    lifetime.abort();
  });

  it("falls back to the browser when a handler declines or throws, and drops handlers with their plugin", () => {
    const lifetime = new AbortController();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    registerPluginLinkHandler(
      "srv-a",
      "declines",
      { id: "a", matches: () => true, open: () => false },
      lifetime.signal,
    );
    registerPluginLinkHandler(
      "srv-a",
      "throws",
      {
        id: "b",
        matches: () => true,
        open: () => {
          throw new Error("boom");
        },
      },
      lifetime.signal,
    );
    expect(openPluginLink({ url: NEW_MR, serverId: "srv-a", workspaceDirectory: null })).toBe(
      false,
    );
    expect(warn).toHaveBeenCalled();

    const open = vi.fn(() => true);
    const plugin = new AbortController();
    registerPluginLinkHandler(
      "srv-a",
      "gitlab-mr",
      { id: "new", matches: () => true, open },
      plugin.signal,
    );
    plugin.abort();
    expect(openPluginLink({ url: NEW_MR, serverId: "srv-a", workspaceDirectory: null })).toBe(
      false,
    );
    expect(open).not.toHaveBeenCalled();
    lifetime.abort();
    warn.mockRestore();
  });
});
