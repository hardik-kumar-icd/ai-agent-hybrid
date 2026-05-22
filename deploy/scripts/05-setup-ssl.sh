#!/usr/bin/env bash
# ============================================================================
# 05-setup-ssl.sh
# Obtain Let's Encrypt SSL cert for agent.visor.no via certbot.
# ============================================================================
set -euo pipefail

log() { echo -e "\n\033[1;34m[setup-ssl]\033[0m $*"; }
ok()  { echo -e "\033[1;32m✓\033[0m $*"; }

if [[ "$EUID" -ne 0 ]]; then
  echo "Run with sudo: sudo bash $0"
  exit 1
fi

DOMAIN=agent.visor.no
EXPECTED_IP=16.171.244.173

# Check DNS resolves to this server
log "Verifying DNS for $DOMAIN..."
RESOLVED=$(dig +short "$DOMAIN" | tail -n1)
if [[ "$RESOLVED" != "$EXPECTED_IP" ]]; then
  echo "⚠️  $DOMAIN resolves to '$RESOLVED' (expected '$EXPECTED_IP')."
  echo "    DNS may not have propagated. Continue anyway? (y/N)"
  read -r ANS
  [[ "$ANS" == "y" ]] || exit 1
else
  ok "DNS resolves to $RESOLVED"
fi

log "Requesting SSL certificate from Let's Encrypt..."
# Interactive mode — certbot will prompt for email and ToS agreement.
certbot --nginx -d "$DOMAIN" --redirect

ok "Certificate installed"

log "Testing renewal..."
certbot renew --dry-run
ok "Renewal works (auto-runs twice daily via systemd timer)"

echo
echo "Visit https://$DOMAIN to verify SSL padlock."
