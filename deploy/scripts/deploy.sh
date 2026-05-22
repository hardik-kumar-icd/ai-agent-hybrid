#!/usr/bin/env bash
# ============================================================================
# deploy.sh
# Day-to-day deploy: git pull, install deps, build client, restart PM2.
# Run from any directory. No sudo needed.
# ============================================================================
set -euo pipefail

log() { echo -e "\n\033[1;34m[deploy]\033[0m $*"; }
ok()  { echo -e "\033[1;32m✓\033[0m $*"; }

APP_DIR=/var/www/visor-agent

cd "$APP_DIR"

log "Pulling latest from main..."
git fetch origin main
LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse origin/main)

if [[ "$LOCAL" == "$REMOTE" ]]; then
  echo "Already up to date. Restart anyway? (y/N)"
  read -r ANS
  [[ "$ANS" != "y" ]] && exit 0
else
  git pull --ff-only origin main
  ok "Pulled $(git log --oneline -1)"
fi

log "Installing server deps..."
cd "$APP_DIR/server"
npm ci --omit=dev

log "Building client..."
cd "$APP_DIR/client"
npm ci
npm run build

log "Restarting PM2..."
cd "$APP_DIR"
pm2 restart visor-agent --update-env
pm2 save

sleep 3
if curl -sf http://localhost:5000/visor-chat >/dev/null; then
  ok "App healthy"
else
  echo "⚠️  App did not respond. Logs: pm2 logs visor-agent --lines 50"
  exit 1
fi
