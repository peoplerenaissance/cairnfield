# Cairnfield

Change together, decide for yourself.

Cairnfield lets agents from many teams change the same shared code at once. Teams publish checkable findings and patches from their own Git repos on Cloudflare Artifacts. An index shows them side by side, and each team builds the version it trusts. Its first use is the review of agent skills, plugins and MCP servers.

It is an entry for Cloudflare's "Build the Next-Gen Git Platform" competition, due October 14, 2026.

## Status, as of October 10, 2026

The site describes the launch. This table describes today.

| Part | State | Note |
| --- | --- | --- |
| Platform behavior the design depends on | verified live | Scoped tokens, concurrent pushes, push triggers, file reads at a commit, forks, and fetching a patch with a read token. |
| Concept, plan and interface sketches | written | The concept was reviewed by seven reviewer agents and the plan by five. |
| Record formats and checks | built | The protocol library in `protocol/`: record schemas, limits, validation, matching and patch checks, with their tests. |
| Demo plugin, lenses and saved findings | built | `fellbeck-sync`, an invented plugin with three planted problems, in `fixtures/`. Its two commits are public at https://github.com/peoplerenaissance/fellbeck-sync, so a node can import them. |
| Team node | built and deployed | The Worker in `node/`: the node contract, the admin routes and the push Workflow. Two demo nodes run on Cloudflare. Each has imported the demo plugin and made its fork, and Artifacts refused a push made with a node's public read token. One of them holds a patch commit and passes the contract check in `scripts/check-node-contract.ts`. |
| Index | built in part, not deployed | The Worker in `index/`: it registers nodes and components with a key, imports its own copy of a component, takes push notices through a queue, reads each node over HTTP and checks every record against its own copy. For a patch record it asks the node for the commit's parent, changed paths and blobs, holds each blob to its hash and runs the patch checks against its own copy. It stores the patch as valid with the ID, kind, size and changed lines it computed, or as rejected with a reason. A commit the node does not serve yet is asked for again for about ten minutes. After that the record stays pending while the node does not serve the commit or a finding it names is not valid, and the index looks again at each later sync of the node and when a finding the record names turns valid. It serves one view per component commit: findings in match groups with their confirmations, patches side by side where their changed lines overlap or adjoin, identical patches as one entry that lists its organizations, claims with their state, recipes, and pending and rejected work. A `teams` query narrows a view to the nodes it lists. Registering a failed component again retries its import with the Git URL and branch the index stored for it. A component whose finished copy does not hold the commit fails again until that copy is deleted by hand. A new URL or branch for a commit is not taken. The public page is not built. The tests use a local database and stand-ins for Artifacts, the queue and the nodes, with patch commits made by hand. No index is deployed yet. |
| The command | built in part | `cairnfield` in `cli/`: `pin`, `validate`, `publish`, `claim`, `view`, `patch`, `assemble`, `decide`, `approvals`, `verify` and `carry`. A team working alone needs a node and no index. |
| Patch agent | built and run live | `cairnfield patch` writes a patch for one of a team's own findings as a checked commit and a patch record, from a live model call or from a recording. The tests use a fake model. A live run on a deployed node patched the demo plugin's any-host rule, and its recording is in `fixtures/recordings/`. A replay gave the same commit and the same records. Live runs on both injection fixtures changed only the cited line. |
| Patched copies | built and run live | `cairnfield assemble` builds a team's copy from the patches its lens lets in. It fetches each patch from the fork of the team that wrote it and checks it again. The copy is one commit, and any team with the same pinned commit and the same patches gets the same file-tree hash. The command prints the full diff of the copy. A lens that publishes recipes has it push the copy to the team's fork and publish a recipe record. On a deployed node with no index, one demo team built its copy of the demo plugin twice with one file-tree hash and published its recipe. Taking another team's patch is tested against a stand-in for the index. No index is deployed yet, so a live run of it is still to come. A merged patch is not built. |
| Verdicts and checking an installed copy | built and run live | `cairnfield decide` writes down the verdict a person gave for a commit, under the Git URL it was pinned from, with the file-tree hash of the copy the team built. The person names that hash, so a copy built again since is not approved by mistake. `approvals` prints the team's table, one entry for each component. `verify` works out the file-tree hash of a folder and compares it with the approved entry in the approvals file it is given. It runs no Git and reads no config file, so it runs on any machine with Node. The table is a local file and is never published. From a clean folder with no config file and no key, `verify` passed on a clone of a demo team's published copy and failed on a clone of the original. A run on a second machine is still to come. |
| Carrying a team's own work to a new version | built, not run live | `cairnfield carry` moves a team's own findings and patches from one pinned commit of a component to a newer one, and pins the newer commit. A finding carries when the newer commit still holds the content it cites, at the same path or at another. A patch carries when the newer commit still holds every content it replaces and every finding it cites carried. It is built again as a commit on the newer commit and keeps its patch ID. The command names each finding and patch that did not carry, with a reason code. It also names each patch of another team that the team's copy of the older commit held, and counts the paths the newer commit added, changed and removed. It carries nothing of another team. The tests run it on the demo plugin's two commits against a stand-in for the node. A run on a deployed node is still to come. |
| Public page, demo script and scale run | planned |  |
| One-click deploy button for the team node | waiting on the platform | To be switched on once Cloudflare's button supports Artifacts, Workflows and push triggers. A setup script deploys the node until then. |
| Carrying other teams' work to a new version, domain verification, sealed findings | not in the prototype | Described in the repository. |
| Deploys from Artifacts through Workers Builds, and a page on each node | not in the prototype | Described under "Ideas that are not built". |

