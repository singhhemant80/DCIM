#!/usr/bin/env bash
# NexoraDC installer and upgrader for Ubuntu 22.04/24.04 and Debian 12
# (including WSL2 on Windows).
#
# One-shot install from GitHub (public repository):
#   curl -fsSL https://raw.githubusercontent.com/singhhemant80/DCIM/main/scripts/install.sh | sudo bash
#
# Private repository: create a read-only token (GitHub > Settings > Developer settings >
# Fine-grained tokens, "Contents: Read-only" on this repo) and run:
#   export GH_TOKEN=github_pat_xxx
#   curl -fsSL -H "Authorization: token $GH_TOKEN" https://raw.githubusercontent.com/singhhemant80/DCIM/main/scripts/install.sh | sudo CDCIM_GITHUB_TOKEN=$GH_TOKEN bash
# The token is used only for this run and is never written to disk.
#
# Re-running the same command upgrades: the new release is built next to the
# running one, the database is backed up, migrations are applied, and the
# service is switched over. If the new release does not become healthy, the
# previous release (and, if migrations ran, the database backup) is put back
# automatically. `sudo crapplet-dcim rollback` does the same by hand later.
#
# Options (environment variables):
#   CDCIM_REPO          Git URL to install from (default: https://github.com/singhhemant80/DCIM.git)
#   CDCIM_GITHUB_TOKEN  Read-only GitHub token, needed only for a private repository
#   CDCIM_BRANCH        Branch or tag (default: main)
#   CDCIM_SOURCE_DIR    Install from a local checkout instead of git (for testing)
#   CDCIM_ADMIN_EMAIL   First administrator email (asked interactively if omitted)
#   CDCIM_ADMIN_NAME    First administrator name (default: Administrator)
#   CDCIM_PORT          Port for the web UI and API (default: 8080)
#   CDCIM_BIND          Listen address (default: 127.0.0.1; use 0.0.0.0 for LAN access)
#   CDCIM_INSECURE_HTTP Set to 1 to allow sign-in over plain http:// by IP (lab use only)
#   CDCIM_DOMAIN        Serve https://DOMAIN through nginx (the API then listens on loopback only)
#   CDCIM_TLS           With CDCIM_DOMAIN: letsencrypt (default; needs public DNS and port 80) or selfsigned
#   CDCIM_TLS_EMAIL     Contact email for Let's Encrypt
#   CDCIM_PREFIX        Install directory (default: /opt/crapplet-dcim)
#   CDCIM_DB_NAME / CDCIM_DB_USER   PostgreSQL database / role (default: crapplet_dcim / cdcim)
#   CDCIM_SKIP_BACKUP   Set to 1 to upgrade without the pre-upgrade backup (not recommended)
#   CDCIM_FAIL_HEALTH   Testing only: make the new release fail its health check (exercises automatic rollback)
set -Eeuo pipefail

