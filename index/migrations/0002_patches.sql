-- What the index computed for each patch record whose commit passed every patch check
-- (R11, KTD5): its patch ID, kind, size and changed lines. No record declares any of it.
-- A patch record that waits for its commit, or was rejected, has no row here. Every
-- value is a hash, a number, a value from a closed list or a path of the index's own copy.
CREATE TABLE patches (
  node TEXT NOT NULL,
  -- The path of the patch record in the team repo. With the node it names the record's
  -- row in `records`.
  path TEXT NOT NULL,
  component TEXT NOT NULL,
  -- The SHA-256 over the content replacements the commit amounts to (KTD4). It holds
  -- neither a commit nor a path, so identical patches share it.
  patch_id TEXT NOT NULL,
  -- removes-only or adds-or-changes.
  kind TEXT NOT NULL,
  -- Lines removed plus lines added.
  size INTEGER NOT NULL,
  -- The changed lines of each content the patch replaces, in the old content's line
  -- numbers: a JSON list of { blob, hunks }, where a hunk is four numbers.
  changes TEXT NOT NULL,
  -- Every path the patch changes, as a JSON list.
  paths TEXT NOT NULL,
  PRIMARY KEY (node, path)
) STRICT;

CREATE INDEX patches_by_component ON patches (component);
