#!/usr/bin/env bash
# AR-3 Research Platform - Vast.ai Setup with Public URL
# This script runs ON the Vast.ai instance
# Pulls latest code on each boot so updates are applied without recreating instance

set -e
echo "=== AR-3 Setup starting at $(date) ==="

export DEBIAN_FRONTEND=noninteractive

# System packages
echo "[1/8] Installing system packages..."
apt-get update -qq
apt-get install -y -qq curl git nginx wget unzip > /dev/null 2>&1

# Node.js 22
echo "[2/8] Installing Node.js 22..."
curl -fsSL https://deb.nodesource.com/setup_22.x | bash - > /dev/null 2>&1
apt-get install -y -qq nodejs > /dev/null 2>&1
echo "Node: $(node --version), npm: $(npm --version)"

# Clone or update AR-3
echo "[3/8] Setting up AR-3..."
cd /opt
if [ -d "AR-3" ]; then
    echo "AR-3 directory exists, pulling latest..."
    cd AR-3
    git pull origin main
else
    echo "Cloning AR-3 fresh..."
    git clone https://github.com/Fenkins/AR-3.git
    cd AR-3
fi

# Install deps
echo "[4/8] Installing npm packages..."
npm install --silent 2>/dev/null

# Database
echo "[5/8] Setting up database..."
echo 'DATABASE_URL="file:./dev.db"' > .env
npx prisma generate
npx prisma db push
npm run seed

# Build
echo "[6/8] Building..."
npm run build

# Install cloudflared for public tunnel
echo "[7/8] Setting up public access tunnel..."
wget -q https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 -O /usr/local/bin/cloudflared
chmod +x /usr/local/bin/cloudflared

# Nginx config
cat > /etc/nginx/sites-available/ar1 <<'EOF'
server {
    listen 3000;
    location / {
        proxy_pass http://localhost:3001;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
    }
}
EOF
ln -sf /etc/nginx/sites-available/ar1 /etc/nginx/sites-enabled/
rm -f /etc/nginx/sites-enabled/default
systemctl restart nginx 2>/dev/null || true

# Kill any existing app process
pkill -f "node.*next" 2>/dev/null || true
pkill -f "npm start" 2>/dev/null || true
sleep 2

# Start the app on port 3001
echo "Starting AR-3 on port 3001..."
cd /opt/AR-3
PORT=3001 nohup npm start > /var/log/ar1.log 2>&1 &
APP_PID=$!
echo "App PID: $APP_PID"

sleep 3

# Create cloudflared tunnel config
cat > /opt/cloudflared-config.yml <<EOF
tunnel: ar1-$(hostname)
credentials-file: /root/.cloudflared/credentials.json
ingress:
  - hostname: ""
    service: http://localhost:3001
  - service: http_status:404
EOF

# Start cloudflared quick tunnel (no auth needed)
echo "Starting Cloudflare quick tunnel..."
pkill -f cloudflared 2>/dev/null || true
sleep 1
nohup cloudflared tunnel --url http://localhost:3001 --logfile /var/log/cloudflared.log > /tmp/tunnel-url.txt 2>&1 &
sleep 10

# Extract tunnel URL
TUNNEL_URL=$(grep -oP 'https://[a-z0-9-]+\.trycloudflare\.com' /tmp/tunnel-url.txt 2>/dev/null || echo "")

echo ""
echo "=== AR-3 Setup Complete ==="
echo "Date: $(date)"
echo "App: http://localhost:3000 (nginx) or http://localhost:3001 (direct)"
echo "Public URL: $TUNNEL_URL"
echo ""

# Save status
cat > /tmp/ar1-status.json <<EOJSON
{
  "status": "ready",
  "timestamp": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "local_port": 3000,
  "direct_port": 3001,
  "public_url": "$TUNNEL_URL",
  "app_pid": $APP_PID
}
EOJSON

# Keep script alive
echo "Waiting for tunnel URL to stabilize..."
for i in $(seq 1 30); do
  CURRENT_URL=$(grep -oP 'https://[a-z0-9-]+\.trycloudflare\.com' /tmp/tunnel-url.txt 2>/dev/null | tail -1)
  if [ -n "$CURRENT_URL" ]; then
    TUNNEL_URL="$CURRENT_URL"
    echo "Public URL: $TUNNEL_URL"
    # Update status file
    cat > /tmp/ar1-status.json <<EOJSON2
{
  "status": "ready",
  "timestamp": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "local_port": 3000,
  "direct_port": 3001,
  "public_url": "$TUNNEL_URL",
  "app_pid": $APP_PID
}
EOJSON2
    break
  fi
  sleep 3
done

echo "=== Setup finished ==="

# Wait forever to keep onstart script running
wait $APP_PID
