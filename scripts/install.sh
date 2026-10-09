#!/usr/bin/env bash
# Crapplet DCIM installer and upgrader for Ubuntu 22.04/24.04 and Debian 12
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
# Re-running the same command upgrades in place: it pulls the latest code,
# rebuilds, applies database migrations and restarts the service. Secrets,
# the database and users are kept.
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
#   CDCIM_PREFIX        Install directory (default: /opt/crapplet-dcim)
#   CDCIM_DB_NAME / CDCIM_DB_USER   PostgreSQL database / role (default: crapplet_dcim / cdcim)
set -Eeuo pipefail

# Everything runs inside main(), which is only called on the last line, so bash has read
# the whole script before executing it (important for `curl … | bash`).
main() {

REPO="${CDCIM_REPO:-https://github.com/singhhemant80/DCIM.git}"
GH_TOKEN_VALUE="${CDCIM_GITHUB_TOKEN:-}"
BRANCH="${CDCIM_BRANCH:-main}"
SOURCE_DIR="${CDCIM_SOURCE_DIR:-}"
PREFIX="${CDCIM_PREFIX:-/opt/crapplet-dcim}"
APP_DIR="$PREFIX/app"
RUN_USER="${CDCIM_USER:-cdcim}"
DB_NAME="${CDCIM_DB_NAME:-crapplet_dcim}"
DB_USER="${CDCIM_DB_USER:-cdcim}"
PORT="${CDCIM_PORT:-8080}"
BIND="${CDCIM_BIND:-127.0.0.1}"
ENV_DIR=/etc/crapplet-dcim
ENV_FILE="$ENV_DIR/api.env"
STATE_DIR=/var/lib/crapplet-dcim
LOG_DIR=/var/log/crapplet-dcim
SERVICE=crapplet-dcim
NODE_MAJOR=22

c_blue=$'\033[1;34m'; c_green=$'\033[1;32m'; c_yellow=$'\033[1;33m'; c_red=$'\033[1;31m'; c_off=$'\033[0m'
step() { printf '\n%s==>%s %s\n' "$c_blue" "$c_off" "$*"; }
ok()   { printf '%s  ✓%s %s\n' "$c_green" "$c_off" "$*"; }
warn() { printf '%s  !%s %s\n' "$c_yellow" "$c_off" "$*"; }
die()  { printf '%s  ✗ %s%s\n' "$c_red" "$*" "$c_off" >&2; exit 1; }
trap 'die "Installation failed at line $LINENO. Fix the error above and run the same command again; it is safe to re-run."' ERR

git_auth() { # git with an in-memory auth header when a token is given (never stored in .git/config)
  # safe.directory: the checkout belongs to the service user while this script runs as root.
  if [ -n "$GH_TOKEN_VALUE" ]; then
    git -c safe.directory="$APP_DIR" -c http.extraHeader="Authorization: Basic $(printf 'x-access-token:%s' "$GH_TOKEN_VALUE" | base64 -w0)" "$@"
  else
    git -c safe.directory="$APP_DIR" "$@"
  fi
}
as_app() { runuser -u "$RUN_USER" -- env HOME="$PREFIX" npm_config_update_notifier=false "$@"; }
has_systemd() { [ -d /run/systemd/system ] && command -v systemctl >/dev/null 2>&1; }
svc() { # svc start|enable NAME
  if has_systemd; then systemctl enable --now "$2" >/dev/null 2>&1 || systemctl start "$2"; else service "$2" start >/dev/null 2>&1 || true; fi
}
psql_admin() { runuser -u postgres -- psql -v ON_ERROR_STOP=1 -qtAX "$@"; }
ask() { # ask VAR "Prompt" [default]  — reads from the terminal even when piped through curl | bash
  local __var=$1 __prompt=$2 __default=${3:-} __reply=''
  if [ -r /dev/tty ]; then
    read -r -p "$__prompt${__default:+ [$__default]}: " __reply </dev/tty || true
  fi
  printf -v "$__var" '%s' "${__reply:-$__default}"
}

# ---------------------------------------------------------------------------
step "Checking the system"
[ "$(id -u)" -eq 0 ] || die "Run as root, e.g.: curl -fsSL …/install.sh | sudo bash"
. /etc/os-release 2>/dev/null || die "Cannot read /etc/os-release"
case "${ID:-}:${ID_LIKE:-}" in
  ubuntu:*|debian:*|*:*debian*) ok "$PRETTY_NAME" ;;
  *) die "Unsupported OS ($PRETTY_NAME). Use Ubuntu 22.04/24.04 or Debian 12." ;;