# Everything runs inside main(), which is only called on the last line, so bash has read
# the whole script before executing it (important for `curl … | bash`).
main() {
cd /   # run from a directory every service account can read (avoids "could not change directory" noise)

REPO="${CDCIM_REPO:-https://github.com/singhhemant80/DCIM.git}"
GH_TOKEN_VALUE="${CDCIM_GITHUB_TOKEN:-}"
BRANCH="${CDCIM_BRANCH:-main}"
SOURCE_DIR="${CDCIM_SOURCE_DIR:-}"
PREFIX="${CDCIM_PREFIX:-/opt/crapplet-dcim}"
APP_DIR="$PREFIX/app"          # symlink to the current release
RELEASES="$PREFIX/releases"
RUN_USER="${CDCIM_USER:-cdcim}"
DB_NAME="${CDCIM_DB_NAME:-crapplet_dcim}"
DB_USER="${CDCIM_DB_USER:-cdcim}"
PORT="${CDCIM_PORT:-8080}"
BIND="${CDCIM_BIND:-127.0.0.1}"
DOMAIN="${CDCIM_DOMAIN:-}"
TLS_MODE="${CDCIM_TLS:-letsencrypt}"
ENV_DIR=/etc/crapplet-dcim
ENV_FILE="$ENV_DIR/api.env"
CONF_FILE="$ENV_DIR/install.conf"
BACKUP_KEY="$ENV_DIR/backup.key"
STATE_DIR=/var/lib/crapplet-dcim
ANCHOR_DIR=/var/lib/crapplet-dcim-anchors
BACKUP_DIR=/var/backups/crapplet-dcim
LOG_DIR=/var/log/crapplet-dcim
SERVICE=crapplet-dcim
NODE_MAJOR=22
STARTED=$(date +%s)

c_blue=$'\033[1;34m'; c_green=$'\033[1;32m'; c_yellow=$'\033[1;33m'; c_red=$'\033[1;31m'; c_off=$'\033[0m'
step() { printf '\n%s==>%s %s\n' "$c_blue" "$c_off" "$*"; }
ok()   { printf '%s  ✓%s %s\n' "$c_green" "$c_off" "$*"; }
warn() { printf '%s  !%s %s\n' "$c_yellow" "$c_off" "$*"; }
die()  { printf '%s  ✗ %s%s\n' "$c_red" "$*" "$c_off" >&2; exit 1; }
trap 'die "Installation failed at line $LINENO. Fix the error above and run the same command again; it is safe to re-run."' ERR

git_auth() { # git with an in-memory auth header when a token is given (never stored in .git/config)
  if [ -n "$GH_TOKEN_VALUE" ]; then
    git -c http.extraHeader="Authorization: Basic $(printf 'x-access-token:%s' "$GH_TOKEN_VALUE" | base64 -w0)" "$@"
  else
    git "$@"
  fi
}
has_systemd() { [ -d /run/systemd/system ] && command -v systemctl >/dev/null 2>&1; }
svc() { # svc start|enable NAME
  if has_systemd; then systemctl enable --now "$2" >/dev/null 2>&1 || systemctl start "$2"; else service "$2" start >/dev/null 2>&1 || true; fi
}
psql_admin() { runuser -u postgres -- psql -v ON_ERROR_STOP=1 -qtAX "$@"; }
ask() { # ask VAR "Prompt" [default]  — reads from the terminal even when piped through curl | bash
  local __var=$1 __prompt=$2 __default=${3:-} __reply=''
  if [ -r /dev/tty ]; then
    read -r -p "$__prompt${__default:+ [$__default]}: " __reply </dev/tty 2>/dev/null || true
  fi
  printf -v "$__var" '%s' "${__reply:-$__default}"
}
mb_free() { df -Pm "$1" 2>/dev/null | awk 'NR==2{print $4}'; }
port_in_use() { ss -Htln "sport = :$1" 2>/dev/null | grep -q .; }
health_ok() { curl -fsS "http://127.0.0.1:$PORT/api/v1/health/ready" >/dev/null 2>&1; }
wait_healthy() { for _ in $(seq 1 "$1"); do health_ok && return 0; sleep 1; done; return 1; }
migrations_applied() { psql_admin -d "$DB_NAME" -c 'select count(*) from drizzle.__drizzle_migrations' 2>/dev/null || echo 0; }

# ---------------------------------------------------------------------------
step "Checking the system"
[ "$(id -u)" -eq 0 ] || die "Run as root, e.g.: curl -fsSL …/install.sh | sudo bash"
. /etc/os-release 2>/dev/null || die "Cannot read /etc/os-release"
case "${ID:-}:${VERSION_ID:-}" in
  ubuntu:22.04|ubuntu:24.04|debian:12) ok "$PRETTY_NAME" ;;
  *) case "${ID:-}:${ID_LIKE:-}" in
       ubuntu:*|debian:*|*:*debian*) warn "$PRETTY_NAME is not a tested release (tested: Ubuntu 22.04/24.04, Debian 12); continuing" ;;
       *) die "Unsupported OS ($PRETTY_NAME). Use Ubuntu 22.04/24.04 or Debian 12." ;;
     esac ;;
esac
case "$(uname -m)" in x86_64|aarch64) ok "Architecture $(uname -m)" ;; *) die "Unsupported CPU architecture $(uname -m) (x86_64 or arm64 needed)" ;; esac
if grep -qi microsoft /proc/version 2>/dev/null; then ok "Running inside WSL"; fi
has_systemd && ok "systemd available: will install services and timers" || warn "No systemd: will use the 'crapplet-dcim' start/stop command; schedule backups with cron"
MEM_MB=$(awk '/MemTotal/{print int($2/1024)}' /proc/meminfo)
[ "$MEM_MB" -ge 1900 ] && ok "Memory ${MEM_MB} MB" || warn "Memory ${MEM_MB} MB: 2 GB or more is recommended (the first build may fail with less)"
mkdir -p "$PREFIX" /var/backups
for d in "$PREFIX" /var/lib /var/backups; do
  free=$(mb_free "$d"); [ "${free:-0}" -ge 3072 ] || die "Only ${free:-0} MB free for $d: at least 3 GB is needed (build, releases, backups)"
done
ok "Disk space: $(mb_free "$PREFIX") MB free"
UPGRADE=0; [ -f "$ENV_FILE" ] && UPGRADE=1
if [ "$UPGRADE" -eq 1 ]; then
  ok "Existing installation found: upgrading"
  # Keep the port and listen address of the running installation.
  PORT="$(sed -n 's/^PORT=//p' "$ENV_FILE" | tail -1)"; PORT="${PORT:-8080}"
  BIND="$(sed -n 's/^HOST=//p' "$ENV_FILE" | tail -1)"; BIND="${BIND:-127.0.0.1}"
elif command -v ss >/dev/null 2>&1 && port_in_use "$PORT"; then
  die "Port $PORT is already in use by another program. Choose another with CDCIM_PORT=8090"
