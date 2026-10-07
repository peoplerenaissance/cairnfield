// A component's file listing, as the caller supplies it (KTD12): each path with its
// Git mode and the blob hash of its content. Directories are not listed.

export interface FileEntry {
  readonly path: string;
  /** A Git mode such as `100644`. It may come from another node, so it is checked where it matters. */
  readonly mode: string;
  readonly blob: string;
}

export type FileListing = readonly FileEntry[];
