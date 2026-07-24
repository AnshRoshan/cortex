# Deploying Cortex to EC2

One container + SQLite; Caddy in front provides free auto-renewing HTTPS.
No domain needed — sslip.io maps `<ip>.sslip.io` to your IP automatically.

## 1. EC2 setup (once)

- Launch **Ubuntu 24.04**, `t3.micro` (free tier) or bigger. 8 GB disk is fine.
- Security group inbound: **22** (your IP only), **80**, **443**. Nothing else.
- Allocate an **Elastic IP** and associate it (free while attached; keeps your
  sslip.io name stable across reboots).

## 2. Install Docker on the instance

```sh
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker ubuntu   # then log out & back in
```

## 3. Copy the project up

From your machine (PowerShell), excluding local build junk:

```powershell
scp -i key.pem -r . ubuntu@<ELASTIC_IP>:cortex   # or git clone on the server
```

Then on the server: `chmod 644 cortex/seed_users.json`. It holds plaintext seed
passwords, but the container's app user (uid 1000) must be able to read it, and
it isn't owned by that user — so it needs to be world-readable. The box is
single-tenant and the file is never web-exposed or committed to git. Change the
passwords via the app after first login, then the file no longer matters.

## 4. Run

```sh
cd cortex
DOMAIN=<ELASTIC_IP>.sslip.io docker compose -f docker-compose.prod.yml up -d --build
```

First build takes a few minutes. Then open `https://<ELASTIC_IP>.sslip.io`.
Caddy fetches the certificate on the first request (needs ports 80+443 open).

## 5. Backups (the whole DB is one file)

```sh
crontab -e
# daily 03:00 snapshot of the SQLite volume:
0 3 * * * docker run --rm -v cortex_cortex-data:/data -v $HOME/backups:/out alpine cp /data/authpad.db /out/authpad-$(date +\%F).db
```

## Updating

```sh
git pull   # or re-scp
DOMAIN=<ELASTIC_IP>.sslip.io docker compose -f docker-compose.prod.yml up -d --build
```

Data survives rebuilds — it lives in the `cortex-data` volume.

## Notes

- `COOKIE_SECURE=1` is set in the prod compose (session cookie is HTTPS-only).
- The app publishes no ports in prod; only Caddy reaches it on the compose network.
- If you later buy a real domain, point an A record at the Elastic IP and just
  change `DOMAIN=`.
