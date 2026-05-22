# Lightsail Deployment

This folder contains everything needed to deploy the Visor.no AI Agent to AWS Lightsail.

## Structure

```
deploy/
├── README.md                    # This file
├── DEPLOYMENT.md                # Full step-by-step runbook
├── env/
│   └── .env.production.example  # Template for server/.env
├── nginx/
│   └── agent.visor.no.conf      # Nginx reverse proxy + SSL config
├── pm2/
│   └── ecosystem.config.js      # PM2 process definition
└── scripts/
    ├── 01-setup-vm.sh           # System deps (Node, PM2, Nginx, certbot, ufw)
    ├── 02-setup-postgres.sh     # Postgres 15 + visor_agent DB
    ├── 03-deploy-app.sh         # npm install + client build + PM2 start
    ├── 04-setup-nginx.sh        # Install nginx config + reload
    ├── 05-setup-ssl.sh          # Let's Encrypt cert for agent.visor.no
    ├── 06-setup-backups.sh      # pg_dump cron (local, 7-day retention)
    └── deploy.sh                # Day-to-day: git pull + rebuild + restart
```

## Quick Start

Read **DEPLOYMENT.md** end-to-end before running anything. It contains the AWS
console steps (instance creation, DNS, snapshots) that must be done before the
scripts will work.

## What These Scripts Don't Do

- Create the Lightsail instance (manual via AWS console)
- Set DNS for agent.visor.no (manual via your DNS provider)
- Fill in the .env file (you do this manually with real secrets)
- Cut over Magento storefront from Render to Lightsail (manual decision)

## Idempotency

All scripts are safe to re-run. They detect existing installs and skip rather
than fail.
