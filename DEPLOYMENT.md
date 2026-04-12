# AR-1 Research Platform - Deployment Guide

## 🚀 Quick Deploy to Vast.ai

### Option 1: Automated Launch (Recommended)

```bash
# Clone repository
git clone https://github.com/Fenkins/AR-1.git
cd AR-1

# Make launch script executable
chmod +x deploy/vast-ai-launch.py

# Run launcher (requires Python 3)
python3 deploy/vast-ai-launch.py
```

This will:
1. Find the cheapest RTX 3060 on Vast.ai
2. Launch instance with auto-setup
3. Deploy AR-1 platform
4. Return access URL

### Option 2: Manual Vast.ai Setup

1. **Go to** [Vast.ai Console](https://console.vast.ai)
2. **Search** for "RTX 3060" instances
3. **Select** an available instance (look for Ubuntu 22.04 template)
4. **Launch** with these settings:
   - Image: `nvidia/cuda:12.2.0-devel-ubuntu22.04`
   - Disk: 50GB
   - SSH: Enabled

5. **SSH into instance**:
```bash
ssh root@YOUR_INSTANCE_IP -p PORT
```

6. **Run setup script**:
```bash
curl -fsSL https://raw.githubusercontent.com/Fenkins/AR-1/main/deploy/vast-ai-setup.sh | bash
```

7. **Access platform** at `http://YOUR_IP:3000`

## 🔑 Admin Credentials

**DO NOT use default credentials in production!**

After first login:
1. Create your own admin account
2. Delete the default admin
3. Change JWT_SECRET in .env

## 🐳 Docker Deployment

### Local Development

```bash
# Build and run
docker-compose up -d

# View logs
docker-compose logs -f

# Stop
docker-compose down
```

### Production with Docker

```bash
# Set environment variables
export JWT_SECRET="your-secret-here"

# Build and deploy
docker-compose -f docker-compose.yml up -d --build
```

## ⚙️ Configuration

### Environment Variables

Create `.env` file:

```env
DATABASE_URL="file:./prisma/dev.db"
JWT_SECRET="change-this-to-random-string"
NEXTAUTH_SECRET="change-this-too"
NEXTAUTH_URL="http://your-domain.com"

# Optional: API Keys for testing
OPENAI_API_KEY="sk-..."
ANTHROPIC_API_KEY="sk-ant-..."
```

### FAISS Knowledge Base

The platform includes FAISS integration for scientific paper search:

```bash
# Knowledge base location
/opt/AR-1/knowledge-base/

# Add papers (example)
python3 scripts/add-paper.py --url "https://arxiv.org/..." --tags "transformer,attention"
```

## 🔧 GPU/CUDA Setup

For CUDA acceleration in sandboxes:

```bash
# Verify CUDA
nvidia-smi

# Install CUDA toolkit (if needed)
apt-get install -y nvidia-cuda-toolkit

# Test in Python
python3 -c "import torch; print(torch.cuda.is_available())"
```

## 📊 Monitoring

### Check Service Status

```bash
systemctl status ar1-platform
journalctl -u ar1-platform -f
```

### Resource Usage

```bash
# GPU usage
nvidia-smi

# Memory
free -h

# Disk
df -h
```

## 🔄 Updates

```bash
# Pull latest code
cd /opt/AR-1
git pull origin main

# Rebuild
npm run build

# Restart
systemctl restart ar1-platform
```

## 🛡️ Security Checklist

- [ ] Change JWT_SECRET
- [ ] Change NEXTAUTH_SECRET
- [ ] Delete default admin account
- [ ] Enable HTTPS (use nginx + certbot)
- [ ] Set up firewall (ufw)
- [ ] Regular backups
- [ ] Monitor API key usage
- [ ] Review agent configurations

## 🆘 Troubleshooting

### "Thinking Agent Setup Failed"

**Problem**: Error when clicking "Start Thinking Agent Setup"

**Solutions**:
1. Ensure you have a THINKING agent configured
2. Verify API key is valid and has credits
3. Check server logs: `journalctl -u ar1-platform -f`
4. Test API key manually with provider

### Service Won't Start

```bash
# Check logs
journalctl -u ar1-platform -n 50

# Test manually
cd /opt/AR-1
npm start

# Check port
ss -tlnp | grep 3000
```

### Database Errors

```bash
# Reset database (WARNING: deletes all data)
cd /opt/AR-1
npx prisma db push --force-reset
npm run seed
```

### GPU Not Detected

```bash
# Check drivers
nvidia-smi

# If not found, reinstall drivers
apt-get install -y nvidia-driver-535
reboot
```

## 📞 Support

- **GitHub Issues**: https://github.com/Fenkins/AR-1/issues
- **Documentation**: See README.md and QUICKSTART.md
- **Vast.ai Docs**: https://vast.ai/docs

## 🎯 Next Steps After Deployment

1. **Access** the platform at your instance URL
2. **Login** with admin credentials
3. **Create** your personal admin account
4. **Delete** the default admin
5. **Configure** AI agents with your API keys
6. **Create** your first research space
7. **Start** researching!

---

**Repository**: https://github.com/Fenkins/AR-1
**License**: MIT
