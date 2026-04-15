#!/bin/bash
set -e

# AR-3 Heartbeat Check
# Runs every 30 minutes via cron

LOG="/tmp/heartbeat.log"
echo "[$(date)] Heartbeat check starting" >> $LOG

# Check Vast.ai instance using vastai CLI
export VAST_API_KEY="8a40b921ecdc6af9124f6715fdee718cd046a1b746e8aa40594480030e03d781"

INSTANCES=$(vastai show instances 2>/dev/null | grep -c "running" || echo "0")
echo "Running instances: $INSTANCES" >> $LOG

# If no running instance, deploy
if [ "$INSTANCES" -eq 0 ]; then
    echo "[$(date)] No running instance! Deploying..." >> $LOG
    cd /opt/AR-3 && python3 deploy/vast-ai-launch-v3.py 2>&1 >> $LOG || echo "Deploy failed" >> $LOG
fi

# Check all spaces via API
RESP=$(curl -s -m 10 "https://kijiji-mask-staff-nomination.trycloudflare.com/api/dashboard" \
  -H "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VySWQiOiI0YTVhMjY5Mi0wM2MzLTRiOTEtOWNkYS01YzVhOGQ4MTQ2ZWUiLCJlbWFpbCI6ImFkbWluQGV4YW1wbGUuY29tIiwicm9sZSI6IkFETUlOIiwiaWF0IjoxNzc2MjQ3OTIyLCJleHAiOjE3NzY4NTI3MjJ9.LBVFg6wluTzypToUdbDqIwPANNST2_okq3CddO1x988" 2>/dev/null || echo "{}")

echo "$RESP" | python3 -c "
import json, sys
try:
    d = json.load(sys.stdin)
    stats = d.get('stats', {})
    print(f'Total spaces: {stats.get(\"totalSpaces\", 0)}')
    print(f'Total tokens: {stats.get(\"totalTokens\", 0)}')
    print(f'Total cost: \${stats.get(\"totalCost\", 0):.4f}')
    print(f'Total experiments: {stats.get(\"totalExperiments\", 0)}')
    print()
    for s in d.get('spaceStats', []):
        print(f'  {s[\"name\"]}: {s[\"status\"]} | {s[\"phase\"]} | {s[\"tokensUsed\"]} tokens | {s[\"experiments\"]} exps')
except Exception as e:
    print(f'Parse error: {e}')
" >> $LOG

echo "[$(date)] Heartbeat check done" >> $LOG
echo "---" >> $LOG
