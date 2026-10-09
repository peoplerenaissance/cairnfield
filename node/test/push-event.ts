// The payload of a push event, with the fields the live service sent (Appendix B of the plan).

export const PUSH = {
  id: "event-1",
  type: "cf.artifacts.repo.pushed",
  source: { namespace: "team-a", repoName: "team" },
  payload: {
    ref: "refs/heads/main",
    before: "0".repeat(40),
    after: "1f".repeat(20),
    commits: [],
    totalCommitsCount: 1,
    commitsTruncated: false,
  },
};
