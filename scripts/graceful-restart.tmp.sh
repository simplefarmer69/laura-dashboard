#!/usr/bin/env bash
# One-shot graceful dev-server restart (2026-09-11). Purpose: the V2 scheduler
# loop runs on a module snapshot frozen before tonight's fixes (globalThis
# cycle guard, orphan-run self-heal, Blockscout UA fix, forum archiving,
# executor reserved-name verify skip). One clean restart at a provably quiet
# moment loads everything current. Waits for the cycle burst to finish and for
# no run to be in flight, then restarts inside the swarm-dev-server tmux
# session, verifies health, and makes sure the watchdog is running.
set -u
TMUX="tmux -f /exec-daemon/tmux.portal.conf"
SESSION=swarm-dev-server
BASE="http://127.0.0.1:4747"
LOG=/tmp/laura-graceful-restart.log
MARKER=/tmp/laura-restart-in-progress
BURST_DONE=/tmp/cycle-burst-2.done

log() { echo "$(date -u +%FT%TZ) $*" >>"$LOG"; }
last_run_finished() {
  python3 -c "import json;s=json.load(open('/workspace/data/state.json'));r=s['runs'][-1];print(1 if r.get('finishedAt') else 0)" 2>/dev/null || echo 0
}

log "graceful restart armed; waiting for burst driver to finish"
# Wait up to 5 hours for the burst; proceed after that regardless (the quiet
# check below still protects an in-flight cycle).
for _ in $(seq 1 600); do
  [ -e "$BURST_DONE" ] && break
  sleep 30
done
log "burst wait over (done marker present: $([ -e "$BURST_DONE" ] && echo yes || echo no)); waiting for quiet"

# Quiet = the newest run is finished on two checks 30s apart.
while true; do
  if [ "$(last_run_finished)" = "1" ]; then
    sleep 30
    [ "$(last_run_finished)" = "1" ] && break
  else
    sleep 30
  fi
done

log "quiet confirmed; restarting dev server"
touch "$MARKER"
$TMUX send-keys -t "$SESSION:0.0" C-c
sleep 5
$TMUX send-keys -t "$SESSION:0.0" C-c
sleep 3
$TMUX send-keys -t "$SESSION:0.0" 'cd /workspace && npm run dev' C-m

code=000
for _ in $(seq 1 24); do
  sleep 10
  code=$(curl -s -m 10 -o /dev/null -w '%{http_code}' "$BASE/api/state" || echo 000)
  [ "$code" = "200" ] && break
done
log "post-restart /api/state: http $code"

# The scheduler starts on first request; wait for a tick line to prove it.
tick=missing
for _ in $(seq 1 10); do
  sleep 30
  if $TMUX capture-pane -t "$SESSION:0.0" -p -S -100 | grep -q 'autopilot online\|tick · next cycle'; then
    tick=seen
    break
  fi
done
log "scheduler heartbeat: $tick"
rm -f "$MARKER"

# Make sure the watchdog is on duty.
if ! $TMUX has-session -t "=laura-watchdog" 2>/dev/null; then
  $TMUX new-session -d -s laura-watchdog -c /workspace -- bash scripts/watchdog.sh
  log "watchdog session started"
fi

log "graceful restart complete"
touch /tmp/laura-graceful-restart.done