fi
if [ -n "$DOMAIN" ]; then
  [[ "$DOMAIN" =~ ^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$ ]] || die "CDCIM_DOMAIN must be a host name, e.g. dcim.example.com"
  case "$TLS_MODE" in letsencrypt|selfsigned) ;; *) die "CDCIM_TLS must be letsencrypt or selfsigned" ;; esac
  BIND=127.0.0.1
fi

# ---------------------------------------------------------------------------
step "Installing system packages (PostgreSQL, Redis, Git, ipmitool)"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq || die "apt-get update failed: check the network and /etc/apt/sources.list*"
REDIS_POLICY="$(apt-cache policy redis-server 2>/dev/null || true)"   # captured first: grep -q in a pipe trips pipefail
if [ "${ID:-}" = ubuntu ] && ! grep -q 'Candidate: [0-9]' <<<"$REDIS_POLICY"; then
  # redis-server and ipmitool are in "universe", which minimal images leave out.
  warn "Enabling the Ubuntu 'universe' component (needed for redis-server and ipmitool)"
  if [ -f /etc/apt/sources.list.d/ubuntu.sources ]; then
    sed -i -E '/^Components:/ { /universe/! s/$/ universe/ }' /etc/apt/sources.list.d/ubuntu.sources
  else
    sed -i -E '/^deb .*ubuntu/ { / universe/! s/ main/ main universe/ }' /etc/apt/sources.list
  fi
  apt-get update -qq
fi
PKGS="ca-certificates curl gnupg git openssl rsync postgresql redis-server ipmitool iputils-ping iproute2 unattended-upgrades"
[ -n "$DOMAIN" ] && PKGS="$PKGS nginx" && [ "$TLS_MODE" = letsencrypt ] && PKGS="$PKGS certbot"
# shellcheck disable=SC2086
apt-get install -y -qq $PKGS >/dev/null || die "Package installation failed (see the apt messages above)"
ok "Packages installed"

if ! command -v node >/dev/null 2>&1 || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt "$NODE_MAJOR" ]; then
  step "Installing Node.js $NODE_MAJOR"
  curl -fsSL --max-time 60 "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" -o /tmp/nodesource_setup.sh || die "Cannot reach deb.nodesource.com to install Node.js $NODE_MAJOR. Allow it through the firewall/proxy, or install Node.js $NODE_MAJOR yourself and re-run."
  bash /tmp/nodesource_setup.sh >/dev/null && rm -f /tmp/nodesource_setup.sh
  apt-get install -y -qq nodejs >/dev/null
fi
NODE_BIN="$(command -v node)"
ok "Node.js $(node -v)"

svc enable postgresql
svc enable redis-server
for _ in $(seq 1 30); do runuser -u postgres -- pg_isready -q && break; sleep 1; done
runuser -u postgres -- pg_isready -q || die "PostgreSQL did not start"
for _ in $(seq 1 10); do redis-cli ping >/dev/null 2>&1 && break; sleep 1; done
redis-cli ping >/dev/null 2>&1 || die "Redis did not start"
ok "PostgreSQL $(runuser -u postgres -- psql -qtAX -c 'show server_version' | cut -d' ' -f1) and Redis running"

# ---------------------------------------------------------------------------
step "Preparing user and directories"
id "$RUN_USER" >/dev/null 2>&1 || useradd --system --home-dir "$PREFIX" --shell /usr/sbin/nologin "$RUN_USER"
install -d -o root -g root -m 0755 "$PREFIX" "$RELEASES" "$PREFIX/bin"
install -d -o "$RUN_USER" -g "$RUN_USER" -m 0750 "$STATE_DIR" "$LOG_DIR" "$PREFIX/.npm" "$PREFIX/build"
install -d -o root -g "$RUN_USER" -m 0750 "$ENV_DIR"
install -d -o root -g root -m 0700 "$BACKUP_DIR" "$ANCHOR_DIR"
# Installs before the release layout kept a single checkout in $APP_DIR: keep it as the first release.
if [ -d "$APP_DIR" ] && [ ! -L "$APP_DIR" ]; then
  legacy="legacy-$(git -c safe.directory='*' -C "$APP_DIR" rev-parse --short HEAD 2>/dev/null || date +%s)"
  mv "$APP_DIR" "$RELEASES/$legacy" && ln -s "$RELEASES/$legacy" "$APP_DIR"
  chown -R root:root "$RELEASES/$legacy"
  ok "Kept the existing installation as release $legacy"
fi
PREV_RELEASE=""; [ -L "$APP_DIR" ] && PREV_RELEASE="$(basename "$(readlink -f "$APP_DIR")")"
if [ ! -s "$BACKUP_KEY" ]; then
  (umask 077; openssl rand -base64 32 >"$BACKUP_KEY")
  NEW_BACKUP_KEY=1
fi
chmod 0600 "$BACKUP_KEY"; chown root:root "$BACKUP_KEY"
ok "User '$RUN_USER', $PREFIX"

