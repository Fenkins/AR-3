# Research Platform - Quick Start Guide

## 🚀 Getting Started

The platform is now running at **http://localhost:3000**

### Admin Credentials
- **Email**: `admin@example.com`
- **Password**: `jkp93p`

## 📋 Setup Steps

### 1. Login
Open your browser and navigate to http://localhost:3000
Login with the admin credentials above.

### 2. Configure AI Agents
Navigate to the **Agents** tab and create agents for each role:

**Recommended minimum setup:**
Create at least one agent for each of these roles:
- 📋 **Planning Agent** - Analyzes research goals
- ⚙️ **Implementation Agent** - Creates solutions
- ▶️ **Execution Agent** - Runs experiments
- ✓ **Verification Agent** - Validates results
- ⭐ **Grading Agent** - Evaluates findings
- 🧠 **Thinking Agent** - Deep analysis

**For each agent:**
1. Enter a descriptive name (e.g., "GPT-4 Planner")
2. Select a provider (OpenAI, Anthropic, Google, OpenRouter, MiniMax)
3. Enter your API key
4. Click "Load Models" to fetch available models
5. Select a model
6. Choose the agent role
7. Set priority order (lower = higher priority)

### 3. Create a Research Space
Navigate to the **Spaces** tab and click "+ New Space"

**Example research prompts:**
- "Explore novel neural network architectures for efficient language modeling"
- "Investigate new optimization algorithms for training large language models"
- "Design self-improving code generation systems"
- "Research emergent behaviors in multi-agent systems"

### 4. Start Research
1. Click on your space card
2. Review the space details
3. Click **Start** to begin the research cycle
4. Or click **Run Cycle** to execute a single phase

### 5. Monitor Progress
Use the **Dashboard** to view:
- Total tokens spent
- Experiments by phase
- Breakthroughs found
- Space statistics

## 🏗️ Architecture Overview

### Research Cycle
The platform follows a 6-phase research cycle:

1. **PLANNING** → Analyze goal, create research plan
2. **IMPLEMENTATION** → Design and implement approach
3. **EXECUTION** → Run and collect results
4. **VERIFICATION** → Validate and check results
5. **GRADING** → Evaluate significance and quality
6. **THINKING** → Deep analysis and synthesis

The cycle repeats continuously, building on previous findings.

### Agent Selection
- Multiple agents can be configured per role
- Lower "order" value = higher priority
- System picks the active agent with lowest order for each phase

## 🔧 Administration

Access the **Admin** tab (admin users only) to:

### Users Management
- **Promote/Demote**: Change user roles between USER and ADMIN
- **Disable/Enable**: Toggle user account status
- **Delete**: Remove user accounts (cannot delete your own)

### Settings
- **Registration Toggle**: Enable or disable new user registration
  - When disabled, only admins can create accounts via API

## 💡 Tips

1. **Start Small**: Begin with one good agent per role
2. **Use Quality Models**: Better models produce better research
3. **Clear Prompts**: Specific initial prompts lead to better results
4. **Monitor Breakthroughs**: Check the dashboard regularly for discoveries
5. **Agent Redundancy**: Consider backup agents for critical roles

## 🎯 Best Practices

### Agent Configuration
- Use high-quality models for Planning and Thinking agents
- Faster/cheaper models work for Execution and Verification
- Order agents by preference (1, 2, 3...)

### Research Spaces
- Be specific in your initial prompt
- Include evaluation criteria if relevant
- Define the scope clearly

### Managing Experiments
- Let the system run multiple cycles for best results
- Check breakthrough confidence levels
- Review experiment logs for insights

## 🔐 Security Notes

- API keys are stored in the database (consider encryption for production)
- Use environment variables for JWT_SECRET in production
- Enable registration toggle appropriately for your use case
- Monitor admin user list regularly

## 🛠️ Development Commands

```bash
# Start development server
npm run dev

# Build for production
npm run build

# Start production server
npm start

# Reset database (warning: deletes all data)
npx prisma db push --force-reset
npm run seed
```

## 📊 API Endpoints

**Authentication**
- `POST /api/auth/register` - User registration
- `POST /api/auth/login` - User login

**Agents**
- `GET /api/agents` - List user's agents
- `POST /api/agents` - Create agent
- `GET /api/agents/:id` - Get agent details
- `PUT /api/agents/:id` - Update agent
- `DELETE /api/agents/:id` - Delete agent
- `POST /api/models` - Fetch available models

**Spaces**
- `GET /api/spaces` - List user's spaces
- `POST /api/spaces` - Create space
- `GET /api/spaces/:id` - Get space details
- `POST /api/spaces/:id` - Execute action (start/cycle/pause/stop)
- `DELETE /api/spaces/:id` - Delete space

**Dashboard**
- `GET /api/dashboard` - Get dashboard statistics

**Admin** (requires ADMIN role)
- `GET /api/admin/users` - List all users
- `PATCH /api/admin/users/:id` - Update user (role/status)
- `DELETE /api/admin/users/:id` - Delete user
- `GET /api/admin/config` - Get system config
- `PUT /api/admin/config` - Update system config

## 🆘 Troubleshooting

**Can't see agents for a role?**
- Make sure you've created at least one agent for that role
- Check that the agent is marked as active

**Getting authentication errors?**
- Your token might have expired - logout and login again
- Check that the user account is still active

**Research cycle not progressing?**
- Ensure agents are configured for all phases
- Check agent API keys are valid
- Review experiment logs for errors

## 🎉 You're Ready!

The platform is now set up and ready for autonomous research. Start exploring new frontiers in software and algorithm design!
