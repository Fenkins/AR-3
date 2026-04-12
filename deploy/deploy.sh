#!/usr/bin/env bash
# AR-1 Research Platform - Vast.ai One-Click Deploy Launcher
# Run this on your local machine to launch AR-1 on Vast.ai
set -e

API_KEY="${VAST_API_KEY:-8a40b921ecdc6af9124f6715fdee718cd046a1b746e8aa40594480030e03d781}"
SCRIPT_URL="https://raw.githubusercontent.com/Fenkins/AR-1/main/deploy/setup-with-tunnel.sh"

echo "================================================================"
echo "AR-1 Research Platform - Vast.ai Deployment"
echo "================================================================"
echo ""

# Find cheapest RTX 3060
echo "🔍 Finding RTX 3060 offers..."
OFFER_OUTPUT=$(curl -s -X POST "https://console.vast.ai/api/v0/bundles/" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"limit": 300}' | python3 -c "
import sys, json
d = json.load(sys.stdin)
offers = sorted([o for o in d.get('offers', []) if o.get('gpu_name') == 'RTX 3060' and o.get('reliability', 0) > 0.95], key=lambda x: x['dph_total'])
if offers:
    o = offers[0]
    print(o['id'])
    print(f\"Price: \${o['dph_total']:.4f}/hr, Location: {o.get('geolocation', '?')}\")
else:
    print('NONE')
")

OfferID=$(echo "$OFFER_OUTPUT" | head -1)
OfferPrice=$(echo "$OFFER_OUTPUT" | tail -1)

if [ "$OfferID" = "NONE" ] || [ -z "$OfferID" ]; then
    echo "❌ No suitable RTX 3060 found"
    exit 1
fi

echo "✅ Found: $OfferPrice"
echo ""
echo "Launching instance (offer ID: $OfferID)..."

# Create instance
RESULT=$(curl -s -X PUT "https://console.vast.ai/api/v0/asks/$OfferID/" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d "{
    \"client_id\": \"me\",
    \"image\": \"nvidia/cuda:12.2.0-devel-ubuntu22.04\",
    \"disk\": 50,
    \"label\": \"AR-1-Research-Platform\",
    \"onstart_cmd\": \"curl -fsSL $SCRIPT_URL | bash\",
    \"runtype\": \"ssh\",
    \"ssh\": true
  }")

CONTRACT_ID=$(echo "$RESULT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('new_contract','?'))")
echo "Contract ID: $CONTRACT_ID"

# Wait for instance
echo ""
echo "⏳ Waiting for instance to be ready (includes setup + tunnel)..."
echo "   This takes 5-15 minutes for full deployment..."
echo ""

for i in $(seq 1 90); do
  STATUS=$(curl -s "https://console.vast.ai/api/v0/instances/?id=$CONTRACT_ID" \
    -H "Authorization: Bearer $API_KEY" 2>/dev/null | python3 -c "
import sys, json
d = json.load(sys.stdin)
inst = d.get('instances', [{}])[0] if d.get('instances') else {}
print(inst.get('actual_status', '?'))
" 2>/dev/null || echo "?")
  
  echo "  [$i] $STATUS"
  
  if [ "$STATUS" = "running" ]; then
    echo ""
    echo "✅ Instance is running!"
    break
  fi
  
  if [ "$STATUS" = "exited" ] || [ "$STATUS" = "failed" ]; then
    echo "❌ Instance failed"
    exit 1
  fi
  
  sleep 10
done

# Get connection info
IP=$(curl -s "https://console.vast.ai/api/v0/instances/?id=$CONTRACT_ID" \
  -H "Authorization: Bearer $API_KEY" 2>/dev/null | python3 -c "
import sys, json
d = json.load(sys.stdin)
inst = d.get('instances', [{}])[0] if d.get('instances') else {}
print(inst.get('public_ipaddr', '?'))
" 2>/dev/null)

SSH_PORT=$(curl -s "https://console.vast.ai/api/v0/instances/?id=$CONTRACT_ID" \
  -H "Authorization: Bearer $API_KEY" 2>/dev/null | python3 -c "
import sys, json
d = json.load(sys.stdin)
inst = d.get('instances', [{}])[0] if d.get('instances') else {}
print(inst.get('ssh_port', '?'))
" 2>/dev/null)

echo ""
echo "Waiting for tunnel setup..."
sleep 30

# Get tunnel URL from instance
TUNNEL_URL=$(ssh -o StrictHostKeyChecking=no -o ConnectTimeout=5 -p "$SSH_PORT" "root@$IP" "cat /tmp/ar1-status.json 2>/dev/null" 2>/dev/null | python3 -c "import sys,json; print(json.load(sys.stdin).get('public_url','?'))" 2>/dev/null || echo "")

echo ""
echo "================================================================"
echo "✅ DEPLOYMENT COMPLETE"
echo "================================================================"
echo ""
echo "Instance Details:"
echo "  Contract ID: $CONTRACT_ID"
echo "  IP: $IP"
echo "  SSH: ssh root@$IP -p $SSH_PORT"
echo ""
if [ -n "$TUNNEL_URL" ] && [ "$TUNNEL_URL" != "?" ]; then
  echo "Public URL: $TUNNEL_URL"
else
  echo "Public URL: Setting up... Check /tmp/tunnel-url.txt on the instance"
  echo "Or access via SSH tunnel: ssh -L 3000:localhost:3000 root@$IP -p $SSH_PORT"
  echo "Then visit: http://localhost:3000"
fi
echo ""
echo "Admin Credentials:"
echo "  Email: admin@example.com"
echo "  Password: jkp93p"
echo ""
echo "⚠️  Change these credentials immediately after first login!"
echo "================================================================"
