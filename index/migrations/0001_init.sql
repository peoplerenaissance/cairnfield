-- The index's state (KTD11, KTD13): registered nodes, registered components, each
-- copy's file listing, and every record the index has read. Every text column holds a
-- value the index checked first: a URL in its accepted spelling, a hash, a path or a
-- value from a closed list. No column holds text from a record that was refused (KTD31).

-- A node is registered by its base URL, which is its identity (KTD8).
CREATE TABLE nodes (
  url TEXT PRIMARY KEY,
  registered_at INTEGER NOT NULL,
  -- The last commit of the node's team repo whose records the index has read (KTD13).
  processed TEXT,
  -- When the oldest notice arrived that no sync has taken up yet.
  noticed_at INTEGER,
  -- When the oldest notice arrived that a sync has taken up and not finished with.
  -- The index lag is the age of the oldest of these two times over all nodes.
  absorbed_at INTEGER,
  -- When a sync was queued that has not started yet. A notice that arrives until then
  -- queues no other (KTD11).
  queued_at INTEGER,
  -- How many syncs of the node have started. Only the one that started last reports a
  -- head as processed, so an older sync that finishes late cannot report an older head.
  syncs INTEGER NOT NULL DEFAULT 0,
  -- 1 from a reset until the node's records are read again. A claim first seen in that
  -- time counts as expired (KTD13).
  rebuilding INTEGER NOT NULL DEFAULT 0
) STRICT;

-- A component is its full commit hash (R8), registered with its Git URL and branch (KTD12).
CREATE TABLE components (
  component TEXT PRIMARY KEY,
  url TEXT NOT NULL,
  branch TEXT NOT NULL,
  -- importing, ready or failed.
  state TEXT NOT NULL,
  -- The Artifacts error code of a failed import, when there is one.
  import_error TEXT,
  registered_at INTEGER NOT NULL,
  -- When the import of the copy was started. The time a copy has to become ready counts
  -- from here. Empty until the first look at the component has started the import.
  import_started_at INTEGER,
  -- Goes up with every change to what the component's view holds (KTD11).
  view_version INTEGER NOT NULL DEFAULT 0
) STRICT;

-- The file listing of a copy that is ready: each path with its mode and blob (KTD12).
CREATE TABLE files (
  component TEXT NOT NULL,
  path TEXT NOT NULL,
  mode TEXT NOT NULL,
  blob TEXT NOT NULL,
  PRIMARY KEY (component, path)
) STRICT;

-- One row for each record file the index has read from a node.
CREATE TABLE records (
  node TEXT NOT NULL,
  -- The file's path in the team repo. Its shape is checked before the file is fetched.
  path TEXT NOT NULL,
  component TEXT NOT NULL,
  type TEXT NOT NULL,
  -- valid, pending or rejected.
  state TEXT NOT NULL,
  -- Why a rejected record was rejected, from the protocol's closed list.
  reason TEXT,
  -- Computed by the index: the record ID of a record that passed the structure check,
  -- and the SHA-256 of the bytes read for any other file.
  hash TEXT NOT NULL,
  -- The commit of the team repo at which the file was read.
  head TEXT NOT NULL,
  -- The record as canonical JSON. Kept only for a valid or a pending record.
  body TEXT,
  -- The blob of the file a valid finding cites: its cited content (KTD5).
  cited TEXT,
  received_at INTEGER NOT NULL,
  -- 1 for a record first seen while its node was being rebuilt.
  rebuilt INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (node, path)
) STRICT;

CREATE INDEX records_by_component ON records (component, state);
