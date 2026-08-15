/**
 * FORK: the `dataSet` builders and `TRAILING_CODE_LINE_BREAKS` below survive.
 * Upstream also exported the six `MARKDOWN_COPY_*_ATTRIBUTE` attribute names for its
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
  blockquote: { paseoMarkdownTag: "blockquote" },
  br: { paseoMarkdownTag: "br" },
  code: { paseoMarkdownTag: "code" },
  h1: { paseoMarkdownTag: "h1" },
  h2: { paseoMarkdownTag: "h2" },
  h3: { paseoMarkdownTag: "h3" },
  h4: { paseoMarkdownTag: "h4" },
  h5: { paseoMarkdownTag: "h5" },
  h6: { paseoMarkdownTag: "h6" },
  hr: { paseoMarkdownTag: "hr" },
  ignore: { paseoMarkdownIgnore: "true" },
  li: { paseoMarkdownTag: "li" },
  listMarker: { paseoMarkdownIgnore: "true", paseoMarkdownListMarker: "true" },
  ol: { paseoMarkdownTag: "ol" },
  p: { paseoMarkdownTag: "p" },
  pre: { paseoMarkdownTag: "pre" },
  s: { paseoMarkdownTag: "s" },
  strong: { paseoMarkdownTag: "strong" },
  em: { paseoMarkdownTag: "em" },
  table: { paseoMarkdownTag: "table" },
  tbody: { paseoMarkdownTag: "tbody" },
  td: { paseoMarkdownTag: "td" },
  th: { paseoMarkdownTag: "th" },
  thead: { paseoMarkdownTag: "thead" },
  tr: { paseoMarkdownTag: "tr" },
  ul: { paseoMarkdownTag: "ul" },
  unwrap: { paseoMarkdownUnwrap: "true" },
} as const;

export type MarkdownCopyInlineTag = "br" | "code" | "em" | "s" | "strong";

export function markdownCopyOrderedListDataSet(start: unknown) {
  return {
    ...markdownCopyDataSet.ol,
    paseoMarkdownListStart: String(start ?? 1),
  } as const;
}

export function markdownCopyCodeBlockDataSet(language: string | null | undefined) {
  const fenceLanguage = language?.trim().split(/\s+/)[0];
  return {
    ...markdownCopyDataSet.pre,
    ...(fenceLanguage ? { paseoMarkdownLanguage: fenceLanguage } : {}),
  } as const;
}

export function markdownCopyTableCellDataSet(tag: "td" | "th", style: unknown) {
  const alignment =
    typeof style === "string"
      ? style.match(/(?:^|;)\s*text-align\s*:\s*(left|right|center)/i)?.[1]
      : null;
  return {
    ...markdownCopyDataSet[tag],
    ...(alignment ? { paseoMarkdownAlign: alignment.toLowerCase() } : {}),
  } as const;
}
