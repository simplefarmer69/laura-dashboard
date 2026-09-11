#!/usr/bin/env bash
# LAURA PC daemon kit — runs LAURA around the clock on a machine you own,
# self-updates from GitHub main, and gives the Cursor agent a co-pilot surface.
#
#   laura-daemon.sh install    one-time setup (clone, build, PM2 apps, boot persistence hint)
#   laura-daemon.sh build      build the newest github main release without switching to it
#   laura-daemon.sh update     fetch github main; if new: build a fresh release, switch at a
#                              quiet moment (no cycle or forum round), verify health, roll back on failure
#   laura-daemon.sh updater    loop: `update` every UPDATE_EVERY_SEC (default 300) or as soon
#                              as data/ops/update.requested appears
#   laura-daemon.sh watchdog   loop: probe /api/health; after 3 misses `pm2 restart laura`
#   laura-daemon.sh status     one-screen summary
#
# Layout under LAURA_HOME (default ~/laura):
#   repo/        git clone tracking github main (never run from here)
#   releases/<sha>/  built copies (blue/green); `current` -> the live one
#   current      symlink PM2 runs from
#   data/        SWARM_DATA_DIR — state, archive, backups, logs (never inside a release)
#   shared/.env.local   secrets; symlinked into every release
#
# Linux, macOS and Windows via WSL2. Requires: bash, git, node >= 22, npm, curl.

set -euo pipefail

LAURA_HOME="${LAURA_HOME:-$HOME/laura}"
REPO_URL="${LAURA_REPO_URL:-https://github.com/simplefarmer69/laura-dashboard.git}"
BRANCH="${LAURA_BRANCH:-main}"
PORT="${PORT:-4747}"
UPDATE_EVERY_SEC="${UPDATE_EVERY_SEC:-300}"
QUIET_WAIT_MAX_SEC="${QUIET_WAIT_MAX_SEC:-2700}"   # 45 min: longer than any observed cycle
KEEP_RELEASES="${KEEP_RELEASES:-3}"

REPO="$LAURA_HOME/repo"
RELEASES="$LAURA_HOME/releases"
CURRENT="$LAURA_HOME/current"
DATA="$LAURA_HOME/data"
SHARED="$LAURA_HOME/shared"
LOG="$DATA/daemon.log"
HEALTH="http://127.0.0.1:$PORT/api/health"

log() { mkdir -p "$DATA"; printf '%s %s\n' "$(date -u +%FT%TZ)" "$*" | tee -a "$LOG" >&2; }
die() { log "FATAL: $*"; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "missing dependency: $1"; }
pm2() { npx --yes pm2 "$@"; }

health_json() { curl -s -m 8 "$HEALTH" 2>/dev/null || true; }
health_ok() { [ "$(curl -s -m 8 -o /dev/null -w '%{http_code}' "$HEALTH" 2>/dev/null)" = "200" ]; }
# `busy` covers cycles and Cafe Bar rounds; older releases only report cycleInFlight.
cycle_in_flight() { health_json | grep -qE '"(busy|cycleInFlight)":true'; }

# ---------------------------------------------------------------- install
cmd_install() {
  need git; need node; need npm; need curl
  local major; major="$(node -p 'process.versions.node.split(".")[0]')"
  [ "$major" -ge 22 ] || die "node >= 22 required (found $(node -v))"
  mkdir -p "$RELEASES" "$DATA" "$SHARED"
  if [ ! -f "$SHARED/.env.local" ]; then
    cat > "$SHARED/.env.local" <<'EOF'
# LAURA secrets — fill in, never commit. Loaded by Next at process start.
ANTHROPIC_API_KEY=
SWARM_LLM_PROVIDER=anthropic
X_API_KEY=
X_API_SECRET=
X_BEARER_TOKEN=
SWARM_WALLET_PRIVATE_KEY=
SNAPSHOT_PUBLISH_SECRET=
VIEWER_PUBLISH_URL=https://laura.stonkbrokers.io
GITHUB_TOKEN=
# Co-pilot surface (/api/ops/*): 32+ random chars; share only with the Cursor agent.
OPERATOR_TOKEN=
EOF
    log "created $SHARED/.env.local template — fill it in, then re-run install"
    exit 2
  fi
  grep -q '^OPERATOR_TOKEN=.\{24,\}' "$SHARED/.env.local" || log "warning: OPERATOR_TOKEN unset or short — /api/ops stays disabled (fine, just no remote co-pilot)"
  if [ ! -d "$REPO/.git" ]; then
    log "cloning $REPO_URL"
    git clone --branch "$BRANCH" "$REPO_URL" "$REPO"
  fi
  cmd_update --force
  pm2 start "$CURRENT/ecosystem.config.cjs" --update-env
  pm2 save
  log "installed. Boot persistence: run 'npx pm2 startup' (Linux/macOS) and execute the printed command; on WSL2 enable 'systemd=true' in /etc/wsl.conf first."
  cmd_status
}

# ---------------------------------------------------------------- update
current_sha() { [ -L "$CURRENT" ] && basename "$(readlink "$CURRENT")" || echo none; }

build_release() {
  local sha="$1" dir="$RELEASES/$sha"
  rm -rf "$dir"; mkdir -p "$dir"
  git -C "$REPO" archive "$sha" | tar -x -C "$dir"
  ln -sfn "$SHARED/.env.local" "$dir/.env.local"
  local prev="$RELEASES/$(current_sha)"
  if [ -d "$prev/node_modules" ] && cmp -s "$prev/package-lock.json" "$dir/package-lock.json"; then
    log "lockfile unchanged — reusing node_modules from $(current_sha)"
    cp -R "$prev/node_modules" "$dir/node_modules"
  else
    log "npm ci in $dir"
    (cd "$dir" && npm ci --no-audit --no-fund >>"$LOG" 2>&1) || return 1
  fi
  log "next build $sha"
  (cd "$dir" && NODE_ENV=production npm run build >>"$LOG" 2>&1) || return 1
  printf '%s %s\n' "$sha" "$(date -u +%FT%TZ)" > "$dir/.release"
}

