#!/usr/bin/env bash
# ============================================================================
# 04-setup-nginx.sh
# Install the agent.visor.no nginx site config and reload.
# ============================================================================
set -euo pipefail

log() { echo -e "\n\033[1;34m[setup-nginx]\033[0m $*"; }
ok()  { echo -e "\033[1;32m✓\033[0m $*"; }

if [[ "$EUID" -ne 0 ]]; then
  echo "Run with sudo: sudo bash $0"
  exit 1
fi

APP_DIR=/var/www/visor-agent
SITE_NAME=agent.visor.no
NGINX_AVAILABLE=/etc/nginx/sites-available/$SITE_NAME
NGINX_ENABLED=/etc/nginx/sites-enabled/$SITE_NAME

log "Installing nginx site config for $SITE_NAME..."
cp "$APP_DIR/deploy/nginx/$SITE_NAME.conf" "$NGINX_AVAILABLE"
ok "Config copied to $NGINX_AVAILABLE"

if [[ ! -L "$NGINX_ENABLED" ]]; then
  ln -s "$NGINX_AVAILABLE" "$NGINX_ENABLED"
  ok "Enabled site"
fi

if [[ -L /etc/nginx/sites-enabled/default ]]; then
  rm /etc/nginx/sites-enabled/default
  ok "Removed default site"
fi

log "Testing nginx config..."
nginx -t

log "Reloading nginx..."
systemctl reload nginx
ok "Nginx reloaded"

echo
echo "Test HTTP access:"
echo "  curl -I http://agent.visor.no"
echo
echo "Then run: sudo bash deploy/scripts/05-setup-ssl.sh"
