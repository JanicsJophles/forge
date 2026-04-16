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
