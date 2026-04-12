# Manual Vast.ai Deployment Guide

## Quick Deploy to Vast.ai (RTX 3060)

Since the Vast.ai search API requires authentication, follow these manual steps:

### Step 1: Launch Instance

1. **Go to** [https://console.vast.ai](https://console.vast.ai)
2. **Login** with your account
3. **Search** for: `RTX 3060`
4. **Filter** by:
   - Type: On-Demand
   - Available: Yes
   - Sort by: Price (lowest first)

### Step 2: Configure Instance

Select an RTX 3060 instance and configure:

**Basic Settings:**
- **Image**: `nvidia/cuda:12.2.0-devel-ubuntu22.04`
- **Disk**: 40 GB
- **Label**: `AR-1-Research`
- **SSH**: ✅ Enabled

**On-Start Script** (paste this):
```bash
#!/bin/bash
set -e

echo "=== AR-1 Research Platform Setup ==="

# Install dependencies
apt-get update -qq
apt-get install -y -qq curl git

# Install Node.js 22
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y -qq nodejs

# Clone and setup AR-1
cd /tmp
git clone https://github.com/Fenkins/AR-1.git
cd AR-1

# Install and build
npm install --silent
npx prisma generate
npx prisma db push
npm run seed

echo "=== Setup Complete ==="

# Start the application
npm start
```

### Step 3: Launch & Wait

1. Click **Launch**
2. Wait 5-10 minutes for setup
3. Instance will show "Running" when ready

### Step 4: Access Platform

Once running:
- **URL**: `http://YOUR_INSTANCE_IP:3000`
- **SSH**: `ssh root@YOUR_INSTANCE_IP -p SSH_PORT`

**Admin Credentials:**
- Email: `admin@example.com`
- Password: `jkp93p`

⚠️ **IMPORTANT**: Change these credentials immediately after first login!

## Post-Deployment Checklist

After accessing the platform:

1. ✅ **Create your own admin account**
   - Go to login page
   - Register new account
   - Login with new account

2. ✅ **Delete default admin**
   - Go to Admin panel
   - Delete `admin@example.com`

3. ✅ **Configure Service Providers**
   - Go to Providers tab (🔑)
   - Add OpenAI/Anthropic/API keys
   - Test each key

4. ✅ **Create Agents**
   - Go to Agents tab (🤖)
   - Create agents for each role
   - Use your configured providers

5. ✅ **Create Research Space**
   - Go to Spaces tab (🔬)
   - Create your first space
   - Start researching!

## Managing Your Instance

### Check Status
```bash
# SSH into instance
ssh root@INSTANCE_IP -p PORT

# Check if running
systemctl status ar1-platform

# View logs
journalctl -u ar1-platform -f

# Check GPU
nvidia-smi
```

### Restart Service
```bash
systemctl restart ar1-platform
```

### Update Platform
```bash
cd /tmp/AR-1
git pull origin main
npm install
npm run build
systemctl restart ar1-platform
```

### Stop Instance
- Go to [Vast.ai Console](https://console.vast.ai)
- Find your instance
- Click "Stop" or "Destroy"

## GPU Testing

To verify CUDA is working:

```bash
# SSH into instance
ssh root@INSTANCE_IP -p PORT

# Check GPU
nvidia-smi

# Test in Python (if needed for sandboxes)
python3 -c "import torch; print('CUDA:', torch.cuda.is_available())"
```

## Troubleshooting

### Platform Won't Start
```bash
# Check logs
journalctl -u ar1-platform -n 50

# Manual start
cd /tmp/AR-1
npm start
```

### Database Errors
```bash
cd /tmp/AR-1
npx prisma db push --force-reset
npm run seed
systemctl restart ar1-platform
```

### Can't Access Port 3000
```bash
# Check if running
ss -tlnp | grep 3000

# Check firewall
ufw status

# Allow port
ufw allow 3000
```

## Cost Management

RTX 3060 instances typically cost **$0.10-$0.20/hour**

**To minimize costs:**
- Stop instance when not in use
- Destroy when done testing
- Monitor usage in Vast.ai console

## Security Notes

⚠️ **Critical Security Steps:**

1. Change default admin credentials immediately
2. Don't expose port 3000 to public internet (use SSH tunnel or VPN)
3. Regularly update the platform
4. Monitor instance usage
5. Destroy instance when done

**SSH Tunnel (More Secure):**
```bash
# Access via SSH tunnel instead of direct HTTP
ssh -L 3000:localhost:3000 root@INSTANCE_IP -p PORT

# Then access locally:
# http://localhost:3000
```

## Support

- **GitHub Issues**: https://github.com/Fenkins/AR-1/issues
- **Vast.ai Docs**: https://vast.ai/docs
- **Repository**: https://github.com/Fenkins/AR-1

---

**Expected Setup Time**: 5-10 minutes
**Cost**: ~$0.15/hour for RTX 3060
**Access**: http://INSTANCE_IP:3000