esac
if grep -qi microsoft /proc/version 2>/dev/null; then ok "Running inside WSL"; fi
has_systemd && ok "systemd available: will install a service" || warn "No systemd: will use the 'crapplet-dcim' start/stop command instead"
UPGRADE=0; [ -f "$ENV_FILE" ] && UPGRADE=1 && ok "Existing installation found: upgrading"

# ---------------------------------------------------------------------------
step "Installing system packages (PostgreSQL, Redis, Git, build tools)"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq ca-certificates curl gnupg git openssl rsync postgresql redis-server >/dev/null
ok "Packages installed"

if ! command -v node >/dev/null 2>&1 || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt "$NODE_MAJOR" ]; then
  step "Installing Node.js $NODE_MAJOR"
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi
ok "Node.js $(node -v)"

svc enable postgresql
svc enable redis-server
for i in $(seq 1 30); do runuser -u postgres -- pg_isready -q && break; sleep 1; done
runuser -u postgres -- pg_isready -q || die "PostgreSQL did not start"
redis-cli ping >/dev/null 2>&1 || die "Redis did not start"
ok "PostgreSQL and Redis running"

# ---------------------------------------------------------------------------
step "Preparing user and directories"
id "$RUN_USER" >/dev/null 2>&1 || useradd --system --home-dir "$PREFIX" --shell /usr/sbin/nologin "$RUN_USER"
install -d -o "$RUN_USER" -g "$RUN_USER" -m 0750 "$PREFIX" "$STATE_DIR" "$LOG_DIR"
install -d -o root -g "$RUN_USER" -m 0750 "$ENV_DIR"
ok "User '$RUN_USER', $PREFIX"

step "Fetching Crapplet DCIM"
if [ -n "$SOURCE_DIR" ]; then
  rsync -a --delete --exclude node_modules --exclude 'dist' --exclude '.env' "$SOURCE_DIR"/ "$APP_DIR"/
  ok "Copied from $SOURCE_DIR"
elif [ -d "$APP_DIR/.git" ]; then
  git_auth -C "$APP_DIR" remote set-url origin "$REPO" 2>/dev/null || git_auth -C "$APP_DIR" remote add origin "$REPO"
  git_auth -C "$APP_DIR" fetch --quiet origin "$BRANCH" || die "Could not fetch from $REPO (private repository? set CDCIM_GITHUB_TOKEN)"
  git_auth -C "$APP_DIR" checkout --quiet -B "$BRANCH" "origin/$BRANCH"
  git_auth -C "$APP_DIR" reset --quiet --hard "origin/$BRANCH"
  ok "Updated to $(git_auth -C "$APP_DIR" rev-parse --short HEAD)"
else
  rm -rf "$APP_DIR"
  git_auth clone --quiet --branch "$BRANCH" --depth 1 "$REPO" "$APP_DIR" || die "Could not clone $REPO (private repository? set CDCIM_GITHUB_TOKEN to a read-only token)"
  ok "Cloned $(git_auth -C "$APP_DIR" rev-parse --short HEAD)"
