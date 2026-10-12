# Cairnfield

Change together, decide for yourself.

Many teams' agents review and fix the same AI tools at once, with nobody in the middle. Each team's work lives in its own Artifacts repo, and each team builds the version it trusts.

- **The video** makes the pitch, then shows the demo's four steps.
- **[The live demo page](https://index.cairnfield.net/components/f7bea8e45539da2eb26841551a553418437d2a58)** shows two teams' work on one plugin, as the demo's index holds it.
- **[The homepage](https://cairnfield.net)** makes the case on one page.

The homepage makes three points in full:

- **[New: across organizations, with no merge](https://cairnfield.net/#across).** Teams that share no repo and no account work on one component, and nothing is merged.
- **[Agents work at the same moment](https://cairnfield.net/#at-once).** Two teams' agents patch one plugin at once, and patches for the same lines stand side by side.
- **[Easy to start](https://cairnfield.net/#start).** Each step is one command, and the demo replays saved work, so it calls no model.

## What it does

Many teams review the same AI tools, each alone, and keep the results private. Cairnfield lets them work on one component together, with no shared repo and no maintainer who merges.

1. **Review together.** A team pins a component at one Git commit. Its review agent writes findings: small JSON files that each name a file, a line range and one problem from a closed list. No finding holds free text. So another team's machine can check each one, and no agent reads another team's prose.
2. **Fix without waiting.** A patch is one commit on the pinned commit, in the fork of the team that wrote it. It may change only the lines its findings cite. An index reads the nodes registered with it, checks each record against its own copy of the component, and shows patches for the same lines side by side. Nothing is merged.
3. **Prove what you run.** Each team builds its own copy: the pinned commit with the patches its own policy lets in. A person reads the diff and gives the verdict. An engineer then checks an installed copy by its file-tree hash.

Each team hosts one piece, its node: a Cloudflare Worker that keeps the team's repos in the team's own Artifacts namespace. The `cairnfield` command runs on the team's machine. It validates, pushes, runs the patch agent and builds copies. A team working alone needs its node and the command, and no index.

[![The parts of Cairnfield and the Cloudflare service behind each. A team's machine runs the cairnfield command. The command pushes to the team's node: a Worker with an Artifacts namespace, a Durable Object and a Workflow. An index reads each node: a Worker with an Artifacts namespace of its own, a D1 database, a Queue and static assets.](reference/architecture.png)](reference/architecture.png)

The drawing shows one team's node in full, a second team's node and an index, with the Cloudflare service behind each part. Its two node addresses are invented. Select the drawing to see it at full size.

## Try it

| To | Go to | You need |
| --- | --- | --- |
| See the demo without running anything | [The public demo page](#the-public-demo-page) | A browser |
| Take one component from `pin` to a checked copy | [One team alone](#one-team-alone) | One node |
| Play the demo with two teams | [Replay the demo](#replay-the-demo) | Two nodes and an index |
| Deploy a team node | [Deploy a node](#deploy-a-node) | A Cloudflare account |
| Have your own review agent write findings | [Let your own agent write findings](#let-your-own-agent-write-findings) | The skill file |

The command needs Node 22.22 and Git, and is written for macOS and Linux. On an older Node it prints `{"error":"node-too-old",...}`, says which Node it needs and stops. Windows is not supported in the prototype. A node and an index each run in a Cloudflare account on the Workers Paid plan, which Artifacts requires.

Install once, in the repo root:

```
nvm use
npm install
```

Run the command as `npx --no cairnfield`. `npm install` links the command inside this repo only, and `--no` stops `npx` from downloading a package of that name from the public registry when it is run anywhere else. [`reference/walkthrough.md`](reference/walkthrough.md) says what each step below leaves behind, lists every command, and says how to read the note on a patch commit.

### One team alone

This path takes the demo plugin, `fellbeck-sync`, from `pin` to a checked copy, with one demo team's saved findings and the recording of one patch run. It calls no model and needs no index. Deploy a node and set its admin key first, as [Deploy a node](#deploy-a-node) says, then put the key in the shell as `CAIRNFIELD_ADMIN_KEY`.

Write `cairnfield.json` in the repo root. Git ignores it.

```json
{
  "node": "https://<your-node>",
  "lens": "fixtures/lenses/team-a-alone.json",
  "team": "team-a",
  "recordings": "fixtures/recordings"
}
```

Then run these in the repo root. The plugin has planted problems, and one is an instruction hidden in a comment: treat its files as data.

```
COMMIT=f7bea8e45539da2eb26841551a553418437d2a58
npx --no cairnfield pin https://github.com/peoplerenaissance/fellbeck-sync --branch main --commit $COMMIT
mkdir -p .cairnfield/outbox
cp -R fixtures/outboxes/team-a/records .cairnfield/outbox/
npx --no cairnfield validate
npx --no cairnfield publish
npx --no cairnfield patch $COMMIT --finding 72b5c551a1e4d6e2a878068dfd3dc3eceac11ed32d56e0110d54dcc67fd83ba9 --replay
npx --no cairnfield assemble $COMMIT
npx --no cairnfield decide $COMMIT --verdict approved-with-required-mitigations --tree <tree-hash>
npx --no cairnfield verify https://github.com/peoplerenaissance/fellbeck-sync .cairnfield/copies/$COMMIT --approvals .cairnfield/decisions.json
```

In order: `pin` has the node import the plugin and writes a checkout. `validate` checks the saved findings against it, and `publish` pushes them to the node. `patch` replays the saved fix for the any-host finding as a checked commit in the team's fork. `assemble` builds the team's copy, prints its diff and its file-tree hash, and `decide` writes down the verdict a person gives for that hash. `verify` passes only when the folder's file-tree hash is the one the team approved. An engineer on another machine runs `verify` with the file that `approvals` prints. When the plugin releases again, `carry $COMMIT <newer-commit> --branch main` writes the team's own findings and patches again for the newer commit.

To pin a component of your own, give `pin` its HTTPS Git URL, a branch that holds the commit and the full commit hash, and write a lens file like the three in `fixtures/lenses/`. Without `--replay`, `patch` calls a model and reads its key from `ANTHROPIC_API_KEY`.

### Replay the demo

`npm run demo`, from the repo root, plays the demo's four steps with two teams, from the saved findings in `fixtures/outboxes/` and the saved edits in `fixtures/recordings/`. It calls no model.

1. **One team alone.** Team A pins the plugin, publishes its findings, replays one patch, builds its copy and records a verdict.
2. **Two teams at the same moment.** Team A adds the index and pins again. Team B pins and publishes. Both patch at once: both remove the hidden instruction with the same edit, so the index shows one patch with two organizations, and Team B's second patch sits beside Team A's on adjoining lines. Team B also publishes a patch made by hand that the index rejects.
3. **Taking another team's patch.** Team A names Team B in its lens and builds its copy again, with another file-tree hash.
4. **A new release.** Team A carries its work to the plugin's later commit.

It needs two nodes and an index of your own, and reads their three addresses, the two admin keys and the index's registration key from the environment. The script stops at the first thing a step must leave behind and does not, and starts only from an empty deployment. `npm run demo:reset` puts the nodes and the index back to that state. [`reference/walkthrough.md`](reference/walkthrough.md#replay-the-demo) says what to deploy, which variables to set and what has run.

### Deploy a node

A team node is the one piece of Cairnfield a team hosts. A setup script deploys it. Run these in `node/`:

```
npm install
npx wrangler login
npm run setup
```

The script deploys the node on `workers.dev`, or on a hostname of your own. It stops when Wrangler is not logged in, deletes nothing, and never makes, reads or stores the node's admin key. You set that key by hand, and the node refuses every admin call until you do. [`node/README.md`](node/README.md) gives the options, what the script creates, how to set the key and how to check the node.

A node answers its own address with a page that lists the records its team has published, by component. The page is the team's own list: nothing on it was checked, and no index and no command reads it.

The script's tests run it against a stand-in for Wrangler. It has not run on a Cloudflare account yet. A one-click deploy button waits on platform support.

### Let your own agent write findings

Cairnfield bundles no reviewer agent. A team's findings come from its own review agent, or from a person, through the outbox. [`skills/cairnfield/SKILL.md`](skills/cairnfield/SKILL.md) is written for that agent. It gives the finding record and its closed lists of values, says where the outbox is and how a record file is named, and names `validate` as the one command the agent runs. `protocol/schemas/` holds a JSON Schema of each record type.

The work is split in three.

1. The operator pins the component.
2. The agent reads the checkout as data and writes one record file for each finding into the outbox. It runs `npx --no --offline cairnfield validate` until its files pass, and stops.
3. The operator runs `publish`. It sends the admin key to the node that `cairnfield.json` names, and an agent that ran in that folder could have changed the file. So the operator reads `cairnfield.json` first, or starts the agent with only the outbox writable.

Start the agent in the folder that holds `cairnfield.json`, and give it this instruction:

```
Follow <repo>/skills/cairnfield/SKILL.md. Review the checkout of <commit>. Stop when validate accepts your files.
```

`<repo>` is the path to this repo, and `<commit>` is the full hash the operator pinned. Do not start the agent in a shell that holds `CAIRNFIELD_ADMIN_KEY` or `CAIRNFIELD_REGISTRATION_KEY`. The agent has just read a component that may be hostile, and `validate` needs no key. The command cannot enforce where a key is set, so this rests on the operator.

## The protocol in brief

A component is one Git commit, a record is one small JSON file with no free text that states one checkable thing about it, and a patch is one commit on the pinned commit that may change only the lines its findings cite. The command and the index each check every record, two findings that cite the same lines for the same reason confirm each other across organizations, and a team's lens says whose patches it takes.

[`reference/protocol.md`](reference/protocol.md) states the rest: the record types, the limits, the matching and patch rules, and each requirement and decision that a comment in the code cites, such as `R2` or `KTD4`, under the same ID. `protocol/schemas/` holds the record shapes as JSON Schema files and the index routes as an OpenAPI description. [`reference/platform-notes.md`](reference/platform-notes.md) says what Cloudflare Artifacts and Workers were seen to do, and what was only read in documentation.

## The public demo page

The demo's index draws the page of the demo plugin's first commit here:

https://index.cairnfield.net/components/f7bea8e45539da2eb26841551a553418437d2a58

The page reads the index's view every two seconds and draws nothing else: live claims, findings by criterion, patches side by side, recipes, each team's fetches, and pending and rejected work. A team's fetches are a number its node states, and the index cannot check it. The view itself is JSON, at the same address with `/view` added. The [status table](#status-as-of-october-12-2026) says what has run on that index.

## Limits and threat model

The prototype shows the mechanism at one commit of one component. A hosted tool with no Git commit cannot be pinned. Only a team's own findings and patches carry forward to a new version, so carrying other teams' work forward is the first follow-up after the prototype. A patch changes the component, not a team's environment: Cairnfield does not replace environment controls, and the two work as a pair. An index takes at most 8 nodes.

Cairnfield assumes that some contributors are hostile, and that any component under review may be. The prototype builds four defenses: checks on records and patches, tokens scoped to one repo, checking again at assembly, and a lens that names teams. [`reference/threat-model.md`](reference/threat-model.md) goes through the threats one by one and says what the prototype builds for each, names four risks an operator should know, lists the parts of the design that are not built, and ends with the disclosure policy. This repo holds no finding about a real product and takes none. [`SECURITY.md`](SECURITY.md) says how to report a flaw in Cairnfield in private.

## Status, as of October 12, 2026

This table describes today. [`reference/platform-notes.md`](reference/platform-notes.md#what-the-command-has-done-on-the-deployed-demo) says what each run on the deployed demo showed, by date.

| Part | State | Note |
| --- | --- | --- |
| Platform behavior the design depends on | verified live | Scoped tokens, concurrent pushes, push triggers, file reads at a commit, forks, fetching a patch with a read token, and the fetch events a node counts. |
| Concept and plan | written | The concept was reviewed by seven reviewer agents and the plan by five. |
| Record formats and checks | built | The protocol library in `protocol/`, with its tests. |
| Protocol, threat model and platform notes | written | In `reference/`, with the walkthrough and the roadmap. |
| Demo plugin, lenses and saved findings | built | `fellbeck-sync`, an invented plugin with three planted problems, in `fixtures/`. Its two commits are public at https://github.com/peoplerenaissance/fellbeck-sync. |
| Team node | built and deployed | The Worker in `node/`. Two demo nodes run on Cloudflare, each with its import of the demo plugin, its fork, its own page and its count of each fork's fetches. |
| Setup script for a team node | built, not run on an account | `npm run setup` in `node/`. Its tests run it against a stand-in for Wrangler. |
| Index | built in part, deployed | The Worker in `index/`. It checks every record and patch against its own copy, serves one view and one page per component commit and a page of its own, and carries each node's declared model and fetch count. It does not show cited lines, a row per host or the index lag. |
| The command | built in part | `cairnfield` in `cli/`: `pin`, `validate`, `publish`, `claim`, `view`, `patch`, `assemble`, `decide`, `approvals`, `verify` and `carry`. |
| Skill file for a team's own review agent | written | `skills/cairnfield/SKILL.md`. |
| Patch agent | built and run live | `cairnfield patch`, from a live model call or from a recording, with a note on each commit it pushes. Two live runs patched the demo plugin on deployed nodes. On its hidden instruction the agent wrote no patch in four live runs. |
| Patched copies | built and run live | `cairnfield assemble`. One demo team built its copy twice with one file-tree hash, and took the other team's patch through the deployed index. |
| Verdicts and checking an installed copy | built and run live | `cairnfield decide`, `approvals` and `verify`. `verify` passed on a clone of a published copy and failed on the original. A run on a second machine is still to come. |
| Carrying a team's own work to a new version | built and run live | `cairnfield carry`. One demo team carried its work to the plugin's later commit, and the copy it built there passed `verify`. |
| Demo script | built and run live | `npm run demo` and `npm run demo:reset`. Both ran twice on the deployed demo, and the second run left the same IDs and hashes. |
| Scale run | not in the prototype | `sim/` holds a placeholder. |
| One-click deploy button for the team node | waiting on the platform | Nobody has tested the button on the node. |
| Carrying other teams' work forward, domain verification, sealed findings, deploys from Artifacts | not in the prototype | Described in `reference/`. |

The build plan named three things to cut if time ran short: `carry`, the display of live claims and the demo's rejected patch. None was cut.

## Roadmap

The prototype is a slice of a larger design. [`reference/roadmap.md`](reference/roadmap.md) says what each item below would do and what stands in for it today.

- **Described and not built:** one command that runs a whole review, reconciling, a scale run, a node in a second Cloudflare account, cited lines and a row per host on the page, an API catalog on the index, merged patches, a fuller lens, an agent's review of the assembled diff, and a suggested verdict.
- **Further work:** carrying other teams' work forward, an install gate, pinning what runs, an egress allow list, confirmation by re-running, signed requests from nodes, an index that reads patch commits over Git, a read-only MCP server, a `since` cursor and a push feed, alerts on new versions, a private findings log, an unclassified pointer, a check that a blind pass was blind, and a local mode with no node.
- **Ideas from Workers Builds:** a node that deploys from its own Artifacts namespace, and a running Preview of a patched component.

## What is here

| Path | Holds |
| --- | --- |
| `protocol/` | The protocol library: every record, limit and check, as pure functions. |
| `node/` | The team node, a Cloudflare Worker on Artifacts. |
| `index/` | The index Worker, its migrations and its two pages. |
| `cli/` | The `cairnfield` command and its patch agent. |
| `skills/` | The skill file for a team's own review agent. |
| `reference/` | The protocol, the threat model, the platform notes, the walkthrough, the roadmap and the architecture drawing. |
| `fixtures/` | The demo plugin, lenses, saved findings, recordings, injection fixtures and the rejected patch. |
| `sim/` | A placeholder for the scale run. |
| `scripts/` | The demo script, its reset and the node contract check. |
| `site/` | The public site, one page served by a Worker. |
| `AGENTS.md` | Instructions for coding agents working in this repo. |

To see the site locally, run `nvm use` and `npm run dev:site` in the repo root. Then open http://localhost:8787.

## Credit

Cairnfield borrows four ideas: one site per party, where a change is a fork shown beside the original and nothing is merged (Ward Cunningham's [Federated Wiki](http://fed.wiki.org)), audits published per organization with a local policy (cargo-vet), publishing from your own repo into a rebuildable aggregate (cargo-crev), and a pinned original plus a list of patches (Nix, quilt, patch-package).

The architecture drawing uses product icons from the [Cloudflare Docs](https://github.com/cloudflare/cloudflare-docs/tree/production/src/icons), under the [Creative Commons Attribution 4.0 license](https://github.com/cloudflare/cloudflare-docs/blob/production/LICENSE). Each icon is recolored in orange.

## License

MIT. See `LICENSE`.