## Limits of the prototype

The prototype shows the mechanism at one commit of one component. Three limits follow.

- **A hosted tool with no Git commit cannot be pinned.** A hosted MCP server with no public source has no fixed version to review and nothing to patch. It is out of scope. Only controls in a team's own environment cover it.
- **Only a team's own findings and patches carry forward to a new version.** `cairnfield carry` writes them again for a newer commit when the content they cite is unchanged. No other team's work moves with them, and a view does not show carried work as carried. When a component releases often, teams spread across many commits, and each commit gathers less evidence. Carrying other teams' work forward is the first follow-up after the prototype. It decides whether Cairnfield works for a plugin that changes every week.
- **A patch changes the component, not a team's environment.** An allow list, a sandbox rule or an instruction on an engineer's machine is not a record, and Cairnfield cannot check it.

A patched copy stays pinned, so a new release does not change what a team runs. The cost comes when the team moves to that release: it reviews the changes and applies its patches again.

Cairnfield does not replace environment controls. The two work as a pair. The shared findings tell a team which hosts a version reaches and which versions it can trust. The team's own settings enforce that.

An index takes at most 8 nodes, and the scale run needs a paged view before that cap goes up.

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
| `index/` | The index: a Cloudflare Worker that reads registered nodes over HTTP, checks their records against its own copy of each component and serves one view per component commit. It serves data and never instructions. |
| `cli/` | The `cairnfield` command: it pins a component, validates the outbox of record files, publishes it to the team's node, writes patches with a bundled agent, builds the team's patched copy, keeps the team's verdicts, checks an installed copy and carries the team's own findings and patches to a newer commit. |
| `fixtures/` | The demo: an invented plugin with planted problems, the two demo teams' lens files and their saved findings. Also two small components with planted instructions, for checking the patch agent, the recording of its live patch, and a patch made by hand that an index rejects because it changes a line its finding does not cite. Not for installing. |
| `site/` | The public site: the case for Cairnfield, the announcement with questions from teams and judges, and interface sketches. A Cloudflare Worker serving static files. |
| `AGENTS.md` | Instructions and rules for coding agents working in this repo. |

The rest of the product code arrives unit by unit from the plan, in `index/`, `cli/` and `sim/`. `cli/` holds the first eleven commands, `index/` holds the sync path, patch intake and the data endpoint, and `sim/` holds a placeholder. The protocol, the threat model and the platform notes will be in `reference/`.

## Running the command

The command needs Node 22.22 and Git, and is written for macOS and Linux. Windows is not supported in the prototype. Every command but `verify` reads `cairnfield.json` in the working folder, which names the team's node and, for a team that shares, an index:

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

A team with a lens file builds its copy and records what it decided:

```
npx cairnfield assemble <full-commit-hash>
npx cairnfield decide <full-commit-hash> --verdict approved-with-required-mitigations --tree <tree-hash>
npx cairnfield approvals
```

`assemble` prints the diff of the copy against the original, writes the copy under `.cairnfield/copies/` and gives the copy's file-tree hash. A person reads the diff and gives the verdict: `approved`, `approved-with-required-mitigations` or `not-approved`. `decide` takes that tree hash, so the verdict is for the copy whose diff was read and for no later one. It writes the verdict to `.cairnfield/decisions.json`, under the Git URL the commit was pinned from. That file is the team's table of what it may install, with one entry for each component. It is never published, and the team shares it by its own means.

An engineer who holds a copy of that file checks an installed copy against it, on any machine:

```
npx cairnfield verify <git-url> <folder> --approvals <file>
```

`verify` passes only when the folder's file-tree hash is the one the team approved. It reads the folder and the file and nothing else. It skips the `.git` folder at the top of a clone, and says nothing about what that folder holds. When a component's tree holds a link, the folder under `.cairnfield/copies/` leaves it out, and only a clone of the published copy has the approved hash.

## Running the site locally

```
nvm use
npm run dev:site
```

Then open http://localhost:8787.

## License

MIT. See `LICENSE`.