# ---------------------------------------------------------------------------
step "Fetching NexoraDC"
BUILD="$PREFIX/build/src"
rm -rf "$BUILD"
if [ -n "$SOURCE_DIR" ]; then
  rsync -a --exclude node_modules --exclude 'dist' --exclude '.env' --exclude .git "$SOURCE_DIR"/ "$BUILD"/
  COMMIT="$(git -c safe.directory='*' -C "$SOURCE_DIR" rev-parse --short HEAD 2>/dev/null || echo local)"
  ok "Copied from $SOURCE_DIR ($COMMIT)"
else
  git_auth clone --quiet --branch "$BRANCH" --depth 1 "$REPO" "$BUILD" || die "Could not clone $REPO (no network to GitHub, or a private repository: set CDCIM_GITHUB_TOKEN to a read-only token)"
  COMMIT="$(git -C "$BUILD" rev-parse --short HEAD)"
  rm -rf "$BUILD/.git"
  ok "Fetched $BRANCH at $COMMIT"
fi
NEW_RELEASE="$(date -u +%Y%m%d-%H%M%S)-$COMMIT"
chown -R "$RUN_USER:$RUN_USER" "$PREFIX/build"

# ---------------------------------------------------------------------------
step "Building release $NEW_RELEASE (the running service is not touched; a few minutes the first time)"
as_build() { runuser -u "$RUN_USER" -- env HOME="$PREFIX" npm_config_cache="$PREFIX/.npm" npm_config_update_notifier=false bash -c "cd '$BUILD' && $1"; }
as_build "npm ci --no-audit --no-fund --loglevel=error" >"$LOG_DIR/install-npm.log" 2>&1 || { tail -30 "$LOG_DIR/install-npm.log"; die "npm install failed (full log: $LOG_DIR/install-npm.log)"; }
as_build "npm run build" >"$LOG_DIR/install-build.log" 2>&1 || { tail -30 "$LOG_DIR/install-build.log"; die "Build failed (full log: $LOG_DIR/install-build.log). The running installation was not changed."; }
as_build "npm prune --omit=dev --no-audit --no-fund --loglevel=error" >>"$LOG_DIR/install-npm.log" 2>&1 || warn "Could not remove build-only packages (harmless)"
# Releases belong to root: the service account can run the code but not change it.
mv "$BUILD" "$RELEASES/$NEW_RELEASE"
chown -R root:root "$RELEASES/$NEW_RELEASE"
chmod -R a+rX,go-w "$RELEASES/$NEW_RELEASE"   # readable by the service account whatever the source permissions were
NEW="$RELEASES/$NEW_RELEASE"
ok "Built"

# ---------------------------------------------------------------------------
# nginx with TLS in front (CDCIM_DOMAIN). Done before the configuration is switched to loopback,
# so a problem here stops the run while the service is still reachable as before.
setup_nginx() {
  step "Configuring nginx and TLS for https://$DOMAIN"
  local conf=/etc/nginx/sites-available/crapplet-dcim.conf live="/etc/letsencrypt/live/$DOMAIN"
  CERT=/etc/ssl/certs/crapplet-dcim.pem; KEY=/etc/ssl/private/crapplet-dcim.key
  [ "$TLS_MODE" = letsencrypt ] && [ -s "$live/fullchain.pem" ] && CERT="$live/fullchain.pem" && KEY="$live/privkey.pem"
  if [ ! -s "$CERT" ]; then
    # Self-signed (selfsigned mode, or until Let's Encrypt has issued one).
    openssl req -x509 -newkey rsa:2048 -nodes -days 825 -subj "/CN=$DOMAIN" -addext "subjectAltName=DNS:$DOMAIN" -keyout "$KEY" -out "$CERT" >/dev/null 2>&1
    chmod 0600 "$KEY"
  fi
  install -d -m 0755 /var/www/letsencrypt
  sed -e "s/dcim\.example\.com/$DOMAIN/g" -e "s#127\.0\.0\.1:8080#127.0.0.1:$PORT#g" -e "s#/opt/crapplet-dcim/app#$APP_DIR#g" \
      -e "s#ssl_certificate .*#ssl_certificate     $CERT;#" -e "s#ssl_certificate_key .*#ssl_certificate_key $KEY;#" \
      "$NEW/deploy/nginx/crapplet-dcim.conf" >"$conf"
  # The CSP allows the one inline theme script by its hash: recompute it for this build.
  CSP_HASH="$(node -e 'const h=require("fs").readFileSync(process.argv[1],"utf8");const m=/<script>([\s\S]*?)<\/script>/.exec(h);if(m)console.log("sha256-"+require("crypto").createHash("sha256").update(m[1]).digest("base64"))' "$NEW/apps/web/dist/index.html")"
  [ -n "$CSP_HASH" ] && sed -i "s#'sha256-[A-Za-z0-9+/=]*'#'$CSP_HASH'#" "$conf"
  # Hosts with IPv6 switched off cannot open [::] sockets.
  [ -s /proc/net/if_inet6 ] || sed -i '/listen \[::\]/d' "$conf"
  ln -sfn "$conf" /etc/nginx/sites-enabled/crapplet-dcim.conf
  rm -f /etc/nginx/sites-enabled/default
  if ! nginx -t >/dev/null 2>&1; then
    nginx -t || true
    rm -f /etc/nginx/sites-enabled/crapplet-dcim.conf
    die "nginx configuration test failed; nothing else was changed"
  fi
  svc enable nginx; (has_systemd && systemctl reload nginx) || service nginx reload >/dev/null 2>&1 || true
  if [ "$TLS_MODE" = letsencrypt ] && [ "$CERT" != "$live/fullchain.pem" ]; then
    if certbot certonly --webroot -w /var/www/letsencrypt -n --agree-tos ${CDCIM_TLS_EMAIL:+-m "$CDCIM_TLS_EMAIL"} ${CDCIM_TLS_EMAIL:---register-unsafely-without-email} \
         -d "$DOMAIN" --deploy-hook "systemctl reload nginx" >"$LOG_DIR/certbot.log" 2>&1; then
      sed -i -e "s#ssl_certificate .*#ssl_certificate     $live/fullchain.pem;#" -e "s#ssl_certificate_key .*#ssl_certificate_key $live/privkey.pem;#" "$conf"
      nginx -t >/dev/null 2>&1 && { (has_systemd && systemctl reload nginx) || service nginx reload >/dev/null 2>&1 || true; }
      ok "Let's Encrypt certificate installed (renewed automatically by the certbot timer)"
    else
      warn "Let's Encrypt could not issue a certificate (DNS for $DOMAIN must point here and port 80 be reachable); a self-signed one is in use. Details: $LOG_DIR/certbot.log. Re-run the installer to try again."
    fi
  fi
  ok "nginx serves https://$DOMAIN"
}
[ -n "$DOMAIN" ] && setup_nginx

