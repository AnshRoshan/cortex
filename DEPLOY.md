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
DOMAIN=<ELASTIC_IP>.sslip.io docker compose -f docker-compose.prod.yml up -d --build --remove-orphans
docker image prune -f   # reclaim disk from the old image each `--build` leaves behind
```

`--remove-orphans` clears containers from services that no longer exist (e.g. a
leftover dev container). `docker image prune -f` deletes the now-dangling old
images — without it, every `--build` grows disk until the small box fills up.
Data survives rebuilds — it lives in the `cortex-data` volume.

## Deploy via GitHub Actions + GHCR (recommended for a small box)

Compiling Rust on a `t3.micro` (1 GB RAM) takes ~18 min and thrashes. Instead, let
GitHub build the image and have EC2 only **pull** it. The workflow
`.github/workflows/ci.yml` builds on every push to `main` and pushes to this repo's
**private** GHCR package `ghcr.io/anshace/cortex:latest` (tagged `latest` + short
SHA). It uses the built-in `GITHUB_TOKEN` — **no repo secrets to configure.**

Cost on the Free plan (private repo): Actions ~2,000 Linux min/month (a build is
~5–8 min); GHCR 500 MB storage + 1 GB/month egress. The push from Actions doesn't
count against egress — only the EC2 pull does, and the image is small. Prune old
package versions occasionally (GitHub → repo → Packages → cortex → versions).

**One-time on EC2 — log in to GHCR** (private image needs auth to pull). Create a
token at GitHub → Settings → Developer settings → **Personal access token** with
`read:packages` (classic) or a fine-grained token scoped to this repo's packages:
```sh
echo <TOKEN> | docker login ghcr.io -u anshace --password-stdin   # persists in ~/.docker/config.json
```

**Each deploy** (after CI is green — watch the Actions tab):
```sh
cd /opt/cortex
git pull                                                    # get compose/Caddyfile changes
docker compose -f docker-compose.prod.yml pull app          # fetch the new image from GHCR
DOMAIN=nexus.isroot.in docker compose -f docker-compose.prod.yml up -d --remove-orphans
docker image prune -f
```
No `--build`, so EC2 never compiles — the whole deploy is a ~30 s image pull. You
still need `.env` and `seed_users.json` present on the box (they're gitignored and
never baked into the image).

## Keeping a small (t3.micro) box healthy

The Rust build needs more RAM than a `t3.micro` (1 GB) has, so it swaps and
crawls. Two things make deploys fast and stop the disk filling:

**1. Add swap once** (turns a thrashing 20-min build into a few minutes):
```sh
sudo fallocate -l 4G /swapfile && sudo chmod 600 /swapfile
sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab   # persist across reboots
free -h   # confirm Swap shows 4Gi
```

**2. Build off-box (best), then just pull the image.** Build the image on your
laptop or CI where RAM is plentiful, then on EC2 only `docker pull` + `up` —
the tiny box never compiles. Either push to a private registry, or copy the
image directly with no registry:
```sh
# on a beefy machine:
docker build -t cortex:latest .
docker save cortex:latest | gzip | ssh ubuntu@<IP> 'gunzip | sudo docker load'
# then on EC2, point the compose `app` service at image: cortex:latest and `up -d` (no --build)
```

## `git pull` as root: SSH deploy key

The repo is root-owned under `/opt/cortex`, so `git pull` runs as **root** — but
the SSH deploy key usually lives in a non-root user's home, so root gets
`git@github.com: Permission denied (publickey)`. Point git at the key explicitly
(one-time, persists in the repo config):
```sh
sudo -i
# find the deploy key (commonly under the user you first cloned as):
ls -la /home/*/.ssh/
cd /opt/cortex
git config core.sshCommand "ssh -i /home/<user>/.ssh/<deploy_key> -o IdentitiesOnly=yes"
git pull
```
Alternatively copy the key to root and use it everywhere:
```sh
sudo mkdir -p /root/.ssh && sudo cp /home/<user>/.ssh/<deploy_key> /root/.ssh/deploy_key
sudo chmod 600 /root/.ssh/deploy_key
printf 'Host github.com\n  IdentityFile /root/.ssh/deploy_key\n  IdentitiesOnly yes\n' | sudo tee -a /root/.ssh/config
```
(Or switch the remote to HTTPS + a Personal Access Token: `git remote set-url origin https://github.com/anshace/cortex.git`.)

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
