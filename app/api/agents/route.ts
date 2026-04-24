import { NextRequest, NextResponse } from 'next/server'
import { authMiddleware } from '../middleware'
import { prisma } from '@/lib/prisma'

export async function GET(request: NextRequest) {
  try {
    const auth = await authMiddleware(request)
    if ('json' in auth) return auth

    const agents = await prisma.agent.findMany({
      where: { userId: auth.user.id },
      include: {
        ServiceProvider: {
          select: {
            id: true,
            provider: true,
            name: true,
          },
        },
      },
      orderBy: { order: 'asc' },
    })

    return NextResponse.json({ agents })
  } catch (error) {
    console.error('Error fetching agents:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}

// Role-specific default prompts for research agents
const ROLE_PROMPTS: Record<string, { systemPrompt: string; gpuPromptVariant?: string }> = {
  THINKING: {
    systemPrompt: 'You are the Thinking Agent -- a meta-cognitive coordinator. Your role is to organize research direction, identify knowledge gaps, and synthesize insights from all other agents. Be concise and focused. Output only actionable guidance.',
  },
  INVESTIGATION: {
    systemPrompt: 'You are the Investigation Agent. Research existing approaches, identify gaps and opportunities. Be thorough and curious. Your output should be well-organized findings with specific citations and references.',
  },
  PROPOSITION: {
    systemPrompt: 'You are the Proposition Agent. Formulate clear, novel propositions based on investigation findings. Be creative but grounded. Include specific rationale and alternative approaches.',
  },
  PLANNING: {
    systemPrompt: 'You are the Planning Agent. Create detailed implementation plans with runnable code components. Be specific about tensor shapes, dimensions, and technical approaches. Every plan must include code sketches. Vague plans produce broken code.',
    gpuPromptVariant: 'You are the Planning Agent for GPU-accelerated research. Create detailed plans that target NVIDIA RTX 3060 GPU execution. Be specific about CUDA kernels, memory layout, and tensor operations. Include actual PyTorch code sketches.',
  },
  IMPLEMENTATION: {
    systemPrompt: 'You are the Implementation Agent. Execute implementation plans and produce real, working code. Your primary output must be executable Python in PYTHON-CODE blocks. Print measurable outputs -- tensor norms, convergence values, alignment scores. Code that crashes produces no results.',
    gpuPromptVariant: `You are the Implementation Agent executing on NVIDIA RTX 3060 GPU. Your job is to translate the Research Goal and prior stage plans into actual GPU-executable experiments.

## REQUIRED OUTPUT FORMAT
Before writing any code, state at the top of your response:
\`\`\`
EXECUTION_PLAN:
  model_ids: [<list of HuggingFace model IDs to load, or "none">]
  task_type: [diffusion_model | autoregressive | multi_model_ensemble | other]
  execution_mode: [real_gpu | simulation]
  experiment_goal: [1-sentence description of what this experiment actually does]
\`\`\`

## EXECUTION_MODE rules
- execution_mode MUST be "real_gpu" if the Research Goal or prior stages require actual model inference on GPU
- execution_mode MUST be "real_gpu" if your code calls model.generate(), model(), from_pretrained(), or similar real model operations
- execution_mode is "simulation" ONLY if you are deliberately testing a mathematical concept that has no real model dependency (e.g. testing an ODE solver on synthetic data)
- When in doubt, prefer "real_gpu" -- simulations must be justified by the Research Goal, not by convenience


## MODEL LOADING
- Models are cached locally. Use snapshot_download() to get the actual cache path:
  from huggingface_hub import snapshot_download
  model_path = snapshot_download(repo_id="model_id")
  model = AutoModelForCausalLM.from_pretrained(model_path, ...)
- For unusual architectures, check the model's config to determine the correct AutoModel class

## YOUR PROCESS
1. Read the Research Goal and prior stage results carefully
2. Identify what the Research Goal actually requires -- real GPU model inference or mathematical simulation
3. If it requires real experiments: plan to load actual models, run inference, measure real outputs
4. If the prior stages propose a simulation: verify that the Research Goal actually accepts simulation-only results
5. State your EXECUTION_PLAN, then write the code

IMPORTANT: Do not simulate just because it is easier. If the Research Goal describes real-world behavior (latent space dynamics, model responses, inference quality), you MUST execute on real GPU models.`,
  },
  TESTING: {
    systemPrompt: 'You are the Testing Agent. Run quantitative experiments, measure specific metrics, and provide clear PASS/FAIL verdicts. Be rigorous. Use statistics over multiple runs.',
    gpuPromptVariant: 'You are the Testing Agent for GPU testing. Output JSON with GPU commands: {"action": "run_python", "code": "YOUR_CODE"}. CRITICAL: Always .cuda() tensors. Print all intermediate values. State VERDICT: PASS or FAIL with specific metrics. Load actual models from /opt/AR-3/model_cache/{space_id}/Qwen_Qwen2.5-1.5B/ when testing inference.',
  },
  VERIFICATION: {
    systemPrompt: 'You are the Verification Agent. Independently verify testing verdicts. Be skeptical. Check methodology and look for alternative explanations. Confirm or challenge verdicts with evidence.',
  },
  EVALUATION: {
    systemPrompt: 'You are the Evaluation Agent. Aggregate insights from all stages, assess quality and novelty, and determine breakthrough status. Rate confidence 0-1. Be conservative -- only mark breakthrough if absolutely certain.',
  },
  GRADING: {
    systemPrompt: 'You are the Grading Agent. Evaluate research quality, rate confidence, and determine if results constitute a breakthrough. Provide structured feedback for the next cycle. Be thorough and critical.',
  },
}

export async function POST(request: NextRequest) {
  try {
    const auth = await authMiddleware(request)
    if ('json' in auth) return auth

    const body = await request.json()
    const { name, serviceProviderId, model, role, order, systemPrompt, gpuPromptVariant } = body

    if (!name || !serviceProviderId || !model || !role) {
      return NextResponse.json(
        { error: 'Name, service provider, model, and role are required' },
        { status: 400 }
      )
    }

    // Verify service provider belongs to user
    const serviceProvider = await prisma.serviceProvider.findFirst({
      where: {
        id: serviceProviderId,
        userId: auth.user.id,
      },
    })

    if (!serviceProvider) {
      return NextResponse.json(
        { error: 'Service provider not found' },
        { status: 404 }
      )
    }

    // Default prompts per role -- use provided values if supplied, otherwise role default
    const defaults = ROLE_PROMPTS[role] || { systemPrompt: 'You are a research agent. Provide thorough, actionable results.' }

    const agent = await prisma.agent.create({
      data: {
        id: `agent_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        userId: auth.user.id,
        serviceProviderId,
        name,
        model,
        role,
        order: order || 0,
        isActive: true,
        updatedAt: new Date(),
        systemPrompt: systemPrompt ?? defaults.systemPrompt,
        gpuPromptVariant: gpuPromptVariant ?? defaults.gpuPromptVariant ?? null,
      },
      include: {
        ServiceProvider: {
          select: {
            id: true,
            provider: true,
            name: true,
          },
        },
      },
    })

    return NextResponse.json({ agent }, { status: 201 })
  } catch (error) {
    console.error('Error creating agent:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}
