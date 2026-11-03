/**
 * FORK: the `dataSet` builders and `TRAILING_CODE_LINE_BREAKS` below survive.
 * Upstream also exports the `MARKDOWN_COPY_*_ATTRIBUTE` attribute names for its
 * selection-to-Markdown serializer; this fork deleted that serializer (see
 * `surface.tsx`), so the names had no reader left.
 *
 * The attributes themselves still get stamped onto the rendered tree by
 * `message.tsx` and are asserted by the browser e2e suite. Keeping them is what
 * lets this fork leave `message.tsx` alone across upstream merges.
 */

/**
 * Trailing line breaks, with any indentation that followed the last one.
 *
 * The copy button strips these because pasting a trailing newline into a terminal
 * runs the last line. A fence body always ends in one, and ends in several when the
 * author left blank lines before the closing fence.
 */
export const TRAILING_CODE_LINE_BREAKS = /(\r?\n[ \t]*)+$/;

export const markdownCopyDataSet = {
  code: { paseoMarkdownTag: "code" },
  pre: { paseoMarkdownTag: "pre" },
  ignore: { paseoMarkdownIgnore: "true" },
} as const;

export function markdownCopyCodeBlockDataSet(language: string | null | undefined) {
  const fenceLanguage = language?.trim().split(/\s+/)[0];
  return {
    ...markdownCopyDataSet.pre,
    ...(fenceLanguage ? { paseoMarkdownLanguage: fenceLanguage } : {}),
  } as const;
}

export const MARKDOWN_COPY_IMAGE_SOURCES_ATTRIBUTE = "data-paseo-markdown-image-sources";
export function markdownCopyImageSourcesDataSet(sources: Record<string, string>) {
  return { paseoMarkdownImageSources: JSON.stringify(sources) };
}
