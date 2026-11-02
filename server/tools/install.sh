#!/usr/bin/env bash
# Quriliş Go — one-command server install on a fresh Ubuntu 22.04 / 24.04 VPS (1 GB RAM is enough).
#
#   curl -fsSL https://raw.githubusercontent.com/usmonovm7777-crypto/Imorat/main/server/tools/install.sh -o install.sh
#   sudo bash install.sh --site imorat.uz --api api.imorat.uz --admin 998901234567 --bot 123456:ABC...
#
# What it does: installs Docker, clones the repository to /opt/imorat, writes server/.env with a random JWT secret,
# starts the API + Caddy (HTTPS certificates are automatic), serves the website from this server too, installs the
# `imorat` helper command, nightly backups and a cron job that refreshes the website from GitHub every 10 minutes.
# Safe to run again: an existing .env and database are kept.
set -euo pipefail
REPO_URL=${REPO_URL:-https://github.com/usmonovm7777-crypto/Imorat.git}
BRANCH=${BRANCH:-main}
REPO_DIR=${REPO_DIR:-/opt/imorat}; SRV=${SRV:-/srv/imorat}; SKIP_SYSTEM=${IMORAT_SKIP_SYSTEM:-0}   # overrides are for tests
SITE=""; API=""; ADMIN=""; BOT=""; OWNER=""; DRY=0
while [ $# -gt 0 ]; do case "$1" in
  --site) SITE=${2:-}; shift 2 ;; --api) API=${2:-}; shift 2 ;; --admin) ADMIN=${2:-}; shift 2 ;; --bot) BOT=${2:-}; shift 2 ;;
  --owner) OWNER=${2:-}; shift 2 ;; # a login for the owner's password sign-in to the panel; the password is asked for at the end (never passed on the command line)
  --repo) REPO_URL=$2; shift 2 ;; --branch) BRANCH=$2; shift 2 ;; --dry-run) DRY=1; shift ;;
  -h|--help) sed -n '2,10p' "$0"; exit 0 ;; *) echo "unknown option $1"; exit 1 ;; esac; done
