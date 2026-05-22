#!/usr/bin/env bash
# ============================================================================
# 01-setup-vm.sh
# Install system dependencies: Node 20, PM2, Nginx, certbot, UFW firewall.
# Idempotent — safe to re-run.
# ============================================================================
set -euo pipefail

log() { echo -e "\n\033[1;34m[setup-vm]\033[0m $*"; }
ok()  { echo -e "\033[1;32m✓\033[0m $*"; }

if [[ "$EUID" -ne 0 ]]; then
  echo "Run with sudo: sudo bash $0"
  exit 1
fi

# ---------- System update ----------
log "Updating apt cache and upgrading system packages..."
apt-get update -y
DEBIAN_FRONTEND=noninteractive apt-get upgrade -y
ok "System up to date"

# ---------- Timezone ----------
log "Setting timezone to Europe/Oslo..."
timedatectl set-timezone Europe/Oslo
ok "Timezone: $(timedatectl show --property=Timezone --value)"

# ---------- Base packages ----------
log "Installing base packages (build tools, git, curl)..."
apt-get install -y \
  build-essential \
  git \
  curl \
  wget \
  unzip \
  htop \
  ca-certificates \
  gnupg \
  lsb-release
ok "Base packages installed"

# ---------- UFW firewall ----------
log "Configuring UFW firewall..."
ufw --force reset >/dev/null
ufw default deny incoming >/dev/null
ufw default allow outgoing >/dev/null
ufw allow OpenSSH >/dev/null
ufw allow 'Nginx Full' >/dev/null
ufw --force enable >/dev/null
ok "UFW enabled (22, 80, 443 only)"

# ---------- Node.js 20 LTS ----------
if ! command -v node >/dev/null || [[ "$(node --version)" != v20.* ]]; then
  log "Installing Node.js 20 LTS..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi
ok "Node $(node --version) / npm $(npm --version)"

# ---------- PM2 ----------
if ! command -v pm2 >/dev/null; then
  log "Installing PM2 globally..."
  npm install -g pm2
fi
ok "PM2 $(pm2 --version)"

# Configure PM2 to start on boot (for user 'ubuntu')
log "Configuring PM2 to start on system boot..."
sudo -u ubuntu pm2 startup systemd -u ubuntu --hp /home/ubuntu 2>/dev/null | \
  grep -E '^sudo' | bash || true
ok "PM2 startup configured"

# ---------- Nginx ----------
if ! command -v nginx >/dev/null; then
  log "Installing Nginx..."
  apt-get install -y nginx
fi
systemctl enable --now nginx
ok "Nginx running"

# ---------- Certbot ----------
if ! command -v certbot >/dev/null; then
  log "Installing Certbot..."
  apt-get install -y certbot python3-certbot-nginx
fi
ok "Certbot $(certbot --version 2>&1 | head -1)"

# ---------- Final ----------
log "VM setup complete."
echo
echo "Next steps:"
echo "  1. sudo bash deploy/scripts/02-setup-postgres.sh"
echo "  2. cp deploy/env/.env.production.example server/.env  (and edit)"
echo "  3. bash deploy/scripts/03-deploy-app.sh"
