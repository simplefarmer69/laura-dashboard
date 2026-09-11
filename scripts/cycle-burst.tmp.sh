#!/usr/bin/env bash
# Cycle burst driver: run TOTAL swarm cycles back to back, each only after the
# previous run has finishedAt set in data/state.json. Logs to /tmp/cycle-burst.log,
# writes /tmp/cycle-burst.done when all cycles have completed.
set -u

TOTAL=10
BASE="http://127.0.0.1:4747"
LOG=/tmp/cycle-burst.log
DONE_MARKER=/tmp/cycle-burst.done
RESP=/tmp/cycle-burst-resp.json

log() { echo "$(date -u +%FT%TZ) $*" >>"$LOG"; }

last_run_finished() {
  python3 - <<'PY'
import json, sys
try:
    s = json.load(open('/workspace/data/state.json'))
    r = s['runs'][-1]
    sys.exit(0 if r.get('finishedAt') else 1)
except Exception:
    sys.exit(1)
PY
}

wait_idle() {
  until last_run_finished; do sleep 30; done
}

last_run_summary() {
  python3 - <<'PY'
import json
s = json.load(open('/workspace/data/state.json'))
r = s['runs'][-1]
dur = (r['finishedAt'] - r['startedAt']) / 60000 if r.get('finishedAt') else None
print(f"id={r.get('id')} durationMin={dur:.1f} error={r.get('error')} "
      f"llmCalls={r.get('llmCalls')} llmFallbacks={r.get('llmFallbacks')} "
      f"llmRepairs={r.get('llmRepairs')} steps={len(r.get('steps', []))} "
      f"errSteps={sum(1 for st in r.get('steps', []) if st.get('status') == 'error')}")
PY
}

log "driver start: target $TOTAL cycles, back to back"
i=1
while [ "$i" -le "$TOTAL" ]; do
  wait_idle
  log "cycle $i/$TOTAL: previous run finished, triggering POST /api/cycle"
  t0=$(date +%s)
  http=$(curl -s -o "$RESP" -w "%{http_code}" --max-time 3600 -X POST "$BASE/api/cycle" || echo "curl-fail")
  t1=$(date +%s)
  if [ "$http" = "409" ]; then
    log "cycle $i/$TOTAL: 409 (a cycle is already running elsewhere), waiting it out before retrying"
    sleep 60
    continue
  fi
  # Whatever curl saw (200, 500, timeout, disconnect), the authoritative record
  # is state.json: wait for the run to close, then log its summary.
  wait_idle
  log "cycle $i/$TOTAL: http=$http wallClock=$((t1 - t0))s $(last_run_summary)"
  i=$((i + 1))
done
log "driver done: $TOTAL cycles completed"
touch "$DONE_MARKER"
