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
  assert.ok(command.dependencies.includes('torch'))
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

function testStrictGpuCommandRejectsCpuOnlyMetricsCode() {
  const extracted = contract.extractStrictGpuCommand(JSON.stringify({
    action: 'run_python',
    dependencies: [],
    code: 'import json\nresult = {"accuracy": 0.91, "loss": 0.12}\nprint(json.dumps(result))\nassert result["accuracy"] > 0\nprint("done")',
  }))
  assert.equal(extracted.ok, false)
  assert.match(extracted.reason, /GPU\/CUDA probe/i)
}

function testStrictGpuCommandAcceptsExecutableGpuProbeCode() {
  const extracted = contract.extractStrictGpuCommand(JSON.stringify({
    action: 'run_python',
    dependencies: ['torch'],
    code: 'import json\nimport torch\ndevice = "cuda" if torch.cuda.is_available() else "cpu"\nx = torch.ones((2, 2), device=device)\nresult = {"cuda_available": torch.cuda.is_available(), "device": str(x.device), "sum": float(x.sum().item())}\nprint(json.dumps(result, sort_keys=True))',
  }))
  assert.equal(extracted.ok, true, extracted.reason)
}

function testFallbackPreparationCommandSanitizesContractReasonMarkers() {
  const fallback = contract.buildAutonomousPreparationCommand({
    researchGoal: 'Any arbitrary model research goal',
    stepDescription: 'Prepare reusable sandbox',
    stageName: 'Investigation',
    reason: 'code contains placeholder/pseudocode markers',
  })
  assert.doesNotMatch(fallback.code, /placeholder|pseudocode/i)
  const extracted = contract.extractStrictGpuCommand(JSON.stringify(fallback))
  assert.equal(extracted.ok, true, extracted.reason)
}

function runPythonCode(code) {
  const script = path.join(outDir, `fallback-${Date.now()}-${Math.random().toString(16).slice(2)}.py`)
  fs.writeFileSync(script, code)
  const output = childProcess.execFileSync('python3', [script], { encoding: 'utf8', timeout: 120000 })
  return JSON.parse(output)
}

function testAutonomousPreparationFallbackEmitsStepSpecificResearchPlan() {
  const fallback = contract.buildAutonomousPreparationCommand({
    researchGoal: 'Improve diffusion model inference with latent gasket ODE trajectory consensus.',
    stepDescription: 'Implement projection metrics for comparing latent trajectories between two model streams.',
    stageName: 'Investigation',
    reason: 'JSON action must be "run_python"',
  })
  const manifest = runPythonCode(fallback.code)
  assert.equal(manifest.research_goal, 'Improve diffusion model inference with latent gasket ODE trajectory consensus.')
  assert.equal(manifest.step_description, 'Implement projection metrics for comparing latent trajectories between two model streams.')
  assert.ok(Array.isArray(manifest.focus_terms), 'focus_terms should be present')
  assert.ok(manifest.focus_terms.includes('latent'), `expected latent focus term, got ${manifest.focus_terms}`)
  assert.ok(manifest.focus_terms.includes('trajectory'), `expected trajectory focus term, got ${manifest.focus_terms}`)
  assert.ok(manifest.recommended_experiment && /projection metrics/i.test(manifest.recommended_experiment.objective))
  assert.ok(manifest.recommended_experiment.metrics.some(metric => /trajectory/i.test(metric)))
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

function testPreparationStagesShortCircuitWeakModelContractFailures() {
  assert.equal(contract.shouldShortCircuitPreparationFallback('Investigation', 'response did not parse as the required JSON object'), true)
  assert.equal(contract.shouldShortCircuitPreparationFallback('Planning', 'JSON action must be "run_python"'), true)
  assert.equal(contract.shouldShortCircuitPreparationFallback('Investigation', 'code contains placeholder/pseudocode markers'), true)
  assert.equal(contract.shouldShortCircuitPreparationFallback('Implementation', 'response did not parse as the required JSON object'), false)
  assert.equal(contract.shouldShortCircuitPreparationFallback('Testing', 'JSON action must be "run_python"'), false)
}

testExtractsJsonAfterUnclosedThink()
testFallbackPreparationCommandIsExecutableAndPromptIndependent()
testPreparationStageWithValidatedManifestSubmitsExecutableFallbackInsteadOfRawManifestJson()
testAutonomousPreparationFallbackIsLimitedToPreparationStages()
testFallbackUsesWorkerProvidedWorkbenchDirectory()
testAutonomousPreparationFallbackIsAcceptedForPreparationStages()
testAutonomousPreparationFallbackDoesNotCompleteImplementationSteps()
testExtractsPersistablePreparationManifestFromFallbackGpuOutput()
testDeterministicGpuExperimentFallbackUsesManifestAndPassesEvidenceGate()
testPreparationProbeShapeIsInvalidForImplementationEvenIfFallbackFlagIsLost()
testLongProseOutputIsNotValidGpuEvidence()
testJsonMetricsOutputIsValidGpuEvidence()
testStrictGpuCommandRejectsCpuOnlyMetricsCode()
testStrictGpuCommandAcceptsExecutableGpuProbeCode()
testFallbackPreparationCommandSanitizesContractReasonMarkers()
testAutonomousPreparationFallbackEmitsStepSpecificResearchPlan()
testPersistedPreparationManifestKeepsResearchSpecificObjective()
testStrictGpuCommandRejectsExecutableGpuProbeCodeWithUnterminatedPythonString()
testPreparationStagesShortCircuitWeakModelContractFailures()
console.log('strict gpu contract tests passed')
