# Quick Reference Card

## 🔑 Login
- **URL**: http://localhost:3000
- **Email**: admin@example.com
- **Password**: jkp93p

## 🚀 Quick Start (3 Steps)

### 1️⃣ Setup Agents (2 minutes)
1. Go to **Agents** tab
2. Click **+ New Agent** (create 6, one per role)
3. For each:
   - Name: "My [Role] Agent"
   - Provider: OpenAI (or your choice)
   - API Key: Your key
   - Click **Load Models**
   - Model: gpt-4 (or available)
   - Role: Select role
   - Order: 1 (for priority)

**Create these 6 agents:**
- Planning Agent (order: 1)
- Implementation Agent (order: 2)
- Execution Agent (order: 3)
- Verification Agent (order: 4)
- Grading Agent (order: 5)
- Thinking Agent (order: 6)

### 2️⃣ Create Space (1 minute)
1. Go to **Spaces** tab
2. Click **+ New Space**
3. Name: "My Research"
4. Initial Prompt: "Explore novel approaches to [your interest]"
5. Click **Create Space**

### 3️⃣ Start Researching
1. Click on space card
2. Click **Start** button
3. Check **Dashboard** for updates
4. Watch breakthroughs appear!

## 📊 Dashboard Insights

**Key Metrics:**
- **Total Tokens**: AI API usage
- **Experiments**: Research iterations
- **Breakthroughs**: Verified findings
- **Spaces**: Active research areas

**What to watch:**
- High experiment count = active research
- Verified breakthroughs = major discoveries
- Token costs = budget management

## 🤖 Agent Tips

**Best Models per Role:**
- Planning/Thinking: GPT-4 or Claude-3-Opus
- Implementation: GPT-4 or Claude-3-Sonnet
- Execution: GPT-3.5 or Claude-3-Haiku
- Verification/Grading: GPT-4 or Claude-3-Opus

**Priority System:**
- Order 1 = First choice
- Order 2 = Backup
- Order 3+ = Additional backups

## 🎯 Space Management

**Status Meanings:**
- **INITIALIZING**: Ready to start
- **RUNNING**: Active research
- **PAUSED**: Temporarily stopped
- **STOPPED**: Ended

**Actions:**
- **Start**: Begin from Planning phase
- **Run Cycle**: Execute next phase only
- **Pause**: Stop temporarily
- **Stop**: End research

## ⚙️ Admin Features

**User Management:**
- Enable/disable accounts
- Promote to admin
- Delete users

**Settings:**
- Toggle registration (on/off)
- Controls new account creation

## 💰 Cost Management

**Track spending:**
- Check Dashboard for total costs
- Monitor tokens per space
- Use cheaper models for execution

**Optimization:**
- GPT-3.5 for Execution: ~$0.002/1K tokens
- GPT-4 for Planning: ~$0.03/1K tokens
- Budget ~$1-5/day for active research

## 🔍 Monitoring Research

**Signs of progress:**
- Experiments increasing
- Breakthroughs appearing
- Phase cycling (check space details)

**Troubleshooting:**
- No progress? Check agent API keys
- Stuck on phase? Ensure agent exists for that role
- High costs? Switch to cheaper models

## 📝 Research Prompt Tips

**Good prompts are:**
- Specific: "Optimize transformer attention mechanisms"
- Measurable: "Reduce computation by 50%"
- Open-ended: "Explore novel architectures"

**Bad prompts are:**
- Vague: "Make AI better"
- Too broad: "Solve AGI"
- Yes/no: "Is GPT good?"

## 🎨 UI Navigation

**Top Navigation:**
- Dashboard → Overview & stats
- Spaces → Research workspaces
- Agents → AI configurations
- Admin → User management (admin only)

**Space Modal:**
- Stats: Phase, experiments, tokens
- Actions: Start, pause, stop
- Breakthroughs: List of findings
- Experiments: Recent activity log

## 🔐 Security

**Keep safe:**
- Don't share API keys
- Use strong passwords
- Monitor admin users
- Disable registration when not needed

## ⚡ Pro Tips

1. **Multiple Spaces**: Run parallel research on different topics
2. **Agent Backups**: Create 2-3 agents per role for reliability
3. **Check Daily**: Review breakthroughs and adjust strategy
4. **Learn from Results**: Read experiment logs for insights
5. **Iterate Prompts**: Refine based on early results

## 🆘 Common Issues

**"No agents configured"**
→ Create agents for all 6 roles

**"Invalid credentials"**
→ Check email/password, reset if needed

**"Registration disabled"**
→ Toggle on in Admin > Settings

**"Failed to fetch models"**
→ Check API key is valid and has credits

**"No agent for phase"**
→ Create agent for missing role

## 📞 Support

Check these docs:
- README.md - Full documentation
- QUICKSTART.md - Detailed setup guide
- PLATFORM_SUMMARY.md - Complete feature list

## 🎯 Daily Workflow

**Morning:**
1. Check Dashboard
2. Review new breakthroughs
3. Check agent activity

**During day:**
1. Monitor space progress
2. Adjust agents if needed
3. Create new spaces for new ideas

**Evening:**
1. Review day's experiments
2. Pause active spaces if done
3. Plan next steps

---

**Remember**: The platform works autonomously once configured. Set it up, start spaces, and let the agents discover!