# ---------------------------------------------------------------------------
step "Configuring database and secrets"
if [ "$UPGRADE" -eq 0 ]; then
  DB_PASS="$(openssl rand -hex 24)"
  if [ "$(psql_admin -c "SELECT 1 FROM pg_roles WHERE rolname='$DB_USER'")" = "1" ]; then
    psql_admin -c "ALTER ROLE \"$DB_USER\" LOGIN PASSWORD '$DB_PASS'"
  else
    psql_admin -c "CREATE ROLE \"$DB_USER\" LOGIN PASSWORD '$DB_PASS'"
  fi
  [ "$(psql_admin -c "SELECT 1 FROM pg_database WHERE datname='$DB_NAME'")" = "1" ] || psql_admin -c "CREATE DATABASE \"$DB_NAME\" OWNER \"$DB_USER\""

  if [ -n "$DOMAIN" ]; then
    ORIGIN="https://$DOMAIN"; HOPS=1; INSECURE=''
  else
    ORIGIN="http://localhost:$PORT"; HOPS=0
    if [ "${CDCIM_INSECURE_HTTP:-0}" = "1" ]; then
      INSECURE=$'COOKIE_SECURE=false\nALLOW_INSECURE_HTTP=true'
      warn "Plain HTTP sign-in enabled (CDCIM_INSECURE_HTTP=1). Put HTTPS in front before real use."
    else
      INSECURE=''
    fi
  fi
  umask 027
  cat >"$ENV_FILE" <<EOF
# Generated by scripts/install.sh on $(date -u +%FT%TZ). Keep this file secret.
NODE_ENV=production
HOST=$BIND
PORT=$PORT
DATABASE_URL=postgres://$DB_USER:$DB_PASS@127.0.0.1:5432/$DB_NAME
REDIS_URL=redis://127.0.0.1:6379
CDCIM_ENCRYPTION_KEYS=k$(date +%Y%m):$(openssl rand -base64 32)
WEB_ORIGIN=$ORIGIN
WEB_DIST_DIR=$APP_DIR/apps/web/dist
TRUST_PROXY_HOPS=$HOPS
LOG_LEVEL=info
# Provisioning (OS installs): the address installing servers use to reach DCIM,
# and the networks allowed to use the boot endpoints (default: private ranges).
# CDCIM_PUBLIC_URL=http://10.0.0.5:$PORT
# CDCIM_BOOT_ALLOW=10.0.0.0/8,172.16.0.0/12,192.168.0.0/16
# Networks the worker may reach with stored device/BMC credentials (your management networks):
# CDCIM_DEVICE_ALLOW=10.10.0.0/16
$INSECURE
EOF
  umask 022
  chown root:"$RUN_USER" "$ENV_FILE"; chmod 0640 "$ENV_FILE"
  ok "Database '$DB_NAME' and secrets created ($ENV_FILE)"
