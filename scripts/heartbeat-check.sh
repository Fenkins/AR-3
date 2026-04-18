#!/bin/bash
# AR-3 Heartbeat Check — runs every 30 minutes via OpenClaw cron
# Monitors AR-3 platform health and auto-restarts if needed

LOG="/tmp/heartbeat.log"
TUNNEL_URL="https://creations-mounting-jets-technologies.trycloudflare.com"
ADMIN_EMAIL="admin@example.com"
ADMIN_PASS="jkp93p"
SPACE_ID="e0e691a3-289c-4dad-b855-d398a05bb6a0"

echo "[$(date)] Heartbeat check starting" >> $LOG

cd /opt/AR-3

# 1. Check Vast.ai instance
export VAST_API_KEY="5d2d46bd85397a2196ae40d659cfa52a6efd1e871d1377dd8b0631359115ae1e"
INSTANCES=$(vastai show instances 2>/dev/null | grep -c "running" || echo "0")
echo "Running instances: $INSTANCES" >> $LOG
if [ "$INSTANCES" -eq 0 ]; then
    echo "[$(date)] No running instance! Deploying..." >> $LOG
    cd /opt/AR-3 && python3 deploy/vast-ai-launch-v3.py 2>& >> $LOG || echo "Deploy failed" >> $LOG
fi

# 2. Check if next-server is running locally
NEXT_PID=$(ps aux | grep -v grep | grep "next-server" | awk '{print $2}' | head -1)
if [ -z "$NEXT_PID" ]; then
    echo "[$(date)] WARNING: next-server not running! Restarting..." >> $LOG
    pkill -f "next-server" 2>/dev/null || true
    sleep 2
    cd /opt/AR-3 && DATABASE_URL="file:./prisma/prisma/dev.db" nohup npm start > /tmp/nextjs.log 2>&1 &
    sleep 5
    echo "next-server restarted" >> $LOG
else
    # Server is running — verify it responds to requests
    if ! curl -s -m 3 http://localhost:3000/ > /dev/null 2>&1; then
        echo "[$(date)] next-server not responding! Force-restarting..." >> $LOG
        kill -9 $NEXT_PID 2>/dev/null || true
        sleep 2
        cd /opt/AR-3 && DATABASE_URL="file:./prisma/prisma/dev.db" nohup npm start > /tmp/nextjs.log 2>&1 &
        sleep 5
    fi
fi

# 3. Check if GPU worker is running
GPU_PID=$(ps aux | grep -v grep | grep "gpu_worker" | awk '{print $2}' | head -1)
if [ -z "$GPU_PID" ]; then
    echo "[$(date)] WARNING: gpu_worker not running! Restarting..." >> $LOG
    pkill -f "gpu_worker" 2>/dev/null || true
    nohup python3 /opt/AR-3/scripts/gpu_worker.py >> /tmp/gpu_worker.log 2>&1 &
    echo "gpu_worker restarted" >> $LOG
fi

# 4. Check if cloudflared tunnel is up (try API endpoint)
if curl -s -m 5 "$TUNNEL_URL/api/health" | grep -q "error"; then
    echo "[$(date)] WARNING: Tunnel may be down! Restarting cloudflared..." >> $LOG
    pkill -f cloudflared 2>/dev/null || true
    sleep 2
    nohup cloudflared tunnel --url http://localhost:3000 --logfile /tmp/cloudflared.log > /tmp/cloudflared_out.log 2>&1 &
    sleep 8
    NEW_URL=$(grep 'https://' /tmp/cloudflared_out.log | tail -1 | grep -o 'https://[^ ]*trycloudflare.com')
    echo "New tunnel URL: $NEW_URL" >> $LOG
fi

# 5. Check pipeline status via API
TOKEN_RESP=$(curl -s -m 10 -X POST "$TUNNEL_URL/api/auth/login" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASS\"}" 2>/dev/null)
TOKEN=$(echo $TOKEN_RESP | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('token',''))" 2>/dev/null)

if [ -n "$TOKEN" ]; then
    SPACES_RESP=$(curl -s -m 10 "$TUNNEL_URL/api/spaces" -H "Authorization: Bearer $TOKEN" 2>/dev/null)
    echo "API spaces response: $(echo $SPACES_RESP | python3 -c 'import json,sys; d=json.load(sys.stdin); print(len(d.get("spaces",[])), "spaces")' 2>/dev/null)" >> $LOG

    # Check if background loop is running (space should be in execution state)
    SPACE_RESP=$(curl -s -m 10 "$TUNNEL_URL/api/spaces/$SPACE_ID" -H "Authorization: Bearer $TOKEN" 2>/dev/null)
    EXEC_STATE=$(echo $SPACE_RESP | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('executionState',{}).get('currentStageName',''))" 2>/dev/null)
    echo "Current stage: $EXEC_STATE" >> $LOG

    # If no execution state and variants exist but none are running, restart pipeline
    VARIANT_COUNT=$(echo $SPACE_RESP | python3 -c "import json,sys; d=json.load(sys.stdin); print(len(d.get('variants',[])))" 2>/dev/null)
    if [ "$VARIANT_COUNT" -gt 0 ]; then
        LAST_LOG=$(tail -3 /tmp/nextjs.log | tr '\n' ' ')
        if echo "$LAST_LOG" | grep -q "executeVariantCycle\|generating"; then
            echo "Pipeline appears active — no restart needed" >> $LOG
        else
            echo "[$(date)] Pipeline may be stalled. Attempting restart..." >> $LOG
            RESTART_RESP=$(curl -s -m 10 -X PUT "$TUNNEL_URL/api/debug/start-loop" \
              -H "Content-Type: application/json" \
              -H "Authorization: Bearer $TOKEN" \
              -d "{\"spaceId\":\"$SPACE_ID\"}" 2>/dev/null)
            echo "Restart response: $RESTART_RESP" >> $LOG
        fi
    fi
else
    echo "Failed to get auth token" >> $LOG
fi

# 6. Check for GPU errors
if grep -q "RuntimeError.*broadcast\|tensor.*shape\|CUDA" /tmp/gpu_worker.log 2>/dev/null; then
    echo "[$(date)] GPU ERROR detected! Clearing stale GPU code files..." >> $LOG
    rm -f /tmp/gpu_code_*.py 2>/dev/null
fi

echo "[$(date)] Heartbeat check done" >> $LOG
echo "===" >> $LOG
