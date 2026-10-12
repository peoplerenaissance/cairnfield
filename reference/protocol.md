# The Cairnfield protocol

Cairnfield lets teams publish checkable findings and patches about a shared component, each team from its own repos. This document says what the parts are, what a record may hold and how the checks work. It then states every requirement and decision that a comment in the code cites, under the same ID.

The code is the truth. `protocol/src/` holds every record, limit and check as pure functions. `protocol/schemas/` holds the record shapes as JSON Schema files, and the index routes as an OpenAPI description in `protocol/schemas/openapi.json`. Both are generated from that code. Where this document and the code differ, the code is right.

Two documents sit beside this one. `threat-model.md` says which attacks the prototype defends against and which it does not. `platform-notes.md` says what Cloudflare Artifacts and Workers were seen to do.

## The parts

| Part | What it is |
| --- | --- |
| Component | One version of a plugin, a skill or a server: a Git repository at one commit. Its name everywhere is the full commit hash. |
| Node | What one team hosts: a Worker and an Artifacts namespace. The namespace holds the team repo with the team's records, a pinned import of each component, and a fork of each import for the team's patch commits. A node's identity is its base URL. |
| Index | A Worker that reads registered nodes over HTTP, checks what they publish against its own import of each component, and serves one view per component commit. It holds nothing original, and anyone can run one. |
| Record | One small JSON file that states one checkable thing about a component. |
| Patch | One commit on the pinned commit, in the fork of the team that wrote it. A patch record announces it. |
| Lens | A team's local policy file. It says which patches the team takes and which teams' work counts for it. It is never published. |
| Copy | Three things. A component copy is a node's pinned import. The index's copy is the index's own import. A team's copy is what the team builds: the pinned commit with the patches its lens lets in, as one commit. |
| Organization | One registered node. Nodes are counted by base URL, and nothing more is proven about who runs one. |
| The command | `cairnfield`, the local program in `cli/`. It validates, pushes, runs the patch agent and builds copies. |

## Records

There are seven record types. Every record carries the schema version, its type and its component.

| Type | Says | Also names |
| --- | --- | --- |
| `claim` | Work has started | A kind, `review` or `patch`, and a run number. A review claim names a kind of check and no file. A patch claim names the findings it will fix. |
| `finding` | What a reviewer saw at some lines | A file, a line range, a criterion, an observation, the kind of check and the model. A finding about an outside destination names the host. |
| `re-check` | A finding holds | The finding and the model. |
| `counter-finding` | A finding is disputed | The finding, a reason and the model. |
| `patch` | A patch commit exists | The commit, one to eight findings and the model. |
| `patch-re-check` | What a team made of a patch | The patch ID, a verdict and the model. |
| `recipe` | A team built this copy | The patch IDs in the copy and its file-tree hash. |

Four rules hold for every record.

- **Immutable and named by content.** A record's ID is the SHA-256 of its canonical JSON. Its path in a team repo is `records/<component-commit>/<type>/<id>.json`. Nothing edits or deletes a published record.
- **No free text.** A field is an enumerated value, a hash, a whole number, a path or a hostname, or a set or a location built from those.
- **Backward pointers only.** A patch names its findings. A finding never names its patch. No record names its own node.
- **References are declared, facts are computed.** Match groups, confirmation counts and everything about a patch but its commit are worked out from content.