else
  chown root:"$RUN_USER" "$ENV_FILE"; chmod 0640 "$ENV_FILE"
  # Older installs pointed WEB_DIST_DIR into the checkout; it now follows the current release.
  sed -i "s#^WEB_DIST_DIR=.*#WEB_DIST_DIR=$APP_DIR/apps/web/dist#" "$ENV_FILE"
  if [ -n "$DOMAIN" ]; then
    # Moving an existing install behind nginx with TLS: loopback only, secure cookies, one proxy hop.
    sed -i -e "s#^HOST=.*#HOST=127.0.0.1#" -e "s#^WEB_ORIGIN=.*#WEB_ORIGIN=https://$DOMAIN#" -e "s#^TRUST_PROXY_HOPS=.*#TRUST_PROXY_HOPS=1#" \
           -e '/^COOKIE_SECURE=false$/d' -e '/^ALLOW_INSECURE_HTTP=true$/d' "$ENV_FILE"
    ok "Configuration switched to https://$DOMAIN (the service now listens on 127.0.0.1:$PORT only)"
  fi
  ok "Keeping existing database and secrets"
fi

cat >"$CONF_FILE" <<EOF
# Written by scripts/install.sh; read by /usr/local/bin/$SERVICE.
PREFIX=$PREFIX
RUN_USER=$RUN_USER
SERVICE=$SERVICE
ENV_FILE=$ENV_FILE
STATE_DIR=$STATE_DIR
BACKUP_DIR=$BACKUP_DIR
ANCHOR_DIR=$ANCHOR_DIR
BACKUP_KEY=$BACKUP_KEY
KEEP_BACKUPS=14
EOF
chmod 0644 "$CONF_FILE"
install -m 0755 "$NEW/scripts/crapplet-dcim" /usr/local/bin/$SERVICE

run_cli() { runuser -u "$RUN_USER" -- bash -c "set -a; . '$ENV_FILE'; set +a; cd '$1/apps/api' && $2"; }

# ---------------------------------------------------------------------------
service_units() {
  if has_systemd; then
    local hardening="NoNewPrivileges=true
PrivateTmp=true
PrivateDevices=true
ProtectSystem=strict
ProtectHome=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectKernelLogs=true
ProtectControlGroups=true
ProtectClock=true
ProtectHostname=true
RestrictNamespaces=true
RestrictRealtime=true
RestrictSUIDSGID=true
LockPersonality=true
SystemCallArchitectures=native
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 AF_NETLINK
CapabilityBoundingSet=
AmbientCapabilities=
UMask=0027
ReadWritePaths=$STATE_DIR $LOG_DIR"
    cat >/etc/systemd/system/$SERVICE.service <<EOF
[Unit]
Description=NexoraDC
After=network-online.target postgresql.service redis-server.service
Wants=network-online.target

[Service]
Type=simple
User=$RUN_USER
Group=$RUN_USER
WorkingDirectory=$APP_DIR/apps/api
EnvironmentFile=$ENV_FILE
ExecStart=$NODE_BIN dist/main.js
Restart=on-failure
RestartSec=3
$hardening
MemoryMax=1G

[Install]
WantedBy=multi-user.target
EOF
    # Background worker: the only process that decrypts credentials and talks to devices.
    cat >/etc/systemd/system/$SERVICE-worker.service <<EOF
[Unit]
Description=NexoraDC worker (polling, alerts, power, BMC reads, provisioning, consoles)
After=network-online.target postgresql.service redis-server.service
Wants=network-online.target

[Service]
Type=simple
User=$RUN_USER
Group=$RUN_USER
WorkingDirectory=$APP_DIR/apps/api
EnvironmentFile=$ENV_FILE
ExecStart=$NODE_BIN dist/worker/main.js
Restart=on-failure
RestartSec=5
$hardening
MemoryMax=768M

[Install]
WantedBy=multi-user.target
EOF
    for job in backup anchor; do
      cat >/etc/systemd/system/$SERVICE-$job.service <<EOF
[Unit]
Description=NexoraDC $job
After=postgresql.service

[Service]
Type=oneshot
ExecStart=/usr/local/bin/$SERVICE $job
EOF
    done
    cat >/etc/systemd/system/$SERVICE-backup.timer <<EOF
[Unit]
Description=Daily NexoraDC backup

[Timer]
OnCalendar=*-*-* 02:15:00
RandomizedDelaySec=30m
Persistent=true

[Install]
WantedBy=timers.target
EOF
    cat >/etc/systemd/system/$SERVICE-anchor.timer <<EOF
[Unit]
Description=Daily NexoraDC audit log anchor

[Timer]
OnCalendar=*-*-* 01:45:00
RandomizedDelaySec=15m
Persistent=true

[Install]
WantedBy=timers.target
EOF
    systemctl daemon-reload
    systemctl enable "$SERVICE" "$SERVICE-worker" >/dev/null 2>&1
    systemctl enable --now "$SERVICE-backup.timer" "$SERVICE-anchor.timer" >/dev/null 2>&1
  else
    cat >"$PREFIX/bin/nosystemd" <<EOF
#!/usr/bin/env bash
# Start/stop helper for systems without systemd (e.g. WSL without systemd).
set -e
PID=$STATE_DIR/api.pid
WPID=$STATE_DIR/worker.pid
running() { [ -f "\$1" ] && kill -0 "\$(cat "\$1")" 2>/dev/null; }
case "\${1:-}" in
  start)
    service postgresql start >/dev/null 2>&1 || true
    service redis-server start >/dev/null 2>&1 || true
    if running "\$PID"; then echo "API already running"; else
      runuser -u $RUN_USER -- bash -c 'set -a; . $ENV_FILE; set +a; cd $APP_DIR/apps/api; nohup $NODE_BIN dist/main.js >>$LOG_DIR/api.log 2>&1 & echo \$! > '"\$PID"
    fi
    if running "\$WPID"; then echo "Worker already running"; else
      runuser -u $RUN_USER -- bash -c 'set -a; . $ENV_FILE; set +a; cd $APP_DIR/apps/api; nohup $NODE_BIN dist/worker/main.js >>$LOG_DIR/worker.log 2>&1 & echo \$! > '"\$WPID"
    fi ;;
  stop)
    for f in "\$PID" "\$WPID"; do running "\$f" && kill "\$(cat "\$f")" 2>/dev/null; rm -f "\$f"; done ;;
  restart) "\$0" stop || true; sleep 1; "\$0" start ;;
  status)
    running "\$PID" && echo "API running (pid \$(cat "\$PID"))" || echo "API not running"
    running "\$WPID" && echo "Worker running (pid \$(cat "\$WPID"))" || echo "Worker not running"
    running "\$PID" ;;
  *) echo "Usage: nosystemd {start|stop|restart|status}"; exit 2 ;;
