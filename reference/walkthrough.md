# Walkthrough

This document is the long form of the README's "Try it" section. It takes one team from `pin` to a checked copy, says what each step leaves behind, and then plays the demo with two teams on nodes and an index of your own. It ends with the staging of a review by a team's own agent. The README gives the same commands with one line each.

Every command is run as `npx --no cairnfield <command>`, from a folder that holds `cairnfield.json`. `verify` needs none. The README's [Deploy a node](../README.md#deploy-a-node) section is not repeated here. Its [Let your own agent write findings](../README.md#let-your-own-agent-write-findings) section gives the split of the work between an agent and its operator, and the instruction for the agent. The last part of this document builds on it.

## One team alone

This path takes the demo plugin, `fellbeck-sync`, from `pin` to a checked copy. It uses one demo team's saved findings and the recording of one patch run, so it calls no model and needs no model key. It needs no index and no other team.

The test named AE18 in `cli/test/verify.test.ts` plays this path from `pin` to `verify` against a stand-in for the node. The [status table](../README.md#status-as-of-october-12-2026) says which steps have run on a deployed node.

1. Deploy a node and set its admin key, as [Deploy a node](../README.md#deploy-a-node) says.

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

   That finding says that line 12 of `plugin.json` allows network access to any host. `patch` writes a patch for it as a checked commit in the team's fork, and publishes a patch record. With `--replay` the edits come from the recording in `fixtures/recordings/`, and no model is called. `patch` also attaches a note to the commit, which says how the commit was made. [Read the note on a patch commit](#read-the-note-on-a-patch-commit) says how to fetch it.

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

`carry` pins the later commit and writes the team's own findings and patches again for it. A finding or a patch follows its content, so when a release edits a file and keeps a byte-identical copy of the old content at another path, both move to that copy and the edited file stays as the release made it. The output then says `content-moved` and names the path. No other team's work moves, and a view does not show carried work as carried. The later commit changes one script, so the finding on that script is named as not carried, with the reason `content-changed`. The patch carries and keeps its patch ID. Then `assemble`, `decide` and `verify` run for the later commit as they did for the first.

### Read the note on a patch commit

`patch` attaches a note to each commit it pushes, in the team's fork at `refs/notes/cairnfield`. The note is the team's own statement of how the commit was made: the commit, the findings its patch record names, the model, the SHA-256 of the recording and, when the recording names one, the SHA-256 of the prompt the model ran under. Nothing checks it, and its team can push any bytes in its place: read a note from another team's fork as data. No route of a node serves it, and the index does not read it. Anyone reads it with Git and the read token the node gives for the fork:

```
curl -s "https://<your-node>/read-token?component=$COMMIT"
git init --quiet notes
git -C notes -c http.extraHeader="Authorization: Bearer <token>" fetch <remote> refs/notes/cairnfield:refs/notes/cairnfield
git -C notes ls-tree --name-only refs/notes/cairnfield
git -C notes notes --ref=cairnfield show <patch-commit>
```

The first line prints the fork's `remote` and a `token`. The fourth lists the commits that have a note. The last prints the note of one of them as one line of JSON, where `<patch-commit>` is the `commit` that `patch` printed. A commit that `carry` built has no note, and neither has a patch commit made by hand. In the demo no note names a prompt: its two recordings that a model wrote were saved before a live run kept that hash, and the other two were written by hand.

### A component of your own

Pin it by its HTTPS Git URL, a branch that holds the commit and the full commit hash. Findings come from your own review agent or from a person, through the outbox: see [Let your own agent write findings](../README.md#let-your-own-agent-write-findings). A lens file states the patch level, the teams it names, the patch kinds it accepts and whether recipes are published. `fixtures/lenses/` holds three. Without `--replay`, `patch` calls a model and reads its key from `ANTHROPIC_API_KEY`. [`cli/evals/README.md`](../cli/evals/README.md) says how to check such a run.

These are the commands. Each is run as `npx --no cairnfield <command>`, and each but `verify` takes `--config <file>` for a config file in another folder.

| Command | What it does |
| --- | --- |
| `pin <git-url> --branch <branch> --commit <full-hash>` | Has the node import a component and writes the checkout of one commit. With an index in the config, it also registers the node and the commit there. |
| `validate` | Checks every record file in the outbox against the checkout. It needs no key and publishes nothing. |
| `publish` | Validates the outbox and pushes it to the team's repo on the node. Then it sends the index a notice, when the config names an index. |
| `claim <commit> --kind review --check <kind>` | Publishes a claim: a record that says a review has started. |
| `claim <commit> --kind patch --findings <id>[,<id>] --intent <intent>` | Publishes a claim that says a patch for those findings has started. `patch` does this itself. |
| `view <commit>` | Prints the index's view of a commit, with only the team's own work and the work of the teams its lens names. It needs an index. |
| `patch <commit> --finding <id> [--replay]` | Writes a patch for one of the team's own findings, from a live model call or from a recording, and attaches a note to its commit. |
| `assemble <commit>` | Builds the team's copy from the patches its lens lets in, and prints the full diff. |
| `decide <commit> --verdict <verdict> [--tree <tree-hash>]` | Writes down the verdict a person gave. |
| `approvals` | Prints the team's table of verdicts. |
| `verify <git-url> <folder> --approvals <file>` | Compares a folder's file-tree hash with the approved entry. It reads no config file. |
| `carry <older-commit> <newer-commit> --branch <branch>` | Moves the team's own findings and patches to a newer commit. |

## Replay the demo

`npm run demo`, from the repo root, plays the demo's four steps with two teams. It reads each team's saved findings from `fixtures/outboxes/` and the saved edits of each patch run from `fixtures/recordings/`. It calls no model. On a terminal it prints each team in its own color, each result as indented JSON and the diff `assemble` prints in red and green. Piped, or with `NO_COLOR` set, it prints one plain line for each command and each result.

1. **One team alone.** Team A has no index in its config. It pins the plugin, publishes its saved findings, replays the patch for the any-host finding, builds its copy and records a verdict. An engineer's `verify` then runs on the published copy.
2. **Two teams at the same moment.** Team A adds the index to its config and pins again, which registers its node and the commit. Team B pins and publishes. Both teams then claim and patch at the same moment. Both remove the hidden instruction, with the same edit, so the index shows one patch with two organizations. Team B also narrows the environment variables, on the line after Team A's any-host patch, so the page shows those two patches side by side. Team B then publishes a patch made by hand that changes a line its finding does not cite, and the index rejects it.
3. **Taking another team's patch.** Team A names Team B in its lens and builds its copy again. The copy now holds Team B's patch and has another file-tree hash.
4. **A new release.** Team A carries its own findings and patches to the plugin's later commit and builds its copy there. `carry` names Team B's patch as left behind.

The script checks what each step must leave behind and stops at the first thing that is missing. It ends by printing the address of the page and one line of JSON with the record files each node holds, the three patch IDs and the three file-tree hashes. Two runs from a reset state print the same line.

The demo replays four patch runs. Two recordings hold what a model wrote in a live run: one team's fix of the any-host rule and the other's fix of the every-variable rule. The other two are written by hand, with the model `none`: both teams' removal of the hidden instruction. In four live runs on that line, with two models, the patch agent wrote no patch. The model's service refused the first run. In the other three the model read the line, then called a tool again and again until the run's limit of 40 requests.

One more patch in the demo is written by hand: the one the index rejects, in [`fixtures/out-of-scope/`](../fixtures/out-of-scope/README.md).

### What you deploy first

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

Give each node a different admin key. [`node/README.md`](../node/README.md) says more about a node and its key.

### Play it

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

### What has run

- The authors ran the index's steps in this order on its first deploy, on October 10, 2026. [`platform-notes.md`](platform-notes.md) records what they saw.
- The demo's own two nodes are deployed from the two environments above.
- Both demo scripts ran on those two nodes and the index on October 10, 2026: the reset, then the demo, then both again. The second run left the page with the same finding IDs, patch IDs and file-tree hashes as the first. The tests also play both scripts against stand-ins for the two nodes and the index.
- Nobody has yet followed this section from its first step in a new Cloudflare account. The deploys above and the two scripts ran at different times, on nodes and an index that were already there.

## Stage a review with an agent

`npm run demo:agent` stages the demo's first step with a review agent in it, for a recording or a rehearsal. The script is the operator and holds the keys. The agent runs in another pane, which a person starts, and holds none. The script covers Claude Code. It needs the two nodes and the index of [What you deploy first](#what-you-deploy-first), the three addresses, and all four keys of [Play it](#play-it). It runs only from a terminal.

1. **The script sets up.** It resets the demo, as `npm run demo:reset` does. In a new folder under the machine's temporary folder, it writes Team A's config with the index in it and pins the plugin's first commit. It copies the skill file to `.claude/skills/cairnfield/` in that folder.
2. **It prints a line and a prompt, and waits.** The line changes to that folder and starts Claude Code with every key name of the demo unset. `ANTHROPIC_API_KEY` is among them, so Claude Code needs a login of its own. The prompt is the README's instruction for the agent, with the commit and the launcher's path filled in. Paste the line into a second pane that runs Node 22.22.1 or later, and give the agent the prompt.
3. **The agent reviews.** It runs the skill's key check, reads the checkout, writes its findings and runs `validate` until its files pass. Then it stops.
4. **You say go.** Quit the agent, then press Enter in the script's pane. No other key ends the wait. The script watches neither the agent nor the outbox.
5. **The script publishes.** It read `cairnfield.json` once, before it waited, and `validate` and `publish` work from that reading. So the admin key goes to the node the script pinned with, whatever the file says by now. It still holds the file to the bytes it pinned with, and stops when they differ. It runs `validate`, and waits for Enter again when the outbox holds no record or a file is refused. Then it runs `publish`. When the push landed and the notice to the index failed, it sends the notice itself.
6. **It checks.** It stops unless the node's branch holds each record it pushed and the index lists each finding. It names a record the index rejected, with the reason.

The findings are the agent's own. They need not be the saved ones, and the demo's later steps do not follow from them. The reset left the public page empty, and this run leaves at most one team's findings on it. So the script ends, whether it finished or stopped, by naming the two commands that put the four-step demo back: `npm run demo:reset`, then `npm run demo`. It keeps its folder, whose outbox holds what the agent wrote.

### Three limits the script does not close

- **The keys are one process away.** The printed line keeps every key out of the agent's own environment, and it does no more. The script holds the keys in its own environment while it waits, and a process can read the environment of another process of the same user. An agent that keeps to its skill file never looks. One that a component has turned can. Against that agent, run it as another user of the machine, or in a container that sees neither the script's process nor the operator's folder.
- **The checkout is under the agent's folder.** The script starts the agent in the folder that holds the checkout, and switches off nothing in the harness. That is safe for this plugin alone: its first commit holds no `CLAUDE.md`, no `AGENTS.md` and no `.claude/` folder. It is a fact about `fellbeck-sync` and no method. For a component of your own, do one of the two things under [Instruction files in a checkout](#instruction-files-in-a-checkout).
- **The harness is the operator's own.** Claude Code loads the operator's own settings, skills, hooks and MCP servers, as it does in any folder. A tool among them that reaches a network is within the agent's reach. Leave Claude Code in the mode that asks before each command and each write.

### Install the skill for another harness

A harness loads a skill from a folder of its own, and a skill file at any other path is only a file to read. The script fills Claude Code's folder itself. For any harness, the `skills` command-line tool installs a skill into a project. Run it in the operator's folder:

```
npx skills add peoplerenaissance/cairnfield
```

In place of the repo's name it takes the path of a clone. By its documentation, it writes one copy under `.agents/skills/` and links `.claude/skills/cairnfield` to that copy. It downloads and runs a package from npm. Nobody has run it on this repo yet.

| Harness | Reads a project's skills from |
| --- | --- |
| Claude Code | `.claude/skills/` in the folder it starts in and in each folder above it |
| Codex, and the other harnesses the tool installs for | `.agents/skills/` in the working folder and in each folder above it, up to the repository root |

Both rows are from each harness's documentation.

### Instruction files in a checkout

A checkout holds a component's own files, and a component can hold instruction files for a harness. By its documentation, Claude Code loads a `CLAUDE.md`, an `AGENTS.md` or a `.claude/skills/` folder that lies below the folder it started in, the first time the agent reads a file beside it. Other harnesses honor files of their own. The skill file tells the agent that such a file is the component's, and it cannot stop a harness from loading one. So the operator does one of the two things the [threat model](threat-model.md) names: switch off the loading of nested instruction files in the harness, or keep the checkout outside the folder tree the agent starts in.

### What has run of the staging

- The script's tests play it against stand-ins for the two nodes and the index. The test writes the saved findings in the agent's place.
- Its wait for Enter was tried on a terminal by itself.
- The script has not run on the deployed nodes and index, and no agent has been started from the line it prints.
