import type { ParsedDiffFile } from "@/git/use-diff-query";

export function getParsedDiffFileKey(file: ParsedDiffFile): string {
  return file.changeSource ? `${file.changeSource}:${file.path}` : file.path;
}
