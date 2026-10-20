#!/bin/bash
set -u
TS=$(date -u +%FT%TZ)
ARCHIVED=$(/usr/bin/python3 /opt/forge/scripts/linear_nightly_archive.py 2>>/var/log/linear-nightly-archive.err.log)
echo "$TS archived $ARCHIVED"
curl -s -X POST http://localhost:5000/agent-events \
  -H 'Content-Type: application/json' \
  -d "{\"eventType\":\"linear_archive_swept\",\"agentId\":\"cron-linear-archive\",\"details\":{\"archived\":\"$ARCHIVED\"}}" > /dev/null
