#!/bin/sh
# Builds the commit of the demo's rejected patch (KTD26) in a repo that holds the demo
# plugin's first commit: a clone of the public repo, or a build from
# `fixtures/demo-plugin/build-repo.sh`. The commit sits on the first commit. Its tree is
# that commit's tree with each file under `files/` in place of the file at the same path.
# The author, the date and the message are fixed, so every build gives the commit in
# COMMIT.json, which is the commit the patch record names. A build that gives any other
# commit fails.
#
# The commit is left on the branch `patch/<component>/<patch-id>`, the name a fork holds
# a patch under (KTD4). Nothing is pushed, and the repo's own index and files stay as
# they are.
#
#   fixtures/out-of-scope/build-commit.sh <repo>
set -eu

here="$(cd "$(dirname "$0")" && pwd)"
repo="${1:?usage: build-commit.sh <repo>}"

# One value of COMMIT.json. Each is a hash, so nothing else is read from the file.
value() {
  sed -n "s/.*\"$1\": \"\([0-9a-f]*\)\".*/\1/p" "$here/COMMIT.json"
}
component="$(value component)"
expected="$(value commit)"
patch_id="$(value patchId)"

# Inside a Git hook, Git's own variables name the repo the hook belongs to, and the
# commands below would write there. Without them the build stays in the repo it was given.
unset $(git rev-parse --local-env-vars)

# No user or system Git configuration takes part, so signing, hooks and line-ending
# conversion cannot change a hash.
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1
export GIT_AUTHOR_NAME="Cairnfield demo" GIT_AUTHOR_EMAIL="demo@cairnfield.example"
export GIT_COMMITTER_NAME="$GIT_AUTHOR_NAME" GIT_COMMITTER_EMAIL="$GIT_AUTHOR_EMAIL"
export GIT_AUTHOR_DATE="2026-10-10T12:00:00Z" GIT_COMMITTER_DATE="2026-10-10T12:00:00Z"

# The tree is built in an index of its own.
scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT
export GIT_INDEX_FILE="$scratch/index"

git -C "$repo" read-tree "$component"
(cd "$here/files" && find . -type f) | sed 's|^\./||' | sort | while read -r path; do
  # Each file keeps the mode it has in the first commit. A path that commit does not
  # hold has none, and the build stops there: a patch adds no file (R11).
  mode="$(git -C "$repo" ls-tree "$component" -- "$path" | cut -d' ' -f1)"
  blob="$(git -C "$repo" hash-object -w --no-filters "$here/files/$path")"
  git -C "$repo" update-index --cacheinfo "$mode,$blob,$path"
done
tree="$(git -C "$repo" write-tree)"
commit="$(git -C "$repo" commit-tree "$tree" -p "$component" -m "Remove the hidden instruction")"
echo "$commit"

if [ "$commit" != "$expected" ]; then
  echo "build-commit.sh: this is not the commit in COMMIT.json. Do not push it" >&2
  exit 1
fi
git -C "$repo" update-ref "refs/heads/patch/$component/$patch_id" "$commit"
