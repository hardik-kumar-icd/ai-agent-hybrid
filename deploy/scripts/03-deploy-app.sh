#!/usr/bin/env bash
# ============================================================================
# 03-deploy-app.sh
# Install dependencies, build client, start (or restart) PM2 process.
# Used for both first-time deploy and subsequent updates.
# ============================================================================
set -euo pipefail

log() { echo -e "\n\033[1;34m[deploy-app]\033[0m $*"; }
ok()  { echo -e "\033[1;32m✓\033[0m $*"; }

APP_DIR=/var/www/visor-agent
LOG_DIR=/var/log/visor-agent

cd "$APP_DIR"

# ---------- Validate .env exists ----------
if [[ ! -f server/.env ]]; then
  echo "❌ server/.env not found."
  echo "   cp deploy/env/.env.production.example server/.env"
  echo "   Then edit it and re-run this script."
  exit 1
fi

# ---------- Log directory ----------
if [[ ! -d "$LOG_DIR" ]]; then
  log "Creating log directory $LOG_DIR..."
  sudo mkdir -p "$LOG_DIR"
  sudo chown -R ubuntu:ubuntu "$LOG_DIR"
fi

# ---------- Server deps ----------
log "Installing server production dependencies..."
cd "$APP_DIR/server"
npm ci --omit=dev
ok "Server deps installed"

# ---------- Client build ----------
log "Installing client dependencies and building..."
cd "$APP_DIR/client"
npm ci
npm run build
ok "Client built ($(du -sh build | cut -f1))"

# ---------- PM2 start or restart ----------
cd "$APP_DIR"
if pm2 list | grep -q "visor-agent"; then
  log "Restarting existing PM2 process..."
  pm2 restart visor-agent --update-env
else
  log "Starting PM2 process..."
  pm2 start deploy/pm2/ecosystem.config.js
fi
pm2 save
ok "PM2 process running"

# ---------- Health check ----------
log "Waiting 3 seconds for app to boot..."
sleep 3

if curl -sf http://localhost:5000/visor-chat >/dev/null; then
  ok "App responding on http://localhost:5000"
else
  echo "⚠️  App did not respond on /visor-chat. Check logs:"
  echo "    pm2 logs visor-agent --lines 50"
  exit 1
fi

echo
echo "Next steps:"
echo "  - sudo bash deploy/scripts/04-setup-nginx.sh"
echo "  - sudo bash deploy/scripts/05-setup-ssl.sh"
echo "  - sudo bash deploy/scripts/06-setup-backups.sh"