esac
EOF
    chmod 0755 "$PREFIX/bin/nosystemd"
  fi
}
restart_services() { if has_systemd; then systemctl restart "$SERVICE" "$SERVICE-worker"; else "$PREFIX/bin/nosystemd" restart >/dev/null; fi; }
switch_to() { ln -sfn "$1" "$APP_DIR.next" && mv -T "$APP_DIR.next" "$APP_DIR"; }

# ---------------------------------------------------------------------------
BACKUP_FILE=""
MIG_BEFORE="$(migrations_applied)"
if [ "$UPGRADE" -eq 1 ] && [ "${CDCIM_SKIP_BACKUP:-0}" != "1" ]; then
  step "Backing up before the upgrade"
  BACKUP_FILE="$(/usr/local/bin/$SERVICE backup --tag pre-upgrade)" || die "The pre-upgrade backup failed; nothing was changed. (CDCIM_SKIP_BACKUP=1 skips it, not recommended)"
  ok "$BACKUP_FILE"
fi

step "Applying database migrations"
run_cli "$NEW" "node dist/cli/migrate.js" || {
  [ -n "$BACKUP_FILE" ] && warn "Migrations failed; the database backup from before the upgrade is $BACKUP_FILE"
  rm -rf "$NEW"
  die "Database migrations failed; the running release ($PREV_RELEASE) was not switched."
}
MIG_AFTER="$(migrations_applied)"
ok "Database schema: $MIG_AFTER migrations"

