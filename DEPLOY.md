# Deploying Cortex to EC2

One container + SQLite; Caddy in front provides free auto-renewing HTTPS.
Works with a real domain (e.g. `nexus.isroot.in`) or, with no domain, sslip.io
which maps `<ip>.sslip.io` to your IP automatically. The URL is set via `DOMAIN=`.

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

If you **cloned via git** (rather than scp), create the seed file first — it's
gitignored, so it isn't in the repo:

```sh
cp seed_users.example.json seed_users.json
nano seed_users.json   # set the owner (role "root") + users/passwords
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

### Custom domain (e.g. nexus.isroot.in)

Same command — just point the domain's **A record at the Elastic IP** first,
then set `DOMAIN` to the domain instead of the sslip.io name:

```sh
DOMAIN=nexus.isroot.in docker compose -f docker-compose.prod.yml up -d --build
```

Caddy issues the cert on the first request, so DNS must already resolve to the
box and ports 80+443 must be open. DNS propagation can take a while (up to a day).

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

## Two-factor (authenticator app)

Any account can turn on TOTP 2FA from **Account & security** (owner console header
gear, or the account menu in the workspace). The owner can reset a user's 2FA from
the Accounts tab (shield icon) if they lose their phone.

**Owner lost their authenticator (break-glass).** The owner is the only account
nobody else can reset, so recovery is host-level — only you control the EC2 box:

```sh
# one-shot: clears 2FA on the owner account, then start normally again
OWNER_2FA_RESET=1 DOMAIN=<ELASTIC_IP>.sslip.io docker compose -f docker-compose.prod.yml up -d
# sign in with just the password, re-enroll, then bring it back up WITHOUT the flag
DOMAIN=<ELASTIC_IP>.sslip.io docker compose -f docker-compose.prod.yml up -d
```

## AI assistant (optional)

The workspace has a built-in AI assistant (✨ in the activity bar) that answers
questions grounded in the workspace's files. It's **off until a key exists** and
supports **Anthropic (Claude)** and any **OpenAI-compatible** endpoint (OpenAI,
Azure, OpenRouter, local Ollama, …).

Two ways to provide a key, lowest-effort first:

1. **Server-wide default (env):** put `ANTHROPIC_API_KEY=sk-ant-…` (optionally
   `AI_MODEL=claude-haiku-4-5` for cost) in a `.env` file next to
   `docker-compose.prod.yml`. Everyone in the org can use the assistant.

2. **Bring-your-own-key (per user / per org, in the UI):** set a random
   `AI_KEY_SECRET` in the same `.env` — this is the master secret that
   **encrypts stored keys at rest** (AES-GCM). Then each person adds their own
   provider + key under **Settings → AI**, and the owner/admin can set an
   **org default** there. Keys are write-only: they're never returned to the
   browser or written to logs. Without `AI_KEY_SECRET`, only option 1 works.

```sh
# .env (next to docker-compose.prod.yml)
AI_KEY_SECRET=$(openssl rand -hex 32)     # enables per-user/org keys in the UI
ANTHROPIC_API_KEY=sk-ant-...              # optional server-wide fallback
AI_MODEL=claude-opus-5                     # optional; env fallback's model
```

Rotating `AI_KEY_SECRET` invalidates all stored keys (users re-enter them) — pick
it once and keep it. DB size and per-table usage are visible in **Settings →
Storage** (owner/admin).

## Notes

- `COOKIE_SECURE=1` is set in the prod compose (session cookie is HTTPS-only).
- The owner's session is short-lived (12h) vs 7 days for everyone else.
- The app publishes no ports in prod; only Caddy reaches it on the compose network.
- If you later buy a real domain, point an A record at the Elastic IP and just
  change `DOMAIN=`.
