#!/bin/bash
# AR-1 Research Platform - Vast.ai Instance Creation Script
# This script runs ON the Vast.ai instance after it boots

set -e

echo "=== AR-1 Research Platform - Instance Setup ==="
echo "Started at: $(date)"

# Install dependencies
echo "[1/6] Installing system dependencies..."
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl git nginx python3 python3-pip > /dev/null 2>&1

# Install Node.js 22
echo "[2/6] Installing Node.js 22..."
curl -fsSL https://deb.nodesource.com/setup_22.x | bash - > /dev/null 2>&1
apt-get install -y -qq nodejs > /dev/null 2>&1
echo "Node.js version: $(node --version)"
echo "npm version: $(npm --version)"

# Clone and setup AR-1
echo "[3/6] Cloning AR-1 repository..."
cd /opt
git clone https://github.com/Fenkins/AR-1.git
cd /opt/AR-1

# Install dependencies
echo "[4/6] Installing npm packages..."
npm install --silent

# Setup database
echo "[5/6] Setting up database..."
npx prisma generate
npx prisma db push
npm run seed

# Build
echo "[6/6] Building application..."
npm run build

# Configure nginx for Vast.ai port mapping detection
echo "Configuring nginx..."
cat > /etc/nginx/sites-available/ar1 <<'EOF'
server {
    listen 80;
    server_name _;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 86400;
    }
}
EOF

ln -sf /etc/nginx/sites-available/ar1 /etc/nginx/sites-enabled/
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl restart nginx

# Create systemd service
echo "Creating systemd service..."
cat > /etc/systemd/system/ar1-platform.service <<EOF
[Unit]
Description=AR-1 Research Platform
After=network.target nginx.service

[Service]
Type=simple
User=root
WorkingDirectory=/opt/AR-1
Environment=NODE_ENV=production
Environment=NEXTAUTH_URL=http://localhost
ExecStart=/usr/bin/npm start
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable ar1-platform
systemctl start ar1-platform

# Get public IP and port info
echo "=== Setup Complete ==="
echo "Completed at: $(date)"
echo ""
echo "Service Status:"
systemctl status ar1-platform --no-pager -l | head -20
echo ""
echo "Nginx Status:"
systemctl status nginx --no-pager -l | head -10
echo ""
echo "Listening ports:"
ss -tlnp | grep -E '(3000|80)' || true

# Create a status file for the launcher to read
cat > /tmp/deployment-status.json <<EOJSON
{
  "status": "ready",
  "timestamp": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "local_url": "http://localhost:3000",
  "nginx_url": "http://localhost:80"
}
EOJSON

echo ""
echo "AR-1 Platform is ready!"
echo "Access via the Vast.ai instance URL (port 80 or 3000)"