wait_quiet() {
  local waited=0
  while cycle_in_flight; do
    if [ "$waited" -ge "$QUIET_WAIT_MAX_SEC" ]; then log "quiet wait exceeded ${QUIET_WAIT_MAX_SEC}s; switching anyway (self-heal closes any orphan)"; return 0; fi
    [ $((waited % 300)) -eq 0 ] && log "cycle in flight; waiting for a quiet moment (${waited}s)"
    sleep 30; waited=$((waited + 30))
  done
}

switch_to() {
  local sha="$1" prev; prev="$(current_sha)"
  wait_quiet
  ln -sfn "$RELEASES/$sha" "$CURRENT"
  log "switched current -> $sha (was $prev); reloading PM2 app laura"
  # Only the swarm process is reloaded here: this function usually runs inside
  # the updater app, which must survive to verify health and roll back.
  pm2 startOrReload "$CURRENT/ecosystem.config.cjs" --only laura --update-env >>"$LOG" 2>&1 || true
  local i; for i in $(seq 1 30); do sleep 4; health_ok && break; done
  if health_ok; then
    log "health OK on $sha"
    return 0
  fi
  log "health FAILED on $sha after 120s"
  if [ "$prev" != none ] && [ -d "$RELEASES/$prev" ]; then
    ln -sfn "$RELEASES/$prev" "$CURRENT"
    pm2 startOrReload "$CURRENT/ecosystem.config.cjs" --only laura --update-env >>"$LOG" 2>&1 || true
    log "ROLLED BACK to $prev"
  fi
  return 1
}

# Bring the kit's own PM2 apps onto the new release last. Restarting the
# updater kills this very process when it runs as laura-updater, so it is the
# final act of a successful update.
refresh_kit() {
  pm2 restart laura-watchdog --update-env >>"$LOG" 2>&1 || true
  if pm2 describe laura-updater >/dev/null 2>&1; then
    log "kit refreshed; restarting laura-updater onto $(current_sha)"
    pm2 restart laura-updater --update-env >>"$LOG" 2>&1 || true
  fi
}

prune_releases() {
  ls -1t "$RELEASES" | tail -n +$((KEEP_RELEASES + 1)) | while read -r old; do
    [ "$old" = "$(current_sha)" ] && continue
    rm -rf "$RELEASES/$old"; log "pruned release $old"
  done
}

head_sha() {
  git -C "$REPO" fetch --quiet origin "$BRANCH"
  git -C "$REPO" rev-parse "origin/$BRANCH"
}

release_built() { [ -f "$RELEASES/$1/.release" ]; }

# Build (or reuse) the release for a sha without touching the live one.
ensure_release() {
  local sha="$1"
  if release_built "$sha"; then log "release $sha already built"; return 0; fi
  if ! build_release "$sha"; then
    log "BUILD FAILED for $sha; keeping $(current_sha) live"
    rm -rf "$RELEASES/$sha"
    return 1
  fi
}

# Pre-warm: build the newest release now so the later switch takes seconds.
cmd_build() {
  need git; need npm; need curl
  local sha; sha="$(head_sha)"
  ensure_release "$sha" && echo "$sha"
}

cmd_update() {
  local force="${1:-}"
  need git; need npm; need curl
  local sha; sha="$(head_sha)"
  if [ "$sha" = "$(current_sha)" ] && [ "$force" != "--force" ]; then return 0; fi
  log "update: $(current_sha) -> $sha"
  ensure_release "$sha" || return 1
  switch_to "$sha" && prune_releases && refresh_kit
}

cmd_updater() {
  log "updater loop online (every ${UPDATE_EVERY_SEC}s, or on data/ops/update.requested)"
  local slept=0
  while true; do
    if [ -f "$DATA/ops/update.requested" ] || [ "$slept" -ge "$UPDATE_EVERY_SEC" ]; then
      rm -f "$DATA/ops/update.requested"
      cmd_update || true
      slept=0
    fi
    sleep 15; slept=$((slept + 15))
  done
}

# ---------------------------------------------------------------- watchdog
cmd_watchdog() {
  log "watchdog online (probing $HEALTH every 60s)"
  local misses=0
  while true; do
    if health_ok; then misses=0; else
      misses=$((misses + 1)); log "health miss $misses/3"
      if [ "$misses" -ge 3 ]; then
        log "restarting laura via PM2"
        pm2 restart laura >>"$LOG" 2>&1 || true
        misses=0; sleep 120
      fi
    fi
    sleep 60
  done
}

# ---------------------------------------------------------------- status
cmd_status() {
  echo "LAURA_HOME : $LAURA_HOME"
  echo "release    : $(current_sha)"
  echo "health     : $(health_json)"
  pm2 ls 2>/dev/null | grep -E 'laura' || true
  echo "log tail   :"; tail -n 8 "$LOG" 2>/dev/null || true
}

case "${1:-}" in
  install)  cmd_install ;;
  build)    cmd_build ;;
  update)   shift; cmd_update "$@" ;;
  updater)  cmd_updater ;;
  watchdog) cmd_watchdog ;;
  status)   cmd_status ;;
  *) sed -n '2,20p' "$0"; exit 1 ;;
esac
