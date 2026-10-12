-- What each node states of the fetches of its fork of a component (R45): the number the
-- node gave at the last sync that read one. The index holds the number to its form, a
-- whole number within the protocol's limit, and cannot check its truth. So a view carries
-- it as a value the node declared, apart from what the index computed (KTD42). A node
-- that says it has counted no fetch of a fork has no row for it: a missing count is not
-- a count of zero.
CREATE TABLE fetch_counts (
  component TEXT NOT NULL,
  node TEXT NOT NULL,
  fetches INTEGER NOT NULL,
  -- The component comes first: a view reads the counts of one component, and a sync
  -- writes the count of one component and one node.
  PRIMARY KEY (component, node)
) STRICT;