fi
chown -R "$RUN_USER:$RUN_USER" "$APP_DIR"

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

  if [ "${CDCIM_INSECURE_HTTP:-0}" = "1" ]; then
    INSECURE=$'COOKIE_SECURE=false\nALLOW_INSECURE_HTTP=true'
    warn "Plain HTTP sign-in enabled (CDCIM_INSECURE_HTTP=1). Put HTTPS in front before real use."
  else
    INSECURE=''
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
WEB_ORIGIN=http://localhost:$PORT
WEB_DIST_DIR=$APP_DIR/apps/web/dist
TRUST_PROXY_HOPS=0
LOG_LEVEL=info
$INSECURE
EOF
  chown root:"$RUN_USER" "$ENV_FILE"; chmod 0640 "$ENV_FILE"
  ok "Database '$DB_NAME' and secrets created ($ENV_FILE)"
else
  ok "Keeping existing database and secrets"
fi

# ---------------------------------------------------------------------------
step "Building (this takes a few minutes the first time)"
as_app bash -c "cd '$APP_DIR' && npm ci --no-audit --no-fund --loglevel=error" >"$LOG_DIR/install-npm.log" 2>&1 || { tail -30 "$LOG_DIR/install-npm.log"; die "npm install failed (full log: $LOG_DIR/install-npm.log)"; }
as_app bash -c "cd '$APP_DIR' && npm run build" >"$LOG_DIR/install-build.log" 2>&1 || { tail -30 "$LOG_DIR/install-build.log"; die "Build failed (full log: $LOG_DIR/install-build.log)"; }
ok "Built"

run_cli() { as_app bash -c "set -a; . '$ENV_FILE'; set +a; cd '$APP_DIR/apps/api' && $*"; }

step "Applying database migrations"
run_cli "node dist/cli/migrate.js"

# ---------------------------------------------------------------------------
ADMIN_EMAIL=''; ADMIN_PASS=''
USERS="$(run_cli "node -e \"const {Pool}=require('pg');const p=new Pool({connectionString:process.env.DATABASE_URL});p.query('select count(*)::int n from users').then(r=>{console.log(r.rows[0].n);return p.end()})\"")"
if [ "$USERS" = "0" ]; then
  step "Creating the first administrator"
  ADMIN_EMAIL="${CDCIM_ADMIN_EMAIL:-}"
  [ -n "$ADMIN_EMAIL" ] || ask ADMIN_EMAIL "Administrator email"
  [ -n "$ADMIN_EMAIL" ] || die "An administrator email is required (set CDCIM_ADMIN_EMAIL=you@example.com)"
  ADMIN_NAME="${CDCIM_ADMIN_NAME:-}"
  [ -n "$ADMIN_NAME" ] || ask ADMIN_NAME "Administrator full name" "Administrator"
  ADMIN_PASS="$(openssl rand -base64 18 | tr -d '/+=' | cut -c1-20)-$(openssl rand -hex 3)"
  run_cli "CDCIM_ADMIN_PASSWORD='$ADMIN_PASS' node dist/cli/create-admin.js --email '$ADMIN_EMAIL' --name '${ADMIN_NAME//\'/}'" >/dev/null
  ok "Administrator $ADMIN_EMAIL created"
fi

# ---------------------------------------------------------------------------
step "Starting the service"
if has_systemd; then
  cat >/etc/systemd/system/$SERVICE.service <<EOF
[Unit]
Description=Crapplet DCIM
After=network-online.target postgresql.service redis-server.service
Wants=network-online.target

[Service]
Type=simple
User=$RUN_USER
Group=$RUN_USER
WorkingDirectory=$APP_DIR/apps/api
EnvironmentFile=$ENV_FILE
ExecStart=$(command -v node) dist/main.js
Restart=on-failure
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=$STATE_DIR $LOG_DIR
CapabilityBoundingSet=
LockPersonality=true
RestrictSUIDSGID=true

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
  systemctl enable "$SERVICE" >/dev/null 2>&1
  systemctl restart "$SERVICE"
  cat >/usr/local/bin/$SERVICE <<EOF