ADMIN_EMAIL=''; ADMIN_PASS=''
USERS="$(run_cli "$NEW" "node -e \"const {Pool}=require('pg');const p=new Pool({connectionString:process.env.DATABASE_URL});p.query('select count(*)::int n from users').then(r=>{console.log(r.rows[0].n);return p.end()})\"")"
if [ "$USERS" = "0" ]; then
  step "Creating the first administrator"
  ADMIN_EMAIL="${CDCIM_ADMIN_EMAIL:-}"
  [ -n "$ADMIN_EMAIL" ] || ask ADMIN_EMAIL "Administrator email"
  [ -n "$ADMIN_EMAIL" ] || die "An administrator email is required (set CDCIM_ADMIN_EMAIL=you@example.com)"
  [[ "$ADMIN_EMAIL" =~ ^[^[:space:]\'\"@]+@[^[:space:]\'\"@]+$ ]] || die "That does not look like an email address: $ADMIN_EMAIL"
  ADMIN_NAME="${CDCIM_ADMIN_NAME:-}"
  [ -n "$ADMIN_NAME" ] || ask ADMIN_NAME "Administrator full name" "Administrator"
  ADMIN_PASS="$(openssl rand -base64 18 | tr -d '/+=' | cut -c1-20)-$(openssl rand -hex 3)"
  run_cli "$NEW" "CDCIM_ADMIN_PASSWORD='$ADMIN_PASS' node dist/cli/create-admin.js --email '$ADMIN_EMAIL' --name '${ADMIN_NAME//\'/}'" >/dev/null
  ok "Administrator $ADMIN_EMAIL created"
fi

# ---------------------------------------------------------------------------
step "Starting release $NEW_RELEASE"
service_units
switch_to "$NEW"
# Testing only: a release whose API cannot start, to exercise the automatic rollback.
[ "${CDCIM_FAIL_HEALTH:-0}" = "1" ] && rm -f "$NEW/apps/api/dist/main.js"
restart_services
if ! wait_healthy 60; then
  if [ -n "$PREV_RELEASE" ] && [ -d "$RELEASES/$PREV_RELEASE" ]; then
    warn "Release $NEW_RELEASE did not become healthy: rolling back to $PREV_RELEASE"
    switch_to "$RELEASES/$PREV_RELEASE"
    if [ "$MIG_AFTER" != "$MIG_BEFORE" ] && [ -n "$BACKUP_FILE" ]; then
      warn "Restoring the database from $BACKUP_FILE (the upgrade changed the schema)"
      /usr/local/bin/$SERVICE restore "$BACKUP_FILE" --yes --keep-config >"$LOG_DIR/rollback-restore.log" 2>&1 || die "Rollback restore failed; see $LOG_DIR/rollback-restore.log"
    else
      restart_services
    fi
    wait_healthy 60 && ok "Rolled back: $PREV_RELEASE is running again" || warn "The previous release did not come back either; check: sudo $SERVICE logs"
    printf '%s\tauto-rollback\t%s\t%s\n' "$(date -u +%FT%TZ)" "$PREV_RELEASE" "$NEW_RELEASE" >>"$STATE_DIR/rollbacks.log"
    die "Upgrade to $NEW_RELEASE failed its health check and was rolled back. Logs: journalctl -u $SERVICE -n 100"
  fi
  die "Service did not become ready. Check logs: sudo $SERVICE logs"
fi
ok "NexoraDC $NEW_RELEASE is running"
[ -n "$PREV_RELEASE" ] && [ "$PREV_RELEASE" != "$NEW_RELEASE" ] && printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$(date -u +%FT%TZ)" "$NEW_RELEASE" "$PREV_RELEASE" "$BACKUP_FILE" "$MIG_BEFORE" "$MIG_AFTER" >>"$STATE_DIR/deploys.log"
# Keep the current and two previous releases (for rollback).
{ ls -1dt "$RELEASES"/*/ 2>/dev/null | tail -n +4 | while read -r old; do [ "$(readlink -f "$APP_DIR")/" != "$old" ] && rm -rf "$old"; done; } || true

# First anchor and backup (new installs, and installs from before Phase 9), so the checks below start green.
[ -s "$ANCHOR_DIR/anchors.jsonl" ] || /usr/local/bin/$SERVICE anchor >/dev/null 2>&1 || true
if ! ls "$BACKUP_DIR"/*.cdcim-backup 2>/dev/null | grep -qv -- '-pre-'; then
  /usr/local/bin/$SERVICE backup --tag initial >/dev/null 2>&1 || warn "The first backup failed: run sudo $SERVICE backup"
fi

# ---------------------------------------------------------------------------
step "Checking the installation"
sleep 2
if /usr/local/bin/$SERVICE doctor >"$LOG_DIR/doctor.log" 2>&1; then
  if grep -q '^WARN' "$LOG_DIR/doctor.log"; then
    ok "No failures. Recommendations:"
    grep -E '^WARN|fix:' "$LOG_DIR/doctor.log" | sed 's/^/    /' | head -30
  else
    ok "All checks passed ($LOG_DIR/doctor.log)"
  fi
else
  grep -E '^(FAIL|WARN)|fix:' "$LOG_DIR/doctor.log" | sed 's/^/    /' | head -30
  warn "Some checks failed (above). Re-run any time: sudo $SERVICE doctor"
fi

HOST_SHOWN=localhost; [ "$BIND" = "0.0.0.0" ] && HOST_SHOWN="$(hostname -I 2>/dev/null | awk '{print $1}')"
URL="http://$HOST_SHOWN:$PORT"; [ -n "$DOMAIN" ] && URL="https://$DOMAIN"
cat <<EOF

${c_green}NexoraDC $( [ "$UPGRADE" -eq 1 ] && echo upgraded || echo installed ) successfully: release $NEW_RELEASE ($(( $(date +%s) - STARTED )) s).${c_off}

  Open:        $URL
EOF
if [ -n "$ADMIN_PASS" ]; then cat <<EOF
  Sign in:     $ADMIN_EMAIL
  Password:    $ADMIN_PASS      (shown once: save it, then change it and enable MFA under Account)
EOF
fi
cat <<EOF

  Check:       sudo $SERVICE doctor
  Logs:        sudo $SERVICE logs
  Control:     sudo $SERVICE {start|stop|restart|status}
  Backups:     sudo $SERVICE backup | backups | restore FILE   (daily at 02:15 into $BACKUP_DIR)
  Roll back:   sudo $SERVICE rollback
  Config:      $ENV_FILE
  Upgrade:     re-run the same install command

EOF
if [ "${NEW_BACKUP_KEY:-0}" = "1" ]; then
  warn "Backups are encrypted with $BACKUP_KEY. Copy that key somewhere safe OFF this server now:"
  warn "  sudo cat $BACKUP_KEY      — without it no backup can be restored."
fi
if [ -z "$DOMAIN" ] && [ "$BIND" != "127.0.0.1" ] && [ "${CDCIM_INSECURE_HTTP:-0}" != "1" ]; then
  warn "Listening on $BIND without HTTPS: browsers only allow sign-in on http://localhost."
  warn "Re-run with CDCIM_DOMAIN=dcim.example.com to put nginx with TLS in front."
fi

}

main "$@" </dev/null
