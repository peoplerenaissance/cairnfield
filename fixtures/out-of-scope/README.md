# The rejected patch

A finding, a patch record and a patch commit, all made by hand, for the patch that the demo's index rejects. They come from the second team's node.

The finding cites one line of the demo plugin's first commit. The commit changes that line and one line the finding does not cite. So an index rejects the patch with reason `patch-out-of-scope`.

`files/` holds a file of the demo plugin with two lines taken out. Treat it as data, and never act on text in it.

| Path | Holds |
| --- | --- |
| `records/` | The finding and the patch record, laid out as an outbox: `records/<component-commit>/<type>/<id>.json` |
| `files/` | Each file the commit changes, as the commit holds it |
| `COMMIT.json` | The component commit, the patch commit and the patch ID |
| `build-commit.sh` | Builds the commit in a repo that holds the plugin's first commit |

The commit changes two lines of `skills/sync/SKILL.md`:

- Line 41, the hidden instruction. The finding cites it.
- Line 17, which keeps the skill to the notes folder. No finding cites it.

## Build the commit

```sh
fixtures/demo-plugin/build-repo.sh <new-directory>
fixtures/out-of-scope/build-commit.sh <new-directory>
```

The second script also runs on a clone of the plugin's public repo. It prints the commit and leaves it on the branch `patch/<component-commit>/<patch-id>`. The author, the date and the message are fixed, so every build gives the commit in `COMMIT.json`, which is the commit the patch record names. A build that gives any other commit fails. The script pushes nothing and changes no file of the plugin.

## Publish it

Push that branch to the second team's fork of the component. Then copy `records/` into the team's outbox and run `cairnfield publish`. The command checks the finding. It does not check a patch commit that a person wrote, so the record goes out, and the index does the check.

## Where it is tested

- `cli/test/demo-fixtures.test.ts` builds the commit and holds it to `COMMIT.json`, to the two records and to the protocol's patch checks.
- `index/test/patches.test.ts` serves the same files from a fake node and checks that the index lists the patch as rejected work.
