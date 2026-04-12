# System Architecture

## High-Level Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                      CLIENT (Browser)                        │
│                                                               │
│  ┌──────────────┐ ┌──────────────┐ ┌─────────────────┐      │
│  │  Dashboard   │ │   Spaces     │ │    Agents       │      │
│  │   (Stats)    │ │  (Research)  │ │ (Configuration) │      │
│  └──────────────┘ └──────────────┘ └─────────────────┘      │
│                                                               │
│  ┌────────────────────────────────────────────────────┐     │
│  │         Authentication & Authorization             │     │
│  └────────────────────────────────────────────────────┘     │
└─────────────────────────────────────────────────────────────┘
                            ↕ HTTP/HTTPS
┌─────────────────────────────────────────────────────────────┐
│                  NEXT.JS APPLICATION SERVER                  │
│                                                               │
│  ┌────────────────────────────────────────────────────┐     │
│  │              API Routes Layer                       │     │
│  │  /api/auth  /api/agents  /api/spaces               │     │
│  │  /api/admin /api/models  /api/dashboard            │     │
│  └────────────────────────────────────────────────────┘     │
│                            ↕                                 │
│  ┌────────────────────────────────────────────────────┐     │
│  │            Business Logic Layer                     │     │
│  │  - Authentication (JWT, bcrypt)                    │     │
│  │  - Agent Selection (by role & priority)            │     │
│  │  - Research Engine (6-phase cycle)                 │     │
│  │  - Breakthrough Detection                          │     │
│  └────────────────────────────────────────────────────┘     │
│                            ↕                                 │
│  ┌────────────────────────────────────────────────────┐     │
│  │          AI Provider Integration                    │     │
│  │  OpenAI • Anthropic • Google • OpenRouter • MiniMax│     │
│  └────────────────────────────────────────────────────┘     │
└─────────────────────────────────────────────────────────────┘
                            ↕ Prisma ORM
┌─────────────────────────────────────────────────────────────┐
│                    DATABASE (SQLite)                         │
│                                                               │
│  ┌──────────┐ ┌────────┐ ┌───────┐ ┌───────────┐           │
│  │  Users   │ │ Agents │ │Spaces │ │Experiments│           │
│  └──────────┘ └────────┘ └───────┘ └───────────┘           │
│                                                               │
│  ┌──────────────┐ ┌────────────────┐                         │
│  │Breakthroughs │ │ SystemConfig   │                         │
│  └──────────────┘ └────────────────┘                         │
└─────────────────────────────────────────────────────────────┘
```

## Authentication Flow

```
User Login/Registration
        ↓
┌──────────────┐
│  Validate    │
│  Credentials │
└──────┬───────┘
       ↓
┌──────────────┐
│ Hash Password│ ← bcrypt (12 rounds)
└──────┬───────┘
       ↓
┌──────────────┐
│  Generate    │ ← JWT Token (7 day expiry)
│  JWT Token   │
└──────┬───────┘
       ↓
  Store in
  LocalStorage
       ↓
Include in
API Requests
(Bearer token)
```

## Research Cycle Flow

```
User Creates Space
    (Initial Prompt)
       ↓
┌──────────────────┐
│   PLANNING Phase │ ← Planning Agent
│  - Analyze goal  │
│  - Create plan   │
│  - Define steps  │
└────────┬─────────┘
         ↓
┌──────────────────┐
│ IMPLEMENTATION   │ ← Implementation Agent
│  - Design approach│
│  - Create code   │
│  - Define params │
└────────┬─────────┘
         ↓
┌──────────────────┐
│   EXECUTION      │ ← Execution Agent
│  - Run tests     │
│  - Collect data  │
│  - Log results   │
└────────┬─────────┘
         ↓
┌──────────────────┐
│  VERIFICATION    │ ← Verification Agent
│  - Validate      │
│  - Check accuracy│
│  - Find flaws    │
└────────┬─────────┘
         ↓
┌──────────────────┐
│    GRADING       │ ← Grading Agent
│  - Assess quality│
│  - Rate novelty  │
│  - Detect        │
│   breakthroughs  │──→ Create Breakthrough Record
└────────┬─────────┘
         ↓
┌──────────────────┐
│   THINKING       │ ← Thinking Agent
│  - Synthesize    │
│  - Find patterns │
│  - Generate new  │
│   hypotheses     │──→ Potential Breakthrough
└────────┬─────────┘
         ↓
   Cycle Repeats
   (Back to PLANNING)
```

## Agent Selection Algorithm

```
Input: Phase (e.g., "PLANNING")
Output: Selected Agent

┌────────────────────────┐
│ Get all active agents  │
│ for this role          │
└──────────┬─────────────┘
           ↓
┌────────────────────────┐
│ Sort by order          │
│ (ascending)            │
└──────────┬─────────────┘
           ↓
┌────────────────────────┐
│ Select first agent     │
│ (lowest order value)   │
└──────────┬─────────────┘
           ↓
     Return Agent
(Config: provider, key, model)
```

## Database Schema Relationships

```
User (1) ──────── (M) Agent
 │                        (userId)
 │
 ├──── (M) Space
 │         │
 │         ├──── (M) Experiment
 │         │         (spaceId)
 │         │
 │         └──── (M) Breakthrough
 │                   (spaceId)
 │
 ├──── (M) Experiment (optional)
 │         (userId)
 │
 └──── (M) Breakthrough (optional)
           (userId)
