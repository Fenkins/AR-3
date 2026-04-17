#!/bin/bash
# AR-3 Overnight Monitor — runs every 10 minutes via cron
# Auto-fixes common issues: stalled pipeline, GPU errors, variant execution

LOG="/tmp/overnight_monitor.log"
EMAIL="fenkins@gmail.com"
SPACE_ID="df8aca58-bab2-47dd-91d5-8c16835ea25f"

echo "[$(date)] Overnight monitor starting" >> $LOG

cd /opt/AR-3

# 1. Check if next-server is running
if ! ps aux | grep -q "next-server" | grep -v grep; then
    echo "[$(date)] ERROR: next-server not running! Restarting..." >> $LOG
    pkill -f "next-server" 2>/dev/null || true
    PORT=3000 nohup npm start >> /tmp/nextjs.log 2>&1 &
    sleep 5
    echo "next-server restarted" >> $LOG
fi

# 2. Check if GPU worker is running
if ! ps aux | grep -q "gpu_worker" | grep -v grep; then
    echo "[$(date)] WARNING: gpu_worker not running! Restarting..." >> $LOG
    pkill -f "gpu_worker" 2>/dev/null || true
    nohup python3 /opt/AR-3/scripts/gpu_worker.py >> /tmp/gpu_worker.log 2>&1 &
    echo "gpu_worker restarted" >> $LOG
fi

# 3. Check search service
if ! ps aux | grep -q "search_service" | grep -v grep; then
    echo "[$(date)] WARNING: search_service not running! Restarting..." >> $LOG
    pkill -f "search_service" 2>/dev/null || true
    nohup python3 /opt/AR-3/scripts/search_service.py >> /tmp/search_service.log 2>&1 &
    echo "search_service restarted" >> $LOG
fi

# 4. Check if pipeline is stalled (no variant execution in last 10 min)
LAST_VARIANT_TIME=$(grep -E "executeVariantCycle|Executing variant|variant.*executing" /tmp/nextjs.log | tail -1 | grep -oP '\[\K[^]]+' | tail -1)
NOW=$(date +%s)
LAST_LOG_LINE=$(tail -1 /tmp/nextjs.log)
echo "Last log: $LAST_LOG_LINE" >> $LOG

# 5. Check if variants are PENDING but not executing
VARIANT_STATUS=$(node /tmp/check_status.js 2>/dev/null | grep "Variant:" | head -3)
if echo "$VARIANT_STATUS" | grep -q "PENDING"; then
    echo "[$(date)] Variants are PENDING — checking if pipeline is stuck..." >> $LOG
    # Check if background loop is running
    if ! ps aux | grep -q "startBackgroundLoop\|background.*loop" | grep -v grep; then
        echo "[$(date)] Pipeline loop not running! Triggering via API..." >> $LOG
        RESP=$(curl -s -m 10 -X POST "https://kijiji-mask-staff-nomination.trycloudflare.com/api/debug/start-loop" \
          -H "Content-Type: application/json" \
          -d "{\"spaceId\":\"$SPACE_ID\"}" 2>/dev/null)
        echo "Start-loop response: $RESP" >> $LOG
    fi
fi

# 6. Check for GPU errors in log
if grep -q "RuntimeError.*broadcast\|tensor.*shape\|CUDA\|cuda.*error" /tmp/gpu_worker.log 2>/dev/null; then
    echo "[$(date)] GPU ERROR detected! Clearing stale GPU code files..." >> $LOG
    rm -f /tmp/gpu_code_*.py 2>/dev/null
    echo "Stale GPU code files cleared" >> $LOG
fi

# 7. Check for repeated MiniMax failures
FAIL_COUNT=$(grep -c "rate.limit\|Rate.limit\|429\|TIMEOUT" /tmp/nextjs.log | tail -1)
if [ "$FAIL_COUNT" -gt 10 ]; then
    echo "[$(date)] WARNING: Multiple API failures ($FAIL_COUNT). Pipeline may be stuck." >> $LOG
fi

# 8. Check DB variant count — are steps being executed?
echo "--- DB Status ---" >> $LOG
node /tmp/check_status.js 2>/dev/null >> $LOG || echo "check_status failed" >> $LOG

# 9. Tail the last few log lines for this cycle
echo "--- Last 5 log lines ---" >> $LOG
tail -5 /tmp/nextjs.log >> $LOG

echo "[$(date)] Monitor cycle done" >> $LOG
echo "===" >> $LOG
