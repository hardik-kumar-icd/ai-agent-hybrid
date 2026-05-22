# Lightsail Deployment Runbook

**Target:** `agent.visor.no` (Static IP: 16.171.244.173, region: eu-north-1)
**Estimated time:** 60–90 minutes
**Result:** Current AI agent running with PM2, Nginx, SSL, and a local Postgres
ready for the intelligence layer in future PRs.

---

## Prerequisites (already done)

- [x] Lightsail instance `visor-agent-prod` created (Ubuntu 22.04, $10 plan)
- [x] Static IP `16.171.244.173` attached
- [x] Firewall ports 22/80/443 open in Lightsail console
- [x] DNS A record: `agent.visor.no` → `16.171.244.173`
- [x] Daily VM snapshots enabled in Lightsail console
- [x] SSH key downloaded to local machine as `~/.ssh/lightsail-eu-north.pem`

If any of the above is missing, complete it before proceeding.

---

## Phase 1 — Connect

From your local terminal:

```bash
chmod 600 ~/.ssh/lightsail-eu-north.pem
ssh -i ~/.ssh/lightsail-eu-north.pem ubuntu@16.171.244.173
```

All remaining commands run **on the VM**.

---

## Phase 2 — Clone the repo

```bash
sudo mkdir -p /var/www/visor-agent
sudo chown -R ubuntu:ubuntu /var/www/visor-agent
cd /var/www
git clone https://github.com/hardik-kumar-icd/ai-agent-hybrid.git visor-agent
cd visor-agent
```

---

## Phase 3 — Run setup scripts in order

Each script prints what it's doing and is safe to re-run.

```bash
cd /var/www/visor-agent
chmod +x deploy/scripts/*.sh

# 3.1 System packages (Node 20, PM2, Nginx, certbot, ufw)
sudo bash deploy/scripts/01-setup-vm.sh

# 3.2 PostgreSQL 15 + visor_agent database
sudo bash deploy/scripts/02-setup-postgres.sh
# IMPORTANT: This script generates a DB password and prints it ONCE.
# Copy it immediately — you'll need it in the next step.
```

---

## Phase 4 — Configure environment

```bash
cp deploy/env/.env.production.example server/.env
chmod 600 server/.env
nano server/.env
```

Fill in **every value** marked with `REPLACE_ME`. Specifically:

| Variable | Where to get it |
|---|---|
| `OPENAI_API_KEY` | platform.openai.com/api-keys |
| `PINECONE_API_KEY` | app.pinecone.io |
| `MAGENTO_BEARER_TOKEN` | Magento Admin → System → Integrations |
| `ADMIN_API_KEY` | Generate: `openssl rand -hex 32` |
| `JWT_SECRET` | Generate: `openssl rand -hex 32` |
| `DATABASE_URL` | Use the password printed by script 02 |

Save with `Ctrl+O`, `Enter`, `Ctrl+X`.

> **Security:** never commit this file. It's already in `.gitignore`.

---

## Phase 5 — Deploy the app

```bash
bash deploy/scripts/03-deploy-app.sh
```

This script:
- Installs server production deps (`npm ci --omit=dev`)
- Installs client deps and builds (`npm run build`)
- Creates `/var/log/visor-agent/` for PM2 logs
- Starts the app via PM2 using `deploy/pm2/ecosystem.config.js`
- Saves PM2 state for reboot persistence

Verify:

```bash
pm2 status
# Expected: visor-agent | online
pm2 logs visor-agent --lines 30
# Expected: server startup logs, listening on port 5000
curl http://localhost:5000/visor-chat
# Expected: JSON response
```

---

## Phase 6 — Nginx reverse proxy

```bash
sudo bash deploy/scripts/04-setup-nginx.sh
```

This script:
- Copies `deploy/nginx/agent.visor.no.conf` to `/etc/nginx/sites-available/`
- Symlinks to `sites-enabled/`
- Removes the default Nginx welcome site
- Tests config and reloads Nginx

Verify HTTP access:

```bash
curl -I http://agent.visor.no
# Expected: HTTP/1.1 200 OK
```

Open `http://agent.visor.no` in a browser — your React build should load.

---

## Phase 7 — SSL via Let's Encrypt

```bash
sudo bash deploy/scripts/05-setup-ssl.sh
```

You'll be prompted for:
- Your email (for renewal notices)
- Agreement to ToS (`Y`)
- Whether to share email with EFF (your choice)

Certbot automatically edits the Nginx config to enable HTTPS and sets up
auto-renewal via a systemd timer.

Verify:

