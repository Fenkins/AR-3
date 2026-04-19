#!/usr/bin/env bash
# AR-3 Research Platform — Vast.ai Setup with Public URL
# Runs ON the Vast.ai instance on each boot
# Applies ALL learned fixes: SearXNG, GPU worker, HF token, search service

set -e
echo "=== AR-3 Setup starting at $(date) ==="

export DEBIAN_FRONTEND=noninteractive
AR3_DIR="/opt/AR-3"
AR3_FRESH="/opt/AR-3-fresh"

# ── 1. System packages ─────────────────────────────────────────────────────────
echo "[1/14] Installing system packages..."
apt-get update -qq
apt-get install -y -qq curl git nginx wget unzip python3 python3-pip python3-venv > /dev/null 2>&1

# ── 2. Node.js 22 ──────────────────────────────────────────────────────────────
echo "[2/14] Installing Node.js 22..."
curl -fsSL https://deb.nodesource.com/setup_22.x | bash - > /dev/null 2>&1
apt-get install -y -qq nodejs > /dev/null 2>&1
echo "Node: $(node --version)"

# ── 3. SearXNG (if not present) ────────────────────────────────────────────────
echo "[3/14] Setting up SearXNG..."
if [ ! -d "$AR3_DIR/searxng" ]; then
    git clone --depth=1 https://github.com/searxng/searxng.git "$AR3_DIR/searxng"
fi
cd "$AR3_DIR/searxng"
pip install -q -r requirements.txt 2>/dev/null

# SearXNG settings with limiter disabled + duckduckgo + huggingface
mkdir -p /etc/searxng
cat > /etc/searxng/settings.yml <<'SEARXNG_CONFIG'
use_default_settings: true

general:
  instance_name: "AR-3 Research"
  debug: false
  autoload_plugins: false

server:
  secret_key: "ar3-searxng-secret-CHANGE-ME"
  bind_address: "127.0.0.1"
  port: 4001
  limiter: false
  public_instance: false

search:
  safe_search: 0
  autocomplete: ""
  default_lang: "en"
  formats:
    - html
    - json

brand:
  issue_url: "https://github.com/FenkIn/AR-3/issues"
  public_instances: ""

outgoing:
  request_timeout: 10.0
  max_request_timeout: 30.0

engines:
  - name: wikipedia
    engine: wikipedia
    shortcut: w
  - name: huggingface
    engine: huggingface
    shortcut: hf
  - name: duckduckgo
    engine: duckduckgo
    shortcut: ddg
SEARXNG_CONFIG

# ── 4. SearXNG search service (port 4001) ─────────────────────────────────────
# Kill existing SearXNG
pkill -f "searx.*webapp\|flask.*searx" 2>/dev/null || true
sleep 1
# Start SearXNG
cd "$AR3_DIR/searxng"
nohup python3 -m flask --app searx.webapp run --host 127.0.0.1 --port 4001 > /tmp/searxng.log 2>&1 &
echo "SearXNG PID: $!"
sleep 3

# ── 5. Python search service (port 4000) — HF/GitHub/arXiv ──────────────────
echo "[5/14] Setting up Python search service (port 4000)..."
if [ -f "$AR3_DIR/scripts/search_service.py" ]; then
    pkill -f "search_service.py" 2>/dev/null || true
    nohup python3 "$AR3_DIR/scripts/search_service.py" > /tmp/search_service.log 2>&1 &
    echo "Search service PID: $!"
fi
sleep 1

# ── 6. Clone / update AR-3 ─────────────────────────────────────────────────────
echo "[6/14] Setting up AR-3..."
cd /opt
if [ -d "$AR3_FRESH" ]; then
    echo "Using existing AR-3-fresh..."
else
    git clone https://github.com/Fenkins/AR-3.git "$AR3_FRESH"
fi
cd "$AR3_FRESH"
git pull origin main

# ── 7. npm install + prisma ───────────────────────────────────────────────────
echo "[7/14] Installing npm packages..."
npm install --silent 2>/dev/null
npx prisma generate

