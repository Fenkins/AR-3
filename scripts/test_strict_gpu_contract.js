Total output lines: 1022

#!/usr/bin/env node
const assert = require('assert')
const childProcess = require('child_process')
const fs = require('fs')
const path = require('path')

const repoRoot = path.resolve(__dirname, '..')
const outDir = '/tmp/ar3-strict-gpu-contract-test'
fs.rmSync(outDir, { recursive: true, force: true })
childProcess.execFileSync(
  path.join(repoRoot, 'node_modules/.bin/tsc'),
  [
    'lib/gpu-command-contract.ts',
    '--target', 'ES2020',
    '--module', 'commonjs',
    '--moduleResolution', 'node',
    '--esModuleInterop',
    '--skipLibCheck',
    '--outDir', outDir,
  ],
  { cwd: repoRoot, stdio: 'inherit' }
)

const contract = require(path.join(outDir, 'gpu-command-contract.js'))

function testExtractsJsonAfterUnclosedThink() {
  const response = '<think>I will reason, but the model forgot to close the tag.\n{"action":"run_python","dependencies":["torch"],"code":"import json\\nimport torch\\nresult = {\\"cuda\\": torch.cuda.is_available()}\\nprint(json.dumps(result))\\nassert isinstance(result, dict)"}'
  const extracted = contract.extractStrictGpuCommand(response)
  assert.equal(extracted.ok, true, extracted.reason)
  assert.equal(extracted.command.action, 'run_python')
  assert.deepEqual(extracted.command.dependencies, ['torch'])
  assert.match(extracted.command.code, /torch\.cuda\.is_available/)
}

