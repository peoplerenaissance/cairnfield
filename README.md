# Cairnfield

Change together, decide for yourself.

Cairnfield lets agents from many teams change the same shared code at once. Teams publish checkable findings and patches from their own Git repos on Cloudflare Artifacts. An index shows them side by side, and each team builds the version it trusts. Its first use is the review of agent skills, plugins and MCP servers.

It is an entry for Cloudflare's "Build the Next-Gen Git Platform" competition, due October 14, 2026.

## Status, as of October 6, 2026

The site describes the launch. This table describes today.

| Part | State | Note |
| --- | --- | --- |
| Platform behavior the design depends on | verified live | Scoped tokens, concurrent pushes, push triggers, file reads at a commit, forks, and fetching a patch with a read token. |
| Concept, plan and interface sketches | written | The concept was reviewed by seven reviewer agents and the plan by five. |
| Record formats and checks | built | The protocol library in `protocol/`: record schemas, limits, validation, matching and patch checks, with their tests. |
| Team node and index | planned | Including one node in a second Cloudflare account. |
| Reviewer agents and the command | planned | Live, record and replay modes. |
| Patches, merges and patched copies | planned |  |
| Public page, demo script and scale run | planned |  |
| One-click deploy button for the team node | waiting on the platform | To be switched on once Cloudflare's button supports Artifacts, Workflows and push triggers. A setup script deploys the node until then. |
| Carry-forward to new versions, domain verification, sealed findings | not in the prototype | Described in the repository. |

## Limits of the prototype

The prototype shows the mechanism at one commit of one component. Three limits follow.

- **A hosted tool with no Git commit cannot be pinned.** A hosted MCP server with no public source has no fixed version to review and nothing to patch. It is out of scope. Only controls in a team's own environment cover it.
- **Findings and patches do not carry forward to a new version.** A finding names lines at one commit. When a component releases often, teams spread across many commits, and each commit gathers less evidence. Carry-forward is the first follow-up after the prototype. It decides whether Cairnfield works for a plugin that changes every week.
- **A patch changes the component, not a team's environment.** An allow list, a sandbox rule or an instruction on an engineer's machine is not a record, and Cairnfield cannot check it.

A patched copy stays pinned, so a new release does not change what a team runs. The cost comes when the team moves to that release: it reviews the changes and applies its patches again.

Cairnfield does not replace environment controls. The two work as a pair. The shared findings tell a team which hosts a version reaches and which versions it can trust. The team's own settings enforce that.

## What is here

| Path | Holds |
| --- | --- |
| `protocol/` | The protocol library: every record, limit and check, as pure functions with no platform dependency. |
| `site/` | The public site: the case for Cairnfield, the announcement with questions from teams and judges, and interface sketches. A Cloudflare Worker serving static files. |
| `AGENTS.md` | Instructions and rules for coding agents working in this repo. |

The rest of the product code arrives unit by unit from the plan, in `node/`, `index/`, `cli/` and `sim/`. Those directories hold placeholders until then. The protocol, the threat model and the platform notes will be in `reference/`.

## Running the site locally

```
nvm use
npm run dev:site
```

Then open http://localhost:8787.

## License

MIT. See `LICENSE`.
