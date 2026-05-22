#!/usr/bin/env bash
# ============================================================================
# 06-setup-backups.sh
# Install pg_dump cron job for daily Postgres backups (local, 7-day retention).
# ============================================================================
set -euo pipefail

log() { echo -e "\n\033[1;34m[setup-backups]\033[0m $*"; }
ok()  { echo -e "\033[1;32m✓\033[0m $*"; }

if [[ "$EUID" -ne 0 ]]; then
  echo "Run with sudo: sudo bash $0"
  exit 1
fi

BACKUP_DIR=/var/backups/postgres
SCRIPT_PATH=/usr/local/bin/backup-visor-db.sh
LOG_PATH=/var/log/visor-db-backup.log

# ---------- Backup directory ----------
log "Creating backup directory $BACKUP_DIR..."
mkdir -p "$BACKUP_DIR"
chown postgres:postgres "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"

# ---------- Backup script ----------
log "Installing backup script at $SCRIPT_PATH..."
cat > "$SCRIPT_PATH" <<'EOF'
#!/usr/bin/env bash
set -e
BACKUP_DIR=/var/backups/postgres
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
DB_NAME=visor_agent
RETENTION_DAYS=7

pg_dump "$DB_NAME" | gzip > "$BACKUP_DIR/${DB_NAME}_${TIMESTAMP}.sql.gz"
find "$BACKUP_DIR" -name "${DB_NAME}_*.sql.gz" -mtime +${RETENTION_DAYS} -delete
echo "[$(date '+%Y-%m-%d %H:%M:%S')] Backup complete: ${DB_NAME}_${TIMESTAMP}.sql.gz ($(du -h "$BACKUP_DIR/${DB_NAME}_${TIMESTAMP}.sql.gz" | cut -f1))"
EOF
chmod +x "$SCRIPT_PATH"
ok "Backup script installed"

# ---------- Log file ----------
touch "$LOG_PATH"
chown postgres:postgres "$LOG_PATH"

# ---------- Cron entry ----------
log "Scheduling daily 03:00 backup via cron (postgres user)..."
CRON_LINE="0 3 * * * $SCRIPT_PATH >> $LOG_PATH 2>&1"
EXISTING=$(sudo -u postgres crontab -l 2>/dev/null || true)
if echo "$EXISTING" | grep -qF "$SCRIPT_PATH"; then
  ok "Cron entry already exists"
else
  echo -e "$EXISTING\n$CRON_LINE" | sudo -u postgres crontab -
  ok "Cron entry added"
fi

# ---------- Run once to verify ----------
log "Running backup now to verify..."
sudo -u postgres "$SCRIPT_PATH"
ok "Initial backup successful"

echo
echo "Verify:"
echo "  ls -lh $BACKUP_DIR"
echo "  sudo crontab -u postgres -l"
echo "  tail -f $LOG_PATH"
