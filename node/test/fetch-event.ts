// The payloads of the two events Artifacts sends for a fetch of a repo over Git, as the
// live service sent them on Oct 12, 2026 (KTD43). A `git fetch --depth=1` of one commit
// sent the first into a repo that held nothing, and the second into a repo that already
// held a commit. The inner payload of each was empty. The namespace and the repo name are
// written here: the repo is the fork of an invented component.

/** The component whose fork the events below name. */
export const COMPONENT = "1f".repeat(20);

const source = { namespace: "team-a", repoName: `fork-${COMPONENT}` };

export const CLONED = {
  id: "0708e5d4-31bd-429b-9908-a12353f857c2",
  type: "cf.artifacts.repo.cloned",
  source,
  payload: {},
};

export const FETCHED = {
  id: "622a3ce7-a059-4326-9ddb-9c6b44059af6",
  type: "cf.artifacts.repo.fetched",
  source,
  payload: {},
};
