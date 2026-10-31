# shellcheck shell=bash
# The commit a branch's work is measured from: the merge base of HEAD with the
# main line.
#
# A developer's clone has a local `main`. A CI checkout of a branch push or of a
# pull request's merge ref has none: actions/checkout creates no local branch
# but the one it checks out (a merge ref none at all), and with fetch-depth 0 it
# fetches every branch as `origin/<name>`. A checkout of `main` itself has both.
# So the local `main` is used where it exists — a fetch then never moves a
# developer's base — and `origin/main` otherwise. With neither, there is no base
# to bind: the function prints nothing and returns 1, and each caller decides
# what that means for it rather than taking some other commit.
#
# Usage:
#   source "$REPO_ROOT/scripts/lib/main-base.sh"
#   base="$(main_merge_base)" || ...
main_merge_base() {
  local ref
  for ref in refs/heads/main refs/remotes/origin/main; do
    if git rev-parse --verify -q "${ref}^{commit}" >/dev/null; then
      git merge-base "$ref" HEAD
      return
    fi
  done
  return 1
}
