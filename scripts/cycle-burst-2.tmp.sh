#!/usr/bin/env bash
# Corrected burst driver: 5 more cycles, counting only genuinely new completed runs.
set -u
TOTAL=5
BASE="http://127.0.0.1:4747"
LOG=/tmp/cycle-burst-2.log
log() { echo "$(date -u +%FT%TZ) $*" >>"$LOG"; }

last_run() { python3 -c "import json;s=json.load(open('/workspace/data/state.json'));r=s['runs'][-1];print(r['id'], 1 if r.get('finishedAt') else 0)"; }

log "driver-2 start: $TOTAL cycles"
for i in $(seq 1 "$TOTAL"); do
  # wait until no run is in flight
  while true; do
    read -r rid fin <<<"$(last_run)"
    [ "$fin" = "1" ] && break
    sleep 30
  done
  prev="$rid"
  log "cycle $i/$TOTAL: triggering (prev $prev finished)"
  code=$(curl -s -m 2400 -o /tmp/cb2-resp.json -w '%{http_code}' -X POST "$BASE/api/cycle" || echo curl-fail)
  # confirm a NEW run appeared and finished
  for _ in $(seq 1 90); do
    read -r rid fin <<<"$(last_run)"
    if [ "$rid" != "$prev" ] && [ "$fin" = "1" ]; then break; fi
    sleep 30
  done
  log "cycle $i/$TOTAL: http=$code newrun=$rid finished=$fin"
done
log "driver-2 done"
touch /tmp/cycle-burst-2.done
