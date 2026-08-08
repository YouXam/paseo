import type { ReactNode } from "react";
import { View, type StyleProp, type ViewStyle } from "react-native";

/**
 * FORK: plain wrapper on every platform, web included.
 *
 * Upstream (#2808) ships a `surface.web.tsx` that intercepts the `copy` event
 * over the transcript, reserializes the DOM selection back to Markdown with
 * turndown, and writes that as `text/plain`. Selecting a sentence and pressing
 * Cmd+C then yields `**bold**`, `- item`, `| a | b |` — Markdown source instead
 * of the words on screen. This fork deletes that file, so Metro resolves this
 * platform-neutral version for web too and the browser's own plain-text copy
 * takes over.
 *
 * The copy BUTTON is untouched: it still writes Markdown plus rich HTML through
 * `writeMarkdownToRichClipboard`, which is what a "copy message" action is for.
 *
 * `markup.ts` and the `data-paseo-markdown-*` attributes it stamps across
 * `message.tsx` deliberately stay. They are inert without the interceptor, and
 * keeping them means this fork never has to touch `message.tsx`; the browser e2e
 * suite also asserts font rendering against those attributes. Re-deleting
 * `surface.web.tsx` after an upstream merge is the whole maintenance cost.
 */
interface AssistantSelectionCopySurfaceProps {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
}

export function AssistantSelectionCopySurface({
  children,
  style,
}: AssistantSelectionCopySurfaceProps) {
  return <View style={style}>{children}</View>;
}
