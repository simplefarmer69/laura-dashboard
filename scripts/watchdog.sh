#!/usr/bin/env bash
# LAURA dev-server watchdog. Runs forever in its own tmux session
# ("laura-watchdog") and restarts the dev server inside the
# "swarm-dev-server" tmux session if /api/state stops answering for
# 3 consecutive checks (~3 minutes). While /tmp/laura-restart-in-progress
# exists, a planned graceful restart owns the server and the watchdog
# stands down. Logs to data/watchdog.log (git-ignored with the rest of data/).
#
# Start (idempotent):
#   tmux -f /exec-daemon/tmux.portal.conf has-session -t "=laura-watchdog" 2>/dev/null || \
#     tmux -f /exec-daemon/tmux.portal.conf new-session -d -s laura-watchdog -c /workspace \
#     -- bash scripts/watchdog.sh
set -u
TMUX="tmux -f /exec-daemon/tmux.portal.conf"
SESSION=swarm-dev-server
BASE="http://127.0.0.1:4747"
LOG=/workspace/data/watchdog.log
MARKER=/tmp/laura-restart-in-progress
fails=0

log() { echo "$(date -u +%FT%TZ) $*" >>"$LOG"; }

restart_server() {
  if ! $TMUX has-session -t "=$SESSION" 2>/dev/null; then
    $TMUX new-session -d -s "$SESSION" -c /workspace
    log "recreated tmux session $SESSION"
  else
    # Two interrupts with a pause: the first stops next dev, the second
    # clears anything (like a shell prompt command) left in the pane.
    $TMUX send-keys -t "$SESSION:0.0" C-c
    sleep 5
    $TMUX send-keys -t "$SESSION:0.0" C-c
    sleep 3
  fi
  $TMUX send-keys -t "$SESSION:0.0" 'cd /workspace && npm run dev' C-m
  # Wait up to 3 minutes for the server to come back.
  local code=000
  for _ in $(seq 1 18); do
    sleep 10
    code=$(curl -s -m 10 -o /dev/null -w '%{http_code}' "$BASE/api/state" || echo 000)
    [ "$code" = "200" ] && break
  done
  log "post-restart health: $code"
}

log "watchdog online (pid $$)"
while true; do
  sleep 60
  if [ -e "$MARKER" ]; then
    fails=0
    continue
  fi
  code=$(curl -s -m 20 -o /dev/null -w '%{http_code}' "$BASE/api/state" || echo 000)
  if [ "$code" = "200" ]; then
    fails=0
    continue
  fi
  fails=$((fails + 1))
  log "health check failed (http $code), consecutive=$fails"
  if [ "$fails" -ge 3 ]; then
    log "restarting dev server after $fails consecutive failures"
    restart_server
    fails=0
  fi
done
