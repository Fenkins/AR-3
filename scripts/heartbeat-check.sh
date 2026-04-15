#!/bin/bash
set -e

# AR-3 Heartbeat Check
# Runs every 30 minutes via cron

LOG="/tmp/heartbeat.log"
echo "[$(date)] Heartbeat check starting" >> $LOG

# Check Vast.ai instance
export VAST_API_KEY="8a40b921ecdc6af9124f6715fdee718cd046a1b746e8aa40594480030e03d781"

INSTANCES=$(python3 -c "
import requests
resp = requests.get('https://console.vast.ai/api/v0/instances', headers={'Authorization': f'Bearer {VAST_API_KEY}'})
data = resp.json()
running = [i for i in data['instances'] if i['cur_state'] == 'running']
print(len(running))
" 2>/dev/null || echo "0")

echo "Running instances: $INSTANCES" >> $LOG

# If no running instance, we need to deploy
if [ "$INSTANCES" -eq 0 ]; then
    echo "[$(date)] No running instance! Need to deploy." >> $LOG
    # Would trigger deployment here
fi

# Check pipeline via public URL
RESP=$(curl -s -m 10 "https://kijiji-mask-staff-nomination.trycloudflare.com/api/spaces/9281ba3d-85ee-4f59-85fe-ea084995ec1e" \
  -H "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VySWQiOiI0YTVhMjY5Mi0wM2MzLTRiOTEtOWNkYS01YzVhOGQ4MTQ2ZWUiLCJlbWFpbCI6ImFkbWluQGV4YW1wbGUuY29tIiwicm9sZSI6IkFETUlOIiwiaWF0IjoxNzc2MjQ3OTIyLCJleHAiOjE3NzY4NTI3MjJ9.LBVFg6wluTzypToUdbDqIwPANNST2_okq3CddO1x988" 2>/dev/null || echo "{}")

echo "$RESP" | python3 -c "
import json, sys
try:
    d = json.load(sys.stdin)
    print(f'Status: {d.get(\"space\", {}).get(\"status\", \"UNKNOWN\")}')
    print(f'Phase: {d.get(\"space\", {}).get(\"currentPhase\", \"UNKNOWN\")}')
    print(f'Tokens: {d.get(\"space\", {}).get(\"totalTokens\", 0)}')
    print(f'Stage: {d.get(\"execution\", {}).get(\"currentStageId\", \"NONE\")}')
    print(f'Running: {d.get(\"execution\", {}).get(\"isRunning\", False)}')
    print(f'Experiments: {len(d.get(\"space\", {}).get(\"experiments\", []))}')
except:
    print('Parse error or unreachable')
" >> $LOG

echo "[$(date)] Heartbeat check done" >> $LOG
