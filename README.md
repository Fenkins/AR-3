# AR-2 Research Platform

**Autonomous Research Platform with Stage-Based Workflow, Variants, and Multi-Agent Orchestration**

[![GitHub](https://img.shields.io/badge/GitHub-AR--1-blue)](https://github.com/Fenkins/AR-2)
[![License](https://img.shields.io/badge/License-MIT-green)](LICENSE)

## Overview

AR-1 is an interactive research platform that enables autonomous agent-driven software invention and discovery. It features a dynamic stage-based workflow with variant exploration, intelligent grading, and user feedback integration.

## ✨ Features

### 🎯 Stage-Based Research Workflow
- **7 Default Stages**: Investigation → Proposition → Planning → Implementation → Testing → Verification → Evaluation
- **Customizable Pipeline**: Add, remove, edit, and reorder stages
- **Thinking Agent Orchestration**: AI-powered initial setup and auto-mode
- **Visual Progress Tracking**: Real-time stage execution monitoring

### 🎲 Variant Exploration
- **Multiple Approaches**: Generate 2-5 variants per stage
- **Intelligent Grading**: Each variant graded 1-100 by evaluation agent
- **User Feedback**: Rate variants and steps (👍/👎)
- **Automatic Selection**: Best variant advances to next stage
- **Step-Level Control**: Configure steps per variant (auto or manual)

### 🤖 Multi-Agent System
- **8 Agent Roles**: Thinking, Investigation, Proposition, Planning, Implementation, Testing, Verification, Evaluation
- **5 AI Providers**: OpenAI, Anthropic, Google, OpenRouter, MiniMax
- **Priority System**: Order-based agent selection
- **Dynamic Model Fetching**: Automatic model listing from providers

### 📊 Comprehensive Dashboard
- Real-time statistics and metrics
- Token usage tracking
- Cost analysis
- Breakthrough detection and verification
- Experiment history with ratings

### 🔐 User Management
- Secure authentication (JWT + bcrypt)
- Role-based access control
- Admin panel for user management
- Registration toggle
- Account enable/disable

### 🧠 FAISS Integration
- Scientific paper knowledge base
- Semantic search capabilities
- Automatic citation and reference tracking
- Ready for research-grade information retrieval

## 🚀 Deployment

### Quick Deploy to Vast.ai (RTX 3060)

```bash
# Clone repository
git clone https://github.com/Fenkins/AR-2.git
cd AR-1

# Automated launch
python3 deploy/vast-ai-launch.py
```

See [DEPLOYMENT.md](DEPLOYMENT.md) for detailed instructions.

### Docker

```bash
docker-compose up -d
```

### Local Development

```bash
npm install
npx prisma generate
npx prisma db push
npm run seed
npm run dev
```

Visit http://localhost:3000

**⚠️ Security**: Change default admin credentials after first login!

## 📋 AI Agent Roles

| Role | Icon | Purpose |
|------|------|---------|
| Thinking | 🧠 | Orchestration, setup, auto-mode |
| Investigation | 🔍 | Research and exploration |
| Proposition | 💡 | Idea generation |
| Planning | 📋 | Strategy and planning |
| Implementation | ⚙️ | Building and creating |
| Testing | 🧪 | Validation and testing |
| Verification | ✓ | Result verification |
| Evaluation | ⭐ | Final assessment |

## 🎯 How It Works

1. **Create Space** → Define research goal with initial prompt
2. **Thinking Setup** → AI analyzes and configures optimal workflow
3. **Configure Agents** → Set up agents for each role
4. **Generate Variants** → Create multiple approaches per stage
5. **Execute & Grade** → Run variants, get grades 1-100
6. **Select Best** → Top-rated variant advances
7. **Iterate** → Cycle through stages, building on findings
8. **Discover** → Evaluation stage detects breakthroughs

## 🛠️ Tech Stack

- **Frontend**: Next.js 14, React 18, TypeScript, Tailwind CSS
- **Backend**: Next.js API Routes, Prisma ORM
- **Database**: SQLite (development), PostgreSQL-ready
- **AI**: OpenAI SDK, Anthropic SDK, Google Generative AI
- **Search**: FAISS (Facebook AI Similarity Search)
- **Deployment**: Docker, Vast.ai compatible

## 📚 Documentation

- [DEPLOYMENT.md](DEPLOYMENT.md) - Deployment guide
- [QUICKSTART.md](QUICKSTART.md) - Getting started
- [QUICK_REFERENCE.md](QUICK_REFERENCE.md) - Tips and shortcuts
- [ARCHITECTURE.md](ARCHITECTURE.md) - System design
- [STAGE_WORKFLOW_UPDATE.md](STAGE_WORKFLOW_UPDATE.md) - Stage system details

## 🔒 Security Notes

- Never commit API keys or credentials
- Change JWT_SECRET in production
- Delete default admin account
- Use environment variables for secrets
- Enable HTTPS for production deployments

## 🤝 Contributing

1. Fork the repository
2. Create feature branch (`git checkout -b feature/amazing-feature`)
3. Commit changes (`git commit -m 'Add amazing feature'`)
4. Push to branch (`git push origin feature/amazing-feature`)
5. Open Pull Request

## 📄 License

MIT License - see [LICENSE](LICENSE) file

## 🌟 Acknowledgments

- Inspired by Karpathy's autoresearch concept
- Built for autonomous research and discovery
- Designed for GPU-accelerated sandboxes

---

**Repository**: https://github.com/Fenkins/AR-2  
**Issues**: https://github.com/Fenkins/AR-2/issues
