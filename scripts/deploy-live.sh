#!/usr/bin/env bash
# deploy-live.sh: ship one commit of the `live` line to the Forge runner on LXC 207.
#
#   scripts/deploy-live.sh <sha>              deploy that commit
#   scripts/deploy-live.sh --dry-run <sha>    every read-only check plus a local build; changes nothing on 207
#   scripts/deploy-live.sh --rollback [name]  put back the code from a backup (newest when no name is given)
#        --restore-db   with --rollback: also restore forge.db from that backup (drops tasks run since)
#        --force        with --rollback: proceed while tasks are active (the restart kills them)
#
# What a deploy does, in order. Any failure after step 6 rolls the code back by itself.
#   1. refuse unless /health and the tasks table both show 0 active tasks
#   2. refuse unless the src on 207 is byte-identical to the last deployed commit
#   3. build the commit locally; refuse unless dist differs from the live dist only in
#      the files this commit's src changes explain
#   4. run one trivial Claude task and one trivial Codex task on the OLD code, so a
#      broken CLI login is not later blamed on the deploy
#   5. back up forge.db (sqlite3 .backup + quick_check) and tar the live dist + src
#   6. stage the changed files next to the app, move them into place, restart PM2
#   7. verify /health, a stable PM2 process, and that the board ghost count dropped
#   8. run the two trivial tasks again and check their logs and board entries
#
# The script never reads or prints .env, tokens, or task logs. /opt/forge is not a
# usable git checkout; this script never runs git there.
set -euo pipefail

HOST="${FORGE_HOST:-root@100.105.173.104}"
APP="${FORGE_APP:-/opt/forge/apps/runner}"
STATE="${FORGE_STATE:-/opt/forge-deploy}"
PORT="${FORGE_PORT:-5000}"
NODE="${FORGE_NODE:-/usr/bin/node}"          # the Node 20 that PM2 runs, not the newer one on PATH
PM2_NAME="${FORGE_PM2_NAME:-forge-runner}"
SMOKE_REPO="${FORGE_SMOKE_REPO:-/opt/repos/forge-deploy-smoke}"
DEFAULT_BASE=e85607b2c6deb94d20a5c44479b26438c88aab13   # what ran on 207 before this script existed
KEEP_BACKUPS=3
TERMINAL="'completed','failed','verified','unverified','capped','killed','done','aborted','missing'"

DRY=0 MODE=deploy RESTORE_DB=0 FORCE=0 ARG=""
for a in "$@"; do
  case "$a" in
    --dry-run) DRY=1 ;;
    --rollback) MODE=rollback ;;
    --restore-db) RESTORE_DB=1 ;;
    --force) FORCE=1 ;;
    -h|--help) sed -n '2,24p' "$0"; exit 0 ;;
    -*) echo "unknown flag: $a" >&2; exit 2 ;;
    *) ARG="$a" ;;
  esac
done

say() { printf '[deploy-live] %s\n' "$*"; }
die() { printf '[deploy-live] FAILED: %s\n' "$*" >&2; exit 1; }

# Run a command line on the runner host. FORGE_LOCAL=1 is for rehearsals against a sandbox.
r() { if [ "${FORGE_LOCAL:-0}" = 1 ]; then bash -c "$1"; else ssh -o BatchMode=yes -o ConnectTimeout=15 "$HOST" "$1"; fi; }
sum256() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$@"; else shasum -a 256 "$@"; fi; }
REMOTE_SUM='if command -v sha256sum >/dev/null 2>&1; then xargs sha256sum; else xargs shasum -a 256; fi'
remote_manifest() { r "cd '$APP' && find $1 -type f ! -name '*.test.ts' | LC_ALL=C sort | $REMOTE_SUM"; }

