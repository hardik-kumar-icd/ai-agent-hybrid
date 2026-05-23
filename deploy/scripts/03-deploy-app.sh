#!/usr/bin/env bash
# ============================================================================
# 03-deploy-app.sh  (updated for latency PR)
#
# Changes vs. previous version:
#  1. Client uses `npm ci` (NOT --omit=dev) so Vite is available for the
#     widget build (Vite is a devDependency).
#  2. Adds `npm run build:widget` step so client/dist/widget.bundle.umd.js
#     is actually produced.
#  3. Verifies the widget bundle exists before reloading PM2.
#
# Used for both first-time deploy and subsequent updates. Idempotent.
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

# ---------- Client deps (INCLUDING devDependencies for Vite) ----------
log "Installing client dependencies (including devDependencies for build tools)..."
cd "$APP_DIR/client"
npm ci
ok "Client deps installed"

# ---------- Client builds ----------
log "Building CRA app (client/build/)..."
npm run build
ok "CRA app built ($(du -sh build 2>/dev/null | cut -f1))"

log "Building widget bundle (client/dist/widget.bundle.umd.js)..."
npm run build:widget
ok "Widget bundle built"

# Sanity check: did the bundle actually appear?
if [[ ! -f "$APP_DIR/client/dist/widget.bundle.umd.js" ]]; then
  echo "❌ Widget bundle build did not produce widget.bundle.umd.js"
  echo "   Check the output of 'npm run build:widget' above for errors."
  exit 1
fi

WIDGET_SIZE=$(du -h "$APP_DIR/client/dist/widget.bundle.umd.js" | cut -f1)
ok "Widget bundle verified: $WIDGET_SIZE"

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

# ---------- Optional: verify streaming endpoint ----------
if curl -sf -X GET http://localhost:5000/visor-chat/stream >/dev/null 2>&1; then
  ok "Streaming endpoint registered"
fi

echo
echo "Next steps:"
echo "  - sudo bash deploy/scripts/04-setup-nginx.sh   (re-run if nginx config changed)"
echo "  - sudo systemctl reload nginx                  (apply nginx changes)"
