#!/usr/bin/env bash
# forge-runner LXC setup script
# Run once on a fresh Debian 12 container after cloning the repo.
# Expects to be executed as root or a sudo-capable user.

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNNER_DIR="${REPO_DIR}/apps/runner"
LOG_DIR="${RUNNER_DIR}/logs"
DATA_DIR="${RUNNER_DIR}/data"

echo "[setup] forge-runner LXC setup"
echo "[setup] repo: ${REPO_DIR}"

# ── Node.js 20 via NodeSource ─────────────────────────────────────────────────
if ! command -v node &>/dev/null || [[ "$(node --version | cut -c2- | cut -d. -f1)" -lt 20 ]]; then
    echo "[setup] installing Node.js 20..."
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    apt-get install -y nodejs
else
    echo "[setup] Node.js $(node --version) already installed"
fi

# ── npm 10 ────────────────────────────────────────────────────────────────────
npm install -g npm@latest

# ── PM2 ───────────────────────────────────────────────────────────────────────
if ! command -v pm2 &>/dev/null; then
    echo "[setup] installing PM2..."
    npm install -g pm2
    pm2 startup systemd -u root --hp /root
else
    echo "[setup] PM2 $(pm2 --version) already installed"
fi

# ── Claude CLI ────────────────────────────────────────────────────────────────
if ! command -v claude &>/dev/null; then
    echo "[setup] installing Claude Code CLI..."
    npm install -g @anthropic-ai/claude-code
else
    echo "[setup] claude $(claude --version) already installed"
fi

# ── Git (ensure recent enough for sparse-checkout etc.) ──────────────────────
apt-get install -y git curl

# ── Workspace install + build ─────────────────────────────────────────────────
echo "[setup] installing npm workspace dependencies..."
cd "${REPO_DIR}"
npm install

echo "[setup] building shared types..."
npm run build --workspace=packages/shared

echo "[setup] building runner..."
cd "${RUNNER_DIR}"
npm run build

# ── Read-only task account (optional) ────────────────────────────────────────
# Read-only tasks run as a dedicated, credential-less account against a disposable
# copy of the repo (see the README "Read-only tasks" section). Create the account
# and its isolated provider-auth dirs here; the interactive logins must be done by
# hand once (they can't be scripted). Skipped entirely unless READONLY_RUN_USER is set.
if [[ -n "${READONLY_RUN_USER:-}" ]]; then
    RO_USER="${READONLY_RUN_USER}"
    RO_CLAUDE_DIR="/etc/forge-ro/claude"
    RO_CODEX_DIR="/etc/forge-ro/codex"
    if ! id "${RO_USER}" &>/dev/null; then
        echo "[setup] creating read-only account '${RO_USER}'..."
        # --user-group gives it its OWN dedicated primary group. A shared group would
        # let the read-only account read the writable run account's group-readable
        # repos and credentials — isolation is by uid AND gid.
        useradd --system --create-home --user-group --shell /usr/sbin/nologin "${RO_USER}"
    else
        echo "[setup] read-only account '${RO_USER}' already exists"
    fi

    # Root-owned, mode-0711 base dir for the disposable copies (never /tmp). The runner
    # also creates this at startup, but make it here so permissions are correct up front.
    RO_BASE_DIR="${READONLY_BASE_DIR:-/var/lib/forge/ro}"
    install -d -o root -g root -m 0711 "${RO_BASE_DIR}"
    echo "[setup] read-only copies will live under ${RO_BASE_DIR} (root-owned, 0711)"

    # Provider auth dirs. They must be WRITABLE by the read-only account for the
    # one-time interactive login below. After login, re-run setup (or the two
    # commands it prints) to LOCK them down: once they contain credentials we make
    # them root-owned and mode 0700, NOT group/world readable. The runner copies this
    # source per-task into a throwaway 0700 HOME, so the agent never reads it directly
    # and one read-only task cannot tamper with the auth the next task uses.
    install -d -o "${RO_USER}" -g "${RO_USER}" -m 0700 "${RO_CLAUDE_DIR}" "${RO_CODEX_DIR}"
    if find "${RO_CLAUDE_DIR}" "${RO_CODEX_DIR}" -mindepth 1 -print -quit | grep -q .; then
        echo "[setup] locking read-only provider config (root-owned, 0700 — only root can read at rest)..."
        chown -R root:root "${RO_CLAUDE_DIR}" "${RO_CODEX_DIR}"
        # root: rwX, group/other: NONE. The runner makes a per-task copy for the agent.
        chmod -R u=rwX,go= "${RO_CLAUDE_DIR}" "${RO_CODEX_DIR}"
    else
        echo "[setup] read-only provider config is empty — leaving it writable for first login"
    fi

    echo ""
    echo "⚠  To finish read-only support, log the '${RO_USER}' account into each provider ONCE:"
    echo "     sudo -u ${RO_USER} CLAUDE_CONFIG_DIR=${RO_CLAUDE_DIR} claude   # then /login"
    echo "     sudo -u ${RO_USER} CODEX_HOME=${RO_CODEX_DIR} codex login"
    echo "   THEN lock the config so a task cannot tamper with it (re-running setup also does this):"
    echo "     chown -R root:root ${RO_CLAUDE_DIR} ${RO_CODEX_DIR}"
    echo "     chmod -R u=rwX,go= ${RO_CLAUDE_DIR} ${RO_CODEX_DIR}"
    echo "   and set in .env:  READONLY_RUN_USER=${RO_USER}"
    echo "                     READONLY_CLAUDE_CONFIG_DIR=${RO_CLAUDE_DIR}"
    echo "                     READONLY_CODEX_HOME=${RO_CODEX_DIR}"
    echo ""
    echo "   The read-only account can still READ any repo it is allowed to clone. Grant"
    echo "   it read access with an ACL (NOT a shared group, which would also expose the"
    echo "   writable account's other group-readable files), and keep OTHER users out:"
    echo "     setfacl -R -m u:${RO_USER}:rX  <each ALLOWED_REPO_PATH>"
    echo "     setfacl -R -d -m u:${RO_USER}:rX  <each ALLOWED_REPO_PATH>"
    echo "     chmod -R o-rx <each ALLOWED_REPO_PATH>"
    echo "   and never leave plaintext secrets inside tracked/ignored repo files."
    echo ""
else
    echo "[setup] READONLY_RUN_USER not set — skipping read-only account setup"
fi

# ── Runtime directories ───────────────────────────────────────────────────────
mkdir -p "${LOG_DIR}" "${DATA_DIR}"

# ── .env check ────────────────────────────────────────────────────────────────
if [[ ! -f "${RUNNER_DIR}/.env" ]]; then
    echo "[setup] copying .env.example → .env"
    cp "${RUNNER_DIR}/.env.example" "${RUNNER_DIR}/.env"
    echo ""
    echo "⚠  Edit ${RUNNER_DIR}/.env before starting:"
    echo "   ALLOWED_REPO_PATHS=/home/forge/repos   # absolute paths, comma-separated"
    echo "   AUTO_COMMIT=true"
    echo ""
fi

# ── PM2 start ─────────────────────────────────────────────────────────────────
echo "[setup] starting forge-runner via PM2..."
cd "${RUNNER_DIR}"
pm2 start pm2.config.js --update-env
pm2 save

echo ""
echo "✓ forge-runner is up. Check status: pm2 status"
echo "  Health: curl http://localhost:5000/health"