`protocol/schemas/<type>.json` holds each shape. The closed lists of values are under [Appendix J](#appendix-j-the-closed-vocabularies).

## Criteria and observations

A criterion is a promise a team wants a component to keep. A finding counts against the promise that its cited lines break.

| Criterion | The promise |
| --- | --- |
| `safe-to-read` | Loading the component's text into an agent's context is safe. |
| `safe-to-run-sandboxed` | Running the component with no credentials and no network access is safe. |
| `safe-to-run-with-access` | Running the component with the permissions and network access it asks for is safe. |
| `works-as-documented` | The component does what its documentation says. It stands apart from the three above and covers ordinary bugs. |

The first three are in order, the most basic first, and each implies the ones before it (R5). A finding counts against the criterion it names and against each later one of the three.

An observation is what a finding says its cited lines do. The page of a component commit says it as one sentence about the component.

| Observation | The cited lines | The page says |
| --- | --- | --- |
| `sends-data-to-host` | send data to the host | This component sends data to *host*. |
| `fetches-instructions-from-host` | fetch text from the host that an agent then follows | This component fetches instructions for an agent from *host*. |
| `loads-resource-from-host` | load code or another resource from the host | This component loads code or another resource from *host*. |
| `network-access-any-host` | allow or ask for network access to any host | This component allows network access to any host. |
| `environment-access-all-variables` | allow or ask for every environment variable | This component allows access to every environment variable. |
| `reads-outside-workspace` | read files outside the workspace | This component reads files outside the workspace. |
| `writes-outside-workspace` | write files outside the workspace | This component writes files outside the workspace. |
| `runs-shell-command` | run a shell command | This component runs a shell command. |
| `runs-with-permissions-bypassed` | run something with permission checks switched off | This component runs something with permission checks switched off. |
| `runs-install-script` | run a script when the component is installed | This component runs a script when it is installed. |
| `hidden-instruction` | hold an instruction to an agent that a person reading the component would not see or expect | This component contains a hidden instruction for an agent. |
| `overrides-host-instructions` | tell an agent to set aside the instructions of its host or its user | This component tells an agent to set aside the instructions of its host or its user. |
| `requests-broad-credential-scope` | ask for a credential that reaches more than the documented feature needs | This component asks for a credential that reaches more than its documented feature needs. |
| `stores-credential-in-plain-text` | store a credential in plain text | This component stores a credential in plain text. |
| `installs-unpinned-dependency` | install a dependency with no pinned version | This component installs a dependency with no pinned version. |
| `documented-control-not-read` | act without reading a setting that the documentation says controls them | This component acts without reading a setting that its documentation says controls it. |
| `fails-on-documented-input` | fail on an input the documentation says works | This component fails on an input that its documentation says works. |

The sentence is the finding's. The page names the organizations that report it on the line under it, and says in the section's own words that a finding is a team's report and no verdict of the index.

## Validation

Validation has two layers. A failure is a reason from a closed list, never a sentence.

1. **Structure and limits.** This needs only the record: its size, its schema version and the fields of its type. A record file must hold the record and nothing else. Its name must be the hash of its content.
2. **Against the pinned copy.** Each cited path must be a regular file there. Each line range must lie within its file. A finding's host must appear in the lines the finding cites.

The command runs both layers on its outbox, against its own checkout. The index runs both on every record it reads, against its own copy.

## The outbox

The outbox is a folder, `.cairnfield/outbox/`, laid out as the team repo is. A person, a team's own review agent and the command itself write record files there. `validate` checks every file and publishes nothing. `publish` checks every file and pushes only when all of them pass. Then it sends the index a notice, when the config names an index.

Every record reaches a team repo this way. The command pushes. An agent never does.

## The node contract

A node is storage with a small HTTP contract. It validates nothing. The shapes are in `protocol/src/contracts.ts`. A route path is relative to the node's base URL.

| Name | Call | Gives |
| --- | --- | --- |
| `listing` | `GET records` | The head commit of the team repo, and each record file's path and blob hash |
| `file` | `GET file?commit=&path=` | One record file as it stood at a commit |
| `patch` | `GET patch?component=&commit=` | A patch commit's parent and its changed paths, each with its mode and blob |
| `blob` | `GET blob?component=&blob=` | The bytes of one blob of a fork |
| `readToken` | `GET read-token?component=` | A read token for the fork of a component |
| `importCopy` | `POST admin/import` | Starts the import of a component, and says whether the copy is ready |
| `createTeamRepo` | `POST admin/team-repo` | Creates the team repo |
| `createFork` | `POST admin/fork` | Forks a component copy |
| `repoToken` | `POST admin/token` | A token for one repo. A copy gets a read token only |

The four `admin/` routes need the node's admin key, in the header `x-cairnfield-admin-key`.

A node also serves a page at its own address, `GET /`, which lists what its team repo holds. The page is not part of the contract, and no index and no command reads it. Every answer the node's Worker builds carries `x-content-type-options: nosniff`. When a route throws, the platform answers with an error page of its own, and the Worker sets no header on that.

## The index routes

`protocol/schemas/openapi.json` describes twelve routes. The index in this repo serves six of them. The other six are shapes in the library that no Worker answers yet.

| Name | Call | Needs | In this repo's index |
| --- | --- | --- | --- |
| `registerNode` | `POST /nodes` | The registration key | Served |
| `registerComponent` | `POST /components` | The registration key | Served |
| `notice` | `POST /notices` | Nothing | Served |
| `view` | `GET /components/{component}/view` | Nothing | Served |
| `list` | `GET /view` | Nothing | Served |
| `reset` | `POST /reset` | The reset key | Served |
| `lookup` | `GET /components?url=` | Nothing | Described only |
| `criteria` | `GET /components/{component}/criteria` | Nothing | Described only |
| `lines` | `GET /components/{component}/findings/{finding}/lines` | Nothing | Described only |
| `catalog` | `GET /.well-known/api-catalog` | Nothing | Described only |
| `description` | `GET /openapi.json` | Nothing | Described only |
| `schema` | `GET /schemas/{type}.json` | Nothing | Described only |

The index also serves a page for each component commit, at `GET /components/{component}`, which reads that commit's view. The index's own page, at `GET /`, reads `GET /view` in the same way. Neither page is part of the contract. Every JSON answer carries the schema version, and a refusal is a code from a closed list.

## Matching and confirmation

A finding's cited content is the blob hash of its file at its component commit. Two findings match when they share an observation, cite the same content and their line ranges overlap. Byte-identical files at different paths are one content. A chain of overlapping findings is one group.

The organizations behind a group are the nodes that published its findings and the nodes that published a re-check of one of them. A group is confirmed at two organizations. That confirms what was seen. Which criterion it breaks is a judgment, so each criterion is counted apart. A counter-finding sits beside the finding it names. It hides nothing and changes no count.

## Patches

A patch is one commit whose only parent is the pinned commit, on the branch `patch/<component-commit>/<patch-id>` of its team's fork.

- **Identity.** A patch amounts to a set of content replacements. Each names an old blob and mode and a new blob and mode, and no path and no commit. The patch ID is the SHA-256 over the replacements. So identical patches from two teams share one ID, and so does the same patch on a later commit that still holds the old content.
- **Checks.** A patch must have the right parent and change regular files only. It may change only content its findings cite, and may add no path. It must rewrite every copy of a content it replaces. It holds at most 3 replacements, changes at most 60 lines and adds at most 8 KB. Last, it may change only the lines its findings cite.
- **Kind.** A patch is `removes-only` when it adds no line and changes no mode. Any other patch is `adds-or-changes`.
- **Groups.** Two patches are in one group when their changed lines in one content overlap or adjoin, directly or through another patch. A group shows side by side. Patch records with one patch ID show as one entry.

The command runs the checks on a patch it wrote before it pushes. The index runs them on every patch record it reads. Assembly runs them again on what it fetched.

`patch` also attaches a note to the commit it pushes, at `refs/notes/cairnfield` of the team's fork (R46). The note is one small JSON file. It says how the team says the commit was made: the commit, the findings its patch record names, the model, the SHA-256 of the recording and, when the recording names one, the SHA-256 of the prompt. Nothing checks a note, and no record names one. Anyone reads it with Git and the fork's read token.

## Lenses and copies

A lens states a patch level, the teams it names, the patch kinds it accepts and whether it publishes recipes. Level 0 takes no patch. Level 1 takes the team's own. Level 2 also takes patches of the teams the lens names.

`assemble` builds the team's copy and prints its full diff and its file-tree hash. A person reads the diff and gives a verdict, and `decide` writes it down in a local table. `verify` compares the file-tree hash of an installed folder with that table. `carry` writes a team's own findings and patches again for a newer commit.

## The IDs in the code

A comment in the code cites a requirement as `R<n>`, a decision as `KTD<n>`, an example as `AE<n>`, and one of four notes as `Appendix <letter>`. Each is stated below as the code has it. The numbers have gaps. A number that is missing here is cited by no code in this repo.

Some comments say "the plan" or "the origin". Those are the project's private build plan and its first concept document. Neither is in this repo, and nothing here needs them. A few comments name a build step as `U<n>`. Those are steps of that plan and name nothing a reader needs.

## Requirements

**R1.** Every record is one immutable JSON file. The types are claim, finding, re-check, counter-finding, patch, patch re-check and recipe.

**R2.** Every record field is an enumerated value, a hash, a whole number, a path or a hostname, or a set or a location built from those. No field holds free text. A cited path must be a regular file in the pinned copy. A finding's hostname must appear in the lines the finding cites.

The host check reads the cited lines as a file, and does not run them. An explicit URL goes to the platform's URL parser, and the hostname the parser reads must be the finding's. A URL ends at white space, and the punctuation of a sentence at the end of such a URL is dropped. All other text is prose, where the name counts unless it is part of a longer name. Two limits follow. Text with no scheme is prose even when a tool would read it as a URL. A URL that a string splits with white space is read as two pieces. The check shows that the name is in the cited lines. It does not show where a program sends data.

**R3.** The command and the index each run both layers of validation, and each refuses a record that fails before an agent reads it. A record file must hold the record and nothing else. A repeated key, an escape or an exponent is refused, because a repeated key could hide free text behind a valid value. White space and key order are free.

**R4.** A finding names a file, a line range, a criterion and an observation at one component commit. A finding whose observation is about an outside destination also names the host, and no other finding may. A finding also names the kind of check and the model. It may name one second location, the line it contradicts, and the claim that announced it. A finding carries no verdict.

**R5.** The shared criteria are `safe-to-read`, `safe-to-run-sandboxed` and `safe-to-run-with-access`, in implication order, and `works-as-documented`, which stands apart. Each safety criterion implies the ones before it. A finding counts against its own criterion and against every stricter one.

**R6.** A team's records, component copies and forks live in that team's own Artifacts namespace. A push needs a write token, and a node gives one only to a caller that holds its admin key.

**R7.** A node serves its records and its patch commits over HTTP. A push to any repo of its namespace starts a Workflow, which sends the index a notice. A node with no index address sends none.

**R8.** A component is identified by its full commit hash: 40 lower-case hexadecimal characters. No route returns a write token for a component copy. Artifacts itself returns a write token from an import, and the node and the index each revoke it.

**R9.** The index reads a node over HTTP only, at the URL the node was registered with. It checks each record's structure. It checks cited paths, lines and hosts against its own copy of the component, never against a node's copy.

**R10.** Two findings match when they share an observation, cite the same file content and their line ranges overlap. Two destination findings share an observation only when they name the same host. File content means the file's blob hash, so byte-identical files at different paths count as one. A chain of overlapping findings is one group.

A group is confirmed when two organizations stand behind it: the authors of its findings, and each node with a re-check of one of them. That confirms what the organizations saw. Each criterion is confirmed apart. An organization stands behind a criterion when its finding, or the finding it re-checked, names that criterion or a weaker one. A criterion is confirmed at two such organizations. A counter-finding names a reason and may cite one location. It never removes or hides a finding and changes no count.

The library also holds the rule that reads criteria against a lens, `countsAgainstLens`. It reads a criterion and a host, never an observation alone. No command applies it yet.

**R11.** The index rejects a patch that changes a line its findings do not cite, that adds a file, that leaves a byte-identical copy of the content it replaces unchanged, or that is over a size limit. It stores the reason. It computes the patch's kind from the diff. The command runs the same checks on a patch it wrote, before any commit is pushed.

**R12.** One sync path serves a push notice, a retry and a full rebuild. Each ends in the same steps: read the node's head and listing, fetch the record files not read yet, check each one, store it.

**R13.** The view of a component commit carries everything the page shows. It holds data and no prose. The library also describes a lookup by Git URL and a projection that holds only criteria and hosts. The index in this repo serves neither.

**R14.** The index serves two pages: its own, at `/`, and one per component commit, at `/components/<commit>`.

The index's own page says in one paragraph what an index is and what it is not: a part of Cairnfield that collects findings, patches and recipes and reports them together, that holds nothing original and gives no verdict, and that no team builds from. Under it the page lists the components the index holds. The versions of one repo stand together under its Git URL, and in it the versions of one branch. A repo stands where its first version was registered, and so does a branch, and the versions of a branch stand in the order they were registered. A failed component that is registered again keeps its place. Each version is a row with its commit, which is a link to that commit's page on the index, and its import state. A mark beside a repo's Git URL leads out to the repo when the URL is an HTTPS address. An address of the form `/?repo=<Git URL>` narrows the page to the versions of that repo, and the page says that it is narrowed. The page of a component commit links there, so a reader gets from one version of a repo to its others. The page narrows the list itself: `GET /view` still takes no query. It shows a Git URL only as the list holds it, and never what the address names. Each import state is a label, and the page shows what the label means when a reader points at it or focuses it.

The page of a component commit says in two sentences what it gathers, and that the index gives no verdict of its own. It shows live claims, work that is being checked, findings by criterion, patches, recipes and rejected work, in that order. Under its heading each section says in plain words what it holds.

A finding is shown as what it says of the component, in one sentence, then its file and lines, then the organizations that report it. Each criterion heads its findings in one block with the promise it stands for, and its name is a link to [Criteria and observations](#criteria-and-observations) in this document. That is the one address the page holds that no record names.

A patch shows the model that each of its records names. Each record has a line of its own: the organization that published it, the word "declared", and the model as the record holds it, with its hyphens. The lines stand in the order of the organizations' addresses. A team states the model, and the index cannot check it. The line is set as a re-check's line is, with no outline. An outline on the page is a status: solid for what is confirmed or checked, dashed for what is unconfirmed. A declared value is a statement and no status. An unconfirmed patch can gain a second organization, and no check reaches a model. The page shows the model of no other record.

Order carries weight on the page. Under a criterion the findings that more organizations report come first. Patches of one group, the groups themselves and recipes are ordered the same way, by the organizations behind each. Entries with as many keep the order of the view. A counter-finding moves nothing, as it changes no count.

A label whose meaning is not plain shows that meaning while a reader points at it or focuses it: a criterion, confirmed and unconfirmed, a patch's kind, the word "declared", pending, a rejection reason, and the hash of a recipe. An organization is shown by its node's address without `https://`, with a small stone in its tone, and the link under it carries the whole address. The tone tells organizations apart and says nothing else. A node address that is not HTTPS is shown whole and is no link.

Each page's bar is a trail: the project's name leads to the project's site, and on the page of a component commit the next part leads to the index's own page. The last part names the page that is open.

Both pages end with the same footer. It credits the people behind the software, says that anyone can run an index and that the credits say nothing of who runs this one, and links to the project's site, its repo, its README and this document.

Each state has words of its own, and none reads as an all-clear.

| State | The page of a component commit says |
| --- | --- |
| The commit is not registered | "No reviews published for this version" |
| The index is importing its copy | "The index is still importing this version" |
| The import failed | "The index could not import this version" |
| The copy is ready and there are no findings | "No findings published", and "This is not a statement that the version is safe." |

Until the index holds its own copy, the page of a component commit shows no count of findings or patches and no section of checked work.

| State | The index's own page says |
| --- | --- |
| The index holds no component | "No component registered" |
| The index is importing a component's copy | "importing" |
| The import failed | "import failed" |
| The copy is ready | "copy held", and never "ready" |

**R15.** A claim says that work has started. The page shows live claims only. The index shows a claim as closed when a finding or a patch record from the same node cites it. A record from another node closes nothing. A claim expires a set time after the index received it.

**R16.** Patches whose changed lines overlap or adjoin in one file content appear side by side, one column each. Patch records with one patch ID are one entry that lists its organizations.

**R18.** An agent the command runs reads one checkout through read-only tools. It has no tool that writes, runs a command or reaches a network. No credential is in its prompt or in a tool result. The command pushes, never the agent.

**R19.** An agent the command runs is given nothing from another team: no record, no patch and no part of a view. Its target is one finding of the team's own.

**R20.** A live run of the patch agent saves its validated edits as a recording. `patch --replay` reads the recording in place of the model call and goes on through the same check, commit and publish path. A replay repeats the commit hash and every record ID of the live run, and the note on the commit (R46).

**R21.** A person or an outside agent writes record files to the outbox, and they publish through the same path as the command's own records. `skills/cairnfield/SKILL.md` and the schemas in `protocol/schemas/` say how. `validate` needs no key and makes no call. It is the one command an outside agent runs. The operator runs `publish`. A record that a person or a script wrote names the model `none`.

**R23.** A lens file states the patch level, the teams it names, the patch kinds it accepts and whether recipes are published. Level 0 takes no patch, level 1 the team's own, and level 2 also those of named teams. Only the team's own work and the work of named teams counts for that team or shows in its `view`. A node the lens does not name can publish, and nothing of it counts.

**R24.** A patch is one commit on the pinned commit in the team's fork, tied to one or more findings and announced by a patch record. It replaces file content, and it rewrites every file in the component that holds the content it replaces. Its identity comes from the content it replaces and the content it puts in its place, not from the commit or the paths. Confirmations are counted per identity: the nodes that published the patch, plus the nodes whose patch re-check says `resolves`.

**R25.** Assembly reads each patch record from the repo of the team that published it, reads the findings it names, and fetches the commit from that team's fork. It runs every patch check again, against the team's own checkout. It takes from the index only the list of candidates. At level 2 it takes another team's patch only when the lens names that team. It prints the full diff of the copy against the pinned commit and gives the copy's file-tree hash. It publishes a recipe record only when the lens says so. A team that does not publish recipes publishes nothing about its copy. The team's verdict stays in a local file.

**R26.** The demo component is `fellbeck-sync`, an invented plugin with three planted problems: a hidden instruction that sends data to an outside host, an over-broad permission block, and a documented off switch that one script never reads. Its public repo holds two commits. The later one changes one script and no file that a demo patch touches. `fixtures/demo-plugin/` holds the source, and `COMMITS.json` there holds the repo's URL and both hashes.

**R27.** The demo has two teams and four steps. One team alone goes from `pin` to a verified copy. Both teams' patch agents then run at the same moment, and the page shows one patch that both wrote identically, two patches side by side on adjoining lines, and one rejected patch. The first team names the second in its lens, takes its patch, and its tree hash changes. The first team carries its work to the plugin's later commit. The steps play from the saved findings in `fixtures/outboxes/` and the saved edits in `fixtures/recordings/`. A test in `index/test/page.test.ts` draws the page as the third step leaves it. The status table in `README.md` says how much of the demo has run.

**R30.** The repo holds what a stranger needs to run and judge the prototype: a README with run instructions, a setup script that deploys a team node, the protocol, the threat model with what the prototype builds, and a disclosure policy. The protocol, the threat model and the platform notes are in `reference/`. The setup script is `npm run setup` in `node/`. The license is MIT, in `LICENSE`. The project's planning documents are private and are in no commit.

**R31.** A person should see the lines a finding cites, read from the index's own copy through a route of its own. That is not built. The library holds the shape of the answer and the one field kind that carries text for a person. No Worker serves the route, and the page shows no cited line. No record carries component text.

**R32.** The command keeps a local table of what the team may install, in `.cairnfield/decisions.json`. It holds one entry for each component, named by the Git URL the commit was pinned from: the commit, the verdict, the time, and the file-tree hash of the copy when the team built one. The verdicts are `approved`, `approved-with-required-mitigations` and `not-approved`. `decide` writes down the verdict a person gave, and `approvals` prints the table. The table is never published.

**R33.** The view carries one row per host: each host that a destination finding names, with the number of findings that name it. The page does not show the rows.

**R34.** An index should serve an API catalog at `/.well-known/api-catalog` that points to a description of its routes and to the record schemas. The library generates both, and they are in `protocol/schemas/`. The index in this repo serves none of the three routes.

**R35.** Every record and every JSON answer of the index carries the schema version. The index serves data and never instructions for agents. A refusal is a code from a closed list: `bad-request`, `unauthorized`, `not-found`, `not-allowed`, `limit-reached` or `already-registered`. The page says what the index holds and tells a reader nothing to do.

**R36.** `verify` works out the file-tree hash of a folder the way Git does and compares it with the team's approved entry. It passes only when the two are equal. It reads the entry from the approvals file it is given, which is a copy of a team's decisions file. It reads nothing else: no config file, no node, no index and no published recipe.

**R37.** `carry` writes the team's own findings and patches again for a newer commit of the same component. A finding carries when the newer commit still holds the content it cites. A patch carries when every content it replaces is still there and every finding it cites carried. A carried patch keeps its patch ID. The command names each finding and patch that did not carry, with a reason code, and builds nothing from it.

**R38.** A team working alone needs its node and the command, and nothing else. `pin`, `publish`, `patch`, `assemble` at level 0 or 1, `decide`, `verify` and `carry` work with no index and no other team.

**R41.** A fuller lens would also state the criterion each kind of use requires, the destinations the team approves and the confirmations it requires, with a level 3 that takes a patch once enough organizations stand behind it. That is not built. A lens file has none of those fields, and a lens with level 3 is refused with the code `level-3-not-built`. The library holds the rule for criteria and approved hosts as `countsAgainstLens`.

**R44.** On a terminal, the demo script and the reset script print what a viewer of a recording can follow: each step heading in bold, each team's lines in a color of its own, each JSON result indented over several lines with its keys, strings and numbers colored, and the diff `assemble` prints with added lines in green and removed lines in red. A hash is shown whole and no result is cut. When the output is not a terminal, and under `NO_COLOR`, every line is plain: one line for each command and each result, and a plain diff. The command itself does not change, and its standard output stays JSON.

**R46.** `patch` attaches a note to each patch commit it pushes, at `refs/notes/cairnfield` of the team's fork. The note says what the team declares about how the commit was made: the commit, the findings its patch record names, the model, the SHA-256 of the recording and, when the recording names one, the SHA-256 of the prompt the model ran under. The note `patch` writes holds hashes and one value from a closed list, and no free text. A live run and its replay write the same bytes.

The note is in the fork before the patch record is published. When the fork turns down the push of the notes ref, `patch` ends before it publishes, and `patch --replay` finishes the run.

A note is read with Git: a fetch of `refs/notes/cairnfield` from the fork, with the read token that the node's `read-token` route gives anyone. No route of a node serves a note, and the index reads none. Nothing has checked a note that a reader fetches. Its team can push any bytes in its place, so a note from another team's fork is data until it is held to `PATCH_NOTE`. A note changes nothing that the index or a command works out, and a commit with no note is as valid as one with a note. `carry` attaches none to the commits it builds, and a commit made by hand has none.

A note is the team's own statement and no record. No record gains a field for it, nothing names it, and its team can write it again.

**R47.** A node answers `GET /` with an HTML page that lists what its team repo holds: each component, and under it each record by its type and ID, as a link to that record's file on the same node. The page draws only what the record path pattern admits of a file's path, the team repo's head, the node's own address and the time the page was drawn. It reads no record file. It says in fixed words that it is the team's own list and that nothing on it was checked, and it tells a reader nothing to do. It runs no script, takes nothing from the request and draws a bounded number of entries. For the page, a node walks its team repo at most once in 30 seconds per isolate, and the page it keeps never serves the `records` route. Every answer the node's Worker builds carries `x-content-type-options: nosniff`.

## Decisions

**KTD1.** Records are content-addressed files. A record's ID is the SHA-256 of its canonical JSON: keys sorted, no white space, whole numbers only, in UTF-8. Its path in the team repo is `records/<component-commit>/<type>/<id>.json`. Two pushes then never differ on a file, only on where the branch points. A record whose content hash differs from its file name, or whose component or type differs from its folders, is rejected with `hash-mismatch`. `publish` never writes a published record again. The index stores each record as valid, pending or rejected.

**KTD2.** The vocabularies are closed lists in `protocol/src/enums.ts`. A value outside a list is rejected with `unknown-value`. The lists are under [Appendix J](#appendix-j-the-closed-vocabularies).

**KTD3.** Records point backward only. A patch record names its findings. A re-check and a counter-finding name their finding. A patch re-check names a patch ID. A finding never names its patch. A finding or a patch record may name the claim that announced it. The index then shows that claim as closed, when the record and the claim come from the same node.

**KTD4.** A patch is a set of content replacements, carried by one commit whose parent is the pinned commit, on the branch `patch/<component-commit>/<patch-id>` of the team's fork. A replacement names the old blob and mode and the new blob and mode. A deletion has a fixed marker as its new side: mode `000000` and a hash of 40 zeros. The commit applies each replacement to every path that holds the old blob with that mode, and changes nothing else. A mode change counts as a change.

The patch ID is the SHA-256 over the replacements in sorted order, one line each: `<old blob> <old mode> <new blob> <new mode>`. It holds no commit and no path. So the same patch on a later version has the same ID, and one replacement covers every byte-identical copy. No diff algorithm has to agree across implementations. A patch record may list the patch IDs it merges, as `sources`. No command writes a merged patch yet.

**KTD5.** The index and the command compute, and authors do not declare. Match groups, confirmation counts, and a patch's kind, size, changed lines, paths and ID are computed from content. So is a finding's cited content. A record declares only references: a patch record's commit, findings and sources, the target of a re-check, a counter-finding or a patch re-check, and a recipe's patches and tree hash.

A reference is resolved when a view is built. A patch shows only while every finding it names is a valid finding of that view. A re-check, a counter-finding or a patch re-check whose target the view does not hold shows nowhere. No code reads `sources` yet. The page labels a recipe's tree hash as published, not checked.

**KTD6.** Limits live in `protocol/src/limits.ts`, and the JSON Schema files state the same patterns.

| What | Limit |
| --- | --- |
| A record | 4 KB |
| A path | 200 characters. Each part holds letters, digits, dots, underscores or hyphens. No part starts with a hyphen, and none is `.`, `..` or `.git` in any letter case |
| A hostname | 253 characters of lower-case letters, digits, hyphens and dots |
| A commit, a tree or a blob | 40 lower-case hexadecimal characters |
| A line number | 1,000,000, a first value |
| A claim's run number | 0 to 4,294,967,295 |
| A patch record | 1 to 8 findings, and 2 to 4 sources when it merges patches |
| A recipe | 1 to 32 patches |
| A patch | 3 replacements, 60 changed lines and 8 KB of added lines. A replacement counts once, however many copies it rewrites |
| A path that a patch changes | A regular file, before and after: mode `100644` or `100755` |
| A served blob | 256 KB |
| A node listing | 5,000 entries, and 500 records per component |
| A fetch from another team's fork | 16 MB of objects, a first value |
| A repo or fork name | Starts with a lower-case letter or a digit, then lower-case letters, digits, dots, underscores or hyphens. At most 100 characters, a first value |
| A namespace name | The same rule, with 2 to 63 characters |
| A branch name | Letters, digits, dots, underscores, hyphens and slashes. It never starts with a hyphen. At most 200 characters, a first value |

**KTD7.** The node is storage with a small HTTP contract. It returns its head commit with a listing of record files, serves a record file at a given commit, serves a patch commit's parent and changed paths with their modes and blobs, serves a blob of a fork, and gives a read token for a fork only. It validates nothing. A refusal is a code: `bad-request`, `unauthorized`, `not-found`, `not-ready` or `refused`. `node/src/contract.ts` holds the node's own copy of the contract. The page a node serves at its own address stands outside the contract (R47, KTD45).

The node keeps one read token per fork, in a Durable Object named after the fork, and serves that one until five minutes before it expires. So the public route cannot mint without bound.

The cost of this design is trust. The index trusts a node for a patch commit's parent and for the completeness of its list of changed paths. The index holds each served blob to its hash, and takes the content a patch replaces only from its own copy. A hostile node can still hide a change from the index, so assembly is the enforcement point (KTD23).

**KTD8.** A node's identity is its base URL. Organization counts are counts of registered node URLs. The URL has one accepted spelling: lower-case `https://`, a lower-case hostname of at most 253 characters that is a name and never an address, with no dot at its end and no Punycode label, and no credentials, query, fragment or last slash. A port is allowed when it is not 443 and has no zero in front. A node under a path adds parts of lower-case letters, digits, dots, underscores and hyphens (KTD24). The library refuses every other spelling, and the JSON Schema pattern states the same rule. Nothing rewrites a node URL, so two strings never name one node. The index refuses a registration whose URL is already registered.

**KTD9.** Each node has its own Artifacts namespace. The push trigger filters by namespace, so one team's push never starts another team's Workflow.

**KTD10.** A node's admin routes need its admin key, sent in a header. The command calls them to import a component copy, create the team repo and a fork, and get repo tokens. Each node has its own key, set by hand as a Worker secret. A node with no key set refuses every admin call.

Every token the node hands out comes from one call that sets both the scope and the lifetime, which is 50 minutes. No route returns a write token for a component copy. Artifacts itself returns a token from every create, import and fork, with write scope and a life of 24 hours. The node never returns, stores or logs that token. No call can revoke it while the import or the fork runs, so every admin route revokes it before it uses a repo that is ready.

**KTD11.** The index stores its state in D1 and takes push notices through a queue. A notice is an unauthenticated hint that names one node. The index always pulls from the URL the node was registered with. A notice for a node that is not registered queues nothing and fetches nothing, and the index answers it with `not-found`.

Notices for one node within 5 seconds cause one sync. A notice that arrives after a sync has read the node's head causes another. A sync takes up to 120 new records in one pass and goes on at once when the node holds more. A sync that failed is tried again after 30 seconds, five times.

A patch record whose commit cannot be checked yet is looked at again every 30 seconds, 20 times. After that it stays pending. Each later sync of its node looks again at up to 120 of the node's waiting patch records, in turn. A finding it names that turns valid also causes a look. Each component's view has a version number that goes up with every change the view can show, so a reader draws again only when it moved.

**KTD12.** A component is registered with its Git URL, branch and commit. The URL must be HTTPS with no credentials. The index imports the branch with no depth, so every commit the branch reaches can be pinned. It holds records for the commit as pending until the copy is ready, and it revokes the token the import returns. When the copy is ready, the index stores its file listing: each path with its mode and blob hash. Matching and the patch checks read that listing.

A component fails when Artifacts refuses the import, when the copy is not ready within five minutes, when the finished copy does not hold the commit, or when the copy holds more than 500 folders or 20,000 files. Its pending records are then rejected with `unknown-component`. Only an import that fails with `UPSTREAM_UNAVAILABLE` is tried again by itself.

Registering a failed component again, with the Git URL and branch the index stored for it, starts its import over. The records rejected because it had failed are dropped, so each node's next sync reads them again. A new URL or branch for a commit is not taken. A component whose finished copy does not hold the commit fails again until that copy is deleted by hand.

The index neither fetches nor stores a record of a component that is not registered. A later sync reads it once the component is.

**KTD13.** The index keeps the last commit it read per node, and the commit at which it read each record. It detects no history rewrite: a view's `historyRewritten` field is always false. A rebuild drops every record and reads every node again. It does not rebuild claim state. A claim first seen in a rebuild counts as expired.

**KTD14.** A page's script draws only what its data endpoint holds, and reads that endpoint every 2 seconds: the view on the page of a component commit, and the list at `GET /view` on the index's own page. People and agents then see the same data. Each page is served with a content security policy that allows no script or style written into the page and loads files from its own origin only: its scripts, its stylesheet, its fonts and its icon. Every value from a record or a registration is set as text. A link made from such a value leaves the index only for an HTTPS address. A patch record's model is a value its team states and the index cannot check. It stands after the word "declared", as the record holds it, in a plain line with no outline. The words a page adds are its own: each is fixed in the page's code, keyed by a value of a closed list, and none comes from a record.

A page's own fixed text and links are written in the repo, in the page's HTML file, outside the element its script draws in. They are what R14 names: what an index is and is not, the line that says what the page of a component commit is, and the links to the site, the repo and the index's own page. They come from no record, a reader with scripts off still sees them, and they tell a reader nothing to do.

**KTD15.** A claim expires a set time after the index receives it, by the index's clock. The default is 15 minutes, and `CLAIM_TTL_SECONDS` sets another at deploy. The page shows live claims only. A closed or expired claim keeps its state in the view. Claims are for display. No command behavior depends on one.

**KTD16.** The bundled agent calls the Claude API directly, with tools of the command's own. Three tools read files of one checkout: `list_files`, `read_file` and `search_files`. A fourth, `get_target`, gives the agent the path, the lines and the observation of one finding of the team's own.

The checkout is an export with no `.git` folder and no symbolic link. It holds only regular files whose path passes the path rule. Each file holds the bytes Git stores for it at the pinned commit, whatever the component's attribute files say. `pin` reports every other entry of the pinned tree by reason: `symbolic-link`, `submodule`, `unsupported-mode`, `refused-path` or `path-collision`.

File content reaches the model only inside a tool result. The system turn and every user turn the command writes hold none of it. A model's own earlier turn goes back to it unchanged. The model key and the repo tokens share the command's process. None is in a prompt or a tool result, and no tool can read one.

**KTD17.** The patch agent returns structured output only: edits, each a path, a line range and the lines that replace it. The command applies each edit to every path that holds the same content, runs the patch checks, and commits with a fixed message, author, committer and dates. The same edits on the same pinned commit then give the same commit hash on every machine, and a repeat push changes nothing. Replacement text goes into the fork as code and never into a record. `patch` then attaches a note to the commit, which names the recording the edits came from (KTD44).

**KTD18.** A recording is the patch agent's saved edits. A live run saves the edits that passed the patch checks, with the number of the claim it published, the model that wrote them and, as `prompt`, the SHA-256 of the prompt that model ran under. A recording saved before live runs kept that hash has no `prompt`. Neither has a recording written by hand, with the model `none`, and the command refuses a recording with that model and a `prompt`. Recordings are kept in the folder the command's config names, by team label, component commit and finding ID. The team label is a stable name from the config and not the node URL, so a reader's own deployment finds the same recordings.

A replay reads the saved edits in place of the model call. It fails when the recording is missing and never calls a model. `cli/src/agents/live.ts` is the one file that calls a model and the one file that names a provider. The protocol, the node, the index and assembly involve no model.

**KTD19.** When the agent's answer fails a check, the command asks once more and sends only the check's code. A second failure publishes no patch. A refusal is never asked again.

**KTD20.** The outbox is the publish boundary. Agents and people write record files to it. `publish` validates it and pushes with pull and retry. After the push it sends the index a notice for its own node, which is the same hint the node's Workflow sends. So a late or lost push event cannot stall a team that waits for the index. `claim`, `patch`, `assemble` and `carry` each publish only the records they wrote, by the same path.

**KTD21.** The default model is `claude-sonnet-5-5`, and `model` in the command's config names another from the protocol's list. A run has a turn limit of 40 requests, a limit of 1,000,000 tokens and a deadline of ten minutes.

**KTD22.** Assembly applies line edits, not Git merges. It takes each selected patch's changed lines from the protocol's own diff against the old content, and applies every edit against that old content. So patches on adjoining lines compose, and the copy does not depend on the order the patches come in. The result goes to every path that holds the old content.

Assembly refuses a selection in which two patches change the same line of one content or add lines at the same place. It also refuses a selection whose result changes a line that none of its patches cites. It names the patches that do not compose: two, or more when no two of them conflict alone.

The copy is one commit with fixed metadata. Two teams with the same pinned commit and the same patches get the same file-tree hash. The copy is pushed to the branch `copy/<component-commit>` of the team's fork only when the lens publishes recipes, and that branch is force-updated when the selection changes. Otherwise the copy stays local.

**KTD23.** Assembly takes nothing from the index on trust. It uses the index view only to find candidates from named teams. It reads each patch record and its findings from the nodes, fetches the commit from its fork on the author's node, and works out again the parent, the scope, the completeness, the size, the kind and the patch ID. A patch ID that differs from the one the index gave refuses the candidate.

**KTD24.** A node's route paths are relative to its base URL, so a node can live under a path of a host, and the node URL rule accepts such a URL. This was meant for a simulator that plays many nodes on one host. The simulator is not built. The node Worker in `node/` serves its routes from the root of its host only.

**KTD25.** The demo plugin's repo has two commits on one branch. The first is the commit the demo pins. The second changes the sync script and nothing a demo patch touches. So `carry` has one finding that does not carry and patches that do.

**KTD26.** The rejected patch of the demo is written by hand and comes from the second team's node. Its finding cites one line, and its commit also changes a line the finding does not cite. The node is honest about the commit, which the index needs in order to reject it. `fixtures/out-of-scope/` holds the finding, the patch record and the files of the commit.

**KTD28.** The code is TypeScript on Node 22 with npm. `protocol`, `index`, `cli` and `sim` share one npm workspace. `node` is self-contained with its own lockfile and imports nothing from the workspace, so its folder can be the root of a repo of its own. `protocol` holds the request and response shapes of the node contract and the index routes, and `node` carries its own copy of the node shapes. The node and the index each set the `global_fetch_strictly_public` compatibility flag, so a call to another Worker in the same account goes to its public URL.

**KTD29.** Tests use Vitest, and the tests of each Worker run in the Workers Vitest pool. The Artifacts binding sits behind a seam, and each test puts an in-memory fake in its place. `remoteBindings: false` in each Worker's Vitest config keeps the pool from reaching the live service.

**KTD30.** The index limits who can add work. Registering a node or a component needs the registration key. The index caps the nodes and the components it registers, at 8 and 16 in this repo's config. It imports only Git URLs on its allow-list. Every read from a node runs under a deadline, follows no redirect and stops at a size limit. The reset route needs a second key. An index with no registration key set refuses every registration, and one with no reset key set refuses every reset.

**KTD31.** Rejected work is stored and served as four values only: the node, a hash the index computed, the type and the reason. The index checks the shape of a record path before it fetches the file. No string from a rejected record reaches a view.

**KTD33.** The command treats every value from a node as hostile before it reaches Git.

- A Git remote must have the Artifacts form, `https://<account-id>.artifacts.cloudflare.net/git/<namespace>/<repo>.git`, with names that pass the protocol's rules. A node cannot point Git at another host.
- Names and commits pass the protocol's checks first and are never placed where Git reads an option. Submodules are never fetched.
- A fetch from another team's fork asks for one commit by its hash at depth 1. It runs under a deadline of two minutes and is stopped when its objects pass 16 MB. Artifacts takes no partial-clone filter, so Git cannot set that bound itself.
- Every Git call runs with the operator's global and system configuration switched off, in an environment the command builds itself. The command never checks a work tree out with Git, so no hook, filter, line-ending rule or attribute file changes an object.
- Every HTTP read from a node runs under a deadline, follows no redirect and stops at a size limit.
- A token reaches Git through configuration in the environment, tied to the one remote it opens. It is never in a URL or an argument.

**KTD35.** The whole protocol has one schema version, `"1"`. Every record carries it, and so does every JSON answer of the index. The index and the command reject a record of another version with `unsupported-version`. The JSON Schema files and the OpenAPI description are generated from the library, and a test fails when the committed files differ from it.

**KTD36.** Neither Worker relies on a repo's default branch or on `HEAD`. An imported repo can report a default branch it does not have. Every binding call names a branch or a full commit hash, and the team repo is created with `main` as its stated default branch. A copy or a fork is ready when `get()` no longer throws an in-progress error and `readCommit` returns the pinned commit. A fork is made with `defaultBranchOnly: false`, because the default copies one branch only.

**KTD37.** Patch scope is checked by line, after the size check. Cited ranges on one content that overlap or adjoin count as one range. The ranges divide the old content into stretches of lines that no finding cites. A patch is in scope when the new content still holds every such stretch, whole and in order, with the first at its start and the last at its end. What stands where a cited range stood may be anything, or nothing.

So every removed line is a cited line, and added lines go in front of a cited line or straight after the last one. A patch that only changes a file's mode needs only that content cited. A patch that deletes a file needs every line of it cited. The check reads the two contents and no diff. `citedRanges` and `linesAreInScope` in `protocol/src/` are the check.

**KTD38.** A lens names teams by node URL, in the one accepted spelling. `view` and assembly drop every record whose node is neither the team's own nor on the list, before any other step. The index stays public. Its page shows all valid work and names each contributor. A `teams` query narrows a view, and the page of it, to the nodes it lists.

**KTD39.** `carry` works from the team's own repo and the two pinned commits. It pins the newer commit from the Git URL the older one was pinned from. It reads the team's findings and patch records at the older commit, and each patch commit from the team's own fork.

A finding carries when the newer commit still holds its cited content. It is written again at the same path when that path still holds the content, and otherwise at the first path in sorted order that does. A finding with a second location carries only when that content is still there too. A patch carries when every blob and mode it replaces is still present and every finding it cites carried. Its replacements go to every path that holds them, the patch checks run on the result, and it keeps its patch ID.

The carried records go out through the outbox. Nothing is carried from another team. The output names each finding and patch with a reason code, names each patch of another team in the copy the team last built at the older commit, and counts the paths the newer commit added, changed and removed. `carry` reviews none of those paths.

**KTD40.** The index is optional in the command's config. With no index address, `pin` registers nothing, `publish` sends no notice, and assembly at level 0 or 1 reads only the team's own repo. `view` and level 2 need an index and end with exit code 6 without one. A node's index address is optional too, and its Workflow sends no notice without one. A team that adds an index later runs `pin` again for each pinned commit, which registers its node and that commit.

**KTD41.** The demo script renders its own lines for a terminal, and the command knows nothing of it. Every line a script says passes through one function, and one function writes the command and result lines, so the renderer tells a line's kind by its prefix. The script decides once for each stream whether to paint: never under `NO_COLOR`, and otherwise only when the stream is a terminal whose own check says it shows colors. A stream that does not paint gets the plain lines unchanged. A result is colored by walking the parsed value and never by matching its text, because a value can hold another team's record fields. The diff is colored line by line, with the counts of each hunk header telling content from a file header.

**KTD44.** `patch` writes the note on a patch commit, and `publish` does not. `publish` holds a token for the team repo only. `patch` holds a write token for the fork and a scratch repo with the commit in it.

The note is a blob of canonical JSON, the form a record's ID is taken over (KTD1). Its fields are `version`, `commit`, `findings`, `model`, `recording` and, when the recording has one, `prompt`. `recording` is the SHA-256 of the recording's canonical JSON and not of its file's bytes, so a file with other spacing or line endings gives the same note. `prompt` is copied from the recording. A live run hashes the prompt it gave the model, as UTF-8 text, and saves the hash in its recording (KTD18). That is the SHA-256 of the file `cli/src/agents/prompts/patch.md` as the run read it. A replay hashes no prompt. The note holds no count of tool calls: no recording holds one, so a replay could not repeat it. `PATCH_NOTE` and `NOTES_REF` in `protocol/src/contracts.ts` hold the shape and the name of the ref.

The notes tree is flat: one plain file for each noted commit, named by the commit's full hash. The command builds it with Git's plumbing, and merges it by the name of that one entry. Git's own `notes` command spreads a tree over folders as it grows, and a reader of the flat path would then miss a note. The notes commit sits on top of the one the fork held, with the message `Cairnfield note` and the fixed author, committer and dates of a patch commit (KTD17). So the same notes on the same history give the same notes commit on every machine.

The notes ref is pushed alone, after the patch branch. One push of both refs could not tell a refusal of one from a refusal of the other. When the ref moved meanwhile, the command reads it again and builds its commit on top, up to six times, as `publish` does (KTD20). When the fork already holds the same bytes under the commit's name, the command makes no commit and no push. A push of the notes ref starts the node's Workflow like any push (R7), so a replay that finds its own note starts none. Other bytes under that name are replaced, and so is a folder. A note names one recording. Two runs of `patch` for two findings that cite the same lines can build the same commit, and each then writes the note of its own recording under that commit's name: the commit has the note of the run that wrote last. A replay of the earlier run writes its note back and moves the ref. `patch` prints which of the three happened, as `note`: `written`, `already-there` or `replaced`.

**KTD45.** The node's page is a string the Worker builds, at `/`, outside the node contract. It comes from the walk the listing makes. It draws the component, the type and the ID that the record path pattern captures, the head, the node's base URL when that is the Worker's own origin in the accepted spelling (KTD8), and the time of the walk. It escapes every value. A file under `records/` whose path the pattern does not admit is not drawn. Components come in ascending order of commit, and a component's records in ascending order of type and then of ID. The page draws at most 20 components and 50 records of a component, so it holds at most 1,000 links, and it gives the number of the rest.

The page's `content-security-policy` is `default-src 'none'` with the SHA-256 hash of the page's one style, `base-uri 'none'`, `form-action 'none'` and `frame-ancestors 'none'`. The style is written into the page because the node has no assets binding and no build step. `cache-control` is `no-store`: the kept page already bounds the reads, and a browser's copy on top would show a reader an older page. `x-robots-tag` is `noindex, nofollow`, because each record link costs the node two reads of the binding that nothing keeps. `referrer-policy` is `no-referrer`. A request with any query is refused as `bad-request`, so nothing a caller sends reaches the kept page.

The rendered page is kept in the isolate, as a promise, for 30 seconds. Requests that arrive together then walk the repo once. The request that starts a walk hands the promise to `waitUntil`, so a reader who leaves does not end a walk that others wait on. Requests that share one walk were seen in local workerd only, and `platform-notes.md` holds what was seen. The page gives the time of its walk, so a reader can tell the age of a kept page. No cache stands in front of the Worker, so a `records` answer is never a kept one.

A node with no team repo, with one still being made or with one that has no push answers 200 and says that nothing is published yet. A head with no record path under it answers 200 and says that the team repo holds no record. When Artifacts fails, the node serves the last page that a walk gave. It keeps that page as a value, so a failed walk waits on no walk before it. A walk that lasts longer than 30 seconds can end after the walk that began next. Its page is the older of the two, and it does not take the place of the newer one. With no such page it answers 503 with fixed words. A failed walk is kept for the same 30 seconds, so a failing Artifacts is asked once in that time.

## Examples

Each example is a case that a test covers. The test's name cites it as `AE<n>`.

**AE1.** A finding cites lines 400 to 410 of a file with 80 lines. The index stores the record as rejected with reason `lines-out-of-range`. It shows under rejected work and never under findings.

**AE2.** A patch's finding cites one file, and the patch commit also changes a second file with other content. The index stores the patch as rejected with reason `patch-out-of-scope`, and the page lists it under rejected work.

**AE3.** Two teams each delete the same line, in a commit of their own. Both patch records give one patch ID, and the page shows one patch entry with two organizations.

**AE4.** One team writes a bug patch, and a second team's patch re-check says `resolves`. The patch then has two organizations behind it and is confirmed. The rest of this example is a lens at level 3 that takes the patch on that count. That part is not built.

**AE6.** Two teams assemble from the same component commit and the same patches. Both copies have the same file-tree hash, whichever team wrote which patch.

**AE8.** A finding names the host `collect.fellbeck-metrics.example`, and that hostname is not in the lines the finding cites. The record is rejected with reason `host-not-in-lines`.

**AE9.** One destination finding is read against a lens that approves its host and against one that does not. `countsAgainstLens` counts it against the second and not against the first. A host is approved only by its exact name. No command applies this rule yet.

**AE10.** A patch is published at one component commit. The same replacement is then committed on a later commit that leaves the file unchanged. Both commits carry the same patch ID.

**AE11.** A script sits byte-identically at two paths, and a finding cites one of them. A patch that rewrites both copies the same way is accepted as one replacement. A patch that rewrites only one copy is rejected with reason `patch-incomplete`.

**AE12.** One team files a finding under `works-as-documented` and a second team a matching one under `safe-to-read`. The group is seen by two organizations and is confirmed, and no criterion is. If the two file under `safe-to-read` and `safe-to-run-with-access` instead, `safe-to-run-with-access` is confirmed by two organizations and `safe-to-read` by one.

**AE13.** A finding cites line 12 of a file, and a patch changes line 12 and line 30. The patch is rejected with reason `patch-out-of-scope`. The command refuses such edits from its patch agent before any commit.

**AE14.** A patch that adds one line of 9 KB is rejected with reason `patch-too-large`. A patch that removes such a line is accepted.

**AE15.** A valid patch comes from a node the lens does not name. At level 2 the patch is not selected, the command asks that node nothing, and the team's `view` does not list the patch.

**AE16.** A team has a patch at one commit, and a newer commit changes another file. `carry` builds the patch again on the newer commit with the same patch ID. When the newer commit no longer holds the content the patch replaces, `carry` reports the patch as not carried and writes no commit and no record for it.

**AE17.** A team approved a copy. `verify` passes on that copy. It fails on a copy with one changed byte, one added file or one changed file mode.

**AE18.** A config names no index. A team pins, publishes, patches, assembles, records a verdict and verifies, and every step succeeds.

**AE19.** A team repo holds files under `records/` whose names hold markup, and files whose paths are no record path. The node's page draws none of them, and has the same elements as a page drawn without them.

**AE20.** A team repo's head has no `records` folder, as after a reset of the demo. The node's page answers 200 and says in fixed words that the team repo holds no record. A node with no team repo, with one still being made or with one that has no push answers 200 and says that nothing is published yet.

**AE21.** A team's fork takes the patch branch and refuses a push to `refs/notes/cairnfield`. `patch` ends with a Git failure. No patch record is published, and the recording is kept. Once the fork takes the ref, `patch --replay` finishes the run under the same claim.

## Notes

### Appendix B. What Artifacts was seen to do

The first check of Cloudflare Artifacts against the live service, on Oct 4, 2026. `platform-notes.md` holds it in full. Comments and the test fakes of the Artifacts binding cite it for these facts.

- An import returns before it finishes.
- An imported repo reported `main` as its default branch when its only branch was `master`.
- A push event names the namespace and the repo, and holds an inner payload with the ref, the commit before and the commit after.

### Appendix H. Small decisions left to the code

- **Claim number.** Two runs for one component would write the same claim, and so the same ID. A claim carries a number that differs per run. A recording stores the number its run used, and a replay publishes the claim with that number.
- **Patch record.** It names the patch commit by hash. That is stable, because the commit's metadata is fixed (KTD17).
- **Index lag.** The time since the index received the oldest notice it has not finished with. A view carries it as `lag`, in milliseconds.
- **References across nodes.** A patch or a re-check can cite a record on a node the index reads later. So a reference is resolved when a view is built, not when a record is stored. A patch record waits as pending while a finding it names is not valid yet.
- **Two copies of the node contract.** `node/` cannot import the protocol library (KTD28), so it carries its own copy of the node shapes. `scripts/check-node-contract.ts` holds a deployed node to the library's shapes, which is what catches a difference.
- **The index's listing.** The index needs the modes and blob hashes of its own copy for the patch checks. It reads them by walking the copy's tree once, when the copy is ready.
- **The kept read token.** A Durable Object per fork keeps the one read token (KTD7). The token reads only a fork that anyone may read.
- **Token scope in Git.** A token is passed only for the exact remote it belongs to. A fetch from another team's fork never carries the team's own write token.
- **The word "copy".** It means three things, which [The parts](#the-parts) tells apart.

### Appendix J. The closed vocabularies

`protocol/src/enums.ts` holds the lists, and each JSON Schema file states the ones its record uses.

| List | Values |
| --- | --- |
| Criteria | `safe-to-read`, `safe-to-run-sandboxed`, `safe-to-run-with-access`, `works-as-documented` |
| Observations: destination, each with a host | `sends-data-to-host`, `fetches-instructions-from-host`, `loads-resource-from-host` |
| Observations: reach | `network-access-any-host`, `environment-access-all-variables`, `reads-outside-workspace`, `writes-outside-workspace` |
| Observations: execution | `runs-shell-command`, `runs-with-permissions-bypassed`, `runs-install-script` |
| Observations: injection | `hidden-instruction`, `overrides-host-instructions` |
| Observations: credentials | `requests-broad-credential-scope`, `stores-credential-in-plain-text` |
| Observations: supply chain | `installs-unpinned-dependency` |
| Observations: works as documented | `documented-control-not-read`, `fails-on-documented-input` |
| Counter-finding reasons | `documented-behavior`, `not-present-at-lines`, `not-reachable`, `required-by-documented-feature` |
| Patch re-check verdicts | `resolves`, `does-not-resolve`, `does-more` |
| Check kinds | `code`, `instructions`, `permissions` |
| Claim kinds | `review`, `patch` |
| Claim intents | `new`, `competing`, `adopt` |
| Models | `claude-sonnet-5-5`, `claude-haiku-4-5-20251001`, `other`, `none` |
| Patch kinds, computed | `removes-only`, `adds-or-changes` |
| Rejection reasons | `unknown-field`, `unknown-value`, `too-large`, `bad-path`, `lines-out-of-range`, `host-not-in-lines`, `hash-mismatch`, `unsupported-version`, `unknown-component`, `unresolved-reference`, `patch-out-of-scope`, `patch-too-large`, `wrong-parent`, `blob-mismatch`, `bad-mode`, `patch-incomplete` |

`other` is a model that is not listed. `none` is a record that a person or a script wrote.

### Appendix M. What the Artifacts reference says

A reading of the Artifacts reference and of the binding types bundled with Wrangler 4.147.0, on Oct 6, 2026. Nothing in that reading was run against the live service. `platform-notes.md` holds it in full. Comments and the test fakes cite it for these points.

- Every create, import and fork returns a token. A token's default scope is write and its default life is 24 hours.
- A fork copies only the default branch unless `defaultBranchOnly` is false.
- `log()` reads `HEAD` unless told otherwise and returns an empty list for a ref it cannot resolve. `get()` throws an in-progress error until a repo is ready.
- A tree entry has a name, a mode, a hash and a type, so a walk can tell a symbolic link and a submodule entry from a file.
- An import takes a branch and an optional depth, and can fail with one of five error codes.
- Artifacts does not support partial-clone filters. It does support a shallow fetch.
