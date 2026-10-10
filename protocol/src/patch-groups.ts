// Which patches sit side by side (R16). The index groups the patches of a view by this
// rule, and the command groups again what its lens leaves (KTD38). Both read the changed
// lines that the protocol's own diff reported for each patch (KTD5).

import { hunksTouch } from "./diff.ts";
import type { ContentChange } from "./patch-checks.ts";

/** What the rule reads of a patch: the changed lines of each content it replaces. */
export interface ChangedLines {
  readonly changes: readonly ContentChange[];
}

/** Whether two patches change lines of one content that overlap or adjoin. */
export function patchesTouch(a: ChangedLines, b: ChangedLines): boolean {
  return a.changes.some((change) =>
    b.changes.some(
      (other) =>
        change.blob === other.blob &&
        change.hunks.some((hunk) => other.hunks.some((against) => hunksTouch(hunk, against))),
    ),
  );
}

/**
 * Puts patches that touch in one group, directly or through another patch. A patch that
 * touches no other is a group of its own. Pass each patch identity once.
 */
export function patchGroups<P extends ChangedLines>(patches: readonly P[]): P[][] {
  let groups: P[][] = [];
  for (const patch of patches) {
    const joined = groups.filter((group) => group.some((member) => patchesTouch(member, patch)));
    groups = [...groups.filter((group) => !joined.includes(group)), [...joined.flat(), patch]];
  }
  return groups;
}