red() { echo -e "\033[31m$*\033[0m"; } ; grn() { echo -e "\033[32m$*\033[0m"; } ; step() { echo -e "\n\033[1m▶ $*\033[0m"; }
[ "$(id -u)" = 0 ] || { red "Run as root: sudo bash install.sh …"; exit 1; }
[ -n "$SITE" ] || { read -r -p "Website domain (e.g. imorat.uz): " SITE; }
[ -n "$API" ] || API="api.$SITE"
[ -n "$ADMIN" ] || { read -r -p "Your phone, digits only, it becomes the moderator (e.g. 998901234567): " ADMIN; }
ADMIN=$(echo "$ADMIN" | tr -cd '0-9'); [ ${#ADMIN} -eq 12 ] || { red "The phone must be 12 digits starting with 998"; exit 1; }
if [ -z "$BOT" ]; then
  echo "Telegram bot token (from @BotFather). Until an SMS contract exists it is the only way to sign in, so it is required."
  read -r -p "Token: " BOT || true
fi
[ -n "$BOT" ] || { red "A Telegram bot token is required: without it nobody can sign in (SMS needs a contract with Eskiz). Create a bot in @BotFather and run again with --bot <token>."; exit 1; }
run() { if [ "$DRY" = 1 ]; then echo "  [dry-run] $*"; else "$@"; fi; }
sys() { if [ "$SKIP_SYSTEM" = 1 ]; then echo "  [skipped] $*"; else run "$@"; fi; }

step "1/7 Packages (git, curl, rsync, firewall, automatic security updates)"
export DEBIAN_FRONTEND=noninteractive
sys apt-get update -qq
sys apt-get install -y -qq git curl rsync ca-certificates ufw unattended-upgrades nano >/dev/null
sys dpkg-reconfigure -f noninteractive unattended-upgrades || true

step "2/7 Docker"
if [ "$SKIP_SYSTEM" = 1 ]; then echo "  [skipped] docker"; elif ! command -v docker >/dev/null 2>&1; then run sh -c "curl -fsSL https://get.docker.com | sh"; else echo "  docker is already installed"; fi
sys systemctl enable --now docker

step "3/7 Firewall: only SSH, HTTP and HTTPS stay open"
sys ufw allow OpenSSH >/dev/null; sys ufw allow 80/tcp >/dev/null; sys ufw allow 443/tcp >/dev/null; sys ufw --force enable >/dev/null || true
# a little swap keeps a 1 GB server comfortable while the image builds
if [ "$DRY" = 0 ] && [ "$SKIP_SYSTEM" = 0 ] && [ ! -f /swapfile ] && [ "$(free -m | awk '/Mem:/{print $2}')" -lt 2500 ]; then fallocate -l 1G /swapfile && chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile && echo '/swapfile none swap sw 0 0' >> /etc/fstab; fi

step "4/7 Code → $REPO_DIR"
if [ -d "$REPO_DIR/.git" ]; then run git -C "$REPO_DIR" fetch -q origin && run git -C "$REPO_DIR" reset -q --hard "origin/$BRANCH"; else run git clone -q -b "$BRANCH" "$REPO_URL" "$REPO_DIR"; fi

step "5/7 Settings → $REPO_DIR/server/.env"
ENV_FILE="$REPO_DIR/server/.env"
if [ -f "$ENV_FILE" ]; then
  echo "  .env already exists — kept as it is (edit later with: imorat env)"
else
  SECRET=$(openssl rand -hex 32 2>/dev/null || head -c 48 /dev/urandom | base64 | tr -dc 'a-zA-Z0-9' | head -c 64)
  setv() { # replace KEY=… (also a commented-out "# KEY=…") or append
    if grep -qE "^#? ?$1=" "$ENV_FILE"; then sed -i -E "s|^#? ?$1=.*|$1=$2|" "$ENV_FILE"; else printf '%s=%s\n' "$1" "$2" >> "$ENV_FILE"; fi; }
  if [ "$DRY" = 1 ]; then echo "  [dry-run] would write $ENV_FILE for $SITE / $API / admin $ADMIN / bot ${BOT:+set}"; else
    cp "$REPO_DIR/server/.env.example" "$ENV_FILE"; chmod 600 "$ENV_FILE"
    setv API_DOMAIN "$API"; setv PUBLIC_URL "https://$API"; setv JWT_SECRET "$SECRET"; setv ADMIN_PHONES "$ADMIN"
    setv ALLOWED_ORIGINS "https://$SITE,https://www.$SITE,https://usmonovm7777-crypto.github.io"
    setv SITE_URL "https://$SITE/"; setv DEMO_STORES 0; setv SITE_DOMAIN "$SITE"
    setv TELEGRAM_BOT_TOKEN "$BOT"; setv SMS_MODE telegram
    # "stage 0": no payment provider yet → buyers pay the store on receipt, the store delivers itself, Quriliş Go takes no
    # commission and holds no money. Once Payme/Click keys are set, card payment switches on and pay-at-store narrows to
    # pickup only by itself (set ALLOW_PAY_AT_STORE=0 to make the site card-only).
    setv ALLOW_PAY_AT_STORE 1
  fi
fi

step "6/7 Helper command, website copy, cron"
sys install -m 755 "$REPO_DIR/server/tools/imorat.sh" /usr/local/bin/imorat
run mkdir -p "$SRV/site" "$SRV/site-config"; sys mkdir -p /var/backups/imorat
if [ "$DRY" = 0 ]; then IMORAT_REPO_DIR="$REPO_DIR" IMORAT_SRV="$SRV" bash "$REPO_DIR/server/tools/imorat.sh" update-site --force --quiet; fi
sys sh -c "printf '%s\n' '*/10 * * * * root /usr/local/bin/imorat update-site --quiet >/dev/null 2>&1' '17 3 * * * root /usr/local/bin/imorat backup --quiet >/dev/null 2>&1' > /etc/cron.d/imorat"
sys chmod 644 /etc/cron.d/imorat

step "7/7 Start: API + Caddy (first build takes 1–2 minutes)"
if [ "$DRY" = 0 ] && [ "$SKIP_SYSTEM" = 0 ]; then (cd "$REPO_DIR/server" && docker compose -f docker-compose.yml -f docker-compose.site.yml up -d --build); sleep 6; fi

if [ -n "$OWNER" ] && [ "$DRY" = 0 ]; then
  step "Owner's password sign-in ($OWNER)"
  echo "  Type a password for the panel (10+ characters). It is not shown and is not saved anywhere: only its hash goes to .env."
  # the API was started in step 7 with no owner yet: `imorat owner` writes the hash to .env and restarts the API so the login works at once
  IMORAT_REPO_DIR="$REPO_DIR" bash "$REPO_DIR/server/tools/imorat.sh" owner --login "$OWNER" || red "  owner password not set — run later: imorat owner --login $OWNER"
fi

echo; grn "Done."; echo
if [ -z "$BOT" ]; then
  red "The API will keep restarting until a sign-in method is configured:"
  echo "  either a Telegram bot token —   imorat env   → TELEGRAM_BOT_TOKEN=…  (keep SMS_MODE=telegram)"
  echo "  or Eskiz SMS —                  imorat env   → ESKIZ_EMAIL / ESKIZ_PASSWORD and remove the SMS_MODE line"
fi
cat <<EOF
Next:
  1. DNS at your registrar — three A records pointing to this server's IP:  $SITE   www.$SITE   $API
     (HTTPS certificates appear by themselves within a minute after DNS works)
  2. Check everything:        imorat doctor
  3. Open https://$SITE — sign in with $ADMIN (or the owner login${OWNER:+ $OWNER} at https://$SITE/#owner), turn on the two-step code (authenticator app), and approve the first store.
  4. Keys as you get them:    imorat env   (Payme/Click, Eskiz, Yandex Delivery, Yandex Maps, Anthropic)
Everyday:  imorat status · imorat logs · imorat update · imorat backup       Guide: $REPO_DIR/DEPLOY.md
EOF
