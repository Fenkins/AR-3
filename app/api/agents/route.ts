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

## STRICT OUTPUT RULES
Your response MUST contain ONLY:
1. EXECUTION_PLAN header (see format below)
2. ONE \`\`\`python code block containing ACTUAL RUNNABLE Python code

DO NOT include: numbered lists (1. 2. 3.), bullet points (-, *), prose descriptions, or thinking blocks. If you write "1." or "2." anywhere except inside the Python code block, the experiment will be MARKED AS FAILED.

## REQUIRED EXECUTION_PLAN (state BEFORE writing any code)
\`\`\`
EXECUTION_PLAN:
  model_ids: [<list of HuggingFace model IDs, or "none">]
  task_type: [diffusion_model | autoregressive | multi_model_ensemble | other]
  execution_mode: [real_gpu | simulation]
  experiment_goal: [1-sentence description]
\`\`\`

## CRITICAL: CODE OUTPUT FORMAT
After EXECUTION_PLAN, output EXACTLY ONE code block like this:
\`\`\`python
# Your actual runnable Python code starts with imports:
import torch
from transformers import AutoModelForCausalLM, AutoTokenizer, BitsAndBytesConfig
# ... rest of your code
\`\`\`

The code MUST:
- Start with \`import torch\` or \`from transformers\` or \`from huggingface_hub\`
- Contain actual model loading (from_pretrained) if doing real inference
- Print measurable outputs: tensor norms, convergence values, alignment scores
- NOT contain numbered lists like "1. We need to..." or "2. Load the model..."

## EXECUTION_MODE rules
- execution_mode MUST be "real_gpu" if the Research Goal requires actual model inference
- execution_mode is "simulation" ONLY for pure mathematical concepts with no model dependency

## MODEL LOADING (for RTX 3060)
- Use BitsAndBytesConfig for 8-bit loading to fit 2+ model copies:
  from transformers import AutoModelForCausalLM, BitsAndBytesConfig
  bnb_config = BitsAndBytesConfig(load_in_8bit=True)
  model = AutoModelForCausalLM.from_pretrained("Qwen/Qwen2.5-1.5B",
    quantization_config=bnb_config, device_map="cuda", torch_dtype=torch.bfloat16)
- Models available: Qwen/Qwen2.5-1.5B (1.7GB/copy in 8-bit), Qwen/Qwen2.5-3B (3GB/copy in 8-bit)
- Load tokenizer the same way, then: input_ids = tokenizer(text, return_tensors="pt").to("cuda")
- Inference: output = model.generate(**input_ids, max_new_tokens=50)

## YOUR PROCESS
1. Read the Research Goal and prior stage plans carefully
2. Write the EXECUTION_PLAN (above)
3. Output ONE \`\`\`python code block with COMPLETE, RUNNABLE code
4. The GPU worker will execute this code directly -- if it crashes, your variant FAILS

WARNING: If your response contains numbered lists ("1. Do X") instead of code, the experiment is FAILED.`,
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
