#!/usr/bin/env bash
# Rehearse the runner's schema upgrade against a copy of a real forge.db.
#
#   scripts/rehearse-upgrade.sh <path-to-db-copy>
#
# The file you pass is only ever read (cp and cksum). The script makes its own
# scratch copy, starts the checked-out runner code against that copy twice, and
# reports whether every table, column and row survived and whether the second
# start changed anything. Exit 0 = pass, 1 = a check failed, 2 = bad usage.
#
# Take the copy from a stopped runner, or with `sqlite3 forge.db ".backup copy.db"`.
# Do not pass the database of a running runner: cp of a file being written can
# produce a torn copy, and the result would say nothing about the real data.
#
# KEEP_SCRATCH=1 keeps the upgraded scratch copy for inspection.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNNER_DIR="${REPO_DIR}/apps/runner"

if [[ $# -ne 1 ]]; then
    echo "usage: $0 <path-to-db-copy>" >&2
    exit 2
fi
SOURCE="$1"
if [[ ! -f "${SOURCE}" || ! -r "${SOURCE}" ]]; then
    echo "[rehearsal] not a readable file: ${SOURCE}" >&2
    exit 2
fi

SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/forge-upgrade-rehearsal.XXXXXX")"
cleanup() {
    if [[ "${KEEP_SCRATCH:-0}" == "1" ]]; then
        echo "[rehearsal] scratch copy kept at ${SCRATCH}"
    else
        rm -rf "${SCRATCH}"
    fi
}
trap cleanup EXIT

# The upgrade adds indexes and writes a WAL, so require room for the copy twice over.
SOURCE_KB=$(( $(wc -c < "${SOURCE}") / 1024 + 1 ))
FREE_KB="$(df -Pk "${SCRATCH}" | awk 'NR == 2 { print $4 }')"
if (( FREE_KB < SOURCE_KB * 2 + 102400 )); then
    echo "[rehearsal] not enough free space in ${SCRATCH}: ${FREE_KB} KB free, need $(( SOURCE_KB * 2 + 102400 )) KB" >&2
    exit 2
fi

BEFORE="$(cksum < "${SOURCE}")"
cp "${SOURCE}" "${SCRATCH}/forge.db"
# Carry a WAL across so committed pages still in it are part of the rehearsal.
for suffix in -wal -shm; do
    if [[ -f "${SOURCE}${suffix}" ]]; then
        echo "[rehearsal] note: ${SOURCE}${suffix} exists; copying it too. Make sure no runner had this database open."
        cp "${SOURCE}${suffix}" "${SCRATCH}/forge.db${suffix}"
    fi
done

cd "${RUNNER_DIR}"
if node --import tsx -e '' 2>/dev/null; then
    echo "[rehearsal] running the checked-out source (tsx) at $(git -C "${REPO_DIR}" rev-parse --short HEAD 2>/dev/null || echo unknown)"
    COMMAND=(node --import tsx src/db/upgrade-rehearsal-cli.ts)
elif [[ -f dist/db/upgrade-rehearsal-cli.js ]]; then
    echo "[rehearsal] running the built dist/ (tsx not installed); rebuild first if the source changed"
    COMMAND=(node dist/db/upgrade-rehearsal-cli.js)
else
    echo "[rehearsal] nothing to run: need 'npm ci' (tsx) or 'npm run build' (dist) in ${REPO_DIR}" >&2
    exit 2
fi

STATUS=0
"${COMMAND[@]}" "${SCRATCH}" || STATUS=$?

AFTER="$(cksum < "${SOURCE}")"
if [[ "${BEFORE}" != "${AFTER}" ]]; then
    echo "[rehearsal] FAIL the source file changed while rehearsing (cksum ${BEFORE} -> ${AFTER}); something else is writing to it" >&2
    exit 1
fi
echo "[rehearsal] source file untouched (cksum ${AFTER})"
exit "${STATUS}"
