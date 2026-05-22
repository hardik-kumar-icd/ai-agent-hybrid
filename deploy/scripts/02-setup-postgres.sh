#!/usr/bin/env bash
# ============================================================================
# 02-setup-postgres.sh
# Install PostgreSQL 15, create visor_agent database and visor_app user.
# Generates a random password and prints it ONCE.
# Idempotent — re-running won't change an existing password.
# ============================================================================
set -euo pipefail

log() { echo -e "\n\033[1;34m[setup-postgres]\033[0m $*"; }
ok()  { echo -e "\033[1;32m✓\033[0m $*"; }
warn(){ echo -e "\033[1;33m!\033[0m $*"; }

if [[ "$EUID" -ne 0 ]]; then
  echo "Run with sudo: sudo bash $0"
  exit 1
fi

DB_NAME=visor_agent
DB_USER=visor_app
PG_VERSION=15

# ---------- Add PostgreSQL APT repo ----------
if ! [[ -f /etc/apt/sources.list.d/pgdg.list ]]; then
  log "Adding PostgreSQL official APT repo..."
  install -d /usr/share/postgresql-common/pgdg
  curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc | \
    gpg --dearmor -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.gpg
  echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.gpg] https://apt.postgresql.org/pub/repos/apt $(lsb_release -cs)-pgdg main" \
    > /etc/apt/sources.list.d/pgdg.list
  apt-get update -y
fi

# ---------- Install Postgres ----------
if ! command -v psql >/dev/null || ! psql --version | grep -q "$PG_VERSION"; then
  log "Installing PostgreSQL $PG_VERSION..."
  apt-get install -y postgresql-$PG_VERSION postgresql-client-$PG_VERSION
fi
systemctl enable --now postgresql
ok "PostgreSQL $(sudo -u postgres psql -tA -c 'SHOW server_version;' | head -1) running"

# ---------- Verify localhost-only binding ----------
PG_CONF=/etc/postgresql/$PG_VERSION/main/postgresql.conf
if grep -qE "^listen_addresses\s*=\s*'\*'" "$PG_CONF"; then
  warn "Postgres is listening on '*'. Restricting to localhost..."
  sed -i "s/^listen_addresses\s*=\s*'\*'/listen_addresses = 'localhost'/" "$PG_CONF"
  systemctl restart postgresql
fi
ok "Postgres bound to localhost only"

# ---------- Create DB and user ----------
DB_EXISTS=$(sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='$DB_NAME'")
USER_EXISTS=$(sudo -u postgres psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='$DB_USER'")

if [[ "$USER_EXISTS" != "1" ]]; then
  DB_PASSWORD=$(openssl rand -base64 24 | tr -d '/+=' | cut -c1-32)
  log "Creating user $DB_USER..."
  sudo -u postgres psql -c "CREATE USER $DB_USER WITH PASSWORD '$DB_PASSWORD';" >/dev/null
  PASSWORD_GENERATED=1
else
  warn "User $DB_USER already exists. Password not changed."
  PASSWORD_GENERATED=0
fi

if [[ "$DB_EXISTS" != "1" ]]; then
  log "Creating database $DB_NAME..."
  sudo -u postgres psql -c "CREATE DATABASE $DB_NAME OWNER $DB_USER;" >/dev/null
fi

log "Granting privileges and enabling pgcrypto..."
sudo -u postgres psql -d "$DB_NAME" <<SQL >/dev/null
GRANT ALL PRIVILEGES ON DATABASE $DB_NAME TO $DB_USER;
GRANT ALL ON SCHEMA public TO $DB_USER;
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
SQL
ok "Database $DB_NAME ready"

# ---------- Print password (once) ----------
echo
echo "============================================================"
if [[ "$PASSWORD_GENERATED" == "1" ]]; then
  echo " DATABASE CREDENTIALS — COPY NOW, NOT PRINTED AGAIN"
  echo "============================================================"
  echo " DB:       $DB_NAME"
  echo " User:     $DB_USER"
  echo " Password: $DB_PASSWORD"
  echo " URL:      postgres://$DB_USER:$DB_PASSWORD@localhost:5432/$DB_NAME"
  echo "============================================================"
  echo
  echo "Paste the URL into server/.env as DATABASE_URL"
else
  echo " Existing user/password unchanged. To reset:"
  echo "   sudo -u postgres psql -c \"ALTER USER $DB_USER WITH PASSWORD 'newpass';\""
  echo "============================================================"
fi
