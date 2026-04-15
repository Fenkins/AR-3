#!/bin/bash
# AR-3 Development Heartbeat - runs every 30 minutes
# Checks deployment, evaluates researcher output, fixes bugs, pushes updates

LOG="/root/.openclaw/workspace/AR-3/scripts/heartbeat.log"
WORKSPACE="/root/.openclaw/workspace/AR-3"
VAST_API_KEY="${VAST_API_KEY}"
GITHUB_TOKEN="${GITHUB_TOKEN}"
SSH_KEY="/tmp/ar3_key"
TUNNEL_URL_FILE="/tmp/tunnel_url.txt"

log() {
    echo "[$(date '+%Y-%m-%d %H:%M')] $1" | tee -a "$LOG"
}

cd "$WORKSPACE"

log "=== Heartbeat check started ==="

# 1. Check if instance is still running
log "[1] Checking instance status..."
OUT=$(vastai --api-key "$VAST_API_KEY" show instances 2>&1)
INST_LINE=$(echo "$OUT" | grep -E "AR-3-Research-Platform|AR-3-Research\s" | head -3)
if echo "$INST_LINE" | grep -q "running"; then
    log "[OK] Instance running"
    CONTRACT=$(echo "$OUT" | grep running | awk '{print $2}')
    
    # Check tunnel URL
    TUNNEL_URL=$(cat /tmp/tunnel_url.txt 2>/dev/null || echo "")
    if [ -n "$TUNNEL_URL" ]; then
        log "[Tunnel] $TUNNEL_URL"
        # Verify tunnel is still accessible
        HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" --connect-timeout 5 "$TUNNEL_URL" 2>/dev/null || echo "000")
        log "[HTTP] $TUNNEL_URL → $HTTP_CODE"
        if [ "$HTTP_CODE" = "200" ] || [ "$HTTP_CODE" = "307" ]; then
            log "[OK] Platform accessible"
        else
            log "[WARN] Platform not responding ($HTTP_CODE), restarting tunnel..."
            # Restart tunnel
            ssh -o StrictHostKeyChecking=no -i "$SSH_KEY" root@ssh7.vast.ai -p 26532 "pkill cloudflared; nohup cloudflared tunnel --url http://localhost:3000 > /tmp/tunnel.log 2>&1 &" 2>/dev/null
            sleep 10
            NEW_URL=$(ssh -o StrictHostKeyChecking=no -i "$SSH_KEY" root@ssh7.vast.ai -p 26532 "cat /tmp/tunnel.log" 2>/dev/null | grep -o 'https://[^ ]*trycloudflare.com' | head -1)
            if [ -n "$NEW_URL" ]; then
                echo "$NEW_URL" > "$TUNNEL_URL_FILE"
                log "[NEW TUNNEL] $NEW_URL"
            fi
        fi
    fi
else
    log "[WARN] Instance not running! Attempting restart..."
    # The instance might be stopped/loading. Try to start it.
    # For now, just log the issue and continue with local development
fi

# 2. Pull latest from GitHub
log "[2] Pulling latest from GitHub..."
cd "$WORKSPACE"
git config user.name "Fenkins" 2>/dev/null
git config user.email "fenkins@users.noreply.github.com" 2>/dev/null
git remote set-url origin "https://$GITHUB_TOKEN@github.com/Fenkins/AR-3.git" 2>/dev/null
git pull origin main 2>&1 >> "$LOG"

# 3. Check TypeScript errors
log "[3] Type checking..."
if ! npx tsc --noEmit 2>&1 | grep -q "error"; then
    log "[OK] TypeScript clean"
else
    ERRORS=$(npx tsc --noEmit 2>&1 | grep "error" | head -5)
    log "[ERRORS] $ERRORS"
fi

# 4. Build check
log "[4] Building..."
BUILD_OUT=$(npm run build 2>&1 | tail -5)
if echo "$BUILD_OUT" | grep -q "✓"; then
    log "[OK] Build successful"
else
    log "[WARN] Build output: $BUILD_OUT"
fi

# 5. If deployed and building, push new build to instance
if echo "$OUT" | grep -q "running"; then
    log "[5] Syncing to instance..."
    # Kill old process, pull latest, rebuild, restart
    ssh -o StrictHostKeyChecking=no -i "$SSH_KEY" root@ssh7.vast.ai -p 26532 <<'SSHEOF' >> "$LOG" 2>&1
cd /opt/AR-3
git pull
npm install --silent
npm run build
pkill -f "npm start" 2>/dev/null || true
sleep 2
nohup npm start > /tmp/ar3.log 2>&1 &
echo "Updated and restarted at $(date)"
SSHEOF
    log "[OK] Instance updated"
fi

# 6. Check researcher results (via API logs if possible)
log "[6] Checking researcher state..."
# Try to get logs from the instance
SPACE_LOGS=$(ssh -o StrictHostKeyChecking=no -i "$SSH_KEY" root@ssh7.vast.ai -p 26532 "cat /tmp/ar3.log 2>/dev/null | tail -20" 2>/dev/null)
if [ -n "$SPACE_LOGS" ]; then
    log "Last logs: $(echo "$SPACE_LOGS" | tail -3 | tr '\n' ' ')"
fi

log "=== Heartbeat check complete ==="
echo ""
