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

It is an entry for Cloudflare's "Build the Next-Gen Git Platform" competition, due October 14, 2026.

## What it does

Many teams review the same AI tools, each alone, and keep the results private. Cairnfield lets them work on one component together, with no shared repo and no maintainer who merges.

1. **Review together.** A team pins a component at one Git commit. Its review agent writes findings: small JSON files that each name a file, a line range and one problem from a closed list. No finding holds free text. So another team's machine can check each one, and no agent reads another team's prose.
2. **Fix without waiting.** A patch is one commit on the pinned commit, in the fork of the team that wrote it. It may change only the lines its findings cite. An index reads the nodes registered with it, checks each record against its own copy of the component, and shows patches for the same lines side by side. Nothing is merged.
3. **Prove what you run.** Each team builds its own copy: the pinned commit with the patches its own policy lets in. A person reads the diff and gives the verdict. An engineer then checks an installed copy by its file-tree hash.

Each team hosts one piece, its node: a Cloudflare Worker that keeps the team's repos in the team's own Artifacts namespace. The `cairnfield` command runs on the team's machine. It validates, pushes, runs the patch agent and builds copies. A team working alone needs its node and the command, and no index.

## Try it

| To | Go to | You need |
| --- | --- | --- |
| See the demo without running anything | [The public demo page](#the-public-demo-page) | A browser |
| Take one component from `pin` to a checked copy | [One team alone](#one-team-alone) | One node |
| Play the demo with two teams | [Replay the demo](#replay-the-demo) | Two nodes and an index |
| Deploy a team node | [Deploy a node](#deploy-a-node) | A Cloudflare account |
| Have your own review agent write findings | [Let your own agent write findings](#let-your-own-agent-write-findings) | The skill file |

The command needs Node 22.22 and Git, and is written for macOS and Linux. On an older Node it prints `{"error":"node-too-old",...}`, says which Node it needs and stops. Node 23 before 23.6 counts as older. Windows is not supported in the prototype. A node and an index each run in a Cloudflare account on the Workers Paid plan, which Artifacts requires. Usage beyond the included amounts is billed to you.

Install once, in the repo root:

```
nvm use
npm install
```

Run the command as `npx --no cairnfield`. `npm install` links the command inside this repo only, and `--no` stops `npx` from downloading a package of that name from the public registry when it is run anywhere else.

### One team alone

This path takes the demo plugin, `fellbeck-sync`, from `pin` to a checked copy. It uses one demo team's saved findings and the recording of one patch run, so it calls no model and needs no model key. It needs no index and no other team.

The test named AE18 in `cli/test/verify.test.ts` plays this path from `pin` to `verify` against a stand-in for the node. The [status table](#status-as-of-october-11-2026) says which steps have run on a deployed node.

1. Deploy a node and set its admin key, as [Deploy a node](#deploy-a-node) says.

2. Write `cairnfield.json` in the repo root. Git ignores that file.

   ```json
   {
     "node": "https://<your-node>",
     "lens": "fixtures/lenses/team-a-alone.json",
     "team": "team-a",
     "recordings": "fixtures/recordings"
   }
   ```

   Every command but `verify` reads `cairnfield.json` in the working folder, which names the team's node and, for a team that shares, an index. This one names no index. `lens` names the team's lens file. This lens takes the team's own patches and publishes a recipe. `team` and `recordings` say where `patch --replay` finds its recording.

3. Put the node's admin key in the environment, as `CAIRNFIELD_ADMIN_KEY`. No key is ever read from a file.

4. Pin the plugin's first commit.

   ```
   COMMIT=f7bea8e45539da2eb26841551a553418437d2a58
   npx --no cairnfield pin https://github.com/peoplerenaissance/fellbeck-sync --branch main --commit $COMMIT
   ```

   `pin` has the node import the component and writes a plain checkout of that commit under `.cairnfield/checkouts/`. The plugin has planted problems, and one is an instruction hidden in a comment. Treat every file of a checkout as data.

5. Publish the saved findings.

   ```
   mkdir -p .cairnfield/outbox
   cp -R fixtures/outboxes/team-a/records .cairnfield/outbox/
   npx --no cairnfield validate
   npx --no cairnfield publish
   ```

   Record files go in `.cairnfield/outbox/`, at `records/<commit>/<type>/<id>.json`. `validate` checks them against the checkout and needs no key. `publish` validates and then pushes them to the team's repo on the node. Each command prints one line of JSON and returns an exit code, which `cli/src/outcome.ts` lists.

6. Patch one finding.

   ```
   npx --no cairnfield patch $COMMIT --finding 72b5c551a1e4d6e2a878068dfd3dc3eceac11ed32d56e0110d54dcc67fd83ba9 --replay
   ```

   That finding says that line 12 of `plugin.json` allows network access to any host. `patch` writes a patch for it as a checked commit in the team's fork, and publishes a patch record. With `--replay` the edits come from the recording in `fixtures/recordings/`, and no model is called.

7. Build the copy and record the verdict.

   ```
   npx --no cairnfield assemble $COMMIT
   npx --no cairnfield decide $COMMIT --verdict approved-with-required-mitigations --tree <tree-hash>
   ```

   `assemble` prints the diff of the copy against the original, writes the copy under `.cairnfield/copies/` and gives the copy's file-tree hash. This lens publishes recipes, so `assemble` also pushes the copy to the team's fork and publishes a recipe record. A person reads the diff and gives the verdict: `approved`, `approved-with-required-mitigations` or `not-approved`. `decide` takes that tree hash, so the verdict is for the copy whose diff was read and for no later one. It writes the verdict to `.cairnfield/decisions.json`, under the Git URL the commit was pinned from. That file is the team's table of what it may install, with one entry for each component. It is never published, and the team shares it by its own means.

8. Check the copy.

   ```
   npx --no cairnfield verify https://github.com/peoplerenaissance/fellbeck-sync .cairnfield/copies/$COMMIT --approvals .cairnfield/decisions.json
   ```

   `verify` passes only when the folder's file-tree hash is the one the team approved. It reads the folder and the file and nothing else. It skips the `.git` folder at the top of a clone, and says nothing about what that folder holds. When a component's tree holds a link, the folder under `.cairnfield/copies/` leaves it out, and only a clone of the published copy has the approved hash. The demo plugin holds none: `pin` prints an empty `leftOut` for it.

`approvals` prints what the decisions file holds. Its output saved to a file, or a copy of `decisions.json`, is the approvals file that `verify` reads. An engineer who holds one checks an installed copy against it, on any machine:

```
npx --no cairnfield approvals > approvals.json
npx --no cairnfield verify <git-url> <folder> --approvals <file>
```

The team runs the first line and shares the file. The engineer runs the second in a clone of this repo, after `npm install`. The folder and the file may be anywhere on that machine. For a published copy, the folder is a clone of the branch `copy/<commit>` of the team's fork. Anyone can fetch that branch with a read token from the node's `read-token` route.

When the plugin releases again, the team carries its own work to the later commit:

```
npx --no cairnfield carry $COMMIT 3c917ed01796b28a0474abb73e0f09abfbf47326 --branch main
```

`carry` pins the later commit and writes the team's own findings and patches again for it. The later commit changes one script, so the finding on that script is named as not carried, with the reason `content-changed`. The patch carries and keeps its patch ID. Then `assemble`, `decide` and `verify` run for the later commit as they did for the first.

#### A component of your own

Pin it by its HTTPS Git URL, a branch that holds the commit and the full commit hash. Findings come from your own review agent or from a person, through the outbox: see [Let your own agent write findings](#let-your-own-agent-write-findings). A lens file states the patch level, the teams it names, the patch kinds it accepts and whether recipes are published. `fixtures/lenses/` holds three. Without `--replay`, `patch` calls a model and reads its key from `ANTHROPIC_API_KEY`. [`cli/evals/README.md`](cli/evals/README.md) says how to check such a run.

These are the commands. Each is run as `npx --no cairnfield <command>`, and each but `verify` takes `--config <file>` for a config file in another folder.

| Command | What it does |
| --- | --- |
| `pin <git-url> --branch <branch> --commit <full-hash>` | Has the node import a component and writes the checkout of one commit. With an index in the config, it also registers the node and the commit there. |
| `validate` | Checks every record file in the outbox against the checkout. It needs no key and publishes nothing. |
| `publish` | Validates the outbox and pushes it to the team's repo on the node. Then it sends the index a notice, when the config names an index. |
| `claim <commit> --kind review --check <kind>` | Publishes a claim: a record that says a review has started. |
| `claim <commit> --kind patch --findings <id>[,<id>] --intent <intent>` | Publishes a claim that says a patch for those findings has started. `patch` does this itself. |
| `view <commit>` | Prints the index's view of a commit, with only the team's own work and the work of the teams its lens names. It needs an index. |
| `patch <commit> --finding <id> [--replay]` | Writes a patch for one of the team's own findings, from a live model call or from a recording. |
| `assemble <commit>` | Builds the team's copy from the patches its lens lets in, and prints the full diff. |
| `decide <commit> --verdict <verdict> [--tree <tree-hash>]` | Writes down the verdict a person gave. |
| `approvals` | Prints the team's table of verdicts. |
| `verify <git-url> <folder> --approvals <file>` | Compares a folder's file-tree hash with the approved entry. It reads no config file. |
| `carry <older-commit> <newer-commit> --branch <branch>` | Moves the team's own findings and patches to a newer commit. |

### Replay the demo

`npm run demo`, from the repo root, plays the demo's four steps with two teams. It reads each team's saved findings from `fixtures/outboxes/` and the saved edits of each patch run from `fixtures/recordings/`. It calls no model. On a terminal it prints each team in its own color, each result as indented JSON and the diff `assemble` prints in red and green. Piped, or with `NO_COLOR` set, it prints one plain line for each command and each result.

1. **One team alone.** Team A has no index in its config. It pins the plugin, publishes its saved findings, replays the patch for the any-host finding, builds its copy and records a verdict. An engineer's `verify` then runs on the published copy.
2. **Two teams at the same moment.** Team A adds the index to its config and pins again, which registers its node and the commit. Team B pins and publishes. Both teams then claim and patch at the same moment. Both remove the hidden instruction, with the same edit, so the index shows one patch with two organizations. Team B also narrows the environment variables, on the line after Team A's any-host patch, so the page shows those two patches side by side. Team B then publishes a patch made by hand that changes a line its finding does not cite, and the index rejects it.
3. **Taking another team's patch.** Team A names Team B in its lens and builds its copy again. The copy now holds Team B's patch and has another file-tree hash.
4. **A new release.** Team A carries its own findings and patches to the plugin's later commit and builds its copy there. `carry` names Team B's patch as left behind.

The script checks what each step must leave behind and stops at the first thing that is missing. It ends by printing the address of the page and one line of JSON with the record files each node holds, the three patch IDs and the three file-tree hashes. Two runs from a reset state print the same line.

The demo replays four patch runs. Two recordings hold what a model wrote in a live run: one team's fix of the any-host rule and the other's fix of the every-variable rule. The other two are written by hand, with the model `none`: both teams' removal of the hidden instruction. In four live runs on that line, with two models, the patch agent wrote no patch. The model's service refused the first run. In the other three the model read the line, then called a tool again and again until the run's limit of 40 requests.

One more patch in the demo is written by hand: the one the index rejects, in [`fixtures/out-of-scope/`](fixtures/out-of-scope/README.md).

#### What you deploy first

The replay needs two nodes and an index of your own, in a Cloudflare account on the Workers Paid plan.

Deploy the index first. Run these in `index/`. `GIT_URLS` is the list of Git URLs the index may import, and the demo imports one.

```
npx wrangler login
export GIT_URLS=https://github.com/peoplerenaissance/fellbeck-sync
npm run deploy
npm run migrate
npx wrangler secret put REGISTRATION_KEY
npx wrangler secret put RESET_KEY
git restore wrangler.jsonc
```

Wrangler prints the address the index answers at. Give the two keys different values. `openssl rand -hex 32` prints a new key. With Wrangler 4.148.0, the first deploy created the index's database and its queue by itself, and wrote their IDs into `index/wrangler.jsonc`. The new database had no tables, and the view answered HTTP 500 until `npm run migrate` ran. `git restore` discards Wrangler's change to the config file. The repo keeps no ID there, and Wrangler finds the database by its name.

Then deploy the two nodes. The demo's nodes are the `team-a` and `team-b` environments of `node/wrangler.jsonc`. Each has a Worker, an Artifacts namespace and a Workflow of its own, so both fit in one account. A node is given its own address when it deploys, so set these three in the shell first.

| Variable | Holds |
| --- | --- |
| `TEAM_A_NODE_URL` | The base URL of Team A's node. On `workers.dev` a Worker answers at `https://<worker name>.<your subdomain>.workers.dev`, and this Worker's name is `cairnfield-node-team-a`. |
| `TEAM_B_NODE_URL` | The base URL of Team B's node. Its Worker's name is `cairnfield-node-team-b`. |
| `INDEX_URL` | The address of the index: an HTTPS URL with no slash at its end. |

Run these in `node/`, which installs on its own:

```
npm install
npm run deploy:team-a
npm run deploy:team-b
npx wrangler secret put ADMIN_KEY --env team-a
npx wrangler secret put ADMIN_KEY --env team-b
```

Give each node a different admin key. [`node/README.md`](node/README.md) says more about a node and its key.

#### Play it

Both scripts read everything from the environment. Neither prints a key, a token or a Git remote. Keep the three addresses set, and add the keys. Write no key in a file.

| Variable | Holds |
| --- | --- |
| `TEAM_A_ADMIN_KEY` | The admin key of Team A's node |
| `TEAM_B_ADMIN_KEY` | The admin key of Team B's node |
| `CAIRNFIELD_REGISTRATION_KEY` | The index's registration key, for `npm run demo` |
| `CAIRNFIELD_RESET_KEY` | The index's reset key, for `npm run demo:reset` |

From the repo root:

```
npm run demo
```

The demo starts only from its start state: two nodes that list no record, and an index that holds none for the plugin's two commits. A deployment that has published nothing is in that state. From any other state the script stops before its first step and names the reset, because its steps would pass on records that were there already.

To play it again, put the nodes and the index back to the start first:

```
npm run demo:reset
```

The reset takes every record off the two nodes' branches. It adds a commit with an empty tree, deletes no repo and keeps the history. It sends the index a notice for each node and waits until the index has read both emptied nodes. Then it has the index drop its records, and waits until the index has read both nodes again.

#### What has run

- The authors ran the index's steps in this order on its first deploy, on October 10, 2026. [`reference/platform-notes.md`](reference/platform-notes.md) records what they saw.
- The demo's own two nodes are deployed from the two environments above.
- Both demo scripts ran on those two nodes and the index on October 10, 2026: the reset, then the demo, then both again. The second run left the page with the same finding IDs, patch IDs and file-tree hashes as the first. The tests also play both scripts against stand-ins for the two nodes and the index.
- Nobody has yet followed this section from its first step in a new Cloudflare account. The deploys above and the two scripts ran at different times, on nodes and an index that were already there.

### Deploy a node

A team node is the one piece of Cairnfield a team hosts. A setup script deploys it. Run these in `node/`:

```
npm install
npx wrangler login
npm run setup
```

The script deploys the node on `workers.dev`, or on a hostname of your own. It stops when Wrangler is not logged in, deletes nothing, and never makes, reads or stores the node's admin key. You set that key by hand, and the node refuses every admin call until you do. [`node/README.md`](node/README.md) gives the options, what the script creates, how to set the key and how to check the node.

The script's tests run it against a stand-in for Wrangler. It has not run on a Cloudflare account yet.

A one-click deploy button waits on platform support. Cloudflare's documentation for the button does not list Artifacts, Workflows or event triggers among what it sets up, and nobody has tested it on a node.

### Let your own agent write findings

Cairnfield bundles no reviewer agent. A team's findings come from its own review agent, or from a person, through the outbox. [`skills/cairnfield/SKILL.md`](skills/cairnfield/SKILL.md) is written for that agent. It gives the finding record and its closed lists of values. It says where the outbox is and how a record file is named. It names `validate` as the one command the agent runs. `protocol/schemas/` holds a JSON Schema of each record type.

The work is split in three.

1. The operator pins the component.
2. The agent reads the checkout as data and writes one record file for each finding into the outbox. It runs `npx --no --offline cairnfield validate` until its files pass, and stops.
3. The operator runs `publish`. It sends the admin key to the node that `cairnfield.json` names, and an agent that ran in that folder could have changed the file. So the operator reads `cairnfield.json` first, or starts the agent with only the outbox writable.

Start the agent in the folder that holds `cairnfield.json`, and give it this instruction:

```
Follow <repo>/skills/cairnfield/SKILL.md. Review the checkout of <commit>. Stop when validate accepts your files.
```

`<repo>` is the path to this repo, and `<commit>` is the full hash the operator pinned. A harness started in the repo root may also load this repo's `AGENTS.md` and `CLAUDE.md`, which are written for coding agents on this repo and give a review agent no instructions.

Do not start the agent in a shell that holds `CAIRNFIELD_ADMIN_KEY` or `CAIRNFIELD_REGISTRATION_KEY`, the index's registration key, which `pin` reads when the config names an index. The agent has just read a component that may be hostile, and `validate` needs no key. The skill file tells the agent to check that neither key is set. The command cannot enforce where a key is set, so this rests on the operator.

## The protocol in brief

- **A component is one Git commit.** Its name everywhere is the full commit hash.
- **A record is one small JSON file that states one checkable thing.** There are seven types: claim, finding, re-check, counter-finding, patch, patch re-check and recipe. A published record is never edited or deleted, and its ID is the SHA-256 of its content.
- **No record holds free text.** A field is a value from a closed list, a hash, a whole number, a path or a hostname.
- **A finding names a file, a line range, a criterion and an observation.** It carries no verdict.
- **The command and the index each check every record.** The command checks its outbox against its own checkout. The index checks every record it reads against its own copy. A cited path must be a file there, the lines must lie within it, and a finding's host must appear in the lines it cites.
- **Two findings match when they share an observation, cite the same file content and their lines overlap.** A group is confirmed at two organizations. An organization is one registered node, and nothing more is proven about who runs one.
- **A patch is one commit on the pinned commit.** It may change only the lines its findings cite. It holds at most 3 replacements, changes at most 60 lines and adds at most 8 KB. Its ID comes from the content it replaces and the content it puts in its place. So identical patches from two teams share one ID, and so does the same patch on a later commit.
- **A lens is a team's local policy file.** Level 0 takes no patch, level 1 takes the team's own, and level 2 also takes patches of the teams the lens names. It is never published.
- **A node is storage.** It serves a team's records and patch commits over HTTP and validates nothing.
- **The index is untrusted.** `assemble` takes only a list of candidates from it. It fetches each patch from the node of the team that wrote it and runs every check again.

[`reference/protocol.md`](reference/protocol.md) has the rest. It also states each requirement and decision that a comment in the code cites, such as `R2` or `KTD4`, under the same ID. `protocol/schemas/` holds the record shapes as JSON Schema files and the index routes as an OpenAPI description. [`reference/platform-notes.md`](reference/platform-notes.md) says what Cloudflare Artifacts and Workers were seen to do, and what was only read in documentation.

## The public demo page

The demo's index draws the page of the demo plugin's first commit here:

https://index.cairnfield.net/components/f7bea8e45539da2eb26841551a553418437d2a58

The page reads the index's view every two seconds and draws nothing else: live claims, findings by criterion, patches side by side, recipes, and pending and rejected work. The view itself is JSON, at the same address with `/view` added. The page shows what the index holds when you open it. The [status table](#status-as-of-october-11-2026) says what has run on that index.

## Limits and threat model

### Limits of the prototype

The prototype shows the mechanism at one commit of one component. Three limits follow.

- **A hosted tool with no Git commit cannot be pinned.** A hosted MCP server with no public source has no fixed version to review and nothing to patch. It is out of scope. Only controls in a team's own environment cover it.
- **Only a team's own findings and patches carry forward to a new version.** `cairnfield carry` writes them again for a newer commit when the content they cite is unchanged. A finding or a patch follows its content, so when a release edits a file and keeps a byte-identical copy of the old content at another path, both move to that copy and the edited file stays as the release made it. The output then says `content-moved` and names the path. No other team's work moves with them, and a view does not show carried work as carried. When a component releases often, teams spread across many commits, and each commit gathers less evidence. Carrying other teams' work forward is the first follow-up after the prototype. It decides whether Cairnfield works for a plugin that changes every week.
- **A patch changes the component, not a team's environment.** An allow list, a sandbox rule or an instruction on an engineer's machine is not a record, and Cairnfield cannot check it.

A patched copy stays pinned, so a new release does not change what a team runs. The cost comes when the team moves to that release: it reviews the changes and applies its patches again.

Cairnfield does not replace environment controls. The two work as a pair. The shared findings tell a team which hosts a version reaches and which versions it can trust. The team's own settings enforce that.

An index takes at most 8 nodes, and the scale run needs a paged view before that cap goes up.

### What the prototype defends against

Cairnfield assumes that some contributors are hostile, and that any component under review may be. The prototype builds four defenses.

1. **Checks on records and patches.** No record holds free text, a cited line must exist, and a patch may change only the lines its findings cite, up to a size limit.
2. **Tokens scoped to one repo.** A write token comes only from a node's admin routes, and none is ever issued for a component copy.
3. **Checking again at assembly.** The command fetches each patch from the node of the team that wrote it and runs every check itself.
4. **A lens that names teams.** Only the team's own work and the work of teams it names counts for it.

The rest of the threat model is built in part or not at all. [`reference/threat-model.md`](reference/threat-model.md) goes through it threat by threat and says what the prototype builds for each. These four parts of the design are described there and not built:

- **Domain verification.** Nothing proves who runs a node, or that two nodes are two organizations.
- **Maintainer flags.** Nothing ties a node to a component's author, so a contribution from the author is not marked.
- **Removal of a contributor from an index.** No route removes a node. A team's lens can leave the node out, and a `teams` query narrows a view to the nodes it lists.
- **The unreviewed list.** A team would keep a local list of the components it uses and has not reviewed.

A fifth part, the display of models used, is built in part. Findings and patch records name the model that wrote them. The page shows the model that each patch record declares, under the word "declared", and the model of no other record. Nothing checks the model a record declares.

Some limits belong to the design and not to the prototype. Every node is public, so a finding cannot be sealed until a fix is ready. Nothing proves that two confirmations are independent. The same document lists these under "Not solved by the design".

### Four risks to know

- **Naming a team in a lens is a statement of trust.** `assemble` checks that team's patches against the lines their findings cite. The checks bound where a patch changes, not what it writes. The operator reads the diff.
- **A hostile component can steer the patch agent.** The bundled agent reads a checkout, and text there may lead it to write a harmful patch. The patch checks bound what a patch can change, and the operator reads the full diff before the verdict.
- **An outside agent must not run in a shell that holds the node's admin key or an index's registration key.** A team's own review agent stops at `validate`, which needs no key. The command cannot enforce where a key is set.
- **Anonymous requests can spend a node's Artifacts request budget.** A node's `records`, `file`, `patch` and `blob` routes read Artifacts on every request, for anyone. Only the read-token route is bounded. The demo accepts this.

### Disclosure policy

The disclosure policy is the last part of [`reference/threat-model.md`](reference/threat-model.md#disclosure-policy). This repo holds no finding about a real product and takes none. Every plugin, host, team and organization in its fixtures and demos is invented. For a finding about a real component, and for a flaw in Cairnfield itself, the rule is the same: tell the maintainer first, and delay publishing. A published record is public at once and is never edited or deleted. [`SECURITY.md`](SECURITY.md) says how to report a flaw in Cairnfield in private.

## Status, as of October 11, 2026

This table describes today.

| Part | State | Note |
| --- | --- | --- |
| Platform behavior the design depends on | verified live | Scoped tokens, concurrent pushes, push triggers, file reads at a commit, forks, and fetching a patch with a read token. |
| Concept and plan | written | The concept was reviewed by seven reviewer agents and the plan by five. |
| Record formats and checks | built | The protocol library in `protocol/`: record schemas, limits, validation, matching and patch checks, with their tests. |
| Protocol, threat model and platform notes | written | In `reference/`. `protocol.md` states each requirement and decision that a comment in the code cites, under the same ID. `threat-model.md` says for each threat what the prototype builds, and holds the disclosure policy. `platform-notes.md` keeps apart what was seen on the platform and what was only read in its documentation. |
| Demo plugin, lenses and saved findings | built | `fellbeck-sync`, an invented plugin with three planted problems, in `fixtures/`. Its two commits are public at https://github.com/peoplerenaissance/fellbeck-sync, so a node can import them. |
| Team node | built and deployed | The Worker in `node/`: the node contract, the admin routes and the push Workflow. Two demo nodes run on Cloudflare. Each has imported the demo plugin and made its fork, and Artifacts refused a push made with a node's public read token. One of them holds a patch commit and passes the contract check in `scripts/check-node-contract.ts`. |
| Setup script for a team node | built, not run on an account | `npm run setup` in `node/` deploys a team node on `workers.dev` or on a hostname of the team's own. It checks each address before it deploys anything, stops when Wrangler is not logged in, deletes nothing and never touches the admin key. Its tests run it against a stand-in for Wrangler and a fake node. It has not run on a Cloudflare account yet. |
| Index | built in part, deployed | The Worker in `index/`: it registers nodes and components with a key, imports its own copy of a component, takes push notices through a queue, reads each node over HTTP and checks every record against its own copy. For a patch record it asks the node for the commit's parent, changed paths and blobs, holds each blob to its hash and runs the patch checks against its own copy. It stores the patch as valid with the ID, kind, size and changed lines it computed, or as rejected with a reason. A commit the node does not serve yet is asked for again for about ten minutes. After that the record stays pending while the node does not serve the commit or a finding it names is not valid. Each later sync of the node looks again at up to 120 of the node's waiting patch records, in turn, so a node with more of them is covered over several syncs. The index also looks again when a finding the record names turns valid. It serves one view per component commit: findings in match groups with their confirmations, patches side by side where their changed lines overlap or adjoin, identical patches as one entry that lists its organizations, claims with their state, recipes, and pending and rejected work. A `teams` query narrows a view to the nodes it lists. Registering a failed component again retries its import with the Git URL and branch the index stored for it. A component whose finished copy does not hold the commit fails again until that copy is deleted by hand. A new URL or branch for a commit is not taken. The index also serves one page per component commit, at `/components/<commit>`. It lists the components it holds at `GET /view`, and serves a page of its own at `/` that reads that list every two seconds and draws each component's Git URL, branch, commit and import state. That page was deployed on October 11, 2026, and lists the demo plugin's two commits. The page reads the view every two seconds and draws nothing else: live claims, findings by criterion with their confirmations and disputes, patches side by side, recipes with a tree hash labelled as published and not checked, and pending and rejected work. A patch shows the model that each of its records declares, under the word "declared" and in a dashed outline, because the index cannot check it. A commit nobody registered, a copy still importing, a failed import and a version with no findings each have a label of their own, and none reads as an all-clear. A `teams` query narrows the page as it narrows the view. Every value from a record or a registration is set as text, a link leaves the page only for an HTTPS address, and the page is served with a content security policy that allows no inline script. After a failed read the last view stays, with the time it was read. The page does not show cited lines, a row per host, the index lag or a fold for a long group of patches. The tests use a local database and stand-ins for Artifacts, the queue, the static assets and the nodes, with patch commits made by hand. They call the pages' drawing code with no browser. A demo index is deployed. On it, the findings and patches of two demo teams appeared in the view and on the page: two patches on adjoining lines side by side, one patch that both teams wrote as one confirmed entry, and a patch made by hand rejected as out of scope. Both of its pages were opened in a browser on October 11, 2026, and drew what the index served. The line for a declared model was built after that deploy, so the demo index does not draw it yet. |
| The command | built in part | `cairnfield` in `cli/`: `pin`, `validate`, `publish`, `claim`, `view`, `patch`, `assemble`, `decide`, `approvals`, `verify` and `carry`. A team working alone needs a node and no index. |
| Skill file for a team's own review agent | written | `skills/cairnfield/SKILL.md` says how an outside agent writes finding records to the outbox and checks them with `validate`, the one command such an agent runs. The operator pins and publishes. |
| Patch agent | built and run live | `cairnfield patch` writes a patch for one of a team's own findings as a checked commit and a patch record, from a live model call or from a recording. The tests use a fake model. A live run on a deployed node patched the demo plugin's any-host rule, and its recording is in `fixtures/recordings/`. A replay gave the same commit and the same records. Live runs on both injection fixtures changed only the cited line. A later live run on the other demo team's node narrowed the environment variables the demo plugin may read, and its recording is there too. On the demo plugin's hidden instruction the agent wrote no patch in four live runs with two models: the model's service refused the first run, and in the other three the model read the line and then called a tool again and again until the run's limit of 40 requests. The command published only the claim each time. |
| Patched copies | built and run live | `cairnfield assemble` builds a team's copy from the patches its lens lets in. It fetches each patch from the fork of the team that wrote it and checks it again. The copy is one commit, and any team with the same pinned commit and the same patches gets the same file-tree hash. The command prints the full diff of the copy. A lens that publishes recipes has it push the copy to the team's fork and publish a recipe record. On a deployed node with no index, one demo team built its copy of the demo plugin twice with one file-tree hash and published its recipe. Taking another team's patch ran live too: through the deployed index, one demo team's lens named the other, and `assemble` fetched that team's patch from its fork, checked it again and built a copy with both teams' patches. A merged patch is not built. |
| Verdicts and checking an installed copy | built and run live | `cairnfield decide` writes down the verdict a person gave for a commit, under the Git URL it was pinned from, with the file-tree hash of the copy the team built. The person names that hash, so a copy built again since is not approved by mistake. `approvals` prints the team's table as its file holds it, one entry for each component. Its output saved to a file is the approvals file `verify` reads. `verify` works out the file-tree hash of a folder and compares it with the approved entry in the approvals file it is given. It runs no Git and reads no config file, so it runs on any machine with Node. The table is a local file and is never published. From a clean folder with no config file and no key, `verify` passed on a clone of a demo team's published copy and failed on a clone of the original. A run on a second machine is still to come. |
| Carrying a team's own work to a new version | built and run live | `cairnfield carry` moves a team's own findings and patches from one pinned commit of a component to a newer one, and pins the newer commit. A finding carries when the newer commit still holds the content it cites, at the same path or at another. A patch carries when the newer commit still holds every content it replaces and every finding it cites carried. It is built again as a commit on the newer commit and keeps its patch ID. The command names each finding and patch that did not carry, with a reason code. It also names each patch of another team that the team's copy of the older commit held, and counts the paths the newer commit added, changed and removed. It carries nothing of another team. The tests run it on the demo plugin's two commits against a stand-in for the node. On a deployed node, one demo team carried its work to the demo plugin's later commit. Its patch kept its patch ID, its finding on the script that changed was reported as not carried, and the copy it then built passed `verify`. A second run published nothing. From a home whose copy of the older commit held the other team's patch, the command named that patch as left behind. |
| Demo script | built and run live | `npm run demo` plays the demo's four steps from one script, with two teams, from the saved findings and the recordings of the patch runs. It calls no model. Two of the four recordings hold what a model wrote: one team's fix of the any-host rule and the other's fix of the every-variable rule. The other two are written by hand, with the model `none`: both teams' removal of the hidden instruction, which the patch agent did not write in any live run. One team alone goes from `pin` to a checked copy. Both teams' patch agents then claim and patch at the same moment, and one team publishes a patch made by hand that the index rejects. The first team names the second in its lens and builds its copy again. Then it carries its own work to the plugin's later commit. The script checks what each step must leave behind and stops at the first thing that is missing. `npm run demo:reset` puts the demo nodes and the index back to the start. The tests play both scripts against stand-ins for the two nodes and the index, and a second run after a reset gives the same record IDs, patch IDs and file-tree hashes. Both scripts ran on the two deployed nodes and the deployed index. The reset emptied both nodes and the index, and the demo then played its four steps to the end. A second reset and run left the page with the same finding IDs, patch IDs and file-tree hashes. |
| Scale run | not in the prototype | A simulator would register a few hundred nodes with one index. `sim/` holds a placeholder. |
| One-click deploy button for the team node | waiting on the platform | To be switched on once Cloudflare's button supports Artifacts, Workflows and push triggers. A setup script deploys the node until then. Nobody has tested the button on the node. |
| Carrying other teams' work to a new version, domain verification, sealed findings | not in the prototype | Described in the repository. |
| Deploys from Artifacts through Workers Builds, and a page on each node | not in the prototype | Described under "Ideas that are not built". |

The build plan named three things to cut if time ran short: `carry`, the display of live claims and the demo's rejected patch. None was cut.

## Roadmap

The prototype is a slice of a larger design. This is what the slice leaves out.

### Parts of the design that are not built

- **One command that runs a whole review.** It would first check whether confirmed findings already rule the component out for the team's lens. Then it would publish claims, run three reviewer agents that read nothing from other teams, validate and publish. The prototype bundles no reviewer agent.
- **Reconciling.** The command would write re-checks and counter-findings on other teams' findings, once the index has read the team's own push. Today a person or a team's own agent writes those records to the outbox.
- **A scale run.** A simulator would register a few hundred nodes with one index. The page would show the count of organizations, label them as simulated and show the index lag. The page would also say when the index has not read every registered node yet. Today a version whose nodes are not read yet says "No findings published", as a version with no findings does.
- **A node in a second Cloudflare account.** The demo's nodes and its index share one account. The index was never shown reading a node in another one.
- **Cited lines on the page.** A person would see the lines a finding cites, read from the index's own copy (R31 in `reference/protocol.md`).
- **A row per host on the page.** The view already carries one row for each host that a finding names, and the page does not show them (R33).
- **An API catalog on the index.** The library generates a description of the index routes and the record schemas. The index does not serve them yet (R34). It also serves no lookup by Git URL and no short form of the view that holds only criteria and hosts (R13).
- **Merged patches.** A patch record can list the patches it merges. No command writes such a record, and no code reads the list.
- **A fuller lens.** It would state the criterion each kind of use requires, the destinations the team approves and the confirmations it requires. At level 3 it would take a patch that enough organizations stand behind (R41).
- **An agent's review of the assembled diff.** A team's own agent would read the full diff of a copy before a recipe is published. Today the operator reads it, and no agent does.
- **A suggested verdict.** The command would work one out from the lens, the view and the copy, and offer it to the operator. Today a person gives the verdict and the command computes none.

### Further work

- **Carrying other teams' work forward, and showing carried work.** The index would show carried work for a newer commit with a label. A carried confirmation is weaker than a fresh one, because other files changed, so a lens would have to opt in to count it.
- **An install gate.** It would apply a recipe on top of an installed copy, compare the tree hash with the approved one, and fail closed when a patch no longer carries. `verify` is the first step.
- **Pinning what runs.** A package tarball or a hosted server's tool manifest would be pinned by its content hash. That brings in tools with no Git commit, and closes the gap between the source a team reviewed and the package it installed.
- **An egress allow list.** The command would write one from the confirmed destination findings of a version and the team's lens. A team that takes no patch would then have something to enforce.
- **Confirmation by re-running.** A finding would carry a check that fails before a patch and passes after, run in a sandbox on push. Confirmation would then not rest on a count of organizations.
- **Signed requests from nodes to an index.** HTTP message signatures would give a node an identity that an index can verify, and would replace the registration key.
- **An index that reads patch commits over Git.** That would remove its trust in the node for a commit's parent and changed paths.
- **A read-only MCP server on the index.**
- **A `since` cursor and a push feed on the view.**
- **Alerts and diff review of new versions.**
- **A private findings log.** A team would keep free-form findings, evidence and mitigations in a local file beside the decisions file. It would never be placed in the outbox or given to an agent.
- **An unclassified pointer.** A record would say that a team has a concern at some lines that the closed lists cannot express. It would carry only a hash of the private note, so no text crosses.
- **A check that a blind pass was really blind.**
- **A local mode with no node.** Records and patch commits would live in a local repo until the team publishes. A team could then start before it has a Workers Paid account.

Three more are under "Ideas that are not built" below.

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
| `node/` | The team node: a Cloudflare Worker that holds a team's repos on Artifacts and serves its records and patch commits. `node/scripts/` holds the setup script that deploys it. |
| `index/` | The index: a Cloudflare Worker that reads registered nodes over HTTP, checks their records against its own copy of each component and serves one view per component commit. It serves data and never instructions. `index/src/page/` holds the two public pages, which draw a view or the list of components for a person. `npm run build` in `index/` writes the pages to `dist/`, and the Worker serves them from there. |
| `cli/` | The `cairnfield` command: it pins a component, validates the outbox of record files, publishes it to the team's node, writes patches with a bundled agent, builds the team's patched copy, keeps the team's verdicts, checks an installed copy and carries the team's own findings and patches to a newer commit. |
| `skills/` | The skill file for a team's own review agent: how to write finding records and check them with `validate`. |
| `reference/` | The protocol, the threat model with the disclosure policy, and the platform notes. |
| `fixtures/` | The demo: an invented plugin with planted problems, the two demo teams' lens files and their saved findings. Also two small components with planted instructions, for checking the patch agent, the recordings of the demo's four patch runs, two written by a model and two by hand, and a patch made by hand that an index rejects because it changes a line its finding does not cite. Not for installing. |
| `sim/` | A placeholder. The scale run is not in the prototype. |
| `scripts/` | The demo script and the script that resets the demo, which run the command for two teams on deployed nodes and an index. Also a check of a deployed node against the protocol's node contract. |
| `site/` | The public site: one page that makes the case for Cairnfield. A Cloudflare Worker serving static files. |
| `AGENTS.md` | Instructions and rules for coding agents working in this repo. |

To see the site locally, run `nvm use` and `npm run dev:site` in the repo root. Then open http://localhost:8787.

## Credit

Cairnfield borrows three ideas: audits published per organization with a local policy (cargo-vet), publishing from your own repo into a rebuildable aggregate (cargo-crev), and a pinned original plus a list of patches (Nix, quilt, patch-package).

## License

MIT. See `LICENSE`.