function testFallbackPreparationCommandIsExecutableAndPromptIndependent() {
  const fallback = contract.buildAutonomousPreparationCommand({
    researchGoal: 'Research whether org/example-model can run on this GPU with a small smoke test.',
    stepDescription: 'Prepare models, dependencies, smoke tests, and grading criteria',
    stageName: 'Investigation',
    reason: 'response did not parse as the required JSON object',
  })
  assert.equal(fallback.action, 'run_python')
  assert.ok(Array.isArray(fallback.dependencies))
  assert.ok(fallback.dependencies.includes('requests'))
  assert.match(fallback.code, /def discover_model_ids/)
  assert.match(fallback.code, /GSAI-ML\/LLaDA-8B-Base/)
  assert.doesNotMatch(fallback.code, /patterns = \[r\"\[A-Za-z0-9_\.\-\]\+\/\[A-Za-z0-9_\.\-\]\+\"/)
  assert.match(fallback.code, /torch\.cuda\.is_available/)
  assert.match(fallback.code, /print\(json\.dumps/)
  assert.doesNotMatch(fallback.code, /TODO|placeholder|pseudocode|\.\.\./i)

  const extracted = contract.extractStrictGpuCommand(JSON.stringify(fallback))
  assert.equal(extracted.ok, true, extracted.reason)
}

function testPreparationStageWithValidatedManifestSubmitsExecutableFallbackInsteadOfRawManifestJson() {
  const selected = contract.selectGpuSubmissionCommand({
    stageName: 'Investigation',
    llmResponse: JSON.stringify({
      schemaVersion: 'ar3.preparation-manifest.v1',
      researchType: 'model-behavior',
      objective: 'prepare workbench',
      models: [],
      dependencies: [],
      resources: [],
      smokeTests: [{ name: 'gpu', command: 'python smoke.py', expectedEvidence: ['cuda_available'], timeoutSeconds: 30 }],
      gradingCriteria: ['prints JSON evidence'],
      workbench: { reuseKey: 'model-behavior', expectedArtifacts: ['metrics.json'] },
    }),
    researchGoal: 'Explore an arbitrary model with GPU evidence.',
    stepDescription: 'Validated preparation manifest',
    manifestValidatedThisCycle: true,
  })
  assert.equal(selected.ok, true, selected.reason)
  assert.equal(selected.command.action, 'run_python')
  assert.match(selected.command.code, /autonomous_preparation_manifest/)
  assert.equal(selected.fallbackUsed, true)
  assert.match(selected.reason, /preparation manifest/i)
}

function testAutonomousPreparationFallbackIsLimitedToPreparationStages() {
  assert.equal(contract.shouldUseAutonomousPreparationFallback('Investigation'), true)
  assert.equal(contract.shouldUseAutonomousPreparationFallback('Planning'), true)
  assert.equal(contract.shouldUseAutonomousPreparationFallback('Implementation'), false)
  assert.equal(contract.shouldUseAutonomousPreparationFallback('Testing'), false)
}

function testPreparationStagesRouteThroughGpuWhenSpaceGpuEnabled() {
  assert.equal(contract.shouldRouteStageThroughGpu('Planning', false, true), true)
  assert.equal(contract.shouldRouteStageThroughGpu('Investigation', false, true), true)
  assert.equal(contract.shouldRouteStageThroughGpu('Implementation', true, true), true)
  assert.equal(contract.shouldRouteStageThroughGpu('Planning', false, false), false)
  assert.equal(contract.shouldRouteStageThroughGpu('Proposition', false, true), false)
}

function testFallbackUsesWorkerProvidedWorkbenchDirectory() {
  const fallback = contract.buildAutonomousPreparationCommand({
    researchGoal: 'Any arbitrary model research goal',
    stepDescription: 'Prepare reusable sandbox',
    stageName: 'Planning',
    reason: 'invalid model output',
  })
  assert.match(fallback.code, /AR3_WORKBENCH_DIR/)
  assert.doesNotMatch(fallback.code, /research_goal\[:80\]/)
}

function testAutonomousPreparationFallbackIsAcceptedForPreparationStages() {
  const assessed = contract.assessGpuExecutionEvidence({
    stageName: 'Investigation',
    fallbackUsed: true,
    success: true,
    output: JSON.stringify({
      type: 'autonomous_preparation_manifest',
      contract_failure_reason: 'code contains placeholder/pseudocode markers',
      gpu: { cuda_available: true, gpu_name: 'RTX 3060' },
      model_ids: ['org/example-model'],
    }),
  })
  assert.equal(assessed.valid, true, assessed.reason)
  assert.match(assessed.reason, /preparation probe/i)
  assert.match(assessed.reason, /accepted/i)
}

function testAutonomousPreparationFallbackAcceptsWorkerPrefixedOutput() {
  const assessed = contract.assessGpuExecutionEvidence({
    stageName: 'Investigation',
    fallbackUsed: true,
    success: true,
    output: 'torch_cuda_smoke initial exit=1\n' + JSON.stringify({
      torch_cuda_available: false,
      torch_error: 'ModuleNotFoundError("No module named torch")',
    }) + '\ntorch_cuda_repair install exit=0\n' + JSON.stringify({
      type: 'autonomous_preparation_manifest',
      contract_failure_reason: 'JSON action must be run_python',
      gpu: { cuda_available: true, gpu_name: 'RTX 3060', gpu_memory_gb: 12 },
      model_ids: ['GSAI-ML/LLaDA-8B-Base'],
      installed_dependencies: ['torch==2.5.1+cu124'],
      workbench: '/tmp/ar3-workbenches/cmp5nqaxb-abc',
      recommended_experiment: { objective: 'Run latent trajectory probe', metrics: ['cuda_available', 'trajectory_cosine_similarity'] },
    }, null, 2),
  })
  assert.equal(assessed.valid, true, assessed.reason)
}

function testAutonomousPreparationFallbackDoesNotCompleteImplementationSteps() {
  const assessed = contract.assessGpuExecutionEvidence({
    stageName: 'Implementation',
    fallbackUsed: true,
    success: true,
    output: JSON.stringify({
      type: 'autonomous_preparation_manifest',
      contract_failure_reason: 'code contains placeholder/pseudocode markers',
      gpu: { cuda_available: true },
    }),
  })
  assert.equal(assessed.valid, false)
  assert.match(assessed.reason, /preparation probe/i)
  assert.match(assessed.reason, /not a completed executable experiment/i)
}

function testExtractsPersistablePreparationManifestFromFallbackGpuOutput() {
  const output = JSON.stringify({
    type: 'autonomous_preparation_manifest',
    stage: 'Investigation',
    contract_failure_reason: 'response did not parse as the required JSON object',
    workbench: '/tmp/ar3-workbenches/ode-1234',
    model_ids: ['GSAI-ML/LLaDA-8B-Base'],
    gpu: { cuda_available: true, torch_cuda_available: true, gpu_name: 'RTX 3060', gpu_memory_gb: 11.64 },
    huggingface: [{ model_id: 'GSAI-ML/LLaDA-8B-Base', status_code: 200, safetensors_files: ['model.safetensors'] }],
    installed_dependencies: ['torch==2.5.1+cu124', 'requests==2.32.0'],
    grading_criteria: ['prints JSON evidence'],
    next_actions: ['Generate a run_python command.'],
  })
  const extracted = contract.extractPersistablePreparationManifest(output)
  assert.equal(extracted.ok, true, extracted.reason)
  assert.equal(extracted.manifest.schemaVersion, 'ar3.preparation-probe.v1')
  assert.equal(extracted.manifest.researchType, 'gpu-autonomous-research')
  assert.deepEqual(extracted.manifest.models[0], { id: 'GSAI-ML/LLaDA-8B-Base', source: 'huggingface', required: true })
  assert.equal(extracted.manifest.dependencies.some(dep => dep.name === 'torch'), true)
  assert.equal(extracted.manifest.workbench.reuseKey, 'ode-1234')
  assert.match(extracted.manifest.smokeTests[0].expectedEvidence.join(' '), /cuda_available/)
}

function testDeterministicGpuExperimentFallbackUsesManifestAndPassesEvidenceGate() {
  const command = contract.buildDeterministicGpuExperimentCommand({
    researchGoal: 'Measure whether org/example-model can execute a GPU smoke test.',
    stepDescription: 'Implementation should run a concrete experiment with metrics.',
    stageName: 'Implementation',
    reason: 'response did not parse as the required JSON object',
    preparationManifest: {
      dependencies: [{ name: 'torch', importName: 'torch' }, { name: 'requests', importName: 'requests' }],
      models: [{ id: 'org/example-model', source: 'huggingface', required: false }],
      gradingCriteria: ['prints cuda_available and tensor_sum metrics'],
      smokeTests: [{ name: 'gpu', command: 'python smoke.py' }],
      workbench: { reuseKey: 'example-workbench' },
    },
  })
  assert.equal(command.action, 'run_python')
  assert.ok(command.dependencies.includes('requests'))
  assert.equal(command.dependencies.some(dep => /^torch/i.test(dep)), false)
  assert.match(command.code, /deterministic_gpu_experiment/)
  assert.match(command.code, /torch\.cuda\.is_available/)
  assert.match(command.code, /tensor_sum/)
  assert.match(command.code, /grading_criteria_checked/)
  assert.doesNotMatch(command.code, /TODO|placeholder|pseudocode|\.\.\./i)

  const extracted = contract.extractStrictGpuCommand(JSON.stringify(command))
  assert.equal(extracted.ok, true, extracted.reason)

  const assessed = contract.assessGpuExecutionEvidence({
    stageName: 'Implementation',
    fallbackUsed: false,
    success: true,
    output: JSON.stringify({ type: 'deterministic_gpu_experiment', cuda_available: true, gpu_name: 'RTX 3060', tensor_sum: 123.0, artifacts: ['/tmp/metrics.json'] }),
  })
  assert.equal(assessed.valid, true, assessed.reason)
}

function testPreparationProbeShapeIsInvalidForImplementationEvenIfFallbackFlagIsLost() {
  const assessed = contract.assessGpuExecutionEvidence({
    stageName: 'Implementation',
    fallbackUsed: false,
    success: true,
    output: JSON.stringify({
      type: 'autonomous_preparation_manifest',
      contract_failure_reason: 'response did not parse as the required JSON object',
      gpu: { cuda_available: true },
    }),
  })
  assert.equal(assessed.valid, false)
  assert.match(assessed.reason, /preparation probe/i)
}

function testLongProseOutputIsNotValidGpuEvidence() {
  const assessed = contract.assessGpuExecutionEvidence({
    stageName: 'Implementation',
    fallbackUsed: false,
    success: true,
    output: 'This experiment would compare several approaches and then report whether the idea is promising. It contains no JSON metrics, files, numeric measurements, artifacts, GPU facts, or stdout evidence from executable work.',
  })
  assert.equal(assessed.valid, false)
  assert.match(assessed.reason, /measurable evidence/i)
}

function testJsonMetricsOutputIsValidGpuEvidence() {
  const assessed = contract.assessGpuExecutionEvidence({
    stageName: 'Implementation',
    fallbackUsed: false,
    success: true,
    output: JSON.stringify({ accuracy: 0.91, loss: 0.12, cuda_available: true }),
  })
  assert.equal(assessed.valid, true, assessed.reason)
}

function testManifestCriteriaRejectMissingExplicitMetricEvidence() {
  const assessed = contract.assessGpuExecutionEvidence({
    stageName: 'Implementation',
    fallbackUsed: false,
    success: true,
    preparationManifest: {
      gradingCriteria: ['stdout contains JSON metrics with cuda_available and trajectory_cosine_similarity'],
    },
    output: JSON.stringify({
      cuda_available: true,
      gpu_name: 'RTX 3060',
      runtime_seconds: 2.4,
      tensor_sum: 123.0,
    }),
  })
  assert.equal(assessed.valid, false)
  assert.match(assessed.reason, /preparation manifest grading criteria/i)
  assert.match(assessed.reason, /trajectory_cosine_similarity/)
}

function testManifestCriteriaAcceptNestedExplicitMetricEvidence() {
  const assessed = contract.assessGpuExecutionEvidence({
    stageName: 'Implementation',
    fallbackUsed: false,
    success: true,
    preparationManifest: {
      gradingCriteria: ['stdout contains JSON metrics with cuda_available and trajectory_cosine_similarity'],
    },
    output: JSON.stringify({
      cuda_available: true,
      gpu_name: 'RTX 3060',
      research_metrics: { trajectory_cosine_similarity: 0.993 },
      runtime_seconds: 2.4,
    }),
  })
  assert.equal(assessed.valid, true, assessed.reason)
}

function testManifestCriteriaRejectMissingPlainMetricEvidence() {
  const assessed = contract.assessGpuExecutionEvidence({
    stageName: 'Implementation',
    fallbackUsed: false,
    success: true,
    preparationManifest: {
      gradingCriteria: ['stdout contains JSON metrics with cuda_available and accuracy'],
    },
    output: JSON.stringify({
      cuda_available: true,
      gpu_name: 'RTX 3060',
      runtime_seconds: 2.4,
      tensor_sum: 123.0,
    }),
  })
  assert.equal(assessed.valid, false)
  assert.match(assessed.reason, /accuracy/)
}

function testManifestCriteriaAcceptPlainMetricEvidence() {
  const assessed = contract.assessGpuExecutionEvidence({
    stageName: 'Implementation',
    fallbackUsed: false,
    success: true,
    preparationManifest: {
      gradingCriteria: ['stdout contains JSON metrics with cuda_available and accuracy'],
    },
    output: JSON.stringify({
      cuda_available: true,
      gpu_name: 'RTX 3060',
      accuracy: 0.91,
      runtime_seconds: 2.4,
    }),
  })
  assert.equal(assessed.valid, true, assessed.reason)
}

function testManifestCriteriaRejectHyphenatedMetricWithoutEvidence() {
  const assessed = contract.assessGpuExecutionEvidence({
    stageName: 'Implementation',
    fallbackUsed: false,
    success: true,
    preparationManifest: {
      gradingCriteria: ['stdout contains JSON metrics with cuda_available and trajectory-cosine-similarity'],
    },
    output: JSON.stringify({
      cuda_available: true,
      gpu_name: 'RTX 3060',
      runtime_seconds: 2.4,
      tensor_sum: 123.0,
    }),
  })
  assert.equal(assessed.valid, false)
  assert.match(assessed.reason, /trajectory-cosine-similarity/)
}

function testManifestCriteriaAcceptHyphenatedMetricAgainstUnderscoreField() {
  const assessed = contract.assessGpuExecutionEvidence({
    stageName: 'Implementation',
    fallbackUsed: false,
    success: true,
    preparationManifest: {
      gradingCriteria: ['stdout contains JSON metrics with cuda_available and trajectory-cosine-similarity'],
    },
    output: JSON.stringify({
      cuda_available: true,
      gpu_name: 'RTX 3060',
      research_metrics: { trajectory_cosine_similarity: 0.993 },
      runtime_seconds: 2.4,
    }),
  })
  assert.equal(assessed.valid, true, assessed.reason)
}

function testManifestSuccessCriteriaRejectMissingEvidence() {
  const assessed = contract.assessGpuExecutionEvidence({
    stageName: 'Implementation',
    fallbackUsed: false,
    success: true,
    preparationManifest: {
      success_criteria: [
        { name: 'trajectory quality', metric: 'trajectory_cosine_similarity', evidence: 'research_metrics.trajectory_cosine_similarity' },
      ],
    },
    output: JSON.stringify({
      cuda_available: true,
      gpu_name: 'RTX 3060',
      runtime_seconds: 2.4,
      tensor_sum: 123.0,
    }),
  })
  assert.equal(assessed.valid, false)
  assert.match(assessed.reason, /trajectory_cosine_similarity/)
}

function testManifestSuccessCriteriaAcceptConcreteEvidence() {
  const assessed = contract.assessGpuExecutionEvidence({
    stageName: 'Implementation',
    fallbackUsed: false,
    success: true,
    preparationManifest: {
      success_criteria: [
        { name: 'trajectory quality', metric: 'trajectory_cosine_similarity', evidence: 'research_metrics.trajectory_cosine_similarity' },
      ],
    },
    output: JSON.stringify({
      cuda_available: true,
      gpu_name: 'RTX 3060',
      research_metrics: { trajectory_cosine_similarity: 0.993 },
      runtime_seconds: 2.4,
    }),
  })
  assert.equal(assessed.valid, true, assessed.reason)
}

function testManifestSuccessCriteriaRejectsUnsatisfiedThreshold() {
  const assessed = contract.assessGpuExecutionEvidence({
    stageName: 'Implementation',
    fallbackUsed: false,
    success: true,
    preparationManifest: {
      success_criteria: [
        { name: 'accuracy floor', metric: 'accuracy', threshold: '>= 0.90', evidence: 'research_metrics.accuracy' },
      ],
    },
    output: JSON.stringify({
      cuda_available: true,
      gpu_name: 'RTX 3060',
      research_metrics: { accuracy: 0.42 },
      runtime_seconds: 2.4,
    }),
  })
  assert.equal(assessed.valid, false)
  assert.match(assessed.reason, /success-criteria thresholds/)
  assert.match(assessed.reason, /accuracy >= 0.90/)
}

function testManifestSuccessCriteriaAcceptsSatisfiedThreshold() {
  const assessed = contract.assessGpuExecutionEvidence({
    stageName: 'Implementation',
    fallbackUsed: false,
    success: true,
    preparationManifest: {
      success_criteria: [
        { name: 'accuracy floor', metric: 'accuracy', threshold: 'at least 0.90', evidence: 'research_metrics.accuracy' },
      ],
    },
    output: JSON.stringify({
      cuda_available: true,
      gpu_name: 'RTX 3060',
      research_metrics: { accuracy: 0.91 },
      runtime_seconds: 2.4,
    }),
  })
  assert.equal(assessed.valid, true, assessed.reason)
}

function testManifestSmokeExpectedEvidenceRejectsMissingField() {
  const assessed = contract.assessGpuExecutionEvidence({
    stageName: 'Implementation',
    fallbackUsed: false,
    success: true,
    preparationManifest: {
      smokeTests: [{
        name: 'latency probe',
        command: 'python run.py',
        expectedEvidence: ['cuda_available', 'latency_ms', 'trajectory-cosine-similarity'],
      }],
    },
    output: JSON.stringify({
      cuda_available: true,
      gpu_name: 'RTX 3060',
      latency_ms: 12.4,
      runtime_seconds: 2.4,
    }),
  })
  assert.equal(assessed.valid, false)
  assert.match(assessed.reason, /smoke-test expected evidence/)
  assert.match(assessed.reason, /trajectory-cosine-similarity/)
}

function testManifestSmokeExpectedEvidenceAcceptsNestedField() {
  const assessed = contract.assessGpuExecutionEvidence({
    stageName: 'Implementation',
    fallbackUsed: false,
    success: true,
    preparationManifest: {
      smokeTests: [{
        name: 'latency probe',
        command: 'python run.py',
        expectedEvidence: ['cuda_available', 'latency_ms', 'trajectory-cosine-similarity'],
      }],
    },
    output: JSON.stringify({
      cuda_available: true,
      gpu_name: 'RTX 3060',
      measurements: {
        latency_ms: 12.4,
        trajectory_cosine_similarity: 0.993,
      },
      runtime_seconds: 2.4,
    }),
  })
  assert.equal(assessed.valid, true, assessed.reason)
}

function testCpuOnlyJsonMetricsAreNotValidGpuEvidence() {
  const assessed = contract.assessGpuExecutionEvidence({
    stageName: 'Implementation',
    fallbackUsed: false,
    success: true,
    output: JSON.stringify({ accuracy: 0.91, loss: 0.12, runtime_seconds: 3.4 }),
  })
  assert.equal(assessed.valid, false)
  assert.match(assessed.reason, /runtime GPU evidence/i)
}

function testFalseCudaAvailabilityIsNotRuntimeGpuEvidence() {
  const assessed = contract.assessGpuExecutionEvidence({
    stageName: 'Implementation',
    fallbackUsed: false,
    success: true,
    output: JSON.stringify({ ac…1316 tokens truncated….test(metric)))
}

function testPersistedPreparationManifestKeepsResearchSpecificObjective() {
  const output = JSON.stringify({
    type: 'autonomous_preparation_manifest',
    stage: 'Investigation',
    research_goal: 'Improve diffusion model inference with latent gasket ODE trajectory consensus.',
    step_description: 'Implement projection metrics for comparing latent trajectories between two model streams.',
    focus_terms: ['latent', 'gasket', 'trajectory'],
    recommended_experiment: {
      objective: 'Run projection metrics for comparing latent trajectories between two model streams.',
      metrics: ['trajectory_cosine_similarity'],
    },
    gpu: { cuda_available: true, gpu_name: 'RTX 3060' },
    model_ids: ['GSAI-ML/LLaDA-8B-Base'],
    installed_dependencies: ['torch==2.5.1+cu124', 'requests==2.32.0'],
    grading_criteria: ['prints trajectory_cosine_similarity and CUDA evidence'],
  })
  const extracted = contract.extractPersistablePreparationManifest(output)
  assert.equal(extracted.ok, true, extracted.reason)
  assert.match(extracted.manifest.objective, /projection metrics/i)
  assert.match(extracted.manifest.objective, /latent trajectories/i)
  assert.deepEqual(extracted.manifest.focusTerms, ['latent', 'gasket', 'trajectory'])
  assert.equal(extracted.manifest.recommendedExperiment.metrics[0], 'trajectory_cosine_similarity')
}

function testPreparationStageRejectsLlmManifestWrapperAndUsesFallback() {
  const selected = contract.selectGpuSubmissionCommand({
    stageName: 'Investigation',
    researchGoal: 'Improve diffusion model inference with latent gasket ODE trajectory consensus.',
    stepDescription: 'Implement projection metrics for comparing latent trajectories between two model streams.',
    llmResponse: JSON.stringify({
      action: 'run_python',
      dependencies: ['torch>=2.0.0', 'transformers>=4.35.0'],
      code: 'import json\nimport torch\nprint(json.dumps({"cuda_available": torch.cuda.is_available()}))\nmanifest = {"schemaVersion": "ar3.preparation-manifest.v1", "preparation_manifest": {"models": [{"modelId": "GSAI-ML/LLaDA-8B-Base", "smokeTest": {}}]}}\nprint(json.dumps(manifest))',
    }),
  })
  assert.equal(selected.ok, true, selected.reason)
  assert.equal(selected.fallbackUsed, true)
  assert.match(selected.reason, /preparation manifest wrapper/i)
  assert.match(selected.command.code, /recommended_experiment/)
}

function testStrictGpuCommandRejectsExecutableGpuProbeCodeWithUnterminatedPythonString() {
  const badCode = 'import json\nimport torch\nresult = {"cuda_available": torch.cuda.is_available()}\nmanifest = {\n    "smokeTests": [\n        {\n            "name": "latent_space_probing",\n            "command": "python -c \\"import numpy as np; print(\'vector_norm:\', np.linalg.norm(v))\\",\n            "expectedEvidence": "vector_norm: float"\n        }\n    ]\n}\nprint(json.dumps(manifest | result))'
  const extracted = contract.extractStrictGpuCommand(JSON.stringify({
    action: 'run_python',
    dependencies: ['torch'],
    code: badCode,
  }))
  assert.equal(extracted.ok, false)
  assert.match(extracted.reason, /python syntax/i)
}

function samplePreparationManifest() {
  return {
    schemaVersion: 'ar3.preparation-probe.v1',
    researchType: 'gpu-autonomous-research',
    objective: 'Run projection metrics for latent gasket ODE trajectories.',
    researchGoal: 'Improve diffusion model inference with latent gasket ODE trajectory consensus.',
    stepDescription: 'Implement projection metrics for comparing latent trajectories between two model streams.',
    focusTerms: ['latent', 'trajectory', 'projection', 'ode', 'consensus'],
    recommendedExperiment: {
      objective: 'Run projection metrics for comparing latent trajectories between two model streams.',
      metrics: ['trajectory_cosine_similarity', 'projection_residual', 'latent_vector_norm'],
    },
    dependencies: [{ name: 'torch', importName: 'torch' }, { name: 'requests', importName: 'requests' }],
    models: [{ id: 'GSAI-ML/LLaDA-8B-Base', source: 'huggingface', required: false }],
    gradingCriteria: ['prints cuda_available and trajectory_cosine_similarity metrics'],
    workbench: { reuseKey: 'ode-research-workbench' },
  }
}

function testPreparationStageWithExistingManifestPromotesWeakOutputToDeterministicExperiment() {
  const selected = contract.selectGpuSubmissionCommand({
    stageName: 'Investigation',
    researchGoal: 'Improve diffusion model inference with latent gasket ODE trajectory consensus.',
    stepDescription: 'Implement projection metrics for comparing latent trajectories between two model streams.',
    preparationManifest: samplePreparationManifest(),
    llmResponse: 'I would run an experiment and report the results later.',
  })
  assert.equal(selected.ok, true, selected.reason)
  assert.equal(selected.fallbackUsed, false)
  assert.match(selected.reason, /deterministic GPU experiment/i)
  assert.equal(selected.command.action, 'run_python')
  assert.match(selected.command.code, /deterministic_gpu_experiment/)
  assert.match(selected.command.code, /trajectory_cosine_similarity/)
  assert.doesNotMatch(selected.command.code, /autonomous_preparation_manifest/)
}

function testPreparationStageWithExistingManifestPromotesWrapperToDeterministicExperiment() {
  const selected = contract.selectGpuSubmissionCommand({
    stageName: 'Investigation',
    researchGoal: 'Improve diffusion model inference with latent gasket ODE trajectory consensus.',
    stepDescription: 'Implement projection metrics for comparing latent trajectories between two model streams.',
    preparationManifest: samplePreparationManifest(),
    llmResponse: JSON.stringify({
      action: 'run_python',
      dependencies: ['torch'],
      code: 'import json\nimport torch\nprint(json.dumps({"cuda_available": torch.cuda.is_available()}))\nmanifest = {"research_findings": "wrapper narrative", "preparation_manifest": {"models": []}}\nprint(json.dumps(manifest))',
    }),
  })
  assert.equal(selected.ok, true, selected.reason)
  assert.equal(selected.fallbackUsed, false)
  assert.match(selected.reason, /deterministic GPU experiment/i)
  assert.match(selected.command.code, /research_metrics/)
}

function testValidatedManifestReconcilesSameBasenameHuggingFaceModelIds() {
  const selected = contract.selectGpuSubmissionCommand({
    stageName: 'Investigation',
    researchGoal: 'Improve diffusion model inference with LLaDA latent gasket ODE trajectory consensus.',
    stepDescription: 'Run an ablation study with the prepared LLaDA checkpoint.',
    preparationManifest: samplePreparationManifest(),
    llmResponse: JSON.stringify({
      action: 'run_python',
      dependencies: ['torch', 'transformers'],
      code: [
        'import json',
        'from transformers import AutoConfig',
        'model_id = "contextualai/LLaDA-8B-Base"',
        'cfg = AutoConfig.from_pretrained("contextualai/LLaDA-8B-Base")',
        'print(json.dumps({"cuda_available": True, "model_id": model_id, "hidden_size": getattr(cfg, "hidden_size", 0)}))',
      ].join('\n'),
    }),
  })
  assert.equal(selected.ok, true, selected.reason)
  assert.match(selected.reason, /reconciled GPU command Hugging Face model ID/)
  assert.match(selected.command.code, /GSAI-ML\/LLaDA-8B-Base/)
  assert.doesNotMatch(selected.command.code, /contextualai\/LLaDA-8B-Base/)
}

function testValidatedManifestRejectsUnmatchedHuggingFaceModelIdsToDeterministicFallback() {
  const selected = contract.selectGpuSubmissionCommand({
    stageName: 'Investigation',
    researchGoal: 'Improve diffusion model inference with LLaDA latent gasket ODE trajectory consensus.',
    stepDescription: 'Run an ablation study with the prepared LLaDA checkpoint.',
    preparationManifest: samplePreparationManifest(),
    llmResponse: JSON.stringify({
      action: 'run_python',
      dependencies: ['torch', 'transformers'],
      code: [
        'import json',
        'from transformers import AutoConfig',
        'cfg = AutoConfig.from_pretrained("other-org/Unprepared-Model")',
        'print(json.dumps({"cuda_available": True, "hidden_size": getattr(cfg, "hidden_size", 0)}))',
      ].join('\n'),
    }),
  })
  assert.equal(selected.ok, true, selected.reason)
  assert.match(selected.reason, /unvalidated Hugging Face model IDs/)
  assert.match(selected.command.code, /deterministic_gpu_experiment/)
  assert.doesNotMatch(selected.command.code, /from_pretrained\("other-org\/Unprepared-Model"/)
}

function testDeterministicExperimentFallbackEmitsResearchSpecificMetrics() {
  const command = contract.buildDeterministicGpuExperimentCommand({
    researchGoal: 'Improve diffusion model inference with latent gasket ODE trajectory consensus.',
    stepDescription: 'Implement projection metrics for comparing latent trajectories between two model streams.',
    stageName: 'Investigation',
    reason: 'JSON action must be run_python',
    preparationManifest: samplePreparationManifest(),
  })
  const result = runPythonCode(command.code)
  assert.equal(result.type, 'deterministic_gpu_experiment')
  assert.ok(result.research_metrics, 'expected nested research_metrics')
  assert.equal(typeof result.research_metrics.trajectory_cosine_similarity, 'number')
  assert.equal(typeof result.research_metrics.projection_residual, 'number')
  assert.ok(result.focus_terms.includes('trajectory'))
  assert.ok(result.grading_criteria_evidence, 'expected grading criteria evidence map')
  const criterionEvidence = result.grading_criteria_evidence['prints cuda_available and trajectory_cosine_similarity metrics']
  assert.equal(criterionEvidence.matched, true)
  assert.ok(criterionEvidence.matched_keys.some(key => /cuda_available|trajectory_cosine_similarity/.test(key)), criterionEvidence.matched_keys.join(', '))
}

function testDeterministicExperimentCriteriaEchoWithoutEvidenceIsRejected() {
  const assessed = contract.assessGpuExecutionEvidence({
    stageName: 'Implementation',
    fallbackUsed: false,
    success: true,
    output: JSON.stringify({
      type: 'deterministic_gpu_experiment',
      cuda_available: true,
      gpu_name: 'RTX 3060',
      tensor_sum: 123.0,
      grading_criteria_checked: ['prints cuda_available and trajectory_cosine_similarity metrics'],
    }),
  })
  assert.equal(assessed.valid, false)
  assert.match(assessed.reason, /grading criteria/i)
}

function testDeterministicExperimentCriteriaEvidencePassesGate() {
  const assessed = contract.assessGpuExecutionEvidence({
    stageName: 'Implementation',
    fallbackUsed: false,
    success: true,
    output: JSON.stringify({
      type: 'deterministic_gpu_experiment',
      cuda_available: true,
      gpu_name: 'RTX 3060',
      tensor_sum: 123.0,
      research_metrics: { trajectory_cosine_similarity: 0.99 },
      grading_criteria_checked: ['prints cuda_available and trajectory_cosine_similarity metrics'],
      grading_criteria_evidence: {
        'prints cuda_available and trajectory_cosine_similarity metrics': {
          matched: true,
          matched_keys: ['cuda_available', 'research_metrics.trajectory_cosine_similarity'],
        },
      },
    }),
  })
  assert.equal(assessed.valid, true, assessed.reason)
}

function testDeterministicExperimentCriteriaEvidenceRejectsPartialExplicitMetrics() {
  const assessed = contract.assessGpuExecutionEvidence({
    stageName: 'Implementation',
    fallbackUsed: false,
    success: true,
    output: JSON.stringify({
      type: 'deterministic_gpu_experiment',
      cuda_available: true,
      gpu_name: 'RTX 3060',
      tensor_sum: 123.0,
      grading_criteria_checked: ['prints cuda_available and trajectory_cosine_similarity metrics'],
      grading_criteria_evidence: {
        'prints cuda_available and trajectory_cosine_similarity metrics': {
          matched: true,
          matched_keys: ['cuda_available'],
        },
      },
    }),
  })
  assert.equal(assessed.valid, false)
  assert.match(assessed.reason, /grading criteria/i)
}

function testDeterministicExperimentCriteriaEvidenceRejectsForgedKeys() {
  const assessed = contract.assessGpuExecutionEvidence({
    stageName: 'Implementation',
    fallbackUsed: false,
    success: true,
    output: JSON.stringify({
      type: 'deterministic_gpu_experiment',
      cuda_available: true,
      gpu_name: 'RTX 3060',
      tensor_sum: 123.0,
      grading_criteria_checked: ['prints cuda_available and trajectory_cosine_similarity metrics'],
      grading_criteria_evidence: {
        'prints cuda_available and trajectory_cosine_similarity metrics': {
          matched: true,
          matched_keys: ['cuda_available', 'research_metrics.trajectory_cosine_similarity'],
        },
      },
    }),
  })
  assert.equal(assessed.valid, false)
  assert.match(assessed.reason, /grading criteria/i)
}

function testDeterministicExperimentCriteriaEvidenceRejectsEmptyValues() {
  const assessed = contract.assessGpuExecutionEvidence({
    stageName: 'Implementation',
    fallbackUsed: false,
    success: true,
    output: JSON.stringify({
      type: 'deterministic_gpu_experiment',
      cuda_available: true,
      gpu_name: 'RTX 3060',
      tensor_sum: 123.0,
      research_metrics: { trajectory_cosine_similarity: null },
      grading_criteria_checked: ['prints cuda_available and trajectory_cosine_similarity metrics'],
      grading_criteria_evidence: {
        'prints cuda_available and trajectory_cosine_similarity metrics': {
          matched: true,
          matched_keys: ['cuda_available', 'research_metrics.trajectory_cosine_similarity'],
        },
      },
    }),
  })
  assert.equal(assessed.valid, false)
  assert.match(assessed.reason, /grading criteria/i)
}

function testDeterministicExperimentCriteriaEvidenceRejectsUnsatisfiedThreshold() {
  const assessed = contract.assessGpuExecutionEvidence({
    stageName: 'Implementation',
    fallbackUsed: false,
    success: true,
    output: JSON.stringify({
      type: 'deterministic_gpu_experiment',
      cuda_available: true,
      gpu_name: 'RTX 3060',
      research_metrics: { accuracy: 0.42 },
      grading_criteria_checked: ['accuracy >= 0.90'],
      grading_criteria_evidence: {
        'accuracy >= 0.90': {
          matched: true,
          matched_keys: ['research_metrics.accuracy'],
        },
      },
    }),
  })
  assert.equal(assessed.valid, false)
  assert.match(assessed.reason, /grading criteria/i)
}

function testDeterministicExperimentCriteriaEvidenceAcceptsSatisfiedThreshold() {
  const assessed = contract.assessGpuExecutionEvidence({
    stageName: 'Implementation',
    fallbackUsed: false,
    success: true,
    output: JSON.stringify({
      type: 'deterministic_gpu_experiment',
      cuda_available: true,
      gpu_name: 'RTX 3060',
      research_metrics: { accuracy: 0.91 },
      grading_criteria_checked: ['accuracy must be at least 0.90'],
      grading_criteria_evidence: {
        'accuracy must be at least 0.90': {
          matched: true,
          matched_keys: ['research_metrics.accuracy'],
        },
      },
    }),
  })
  assert.equal(assessed.valid, true, assessed.reason)
}

function testPreparationStagesShortCircuitWeakModelContractFailures() {
  assert.equal(contract.shouldShortCircuitPreparationFallback('Investigation', 'response did not parse as the required JSON object'), true)
  assert.equal(contract.shouldShortCircuitPreparationFallback('Planning', 'JSON action must be "run_python"'), true)
  assert.equal(contract.shouldShortCircuitPreparationFallback('Investigation', 'code contains placeholder/pseudocode markers'), true)
  assert.equal(contract.shouldShortCircuitPreparationFallback('Implementation', 'response did not parse as the required JSON object'), false)
  assert.equal(contract.shouldShortCircuitPreparationFallback('Testing', 'JSON action must be run_python'), false)
}

function testGpuStepCompletionRejectsProseWithoutExecutionResult() {
  const assessed = contract.assessGpuStepCompletion('<think>I would run a comparison.</think>\n```python\nprint("not executed")\n```')
  assert.equal(assessed.valid, false)
  assert.match(assessed.reason, /did not record a completed GPU execution result/i)
}

function testGpuStepCompletionRejectsGpuError() {
  const assessed = contract.assessGpuStepCompletion('[GPU Error]: failed to submit GPU job')
  assert.equal(assessed.valid, false)
  assert.match(assessed.reason, /failed to submit GPU job/i)
}

function testGpuStepCompletionAcceptsRecordedExecutionResult() {
  const assessed = contract.assessGpuStepCompletion('[GPU Execution Result] job:gpu_test_123\n{"cuda_available":true,"gpu_name":"RTX 2060 SUPER","metric":0.42}')
  assert.equal(assessed.valid, true, assessed.reason)
}

testExtractsJsonAfterUnclosedThink()
testFallbackPreparationCommandIsExecutableAndPromptIndependent()
testPreparationStageWithValidatedManifestSubmitsExecutableFallbackInsteadOfRawManifestJson()
testAutonomousPreparationFallbackIsLimitedToPreparationStages()
testPreparationStagesRouteThroughGpuWhenSpaceGpuEnabled()
testFallbackUsesWorkerProvidedWorkbenchDirectory()
testAutonomousPreparationFallbackIsAcceptedForPreparationStages()
testAutonomousPreparationFallbackAcceptsWorkerPrefixedOutput()
testAutonomousPreparationFallbackDoesNotCompleteImplementationSteps()
testExtractsPersistablePreparationManifestFromFallbackGpuOutput()
testDeterministicGpuExperimentFallbackUsesManifestAndPassesEvidenceGate()
testPreparationProbeShapeIsInvalidForImplementationEvenIfFallbackFlagIsLost()
testLongProseOutputIsNotValidGpuEvidence()
testJsonMetricsOutputIsValidGpuEvidence()
testManifestCriteriaRejectMissingExplicitMetricEvidence()
testManifestCriteriaAcceptNestedExplicitMetricEvidence()
testManifestCriteriaRejectMissingPlainMetricEvidence()
testManifestCriteriaAcceptPlainMetricEvidence()
testManifestCriteriaRejectHyphenatedMetricWithoutEvidence()
testManifestCriteriaAcceptHyphenatedMetricAgainstUnderscoreField()
testManifestSuccessCriteriaRejectMissingEvidence()
testManifestSuccessCriteriaAcceptConcreteEvidence()
testManifestSuccessCriteriaRejectsUnsatisfiedThreshold()
testManifestSuccessCriteriaAcceptsSatisfiedThreshold()
testCpuOnlyJsonMetricsAreNotValidGpuEvidence()
testFalseCudaAvailabilityIsNotRuntimeGpuEvidence()
testGpuIdentityCanValidateRuntimeEvidenceWhenTorchCudaIsFalse()
testArtifactOnlyOutputIsNotValidGpuEvidence()
testStrictGpuCommandRejectsCpuOnlyMetricsCode()
testStrictGpuCommandAcceptsExecutableGpuProbeCode()
testStrictGpuCommandSkipsNonCommandJsonAndAcceptsLaterCommand()
testStrictGpuCommandAcceptsPythonFenceForWeakModels()
testFallbackPreparationCommandSanitizesContractReasonMarkers()
testAutonomousPreparationFallbackEmitsStepSpecificResearchPlan()
testPersistedPreparationManifestKeepsResearchSpecificObjective()
testPreparationStageRejectsLlmManifestWrapperAndUsesFallback()
testStrictGpuCommandRejectsExecutableGpuProbeCodeWithUnterminatedPythonString()
testPreparationStageWithExistingManifestPromotesWeakOutputToDeterministicExperiment()
testPreparationStageWithExistingManifestPromotesWrapperToDeterministicExperiment()
testValidatedManifestReconcilesSameBasenameHuggingFaceModelIds()
testValidatedManifestRejectsUnmatchedHuggingFaceModelIdsToDeterministicFallback()
testDeterministicExperimentFallbackEmitsResearchSpecificMetrics()
testDeterministicExperimentCriteriaEchoWithoutEvidenceIsRejected()
testDeterministicExperimentCriteriaEvidencePassesGate()
testDeterministicExperimentCriteriaEvidenceRejectsPartialExplicitMetrics()
testDeterministicExperimentCriteriaEvidenceRejectsForgedKeys()
testDeterministicExperimentCriteriaEvidenceRejectsEmptyValues()
testDeterministicExperimentCriteriaEvidenceRejectsUnsatisfiedThreshold()
testDeterministicExperimentCriteriaEvidenceAcceptsSatisfiedThreshold()
testPreparationStagesShortCircuitWeakModelContractFailures()
testGpuStepCompletionRejectsProseWithoutExecutionResult()
testGpuStepCompletionRejectsGpuError()
testGpuStepCompletionAcceptsRecordedExecutionResult()
console.log('strict gpu contract tests passed')