#!/usr/bin/env bash
# Convenience wrapper around systemd.
case "\${1:-}" in
  start|stop|restart|status) exec systemctl "\$1" $SERVICE ;;
  logs) exec journalctl -u $SERVICE -f ;;
  *) echo "Usage: $SERVICE {start|stop|restart|status|logs}"; exit 2 ;;
esac
EOF
  chmod 0755 /usr/local/bin/$SERVICE
  LOGS_CMD="sudo $SERVICE logs"
  CTL="sudo $SERVICE {start|stop|restart|status}"
else
  cat >/usr/local/bin/$SERVICE <<EOF
#!/usr/bin/env bash
# Start/stop helper for systems without systemd (e.g. WSL without systemd).
set -e
PID=$STATE_DIR/api.pid
case "\${1:-}" in
  start)
    service postgresql start >/dev/null 2>&1 || true
    service redis-server start >/dev/null 2>&1 || true
    if [ -f "\$PID" ] && kill -0 "\$(cat "\$PID")" 2>/dev/null; then echo "Already running"; exit 0; fi
    runuser -u $RUN_USER -- bash -c 'set -a; . $ENV_FILE; set +a; cd $APP_DIR/apps/api; nohup node dist/main.js >>$LOG_DIR/api.log 2>&1 & echo \$! > '"\$PID"
    echo "Started. Logs: $LOG_DIR/api.log" ;;
  stop) [ -f "\$PID" ] && kill "\$(cat "\$PID")" 2>/dev/null && rm -f "\$PID" && echo "Stopped" || echo "Not running" ;;
  restart) "\$0" stop || true; sleep 1; "\$0" start ;;
  status) [ -f "\$PID" ] && kill -0 "\$(cat "\$PID")" 2>/dev/null && echo "Running (pid \$(cat "\$PID"))" || { echo "Not running"; exit 3; } ;;
  logs) tail -f $LOG_DIR/api.log ;;
  *) echo "Usage: $SERVICE {start|stop|restart|status|logs}"; exit 2 ;;
esac
EOF
  chmod 0755 /usr/local/bin/$SERVICE
  /usr/local/bin/$SERVICE restart >/dev/null
  LOGS_CMD="sudo $SERVICE logs"
  CTL="sudo $SERVICE {start|stop|restart|status}"
fi

for i in $(seq 1 40); do
  curl -fsS "http://127.0.0.1:$PORT/api/v1/health/ready" >/dev/null 2>&1 && break
  sleep 1
done
curl -fsS "http://127.0.0.1:$PORT/api/v1/health/ready" >/dev/null 2>&1 || die "Service did not become ready. Check logs: $LOGS_CMD"
ok "Crapplet DCIM is running"

# ---------------------------------------------------------------------------
HOST_SHOWN=localhost; [ "$BIND" = "0.0.0.0" ] && HOST_SHOWN="$(hostname -I 2>/dev/null | awk '{print $1}')"
cat <<EOF

${c_green}Crapplet DCIM $( [ "$UPGRADE" -eq 1 ] && echo upgraded || echo installed ) successfully.${c_off}

  Open:        http://$HOST_SHOWN:$PORT
EOF
if [ -n "$ADMIN_PASS" ]; then cat <<EOF
  Sign in:     $ADMIN_EMAIL
  Password:    $ADMIN_PASS      (shown once: save it, then change it under Account)
EOF
fi
cat <<EOF

  Logs:        $LOGS_CMD
  Control:     $CTL
  Config:      $ENV_FILE
  Upgrade:     re-run the same install command

EOF
if [ "$BIND" != "127.0.0.1" ] && [ "${CDCIM_INSECURE_HTTP:-0}" != "1" ]; then
  warn "Listening on $BIND without HTTPS: browsers only allow sign-in on http://localhost."
  warn "For access by IP or domain, put nginx with TLS in front (deploy/nginx/crapplet-dcim.conf)."
fi

}

main "$@" </dev/null