```

## API Request Flow

```
Client Request
(Bearer Token)
      ↓
┌─────────────────┐
│  Middleware:    │
│  - Extract     │
│    token       │
│  - Verify JWT  │
│  - Fetch user  │
└────────┬────────┘
         ↓
    Valid? ──No──→ 401 Unauthorized
      ↓ Yes
┌─────────────────┐
│  Route Handler  │
│  - Process     │
│    request     │
│  - Query DB    │
│  - Call AI     │
│    (if needed) │
└────────┬────────┘
         ↓
┌─────────────────┐
│  Response       │
│  - JSON data   │
│  - Status code │
└─────────────────┘
```

## Data Flow: Creating a Space

```
1. User fills form
   ↓
2. POST /api/spaces
   ↓
3. Auth middleware validates
   ↓
4. Create Space record
   ↓
5. Set status: INITIALIZING
   ↓
6. Set phase: PLANNING
   ↓
7. Return space data
   ↓
8. Display in UI
```

## Data Flow: Running Research Cycle

```
1. User clicks "Start" or "Run Cycle"
   ↓
2. POST /api/spaces/:id
   { action: "cycle" }
   ↓
3. Fetch space + agents
   ↓
4. Find agent for current phase
   ↓
5. Generate phase-specific prompt
   ↓
6. Call AI provider
   ↓
7. Record experiment
   ↓
8. Update space stats
   ↓
9. Check for breakthrough
   ↓
10. Advance to next phase
   ↓
11. Return results
```

## Breakthrough Detection Logic

```
During GRADING phase:
┌────────────────────────────┐
│ Analyze agent response     │
└──────────┬─────────────────┘
           ↓
┌────────────────────────────┐
│ Check for:                 │
│ - "breakthrough: yes"      │
│ - Confidence score         │
└──────────┬─────────────────┘
           ↓
   If breakthrough detected
           ↓
┌────────────────────────────┐
│ Create Breakthrough record │
│ - Title (extracted)        │
│ - Description              │
│ - Category                 │
│ - Confidence               │
│ - Verified? (>0.7)         │
└────────────────────────────┘

During THINKING phase:
┌────────────────────────────┐
│ Look for patterns:         │
│ - "novel", "discovery"     │
│ - "significant", "key"     │
└──────────┬─────────────────┘
           ↓
   If pattern found
           ↓
┌────────────────────────────┐
│ Create Breakthrough        │
│ (confidence: 0.6 default)  │
└────────────────────────────┘
```

## Technology Stack Diagram

```
Frontend Layer
┌──────────────────────────────────────┐
│ Next.js 14 (App Router)              │
│ ├─ React 18                         │
│ ├─ TypeScript                       │
│ └─ Tailwind CSS                     │
└──────────────────────────────────────┘

Backend Layer
┌──────────────────────────────────────┐
│ Next.js API Routes                   │
│ ├─ Authentication (JWT + bcrypt)    │
│ ├─ Business Logic                   │
│ └─ AI Integration                   │
└──────────────────────────────────────┘

Database Layer
┌──────────────────────────────────────┐
│ SQLite + Prisma ORM                  │
│ ├─ Schema Management                │
│ ├─ Type Safety                      │
│ └─ Query Building                   │
└──────────────────────────────────────┘

AI Layer
┌──────────────────────────────────────┐
│ Multi-Provider SDK                   │
│ ├─ OpenAI SDK                       │
│ ├─ Anthropic SDK                    │
│ ├─ Google Generative AI             │
│ └─ Custom (OpenRouter, MiniMax)     │
└──────────────────────────────────────┘
```

## Security Architecture

```
┌────────────────────────────────┐
│     Request arrives            │
└──────────┬─────────────────────┘
           ↓
┌────────────────────────────────┐
│  Token Validation              │
│  ├─ Extract Bearer token       │
│  ├─ Verify JWT signature       │
│  ├─ Check expiry               │
│  └─ Fetch user from DB         │
└──────────┬─────────────────────┘
           ↓
┌────────────────────────────────┐
│  Authorization Check           │
│  ├─ Is user active?            │
│  ├─ Has required role?         │
│  └─ Resource ownership?        │
└──────────┬─────────────────────┘
           ↓
┌────────────────────────────────┐
│  Process Request               │
│  ├─ Validate input             │
│  ├─ Execute business logic     │
│  └─ Return response            │
└────────────────────────────────┘

Security Features:
- Password hashing (bcrypt 12 rounds)
- JWT tokens (7 day expiry)
- Role-based access control
- User ownership validation
- Admin action protection
- Cannot modify/delete self
```

## State Management

```
Client-Side:
┌────────────────────┐
│ AuthContext        │
│ ├─ user            │
│ ├─ token           │
│ ├─ login()         │
│ ├─ register()      │
│ ├─ logout()        │
│ └─ updateToken()   │
└────────────────────┘
       ↓
LocalStorage:
┌────────────────────┐
│ research_token     │
│ research_user      │
└────────────────────┘

Component State:
- useStat() for data
- useEfffect() for fetch
- Local state for forms
```

This architecture provides:
✅ Scalability (can add more providers)
✅ Modularity (independent components)
✅ Security (multiple layers)
✅ Flexibility (easy to modify)
✅ Maintainability (clear separation)
