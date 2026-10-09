#!/bin/sh
# Builds the demo plugin's Git repo from this folder: two commits on `main` (KTD25).
# `first/` is the whole tree of the first commit. `later/` holds the files the later
# commit changes. The author, the dates and the messages are fixed, so every build gives
# the two commit hashes in COMMITS.json. A build that gives any other pair fails.
#
#   fixtures/demo-plugin/build-repo.sh <new-directory>
set -eu

here="$(cd "$(dirname "$0")" && pwd)"
target="${1:?usage: build-repo.sh <new-directory>}"
if [ -e "$target" ] || [ -L "$target" ]; then
  echo "build-repo.sh: $target already exists" >&2
  exit 1
fi

# Inside a Git hook, Git's own variables name the repo the hook belongs to, and the
# commands below would write there. Without them the build stays in the new directory.
unset $(git rev-parse --local-env-vars)

# No user or system Git configuration takes part, so signing, hooks and line-ending
# conversion cannot change a hash.
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1
export GIT_AUTHOR_NAME="Cairnfield demo" GIT_AUTHOR_EMAIL="demo@cairnfield.example"
export GIT_COMMITTER_NAME="$GIT_AUTHOR_NAME" GIT_COMMITTER_EMAIL="$GIT_AUTHOR_EMAIL"

commit() {
  # File modes come from here and not from the disk: the two scripts are executable.
  # Git reads the user's own ignore file even with no configuration, so none is named.
  git -C "$target" -c core.fileMode=false -c core.excludesFile=/dev/null add --all
  git -C "$target" update-index --chmod=+x scripts/sync.sh scripts/export.sh
  GIT_AUTHOR_DATE="$1" GIT_COMMITTER_DATE="$1" git -C "$target" commit --quiet --message "$2"
}

# No template, so the new repo starts with no hook and no ignore list of its own.
git init --quiet --initial-branch=main --template= "$target"
cp -R "$here/first/." "$target/"
commit "2026-10-08T12:00:00Z" "fellbeck-sync 0.4.0"
cp -R "$here/later/." "$target/"
commit "2026-10-09T12:00:00Z" "Skip an empty notes folder and give up on a slow upload"

first="$(git -C "$target" rev-parse HEAD~1)"
later="$(git -C "$target" rev-parse HEAD)"
echo "$first"
echo "$later"

# A file that does not belong in `first/` or `later/`, such as `.DS_Store`, is committed
# with the rest and changes both hashes.
if ! grep -q "\"first\": \"$first\"" "$here/COMMITS.json" || ! grep -q "\"later\": \"$later\"" "$here/COMMITS.json"; then
  echo "build-repo.sh: these are not the two commits in COMMITS.json. Do not publish $target" >&2
  exit 1
fi
