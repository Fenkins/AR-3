#!/bin/bash
# AR-3 Heartbeat Check - Vast.ai instance
# Run via OpenClaw heartbeat

LOG="http://localhost:3000"
TUNNEL="${AR3_TUNNEL_URL:-http://localhost:3000}"
SPACE_ID=""
ADMIN_EMAIL="${ADMIN_EMAIL:-admin@example.com}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-}"
SSH_HOST="${AR3_SSH_HOST:-}"
SSH_PORT="${AR3_SSH_PORT:-22}"
SSH_KEY="${AR3_SSH_KEY:-}"

echo "=== AR-3 Heartbeat $(date -u +%Y-%m-%dT%H:%M:%SZ) ==="

echo ""
echo "--- Infrastructure ---"
if [ -n "$SSH_HOST" ] && [ -n "$SSH_KEY" ]; then
  ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=10 -i "$SSH_KEY" -p "$SSH_PORT" "root@$SSH_HOST" '
    echo "next-server: $(pgrep -la next-server | grep -v grep | awk "{print \$1}")"
    echo "cloudflared: $(pgrep -la cloudflared | grep -v grep | awk "{print \$1}")"
    echo "gpu_worker:  $(pgrep -la "gpu_worker" | grep -v grep | awk "{print \$1}" | tr "\n" " ")"
    echo "gpu_results: $(wc -l < /tmp/gpu_results.json 2>/dev/null || echo 0) lines"
    echo ""
    echo "--- Last 3 errors ---"
    strings /tmp/nextjs.log | grep -E "Error:" | tail -3
  '
else
  echo "Skipping SSH checks; set AR3_SSH_HOST and AR3_SSH_KEY to enable them."
fi

echo ""
echo "--- API Health ---"
bash /tmp/check_h.sh 2>/dev/null || {
  if [ -z "$ADMIN_PASSWORD" ]; then
    echo "Skipping authenticated API checks; set ADMIN_PASSWORD to enable them."
    TOKEN=""
  else
    TOKEN=$(python3 -c 'import json, os; print(json.dumps({"email": os.environ.get("ADMIN_EMAIL", "admin@example.com"), "password": os.environ["ADMIN_PASSWORD"]}))' | curl -s -X POST "$TUNNEL/api/auth/login" -H "Content-Type: application/json" -d @- | python3 -c "import sys,json; print(json.load(sys.stdin).get('token',''))")
  fi
  if [ -n "$TOKEN" ]; then
    echo "/api/admin/users: $(curl -s -o /dev/null -w '%{http_code}' "$TUNNEL/api/admin/users" -H "Authorization: Bearer $TOKEN")"
    echo "/api/agents:      $(curl -s -o /dev/null -w '%{http_code}' "$TUNNEL/api/agents" -H "Authorization: Bearer $TOKEN")"
    echo "/api/providers:   $(curl -s -o /dev/null -w '%{http_code}' "$TUNNEL/api/providers" -H "Authorization: Bearer $TOKEN")"
    echo "/api/dashboard:   $(curl -s -o /dev/null -w '%{http_code}' "$TUNNEL/api/dashboard" -H "Authorization: Bearer $TOKEN")"
    echo "/api/spaces:      $(curl -s -o /dev/null -w '%{http_code}' "$TUNNEL/api/spaces" -H "Authorization: Bearer $TOKEN")"
  fi
}

echo ""
echo "--- Pipeline Status ---"
if [ -n "$ADMIN_PASSWORD" ]; then
  TOKEN=$(python3 -c 'import json, os; print(json.dumps({"email": os.environ.get("ADMIN_EMAIL", "admin@example.com"), "password": os.environ["ADMIN_PASSWORD"]}))' | curl -s -X POST "$TUNNEL/api/auth/login" -H "Content-Type: application/json" -d @- | python3 -c "import sys,json; print(json.load(sys.stdin).get('token',''))" 2>/dev/null)
else
  TOKEN=""
fi
if [ -n "$TOKEN" ]; then
  SPACES=$(curl -s "$TUNNEL/api/spaces" -H "Authorization: Bearer $TOKEN")
  SPACE_ID=$(echo "$SPACES" | python3 -c "import sys,json; s=json.load(sys.stdin).get('spaces',[]); print(s[0]['id'] if s else '')" 2>/dev/null)
  if [ -n "$SPACE_ID" ]; then
    SPACE_DATA=$(curl -s "$TUNNEL/api/spaces/$SPACE_ID" -H "Authorization: Bearer $TOKEN")
    echo "$SPACE_DATA" | python3 -c "
import sys,json
d=json.load(sys.stdin)
s=d.get('space',{})
print(f'phase={s.get(\"currentPhase\",\"?\")} cycle={s.get(\"currentCycle\",\"?\")} status={s.get(\"status\",\"?\")}')
print(f'variants={len(s.get(\"Variant\",[]))} experiments={len(s.get(\"Experiment\",[]))}')
" 2>/dev/null
  fi
fi

echo ""
echo "Done."
