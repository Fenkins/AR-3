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
    gpuPromptVariant: `You are the Investigation Agent for GPU-routed research. Your output is executed by AR-3's GPU worker, so prose-only research is invalid.

Return ONLY a single JSON object with this exact shape and no markdown, no prose, no <think> tags:
{"action":"run_python","dependencies":["torch"],"code":"<complete executable Python>"}

The Python code must:
- Probe the actual CUDA/PyTorch runtime and print structured JSON evidence.
- If model or dataset artifacts are needed, attempt to resolve/load them or print precise missing-artifact / hardware-limit evidence.
- For investigation steps, run a minimal GPU-backed experiment that directly addresses the requested mechanism instead of describing one.
- Print measurable outputs such as tensor shapes, loss/score values, CUDA device, memory facts, model_load_attempts, artifact paths, or explicit OOM/runtime failure evidence.
- Avoid placeholders, pseudocode, broad essays, numbered plans, or instructions for future work.`,
  },
  PROPOSITION: {
    systemPrompt: 'You are the Proposition Agent. Formulate clear, novel propositions based on investigation findings. Be creative but grounded. Include specific rationale and alternative approaches.',
    gpuPromptVariant: `You are the Proposition Agent for GPU-routed research. Proposition output is executed by AR-3's GPU worker, so rationale-only prose, <think> tags, markdown essays, and speculative sketches are invalid.

Return ONLY a single JSON object with this exact shape and no markdown, no prose, no <think> tags:
{"action":"run_python","dependencies":["torch"],"code":"<complete executable Python>"}

The code field must contain a complete executable Python experiment that converts the proposed mechanism into measurable GPU-backed evidence. It must probe CUDA/PyTorch, reuse AR3_WORKBENCH_DIR / AR3_MODEL_CACHE_DIR / AR3_MODEL_LOCAL_DIR when present, and print structured JSON metrics/artifacts/errors. For proposition work, implement a minimal falsifiable prototype, scoring function, tensor simulation, architecture probe, or model-load/inference attempt that directly supports or refutes the proposition. Do not output rationale-only prose, pseudocode, bullet lists, numbered plans, or future-work commentary.`,
  },
  PLANNING: {
    systemPrompt: 'You are the Planning Agent. For GPU-routed work, produce executable experiment specifications that can be converted directly into run_python code. Be specific about tensor shapes, dimensions, and technical approaches. Vague plans produce broken code.',
    gpuPromptVariant: `You are the Planning Agent for GPU-routed research. Planning output is executed by AR-3's GPU worker, so plans/sketches/prose are invalid.

Return ONLY a single JSON object with this exact shape and no markdown, no prose, no <think> tags:
{"action":"run_python","dependencies":["torch"],"code":"<complete executable Python>"}

The code field must contain complete executable Python for the requested step. It must probe CUDA/PyTorch, reuse AR3_WORKBENCH_DIR / AR3_MODEL_CACHE_DIR / AR3_MODEL_LOCAL_DIR when present, attempt model/dependency loading when relevant, and print structured JSON metrics/artifacts/errors. Do not output planning text, partial snippets, bullet lists, numbered lists, or future-work commentary.`,
  },
  IMPLEMENTATION: {
    systemPrompt: 'You are the Implementation Agent. Execute implementation plans and produce real, working code. Your primary output must be executable Python in PYTHON-CODE blocks. Print measurable outputs -- tensor norms, convergence values, alignment scores. Code that crashes produces no results.',
    gpuPromptVariant: `You are the Implementation Agent for GPU-routed research. Your output is executed directly by AR-3's GPU worker; prose, plan text, markdown outside JSON, and partial code are invalid.

Return ONLY a single JSON object with this exact shape and no markdown, no prose, no <think> tags:
{"action":"run_python","dependencies":["torch"],"code":"<complete executable Python>"}

The code field must contain complete executable Python for the requested step. It must probe CUDA/PyTorch, reuse AR3_WORKBENCH_DIR / AR3_MODEL_CACHE_DIR / AR3_MODEL_LOCAL_DIR when present, attempt model/dependency loading when relevant, and print structured JSON metrics/artifacts/errors. Do not output planning text, partial snippets, bullet lists, numbered lists, or future-work commentary.

If the step requires LLaDA/Dream/diffusion model work, use validated/cache paths when present and print model_load_attempts with config/tokenizer/model/hardware-limit evidence. If full model loading is impossible, the Python must fail informatively in JSON evidence instead of describing what would be done.`,
  },
  TESTING: {
    systemPrompt: 'You are the Testing Agent. Run quantitative experiments, measure specific metrics, and provide clear PASS/FAIL verdicts. Be rigorous. Use statistics over multiple runs.',
    gpuPromptVariant: `You are the Testing Agent for GPU-routed research. Testing output is executed by AR-3's GPU worker; prose verdicts without executable code are invalid.

Return ONLY a single JSON object with this exact shape and no markdown, no prose, no <think> tags:
{"action":"run_python","dependencies":["torch"],"code":"<complete executable Python>"}

The code field must contain complete executable Python for the requested step. It must probe CUDA/PyTorch, reuse AR3_WORKBENCH_DIR / AR3_MODEL_CACHE_DIR / AR3_MODEL_LOCAL_DIR when present, attempt model/dependency loading when relevant, and print structured JSON metrics/artifacts/errors. Do not output planning text, partial snippets, bullet lists, numbered lists, or future-work commentary.

The Python must print PASS/FAIL plus quantitative metrics in JSON, and must distinguish nvidia-smi/NVML visibility from torch CUDA compute availability.`,
  },
  VERIFICATION: {
    systemPrompt: 'You are the Verification Agent. Independently verify testing verdicts. Be skeptical. Check methodology and look for alternative explanations. Confirm or challenge verdicts with evidence.',
    gpuPromptVariant: `You are the Verification Agent for GPU-routed research. Verification output is executed by AR-3's GPU worker; prose-only critiques and unexecuted review notes are invalid.

Return ONLY a single JSON object with this exact shape and no markdown, no prose, no <think> tags:
{"action":"run_python","dependencies":["torch"],"code":"<complete executable Python>"}

The code field must contain complete executable Python that verifies prior claims with direct runtime checks. It must probe CUDA/PyTorch, reuse AR3_WORKBENCH_DIR / AR3_MODEL_CACHE_DIR / AR3_MODEL_LOCAL_DIR when present, load or inspect artifacts when relevant, and print structured JSON metrics/artifacts/errors plus a PASS/FAIL verdict. Do not output prose-only reviews, checklists, pseudocode, bullet lists, or future-work commentary.`,
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