```bash
curl -I https://agent.visor.no
# Expected: HTTP/2 200
sudo certbot renew --dry-run
# Expected: success
```

Open `https://agent.visor.no` in a browser — valid padlock should appear.

---

## Phase 8 — Database backups

```bash
sudo bash deploy/scripts/06-setup-backups.sh
```

This script:
- Creates `/var/backups/postgres/` owned by `postgres` user
- Installs `/usr/local/bin/backup-visor-db.sh`
- Schedules daily 03:00 Oslo backup via cron
- Runs the backup once immediately to verify

Verify:

```bash
ls -lh /var/backups/postgres/
# Expected: one .sql.gz file
sudo crontab -u postgres -l
# Expected: 0 3 * * * /usr/local/bin/backup-visor-db.sh ...
```

Retention: 7 days local. Combined with Lightsail daily snapshots, you have
two independent restore paths.

---

## Phase 9 — End-to-end smoke test

From your local machine:

```bash
# 9.1 HTTPS reaches the app
curl https://agent.visor.no/visor-chat

# 9.2 Try a chat query
curl -X POST https://agent.visor.no/visor-chat \
  -H "Content-Type: application/json" \
  -H "X-Conversation-Id: test-conv-1" \
  -d '{"message":"Hva er åpningstider?","conversationId":"test-conv-1"}'
```

Open `https://agent.visor.no` in a browser and run 5–10 real queries:
- 2–3 KB questions (FAQ topics)
- 1 order lookup using a real test.visor.no order
- 1 ambiguous query to test ticket fallback

---

## Phase 10 — Cutover (when ready)

You are **not cutting over yet**. Render stays live until you've tested in
production traffic for 24–48 hours. When ready:

1. On Magento staging (test.visor.no): update widget embed `baseUrl` from
   the Render URL to `https://agent.visor.no`
2. Monitor for 24–48 hours via `pm2 logs visor-agent`
3. On Magento production (visor.no): update widget embed
4. Update VM `.env`: switch `MAGENTO_API_URL` and `MAGENTO_BEARER_TOKEN` to
   production values, then `pm2 restart visor-agent`
5. After one week of stable production: shut down Render

---

## Day-to-day operations

### Deploy a new commit

```bash
ssh -i ~/.ssh/lightsail-eu-north.pem ubuntu@16.171.244.173
cd /var/www/visor-agent
bash deploy/scripts/deploy.sh
```

### View logs

```bash
pm2 logs visor-agent --lines 100
pm2 logs visor-agent --err
sudo tail -f /var/log/nginx/access.log
sudo tail -f /var/log/nginx/error.log
```

### Restart

```bash
pm2 restart visor-agent      # after .env changes
sudo systemctl reload nginx  # after nginx config changes
```

### Monitor resource usage

```bash
pm2 monit         # live PM2 dashboard
htop              # CPU + memory
df -h             # disk
free -h           # memory
```

### Manual DB backup

```bash
sudo -u postgres /usr/local/bin/backup-visor-db.sh
```

### Restore from backup

```bash
# List backups
ls -lh /var/backups/postgres/

# Restore (replace timestamp)
sudo -u postgres bash -c "gunzip -c /var/backups/postgres/visor_agent_20260522_030001.sql.gz | psql visor_agent"
```

---

## Troubleshooting

### App won't start

```bash
pm2 logs visor-agent --err --lines 50
# Common issues:
# - Bad DATABASE_URL → test with: psql "$DATABASE_URL"
# - Missing env var → check server/.env vs .env.production.example
# - Port 5000 in use → sudo lsof -i :5000
```

### 502 Bad Gateway from Nginx

```bash
pm2 status                     # Is app running?
sudo tail /var/log/nginx/error.log
```

### SSL renewal failing

```bash
sudo certbot certificates
sudo certbot renew --dry-run
sudo systemctl status certbot.timer
```

### Disk filling up

```bash
df -h
du -sh /var/log/* | sort -h
sudo journalctl --vacuum-time=7d      # trim systemd logs
pm2 flush visor-agent                 # trim PM2 logs
```

### Postgres connection refused

```bash
sudo systemctl status postgresql
sudo -u postgres psql -c "SELECT version();"
```

---

## Security checklist

- [x] `.env` chmod 600
- [x] UFW enabled, only 22/80/443 open
- [x] Postgres bound to localhost only
- [x] All API keys rotated after initial setup
- [x] SSH key not committed to repo
- [ ] Lightsail console MFA enabled (do this in AWS console)
- [ ] Periodic rotation of `ADMIN_API_KEY` and `JWT_SECRET` scheduled