# One JSON-speaking helper, run with the runner's own Node so the box needs no jq.
probe() {
  r "'$NODE' - $PORT $*" <<'JS'
const [port, cmd, ...args] = process.argv.slice(2)
const base = `http://127.0.0.1:${port}`
async function call(path, init = {}) {
  const res = await fetch(base + path, { signal: AbortSignal.timeout(20000), ...init })
  return { status: res.status, body: await res.json().catch(() => null) }
}
const post = (path, body) => call(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const commands = {
  async health() {
    const { status, body } = await call('/health')
    if (status !== 200 || body?.status !== 'ok') throw new Error(`/health returned ${status}`)
    console.log(body.activeTasks)
  },
  // forge-task entries the board currently presents as live
  async liveforge() {
    const { status, body } = await call('/agent-context')
    if (status !== 200) throw new Error(`/agent-context returned ${status}`)
    console.log(body.liveAgents.filter(a => a.agentId.startsWith('forge-task-')).length)
  },
  async pm2(name) {
    const list = JSON.parse(require('node:child_process').execFileSync('pm2', ['jlist'], { encoding: 'utf8' }))
    const p = list.find(x => x.name === name)
    if (!p) throw new Error(`pm2 has no process named ${name}`)
    console.log(`${p.pm2_env.status} ${p.pm2_env.restart_time}`)
  },
  // One trivial task. Its answer is a sum that does not appear in the prompt, so finding
  // it in the log proves the model really ran (a task can "complete" with no output).
  async smoke(provider, repo, checkBoard) {
    const x = 100 + Math.floor(Math.random() * 900), y = 100 + Math.floor(Math.random() * 900)
    const want = `FORGESMOKE${x + y}`
    const prompt = `Deploy smoke test. Reply with exactly one line: the word FORGESMOKE immediately followed by the sum of ${x} and ${y}, with no space. Do not run tools. Do not create, edit or delete any file.`
    const created = await post('/tasks', { provider, repo, branch: 'main', prompt, autoCommit: false })
    if (created.status !== 201) throw new Error(`POST /tasks (${provider}) returned ${created.status}`)
    const id = created.body.taskId, boardId = `forge-task-${id}`
    if (checkBoard === '1') {
      await post('/agent-state/checkpoint', { agentId: boardId, agentType: 'forge', repo: 'forge-deploy-smoke', status: 'running', intent: 'deploy smoke test', ttlSeconds: 900 })
    }
    let status = 'queued'
    for (let i = 0; i < 100 && (status === 'queued' || status === 'running'); i++) {
      await sleep(3000)
      status = (await call(`/tasks/${id}?view=status`)).body?.status ?? status
    }
    if (status === 'queued' || status === 'running') {
      await call(`/tasks/${id}`, { method: 'DELETE' })
      throw new Error(`${provider} task ${id} did not finish in 5 minutes (cancelled)`)
    }
    const task = (await call(`/tasks/${id}`)).body
    if (status !== 'completed') throw new Error(`${provider} task ${id} ended ${status}: ${task?.errorMessage ?? 'no error message'}`)
    const log = task?.log ?? ''
    if (!log.includes(want)) throw new Error(`${provider} task ${id} completed but its log (${log.length} bytes) lacks the expected answer`)
    if (checkBoard === '1') {
      const live = (await call('/agent-state')).body
      if (live.some(a => a.agentId === boardId)) throw new Error(`board still lists ${boardId} as live after it completed`)
      const entry = (await call(`/agent-state/${boardId}`)).body
      if (entry?.status !== 'completed') throw new Error(`board entry ${boardId} has status ${entry?.status}, expected completed`)
    }
    console.log(`${provider} task ${id}: real output in log (${log.length} bytes)${checkBoard === '1' ? ', board entry settled as completed' : ''}`)
  },
}
if (!commands[cmd]) { console.error(`unknown probe ${cmd}`); process.exit(2) }
commands[cmd](...args).catch(err => { console.error(err.message); process.exit(1) })
JS
}

db_scalar() { r "sqlite3 -readonly '$APP/data/forge.db'" <<<"$1"; }
active_in_db() { db_scalar "SELECT COUNT(*) FROM tasks WHERE status IN ('queued','running');"; }
# Board entries shown as live whose task has ended, or vanished more than 10 minutes ago.
ghosts() {
  db_scalar "SELECT COUNT(*) FROM agent_state a LEFT JOIN tasks t ON t.id = substr(a.agent_id, 12)
    WHERE substr(a.agent_id, 1, 11) = 'forge-task-' AND a.expires_at > datetime('now')
      AND COALESCE(a.status, '') NOT IN ($TERMINAL)
      AND (t.status IN ('completed','failed') OR (t.id IS NULL AND a.updated_at <= datetime('now', '-600 seconds')));"
}

wait_healthy() {
  local i
  for i in $(seq 1 30); do
    if probe health >/dev/null 2>&1; then return 0; fi
    sleep 2
  done
  return 1
}

# Restore dist + src (and optionally forge.db) from a backup dir on the host, then restart.
restore_from() {
  r "bash -s -- '$APP' '$1' '$PM2_NAME' '$2' '$STATE'" <<'SH'
set -euo pipefail
app=$1 b=$2 name=$3 restore_db=$4 state=$5
tar -tzf "$b/code.tgz" >/dev/null
aside="$b/replaced-$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$aside"
if [ "$restore_db" = 1 ]; then
  [ "$(sqlite3 "$b/forge.db" 'PRAGMA quick_check')" = ok ]
  pm2 stop "$name" >/dev/null
  for f in forge.db forge.db-wal forge.db-shm; do
    if [ -e "$app/data/$f" ]; then mv "$app/data/$f" "$aside/"; fi
  done
  cp "$b/forge.db" "$app/data/forge.db"
fi
mv "$app/dist" "$app/src" "$aside/"
tar -xzf "$b/code.tgz" -C "$app"
pm2 restart "$name" >/dev/null
cp "$b/FROM_SHA" "$state/DEPLOYED_SHA"
SH
}

SWAPPED=0 BACKUP="" BUILD=""
on_exit() {
  local code=$?
  if [ -n "$BUILD" ]; then rm -rf "$BUILD"; fi
  if [ "$code" -ne 0 ] && [ "$SWAPPED" = 1 ]; then
    SWAPPED=0
    say "deploy failed after the swap; ROLLING BACK the code from $BACKUP"
    if restore_from "$BACKUP" 0 && wait_healthy; then
      say "ROLLED BACK. 207 runs the previous code again and /health is ok. forge.db was not touched."
      say "The replaced files are kept under $BACKUP/replaced-*; the DB backup is $BACKUP/forge.db."
    else
      say "ROLLBACK FAILED. The runner may be down. Backup: $BACKUP (code.tgz, forge.db). Check PM2 process $PM2_NAME on 207."
    fi
  fi
  exit "$code"
}
trap on_exit EXIT
trap 'exit 130' INT TERM

if [ "$MODE" = rollback ]; then
  BACKUP_NAME="${ARG:-$(r "ls -1 '$STATE/backups' 2>/dev/null | LC_ALL=C sort | tail -n 1")}"
  [ -n "$BACKUP_NAME" ] || die "no backups under $STATE/backups on 207; nothing to roll back to"
  B="$STATE/backups/$BACKUP_NAME"
  r "test -f '$B/code.tgz' && test -f '$B/forge.db' && test -f '$B/FROM_SHA'" || die "$B is not a complete backup"
  ACTIVE=$(probe health 2>/dev/null || echo unknown)
  say "rollback target: $B (code from commit $(r "cat '$B/FROM_SHA'")); active tasks now: $ACTIVE"
  [ "$RESTORE_DB" = 1 ] && say "forge.db will ALSO be restored; tasks and board changes since that backup are dropped (the current DB is kept aside)"
  if [ "$ACTIVE" != 0 ] && [ "$ACTIVE" != unknown ] && [ "$FORCE" != 1 ]; then
    die "$ACTIVE task(s) are active and the restart would kill them; wait, or pass --force"
  fi
  if [ "$DRY" = 1 ]; then say "dry run: would move the current dist + src aside, restore them from the backup and restart $PM2_NAME. Nothing changed."; exit 0; fi
  restore_from "$B" "$RESTORE_DB" || die "restore step failed; check $B and PM2 process $PM2_NAME on 207"
  wait_healthy || die "runner did not become healthy after the rollback; check PM2 process $PM2_NAME on 207"
  say "ROLLED BACK to $(r "cat '$STATE/DEPLOYED_SHA'"). /health is ok."
  exit 0
fi

# ---- deploy ---------------------------------------------------------------------------
[ -n "$ARG" ] || die "usage: scripts/deploy-live.sh [--dry-run] <sha>   (see --help)"
ROOT=$(git -C "$(dirname "$0")" rev-parse --show-toplevel)
SHA=$(git -C "$ROOT" rev-parse --verify --quiet "$ARG^{commit}") || die "$ARG is not a commit in $ROOT (fetch first?)"
BASE=$(r "cat '$STATE/DEPLOYED_SHA' 2>/dev/null || echo $DEFAULT_BASE")
git -C "$ROOT" cat-file -e "$BASE^{commit}" 2>/dev/null || die "207 runs $BASE, which is not in this clone; git fetch origin"
[ "$SHA" != "$BASE" ] || die "$SHA is already what 207 runs"
git -C "$ROOT" merge-base --is-ancestor "$BASE" "$SHA" || die "$SHA does not descend from the deployed commit $BASE"
say "deployed now: $BASE"
say "deploying:    $SHA"

# 1. nothing may be running: the restart fails every queued or running task
ACTIVE=$(probe health) || die "/health did not answer ok"
[ "$ACTIVE" = 0 ] || die "/health shows $ACTIVE active task(s); wait for them to finish"
[ "$(active_in_db)" = 0 ] || die "the tasks table still has queued or running rows"

# 2. the commit may only change runner src files, and 207 must really be at BASE
if git -C "$ROOT" diff --name-only "$BASE" "$SHA" | grep -E '^(package-lock\.json|packages/)' >/dev/null; then
  die "this commit changes package-lock.json or packages/; node_modules on 207 would be stale. Not a file-swap deploy."
fi
CHANGES=$(git -C "$ROOT" diff --name-status "$BASE" "$SHA" -- apps/runner/src | grep -v '\.test\.ts$' || true)
[ -n "$CHANGES" ] || die "no runner src changes between $BASE and $SHA"
if printf '%s\n' "$CHANGES" | grep -Ev '^[AM][[:space:]]' >/dev/null; then die "deleted or renamed src files are not supported by the file swap"; fi
SRC_FILES=$(printf '%s\n' "$CHANGES" | awk '{print $2}' | sed 's#^apps/runner/##')
DIST_FILES=$(printf '%s\n' "$SRC_FILES" | sed -e 's#^src/#dist/#' -e 's#\.ts$#.js#')

WANT=$(git -C "$ROOT" ls-tree -r --name-only "$BASE" -- apps/runner/src | grep -v '\.test\.ts$' | LC_ALL=C sort | while read -r f; do
  printf '%s  %s\n' "$(git -C "$ROOT" show "$BASE:$f" | sum256 | cut -d' ' -f1)" "${f#apps/runner/}"
done)
[ "$WANT" = "$(remote_manifest src)" ] || die "src on 207 is not byte-identical to $BASE; someone changed the box by hand. Refusing."
say "207 src matches the deployed commit"

# 3. local build, then prove the new dist differs from the live one only where expected
BUILD=$(mktemp -d "${TMPDIR:-/tmp}/forge-deploy-build.XXXXXX")
git -C "$ROOT" archive "$SHA" | tar -x -C "$BUILD"
(cd "$BUILD" && npm ci --ignore-scripts >"$BUILD/build.log" 2>&1 && npm run build >>"$BUILD/build.log" 2>&1) \
  || { tail -n 20 "$BUILD/build.log" >&2; die "local build of $SHA failed"; }
remote_manifest dist >"$BUILD/live.sums"
(cd "$BUILD/apps/runner" && find dist -type f | LC_ALL=C sort | xargs shasum -a 256) >"$BUILD/new.sums"
DIFFERING=$({ diff "$BUILD/live.sums" "$BUILD/new.sums" || true; } | awk '/^[<>]/ {print $3}' | LC_ALL=C sort -u)
[ -n "$DIFFERING" ] || die "the built dist is identical to the live dist; nothing to deploy"
UNEXPECTED=$(printf '%s\n' "$DIFFERING" | grep -v '^$' | grep -Fxv -f <(printf '%s\n' "$DIST_FILES") || true)
[ -z "$UNEXPECTED" ] || die "built dist differs from live in files this commit does not explain: $(echo $UNEXPECTED)"
say "built dist differs from live only in: $(echo $DIFFERING)"

DB_BYTES=$(r "stat -c %s '$APP/data/forge.db' 2>/dev/null || stat -f %z '$APP/data/forge.db'")
FREE_KB=$(r "df -Pk '$APP/data' | awk 'NR==2 {print \$4}'")
[ "$FREE_KB" -gt $(( DB_BYTES / 1024 * 2 + 1048576 )) ] || die "not enough free disk on 207 for a DB backup (free ${FREE_KB} KB, DB ${DB_BYTES} bytes)"
r "command -v sqlite3 >/dev/null && command -v pm2 >/dev/null && test -x '$NODE'" || die "207 is missing sqlite3, pm2 or $NODE"

GHOSTS_BEFORE=$(ghosts); LIVE_BEFORE=$(probe liveforge)
STAMP="$(date -u +%Y%m%dT%H%M%SZ)-$(printf '%s' "$SHA" | cut -c1-7)"
BACKUP="$STATE/backups/$STAMP"; STAGE="$APP/.deploy-stage-$STAMP"
say "board now: $LIVE_BEFORE forge-task entries shown live, $GHOSTS_BEFORE of them ghosts"
say "plan: smoke-test Claude + Codex on the old code; back up forge.db ($DB_BYTES bytes) and dist + src to $BACKUP;"
say "      swap $(echo $DIST_FILES $SRC_FILES); restart $PM2_NAME; verify; smoke-test again"
if [ "$DRY" = 1 ]; then say "dry run: all read-only checks passed. Nothing changed on 207."; exit 0; fi

# 4. baseline smoke on the old code
r "bash -s -- '$SMOKE_REPO'" <<'SH' || die "could not prepare the smoke-test repo; nothing else was changed"
set -euo pipefail
if [ ! -d "$1/.git" ]; then
  mkdir -p "$1"
  git -C "$1" init -q -b main
  git -C "$1" -c user.name=forge-deploy -c user.email=forge-deploy@localhost commit -q --allow-empty -m "forge deploy smoke repo"
  if id forge >/dev/null 2>&1; then chown -R forge:forge "$1"; fi
fi
SH
for p in claude codex; do
  say "baseline smoke ($p, old code)..."
  probe smoke "$p" "$SMOKE_REPO" 0 || die "the $p smoke task fails BEFORE the deploy, so the box is unhealthy on its own (CLI login?). Code and DB were not changed."
done

# 5. backups
say "backing up to $BACKUP ..."
r "bash -s -- '$APP' '$BACKUP' '$BASE' '$SHA'" <<'SH' || die "backup failed; code and DB were not changed"
set -euo pipefail
app=$1 b=$2
mkdir -p "$b"
sqlite3 -cmd '.timeout 30000' "$app/data/forge.db" ".backup '$b/forge.db'"
[ "$(sqlite3 "$b/forge.db" 'PRAGMA quick_check')" = ok ]
tar -czf "$b/code.tgz" -C "$app" dist src
echo "$3" >"$b/FROM_SHA"; echo "$4" >"$b/TO_SHA"
SH

# 6. stage beside the app (same filesystem), verify, then rename into place and restart
# shellcheck disable=SC2086
(cd "$BUILD/apps/runner" && COPYFILE_DISABLE=1 tar --format ustar -cf - $DIST_FILES $SRC_FILES) \
  | r "mkdir -p '$STAGE' && tar --no-same-owner -xf - -C '$STAGE'" || die "staging failed; live code and DB were not changed"
STAGED=$(r "cd '$STAGE' && find dist src -type f | LC_ALL=C sort | $REMOTE_SUM")
# shellcheck disable=SC2086
LOCAL=$(cd "$BUILD/apps/runner" && printf '%s\n' $DIST_FILES $SRC_FILES | LC_ALL=C sort | xargs shasum -a 256)
[ "$STAGED" = "$LOCAL" ] || { r "rm -rf '$STAGE'"; die "staged files do not match the build; live code and DB were not changed"; }

SWAPPED=1
set +e
# shellcheck disable=SC2086
r "bash -s -- '$APP' '$STAGE' '$PORT' '$PM2_NAME' $(echo $DIST_FILES $SRC_FILES)" <<'SH'
set -euo pipefail
app=$1 stage=$2 port=$3 name=$4; shift 4
if ! curl -fsS -m 10 "http://127.0.0.1:$port/health" | grep -q '"activeTasks":0'; then rm -rf "$stage"; exit 3; fi
for f in "$@"; do mkdir -p "$app/$(dirname "$f")"; mv -f "$stage/$f" "$app/$f"; done
rm -rf "$stage"
pm2 restart "$name" >/dev/null
SH
RC=$?
set -e
if [ "$RC" = 3 ]; then SWAPPED=0; die "a task started during the backup; nothing was swapped. Run again when idle."; fi
[ "$RC" = 0 ] || die "swap or restart failed"
say "swapped and restarted $PM2_NAME"

# 7. health, crash loop, ghosts
wait_healthy || die "/health did not come back within 60 seconds"
PM2_A=$(probe pm2 "$PM2_NAME"); sleep 10; PM2_B=$(probe pm2 "$PM2_NAME")
[ "$PM2_A" = "$PM2_B" ] && [ "${PM2_B%% *}" = online ] || die "PM2 process is not stable (was '$PM2_A', now '$PM2_B')"
LIVE_AFTER=$(probe liveforge); GHOSTS_AFTER=$(ghosts)
say "board after: $LIVE_AFTER forge-task entries shown live, $GHOSTS_AFTER ghosts (before: $LIVE_BEFORE and $GHOSTS_BEFORE)"
[ "$GHOSTS_AFTER" = 0 ] || die "$GHOSTS_AFTER ghost entries remain after the reconcile"
if [ "$GHOSTS_BEFORE" -gt 0 ] && [ "$LIVE_AFTER" -ge "$LIVE_BEFORE" ]; then die "/agent-context live forge-task count did not drop"; fi

# 8. the same two trivial tasks on the new code, this time with a board entry each
for p in claude codex; do
  say "smoke ($p, new code)..."
  probe smoke "$p" "$SMOKE_REPO" 1 || die "the $p smoke task failed on the new code"
done

SWAPPED=0
r "echo '$SHA' >'$STATE/DEPLOYED_SHA'; ls -1d '$STATE'/backups/*/ | LC_ALL=C sort -r | awk 'NR>$KEEP_BACKUPS' | xargs rm -rf"
say "DEPLOYED $SHA. Backup kept at $BACKUP (newest $KEEP_BACKUPS are kept)."
say "To undo: scripts/deploy-live.sh --rollback"
