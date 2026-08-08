import type { BrowserContext } from "@playwright/test";
import { expect, test, type Page } from "../support/fixtures";
import { openAgentRoute, seedMockAgentWorkspace } from "../support/helpers/mock-agent";

/**
 * FORK: this file replaces the upstream spec (#2808) that asserted a selection
 * copy produces Markdown source. This fork deletes the `copy` interceptor
 * (`assistant-selection-copy/surface.tsx` explains why), so a selection copy is
 * the browser's own plain text — the words on screen, no Markdown syntax.
 *
 * The rendering assertions are kept from the upstream spec: the fork still stamps
 * `data-paseo-markdown-*` attributes across `message.tsx`, and this is the only
 * place that guards them.
 */
const ASSISTANT_MARKDOWN = [
  "Direct matches:",
  "",
  "Formatted **strong prose**, _emphasized prose_, and ~~struck prose~~.",
  "",
  "- **[First issue](https://example.com/issues/1)**: exact `apply_patch` failure.",
  "- [Second issue](https://example.com/issues/2): repeated sandbox setup.",
  "",
  "| Left | Right |",
  "| :-- | --: |",
  "| Current | ready |",
].join("\n");

/** Syntax that must never reach the clipboard's plain-text flavor again. */
const MARKDOWN_SYNTAX = ["**", "~~", "](https://", "`", "| :--"];

async function allowRichClipboard(context: BrowserContext): Promise<void> {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
}

async function selectAssistantMessage(page: Page): Promise<void> {
  const assistantMessage = page.getByTestId("assistant-message").filter({
    hasText: "Direct matches:",
  });
  await expect(assistantMessage).toBeVisible();
  await assistantMessage.evaluate((element) => {
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(element);
    selection?.removeAllRanges();
    selection?.addRange(range);
  });
}

test("copying an assistant selection yields the visible text, not Markdown source", async ({
  context,
  page,
}) => {
  await page.addInitScript(() => {
    localStorage.setItem("@paseo:app-settings", JSON.stringify({ uiFontFamily: "serif" }));
  });
  const agent = await seedMockAgentWorkspace({
    repoPrefix: "assistant-selection-copy-",
    title: "Assistant selection copy",
    initialPrompt: "Render the clipboard fixture.",
    featureValues: { mockAssistantResponse: ASSISTANT_MARKDOWN },
  });

  try {
    await allowRichClipboard(context);
    await agent.client.waitForAgentUpsert(
      agent.agentId,
      (snapshot) => snapshot.status === "idle",
      30_000,
    );
    await openAgentRoute(page, agent);

    const assistantMessage = page.getByTestId("assistant-message").filter({
      hasText: "Direct matches:",
    });
    for (const [tag, text] of [
      ["strong", "strong prose"],
      ["em", "emphasized prose"],
      ["s", "struck prose"],
    ]) {
      const formattedProse = assistantMessage
        .locator(`[data-paseo-markdown-tag="${tag}"]`)
        .filter({ hasText: text });
      await expect(formattedProse).toHaveCSS("font-family", "serif");
      await expect(formattedProse).not.toHaveAttribute("data-pmono");
    }
    const inlineCode = assistantMessage
      .locator('[data-paseo-markdown-tag="code"]')
      .filter({ hasText: "apply_patch" });
    await expect(inlineCode).toHaveAttribute("data-pmono", "");

    await selectAssistantMessage(page);
    await page.keyboard.press("ControlOrMeta+c");

    const plainText = await page.evaluate(() => navigator.clipboard.readText());

    for (const visible of [
      "Direct matches:",
      "strong prose",
      "emphasized prose",
      "struck prose",
      "First issue",
      "apply_patch",
      "Second issue",
      "ready",
    ]) {
      expect(plainText).toContain(visible);
    }
    for (const syntax of MARKDOWN_SYNTAX) {
      expect(plainText).not.toContain(syntax);
    }
  } finally {
    await agent.cleanup();
  }
});
