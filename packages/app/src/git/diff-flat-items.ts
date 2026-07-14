import type { ParsedDiffFile } from "@/git/use-diff-query";
import { getParsedDiffFileKey } from "@/git/diff-file-identity";
import {
  buildDiffTree,
  compressSingleChildChains,
  flattenDiffTree,
  type DiffTreeDirNode,
} from "@/git/diff-tree";

// The row model for the Changes FlatList. `fileIndex` is the file's index within
// the (path-sorted) `files` array — a stable identity for testIDs/keys that is
// independent of folder rows and collapse state. `depth` drives indentation.
export type DiffFlatItem =
  | {
      type: "changeGroup";
      source: DiffChangeSource;
      fileCount: number;
      additions: number;
      deletions: number;
    }
  | {
      type: "folder";
      dirPath: string;
      displayName: string;
      depth: number;
      collapsed: boolean;
      additions: number;
      deletions: number;
    }
  | { type: "header"; file: ParsedDiffFile; fileIndex: number; isExpanded: boolean; depth: number }
  | { type: "body"; file: ParsedDiffFile; fileIndex: number; depth: number };

type DiffChangeSource = NonNullable<ParsedDiffFile["changeSource"]>;

const CHANGE_SOURCE_ORDER = ["staged", "unstaged"] as const satisfies readonly DiffChangeSource[];

export interface DiffFlatItemsResult {
  items: DiffFlatItem[];
  /** Indices into `items` of expanded file headers — folder rows are never sticky. */
  stickyHeaderIndices: number[];
}

export interface BuildDiffFlatItemsInput {
  files: ParsedDiffFile[];
  viewMode: "flat" | "tree";
  /** Full uncompressed directory paths that are collapsed (empty = all expanded). */
  collapsedFolders: ReadonlySet<string>;
  /** File identities whose diff body is expanded. */
  expandedPaths: ReadonlySet<string>;
  /**
   * Pre-built compressed tree (from the same `files`). Pass it to avoid rebuilding
   * the tree on every collapse toggle; omitted callers (tests) build it internally.
   */
  tree?: DiffTreeDirNode;
}

/**
 * Build the FlatList item model plus its sticky-header indices: files grouped
 * under directory rows, single-child chains compressed, descendants of collapsed
 * folders omitted.
 *
 * Sticky indices are derived from the FINAL (post-collapse) item list and only
 * ever point at expanded FILE headers, so folder rows can't stack or collide in
 * the sticky header stack.
 */
export function buildDiffFlatItems({
  files,
  viewMode,
  collapsedFolders,
  expandedPaths,
  tree,
}: BuildDiffFlatItemsInput): DiffFlatItemsResult {
  const items: DiffFlatItem[] = [];
  const stickyHeaderIndices: number[] = [];
  const indexByFileKey = new Map(files.map((file, index) => [getParsedDiffFileKey(file), index]));

  const pushFile = (file: ParsedDiffFile, fileIndex: number, depth: number): void => {
    const isExpanded = expandedPaths.has(getParsedDiffFileKey(file));
    items.push({ type: "header", file, fileIndex, isExpanded, depth });
    if (isExpanded) {
      stickyHeaderIndices.push(items.length - 1);
      items.push({ type: "body", file, fileIndex, depth });
    }
  };

  const pushFileSet = (fileSet: ParsedDiffFile[]): void => {
    if (viewMode === "flat") {
      for (const file of fileSet) {
        const fileIndex = indexByFileKey.get(getParsedDiffFileKey(file));
        if (fileIndex !== undefined) {
          pushFile(file, fileIndex, 0);
        }
      }
      return;
    }

    const compressedTree =
      tree && fileSet.length === files.length
        ? tree
        : compressSingleChildChains(buildDiffTree(fileSet));
    const rows = flattenDiffTree(compressedTree, collapsedFolders);

    for (const row of rows) {
      if (row.kind === "folder") {
        items.push({
          type: "folder",
          dirPath: row.dirPath,
          displayName: row.displayName,
          depth: row.depth,
          collapsed: collapsedFolders.has(row.dirPath),
          additions: row.additions,
          deletions: row.deletions,
        });
        continue;
      }
      const fileIndex = indexByFileKey.get(getParsedDiffFileKey(row.file));
      if (fileIndex === undefined) {
        // Should never happen: the tree is built from the same `files` array.
        continue;
      }
      pushFile(row.file, fileIndex, row.depth);
    }
  };

  if (files.some((file) => file.changeSource)) {
    for (const source of CHANGE_SOURCE_ORDER) {
      const fileSet = files.filter((file) => (file.changeSource ?? "unstaged") === source);
      if (fileSet.length === 0) {
        continue;
      }
      items.push({
        type: "changeGroup",
        source,
        fileCount: fileSet.length,
        additions: fileSet.reduce((sum, file) => sum + file.additions, 0),
        deletions: fileSet.reduce((sum, file) => sum + file.deletions, 0),
      });
      pushFileSet(fileSet);
    }
    return { items, stickyHeaderIndices };
  }

  pushFileSet(files);
  return { items, stickyHeaderIndices };
}

/** Cumulative height of every item before `index`. Single source of truth for
 * FlatList's getItemLayout AND the collapse scroll-anchor math. */
export function sumHeightsBefore(
  items: DiffFlatItem[],
  index: number,
  heightFor: (item: DiffFlatItem) => number,
): number {
  let offset = 0;
  const end = Math.min(index, items.length);
  for (let i = 0; i < end; i++) {
    offset += heightFor(items[i]);
  }
  return Math.max(0, offset);
}