# ── 8. .env configuration ──────────────────────────────────────────────────────
echo "[8/14] Writing .env configuration..."
INTERNAL_SECRET=$(python3 -c "import secrets; print(secrets.token_hex(16))")
HF_TOKEN="${HF_TOKEN:-}"
cat > "$AR3_FRESH/.env" <<ENVEOF
DATABASE_URL="file:./prisma/prisma/dev.db"
NEXTAUTH_URL="http://localhost:3000"
NEXTAUTH_SECRET="$INTERNAL_SECRET"
INTERNAL_API_SECRET="$INTERNAL_SECRET"
HF_TOKEN="$HF_TOKEN"
ENVEOF
echo ".env written (HF_TOKEN masked: ${HF_TOKEN:0:8}...)"

# ── 9. Database setup ───────────────────────────────────────────────────────────
echo "[9/14] Setting up database..."
mkdir -p "$AR3_FRESH/prisma/prisma"
npx prisma db push --skip-generate 2>/dev/null || true
npm run seed 2>/dev/null || true

# ── 10. Build Next.js ──────────────────────────────────────────────────────────
echo "[10/14] Building Next.js..."
npm run build

# ── 11. GPU Worker setup ───────────────────────────────────────────────────────
echo "[11/14] Setting up GPU worker..."
if [ -f "$AR3_FRESH/scripts/gpu_worker.py" ]; then
    pkill -f "gpu_worker.py" 2>/dev/null || true
    nohup python3 "$AR3_FRESH/scripts/gpu_worker.py" > /tmp/gpu_worker.log 2>&1 &
    echo "GPU worker PID: $!"
fi

# ── 12. Nginx ──────────────────────────────────────────────────────────────────
echo "[12/14] Configuring nginx..."
cat > /etc/nginx/sites-available/ar3 <<'NGINX_EOF'
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
NGINX_EOF
ln -sf /etc/nginx/sites-available/ar3 /etc/nginx/sites-enabled/
rm -f /etc/nginx/sites-enabled/default
systemctl restart nginx 2>/dev/null || true

# ── 13. Kill existing, start fresh on port 3001 ────────────────────────────────
echo "[13/14] Starting Next.js on port 3001..."
pkill -f "node.*next" 2>/dev/null || true
pkill -f "npm start" 2>/dev/null || true
sleep 2
PORT=3001 nohup npm start > /tmp/nextjs.log 2>&1 &
echo "Next.js PID: $!"
sleep 4

# ── 14. Cloudflared tunnel ─────────────────────────────────────────────────────
echo "[14/14] Setting up Cloudflare tunnel..."
wget -q https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 -O /usr/local/bin/cloudflared
chmod +x /usr/local/bin/cloudflared
pkill -f cloudflared 2>/dev/null || true
sleep 1
nohup cloudflared tunnel --url http://localhost:3001 --logfile /tmp/cloudflared.log > /tmp/cloudflared_out.log 2>&1 &
sleep 10
TUNNEL_URL=$(grep -oP 'https://[a-z0-9-]+\.trycloudflare\.com' /tmp/cloudflared_out.log 2>/dev/null | tail -1 || echo "")

# ── Health checks ───────────────────────────────────────────────────────────────
echo ""
echo "=== Health Checks ==="
sleep 2

check_port() {
    local port=$1
    local name=$2
    if curl -sf "http://127.0.0.1:$port/healthz" > /dev/null 2>&1 || curl -sf "http://127.0.0.1:$port" > /dev/null 2>&1; then
        echo "  $name (port $port): OK"
    else
        echo "  $name (port $port): FAIL"
    fi
}

check_port 3000 "Next.js (via nginx)"
check_port 3001 "Next.js (direct)"
check_port 4000 "Search service"
check_port 4001 "SearXNG"

if nvidia-smi > /dev/null 2>&1; then
    echo "  GPU (nvidia-smi): OK"
else
    echo "  GPU (nvidia-smi): NOT DETECTED"
fi

echo ""
echo "=== AR-3 Setup Complete ==="
echo "Date: $(date)"
echo "Public URL: ${TUNNEL_URL:-pending}"
echo ""
echo "Admin credentials (change these!):"
echo "  Email: admin@example.com"
echo "  Password: jkp93p"
echo ""

# Save status
cat > /tmp/ar3-status.json <<EOJSON
{
  "status": "ready",
  "timestamp": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "public_url": "${TUNNEL_URL:-}",
  "ports": {
    "nextjs": 3001,
    "nginx": 3000,
    "search": 4000,
    "searxng": 4001
  }
}
EOJSON

# Keep onstart running
echo "Setup done, waiting for instance keep-alive..."
wait
