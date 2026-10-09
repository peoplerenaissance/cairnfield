# Cairnfield

Change together, decide for yourself.

Cairnfield lets agents from many teams change the same shared code at once. Teams publish checkable findings and patches from their own Git repos on Cloudflare Artifacts. An index shows them side by side, and each team builds the version it trusts. Its first use is the review of agent skills, plugins and MCP servers.

It is an entry for Cloudflare's "Build the Next-Gen Git Platform" competition, due October 14, 2026.

## Status, as of October 9, 2026

The site describes the launch. This table describes today.

| Part | State | Note |
| --- | --- | --- |
| Platform behavior the design depends on | verified live | Scoped tokens, concurrent pushes, push triggers, file reads at a commit, forks, and fetching a patch with a read token. |
| Concept, plan and interface sketches | written | The concept was reviewed by seven reviewer agents and the plan by five. |
| Record formats and checks | built | The protocol library in `protocol/`: record schemas, limits, validation, matching and patch checks, with their tests. |
| Demo plugin, lenses and saved findings | built | `fellbeck-sync`, an invented plugin with three planted problems, in `fixtures/`. Its two commits are public at https://github.com/peoplerenaissance/fellbeck-sync, so a node can import them. |
| Team node | built and deployed | The Worker in `node/`: the node contract, the admin routes and the push Workflow. Two demo nodes run on Cloudflare. Each has imported the demo plugin and made its fork, and Artifacts refused a push made with a node's public read token. |
| Index | planned |  |
| The command | built in part | `cairnfield` in `cli/`: `pin`, `validate`, `publish`, `claim`, `view` and `patch`. It needs a node and no index. |
| Patch agent | built, live run pending | `cairnfield patch` writes a patch for one of a team's own findings as a checked commit and a patch record, from a live model call or from a recording. The tests use a fake model. The live run and its recording are not made yet. |
| Patches, merges and patched copies | planned |  |
| Public page, demo script and scale run | planned |  |
| One-click deploy button for the team node | waiting on the platform | To be switched on once Cloudflare's button supports Artifacts, Workflows and push triggers. A setup script deploys the node until then. |
| Carry-forward to new versions, domain verification, sealed findings | not in the prototype | Described in the repository. |
| Deploys from Artifacts through Workers Builds, and a page on each node | not in the prototype | Described under "Ideas that are not built". |

## Limits of the prototype

The prototype shows the mechanism at one commit of one component. Three limits follow.

- **A hosted tool with no Git commit cannot be pinned.** A hosted MCP server with no public source has no fixed version to review and nothing to patch. It is out of scope. Only controls in a team's own environment cover it.
- **Findings and patches do not carry forward to a new version.** A finding names lines at one commit. When a component releases often, teams spread across many commits, and each commit gathers less evidence. Carry-forward is the first follow-up after the prototype. It decides whether Cairnfield works for a plugin that changes every week.
- **A patch changes the component, not a team's environment.** An allow list, a sandbox rule or an instruction on an engineer's machine is not a record, and Cairnfield cannot check it.

A patched copy stays pinned, so a new release does not change what a team runs. The cost comes when the team moves to that release: it reviews the changes and applies its patches again.

Cairnfield does not replace environment controls. The two work as a pair. The shared findings tell a team which hosts a version reaches and which versions it can trust. The team's own settings enforce that.

## Ideas that are not built

Cloudflare can deploy a Worker from an Artifacts repository through Workers Builds. A push to `main` builds and deploys the Worker. With previews switched on, a push to another branch makes a Worker Preview. Two uses fit Cairnfield, and neither is in the prototype.

- **A node that deploys from its own namespace.** The node's source would live in an Artifacts repo beside the team's records. Updating a node would be a `git push`, with no account on another Git host, and a branch would give a staging node as a Preview. As of October 8, 2026, Cloudflare's guide describes connecting the repo only in the dashboard, so the setup script could not do it.
- **A running Preview of a patched component.** When a component is itself a Worker, as some MCP servers are, each patch branch could get its own Preview, and the copy a team approves would be the copy it deploys. This runs code that is still under review inside the team's account, so it needs its own safeguards first.

We would not deploy from the records repo. A push there would become a deploy, and a token that can write records could then change a Worker.

A third idea needs no build step.

- **A page on each node.** A node already serves its records over HTTP. It could also render a page of its own work on each request, so a reader sees a team's work at the source without the index. The page would be that team's own unchecked view, and no agent would read it.

## What is here

| Path | Holds |
| --- | --- |
| `protocol/` | The protocol library: every record, limit and check, as pure functions with no platform dependency. |
| `node/` | The team node: a Cloudflare Worker that holds a team's repos on Artifacts and serves its records and patch commits. |
| `cli/` | The `cairnfield` command: it pins a component, validates the outbox of record files, publishes it to the team's node and writes patches with a bundled agent. |
| `fixtures/` | The demo: an invented plugin with planted problems, the two demo teams' lens files and their saved findings. Also two small components with planted instructions, for checking the patch agent. Not for installing. |
| `site/` | The public site: the case for Cairnfield, the announcement with questions from teams and judges, and interface sketches. A Cloudflare Worker serving static files. |
| `AGENTS.md` | Instructions and rules for coding agents working in this repo. |

The rest of the product code arrives unit by unit from the plan, in `index/`, `cli/` and `sim/`. `cli/` holds the first six commands, and the other two hold placeholders. The protocol, the threat model and the platform notes will be in `reference/`.

## Running the command

The command needs Node 22.22 and Git, and is written for macOS and Linux. Windows is not supported in the prototype. It reads `cairnfield.json` in the working folder, which names the team's node and, for a team that shares, an index:

```json
{ "node": "https://node.team-a.example" }
```

The node's admin key comes from the environment, in `CAIRNFIELD_ADMIN_KEY`. No key is ever read from a file.

```
nvm use
npm install
npx cairnfield pin <git-url> --branch <branch> --commit <full-commit-hash>
npx cairnfield validate
npx cairnfield publish
```

`pin` has the node import the component and writes a plain checkout of that commit under `.cairnfield/checkouts/`. Record files go in `.cairnfield/outbox/`, at `records/<commit>/<type>/<id>.json`. `validate` checks them against the checkout and needs no key. `publish` validates and then pushes them to the team's repo on the node. Each command prints one line of JSON and returns an exit code, which `cli/src/outcome.ts` lists.

## Running the site locally

```
nvm use
npm run dev:site
```

Then open http://localhost:8787.

## License

MIT. See `LICENSE`.
