#!/usr/bin/env bash
# Smoke test for the SKIP_SECRET_SCAN_REASON enforcement (UNI-38).
#
# Spins up a throwaway git repo, copies the pre-commit hook in, and
# checks four behaviors:
#   1. SKIP_SECRET_SCAN=1 alone is rejected with non-zero exit and the
#      rejection message references SKIP_SECRET_SCAN_REASON.
#   2. SKIP_SECRET_SCAN=1 + an empty SKIP_SECRET_SCAN_REASON= is also
#      rejected (defensive: empty must not count as a reason).
#   3. SKIP_SECRET_SCAN=1 + SKIP_SECRET_SCAN_REASON="..." allows the
#      commit and emits a stderr banner that contains the reason and
#      the user's email.
#   4. With no SKIP_SECRET_SCAN env var, a staged AWS-key fixture is
#      still caught by the underlying scan (regression check that
#      UNI-38 didn't break UNI-29 behavior).
#
# Exits 0 on pass, 1 on first failure. Run from repo root:
#   bash scripts/git-hooks/test-bypass.sh

set -eu

REPO_ROOT=$(cd "$(dirname "$0")/../.." && pwd)
HOOK="$REPO_ROOT/scripts/git-hooks/pre-commit"

if [ ! -x "$HOOK" ]; then
  echo "FAIL: $HOOK is not executable" >&2
  exit 1
fi

WORKDIR=$(mktemp -d)
trap 'rm -rf "$WORKDIR"' EXIT

cd "$WORKDIR"
git init -q -b main
git config user.email tester@example.com
git config user.name "UNI-38 tester"
git config commit.gpgsign false
mkdir -p .git/hooks
cp "$HOOK" .git/hooks/pre-commit
chmod +x .git/hooks/pre-commit

# Need at least one prior commit for the staged-files diff path to be
# clean; an empty repo also works, but seeding lets us run multiple
# commits in sequence.
echo "seed" > seed.txt
git add seed.txt
git commit -q -m "seed"

fail() {
  echo "FAIL: $1" >&2
  if [ -n "${2:-}" ]; then
    echo "----- captured output -----" >&2
    echo "$2" >&2
    echo "---------------------------" >&2
  fi
  exit 1
}

echo "[1/4] SKIP_SECRET_SCAN=1 with no reason should be rejected." >&2
echo "harmless content $RANDOM" > a.txt
git add a.txt
set +e
out=$(SKIP_SECRET_SCAN=1 git commit -m "should fail" 2>&1)
rc=$?
set -e
[ "$rc" -ne 0 ] || fail "hook accepted SKIP_SECRET_SCAN=1 without reason" "$out"
grep -q "SKIP_SECRET_SCAN_REASON" <<< "$out" \
  || fail "rejection message did not mention SKIP_SECRET_SCAN_REASON" "$out"
echo "      pass — exit=$rc, message references SKIP_SECRET_SCAN_REASON" >&2

echo "[2/4] SKIP_SECRET_SCAN=1 with an empty reason should also be rejected." >&2
set +e
out=$(SKIP_SECRET_SCAN=1 SKIP_SECRET_SCAN_REASON="" git commit -m "should fail" 2>&1)
rc=$?
set -e
[ "$rc" -ne 0 ] || fail "hook accepted an empty SKIP_SECRET_SCAN_REASON" "$out"
echo "      pass — empty reason rejected (exit=$rc)" >&2

echo "[3/4] SKIP_SECRET_SCAN=1 + SKIP_SECRET_SCAN_REASON should allow + warn." >&2
REASON="test fixture: smoke test for UNI-38"
set +e
out=$(SKIP_SECRET_SCAN=1 SKIP_SECRET_SCAN_REASON="$REASON" \
  git commit -m "smoke commit" 2>&1)
rc=$?
set -e
[ "$rc" -eq 0 ] || fail "hook rejected even though both env vars were set (rc=$rc)" "$out"
for needle in "SECRET SCAN BYPASSED" "$REASON" "tester@example.com"; do
  grep -qF "$needle" <<< "$out" || fail "banner missing expected text: $needle" "$out"
done
echo "      pass — banner contains reason + user email" >&2

echo "[4/4] Without bypass env vars, a known secret pattern is still caught." >&2
echo "AKIAIOSFODNN7EXAMPLE" > fixture.txt
git add fixture.txt
set +e
out=$(git commit -m "should be caught" 2>&1)
rc=$?
set -e
[ "$rc" -ne 0 ] || fail "scan failed to catch a staged AWS-key fixture" "$out"
grep -q "AWS Access Key" <<< "$out" \
  || fail "rejection did not mention the AWS Access Key pattern" "$out"
echo "      pass — scan still catches a real-shaped secret" >&2

echo "ALL PASS" >&2
