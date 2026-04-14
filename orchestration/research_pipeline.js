import { TaskFlow } from '@openclaw/taskflow'; // Example import based on OpenClaw's taskflow skill

/**
 * AR-3 Autonomous Research Pipeline
 * Defines the multi-stage research flow:
 * Investigation -> Proposition -> Planning -> Implementation -> Testing -> Verification -> Evaluation
 */
export const researchPipeline = new TaskFlow({
  id: 'ar-3-research-loop',
  name: 'Autonomous Research Pipeline',
  stages: [
    {
      id: 'investigation',
      name: 'Investigation',
      description: 'Drafts a proposition based on the prompt, looks for solutions and performs investigation.',
      agentRole: 'investigator',
      config: {
        allowVariants: true,
        defaultVariants: 3,
        autoStepEvaluation: true,
      }
    },
    {
      id: 'proposition',
      name: 'Proposition',
      description: 'Drafts hypotheses based on investigation feedback and grades, proposes novel ideas.',
      agentRole: 'proposer',
      config: {
        allowVariants: true,
        defaultVariants: 3,
        autoStepEvaluation: true,
      }
    },
    {
      id: 'planning',
      name: 'Planning',
      description: 'Drafts an implementation plan taking into account the winning propositions.',
      agentRole: 'planner',
      config: {
        allowVariants: true,
        defaultVariants: 2,
        autoStepEvaluation: true,
      }
    },
    {
      id: 'implementation',
      name: 'Implementation',
      description: 'Pieces together an actual implementation based on the planning stage. Produces a working prototype.',
      agentRole: 'implementer',
      config: {
        allowVariants: false, // Usually one implementation based on the best plan
        autoStepEvaluation: true,
        requiresEnvironmentAccess: true
      }
    },
    {
      id: 'testing',
      name: 'Testing',
      description: 'Tests the implementation and decides whether to pass it forward or send back diagnostics.',
      agentRole: 'tester',
      config: {
        allowVariants: false,
        autoStepEvaluation: true,
      }
    },
    {
      id: 'verification',
      name: 'Verification',
      description: 'Verifies the verdict received from the Testing phase to ensure results are reproducible and verifiable.',
      agentRole: 'verifier',
      config: {
        allowVariants: false,
        autoStepEvaluation: true,
      }
    },
    {
      id: 'evaluation',
      name: 'Evaluation',
      description: 'Evaluates all results. If it hits a breakthrough, increments counter and feeds back to investigation.',
      agentRole: 'evaluator',
      config: {
        allowVariants: false,
        autoStepEvaluation: true,
        isTerminalOrLoop: true // Loops back to investigation if needed
      }
    }
  ]
});
