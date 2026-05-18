#!/usr/bin/env node
const assert = require('assert')
const childProcess = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')
const ts = require('typescript')
const vm = require('vm')

function loadTsModule(relativePath) {
  const filePath = path.join(__dirname, '..', relativePath)
  const source = fs.readFileSync(filePath, 'utf8')
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText
  const module = { exports: {} }
  const context = vm.createContext({ require, module, exports: module.exports, console })
  vm.runInContext(output, context, { filename: filePath })
  return module.exports
}

const { assessGpuExecutionEvidence, assessGpuStepCompletion, buildAutonomousPreparationCommand, buildDeterministicGpuExperimentCommand, extractStrictGpuCommand, selectGpuSubmissionCommand } = loadTsModule('lib/gpu-command-contract.ts')

function testAutonomousPreparationUsesNvidiaSmiFallback() {
  const command = buildAutonomousPreparationCommand({
    researchGoal: 'benchmark arbitrary transformer on the available GPU',
    stepDescription: 'prepare reusable workbench and validate GPU visibility',
    stageName: 'Investigation',
    reason: 'manifest validated',
  })

  assert.strictEqual(command.action, 'run_python')
  assert.ok(command.code.includes('nvidia-smi'), 'preparation probe must query nvidia-smi, not rely only on torch')
  assert.ok(command.code.includes('nvidia_smi'), 'preparation JSON should expose nvidia_smi evidence')
  assert.ok(command.code.includes('cuInit'), 'preparation probe must check CUDA driver init, not only NVML')
  assert.ok(command.code.includes('cuda_compute_available'), 'preparation JSON should distinguish CUDA compute from NVML visibility')
  assert.ok(command.code.includes('torch_cuda_available'), 'preparation JSON should distinguish torch CUDA from driver-level GPU visibility')
}

testAutonomousPreparationUsesNvidiaSmiFallback()

function validBareGpuCode() {
  return [
    'import json',
    'import torch',
    'device = "cuda" if torch.cuda.is_available() else "cpu"',
    'x = torch.ones((2,), device=device)',
    'print(json.dumps({"cuda_available": torch.cuda.is_available(), "device": device, "tensor_sum": float(x.sum().item())}))',
  ].join('\n')
}

function testStrictGpuExtractorAcceptsPyFence() {
  const result = extractStrictGpuCommand('```py\n' + validBareGpuCode() + '\n```')
  assert.strictEqual(result.ok, true, result.reason)
  assert.strictEqual(result.command.action, 'run_python')
  assert.ok(result.command.dependencies.includes('torch'), 'bare py fence should infer torch dependency')
}

function testStrictGpuExtractorAcceptsGenericCodeFence() {
  const result = extractStrictGpuCommand('```code\n' + validBareGpuCode() + '\n```')
  assert.strictEqual(result.ok, true, result.reason)
  assert.strictEqual(result.command.action, 'run_python')
}

function testStrictGpuExtractorStillRejectsProseInGenericFence() {
  const result = extractStrictGpuCommand('```code\nUse torch to run a GPU benchmark and print JSON metrics.\n```')
  assert.strictEqual(result.ok, false)
  assert.match(result.reason, /executable Python syntax|lacks enough/)
}

function testStrictGpuExtractorRejectsUnmanagedTmpModelPaths() {
  const code = [
    'import json',
    'import torch',
    'model_dir = "/tmp/multi_instance_models/instance_0"',
    'print(json.dumps({"cuda_available": torch.cuda.is_available(), "gpu_name": "test", "model_dir": model_dir}))',
  ].join('\n')
  const result = extractStrictGpuCommand('```python\n' + code + '\n```')
  assert.strictEqual(result.ok, false)
  assert.match(result.reason, /unmanaged absolute \/tmp path/)
  assert.match(result.reason, /multi_instance_models/)
}

function testStrictGpuExtractorAllowsManagedWorkbenchPaths() {
  const code = [
    'import json',
    'import torch',
    'artifact = "/tmp/ar3-workbenches/space/artifacts/metrics.json"',
    'print(json.dumps({"cuda_available": torch.cuda.is_available(), "gpu_name": "test", "artifact": artifact}))',
  ].join('\n')
  const result = extractStrictGpuCommand('```python\n' + code + '\n```')
  assert.strictEqual(result.ok, true, result.reason)
}

testStrictGpuExtractorAcceptsPyFence()
testStrictGpuExtractorAcceptsGenericCodeFence()
testStrictGpuExtractorStillRejectsProseInGenericFence()
testStrictGpuExtractorRejectsUnmanagedTmpModelPaths()
testStrictGpuExtractorAllowsManagedWorkbenchPaths()

function manifestWithExpectedArtifacts(artifacts) {
  return {
    smokeTests: [
      {
        name: 'deterministic-smoke',
        expectedEvidence: ['cuda_available', 'tensor_sum'],
      },
    ],
    gradingCriteria: [
      'stdout contains JSON metrics with cuda_available and tensor_sum',
    ],
    workbench: {
      reuseKey: 'deterministic-smoke',
      expectedArtifacts: artifacts,
    },
  }
}

function gpuEvidence(overrides = {}) {
  return JSON.stringify({
    cuda_available: true,
    gpu_name: 'Test GPU',
    tensor_sum: 120,
    runtime_seconds: 0.02,
    artifacts: ['/tmp/ar3-workbenches/deterministic-smoke/metrics.json'],
    ...overrides,
  })
}

function testManifestExpectedArtifactsMustBeReported() {
  const result = assessGpuExecutionEvidence({
    stageName: 'Implementation',
    success: true,
    output: gpuEvidence(),
    preparationManifest: manifestWithExpectedArtifacts(['metrics.json', 'model-card.txt']),
  })

  assert.strictEqual(result.valid, false)
  assert.match(result.reason, /expected artifacts/)
  assert.match(result.reason, /model-card\.txt/)
}

function testManifestExpectedArtifactsAcceptBasenameInArtifactPath() {
  const result = assessGpuExecutionEvidence({
    stageName: 'Implementation',
    success: true,
    output: gpuEvidence(),
    preparationManifest: manifestWithExpectedArtifacts(['metrics.json']),
  })

  assert.strictEqual(result.valid, true, result.reason)
}

testManifestExpectedArtifactsMustBeReported()
testManifestExpectedArtifactsAcceptBasenameInArtifactPath()

function testManifestExpectedArtifactsRejectProseOnlyMentions() {
  const result = assessGpuExecutionEvidence({
    stageName: 'Implementation',
    success: true,
    output: JSON.stringify({
      cuda_available: true,
      gpu_name: 'Test GPU',
      tensor_sum: 120,
      runtime_seconds: 0.02,
      stdout: 'completed run and will save metrics.json after validation',
    }),
    preparationManifest: manifestWithExpectedArtifacts(['metrics.json']),
  })

  assert.strictEqual(result.valid, false)
  assert.match(result.reason, /expected artifacts/)
  assert.match(result.reason, /metrics\.json/)
}

function testManifestExpectedArtifactsAcceptStructuredArtifactObject() {
  const result = assessGpuExecutionEvidence({
    stageName: 'Implementation',
    success: true,
    output: JSON.stringify({
      cuda_available: true,
      gpu_name: 'Test GPU',
      tensor_sum: 120,
      runtime_seconds: 0.02,
      artifact_manifest: {
        metrics: { path: '/tmp/ar3-workbenches/structured/metrics.json' },
      },
    }),
    preparationManifest: manifestWithExpectedArtifacts(['metrics.json']),
  })

  assert.strictEqual(result.valid, true, result.reason)
}

testManifestExpectedArtifactsRejectProseOnlyMentions()
testManifestExpectedArtifactsAcceptStructuredArtifactObject()

function preparationProbeOutput() {
  return `[GPU Execution Result] job:gpu_test\n[CODE]\nprint('prep')\n[/CODE]\n${JSON.stringify({
    type: 'autonomous_preparation_manifest',
    gpu: { cuda_available: true, gpu_name: 'Test GPU' },
    model_ids: ['GSAI-ML/LLaDA-8B-Base'],
    huggingface: [{ model_id: 'GSAI-ML/LLaDA-8B-Base', status_code: 200 }],
    installed_dependencies: ['torch==2.5.1'],
    workbench: '/tmp/ar3-workbenches/test',
    recommended_experiment: { metrics: ['cuda_available', 'runtime_seconds'] },
  })}`
}

function testGpuStepCompletionRejectsPreparationProbeForExperimentStep() {
  const result = assessGpuStepCompletion(preparationProbeOutput(), {
    stepName: 'Measure a minimal executable case for latent alignment',
    stepDescription: 'Run a GPU-backed probe and print JSON metrics for latent trajectory cosine similarity',
  })

  assert.strictEqual(result.valid, false)
  assert.match(result.reason, /preparation probe/i)
  assert.match(result.reason, /not task-specific/i)
}

function testGpuStepCompletionRejectsPreparationProbeForModelExperimentStep() {
  const result = assessGpuStepCompletion(preparationProbeOutput(), {
    stepName: 'Verify LLaDA model inference quality',
    stepDescription: 'Load HuggingFace weights and run a GPU benchmark comparing latent vectors',
  })

  assert.strictEqual(result.valid, false)
  assert.match(result.reason, /preparation probe/i)
}

function testGpuStepCompletionAllowsPreparationProbeForSetupStep() {
  const result = assessGpuStepCompletion(preparationProbeOutput(), {
    stepName: 'Prepare reusable GPU workbench',
    stepDescription: 'Set up model infrastructure and validate HuggingFace/GPU dependencies',
  })

  assert.strictEqual(result.valid, true, result.reason)
}

testGpuStepCompletionRejectsPreparationProbeForExperimentStep()
testGpuStepCompletionRejectsPreparationProbeForModelExperimentStep()
testGpuStepCompletionAllowsPreparationProbeForSetupStep()

function testObjectShapedExpectedEvidenceIsEnforced() {
  const result = assessGpuExecutionEvidence({
    stageName: 'Implementation',
    success: true,
    output: JSON.stringify({
      cuda_available: true,
      gpu_name: 'Test GPU',
      runtime_seconds: 0.02,
      artifacts: ['/tmp/ar3-workbenches/object-evidence/metrics.json'],
    }),
    preparationManifest: {
      smokeTests: [
        {
          name: 'object-evidence-smoke',
          expectedEvidence: [
            { field: 'cuda_available' },
            { metric: 'tensor_sum' },
          ],
        },
      ],
      gradingCriteria: [
        'stdout contains JSON metrics with cuda_available and tensor_sum',
      ],
      workbench: {
        expectedArtifacts: ['metrics.json'],
      },
    },
  })

  assert.strictEqual(result.valid, false)
  assert.match(result.reason, /expected evidence/)
  assert.match(result.reason, /tensor_sum/)
}

function testObjectShapedExpectedArtifactsAreEnforced() {
  const result = assessGpuExecutionEvidence({
    stageName: 'Implementation',
    success: true,
    output: JSON.stringify({
      cuda_available: true,
      gpu_name: 'Test GPU',
      tensor_sum: 120,
      runtime_seconds: 0.02,
      artifacts: ['/tmp/ar3-workbenches/object-artifacts/metrics.json'],
    }),
    preparationManifest: {
      smokeTests: [
        {
          name: 'object-artifact-smoke',
          expectedEvidence: [{ field: 'cuda_available' }, { field: 'tensor_sum' }],
        },
      ],
      gradingCriteria: [
        'stdout contains JSON metrics with cuda_available and tensor_sum',
      ],
      workbench: {
        expectedArtifacts: [
          { path: 'metrics.json' },
          { filename: 'model-status.json' },
        ],
      },
    },
  })

  assert.strictEqual(result.valid, false)
  assert.match(result.reason, /expected artifacts/)
  assert.match(result.reason, /model-status\.json/)
}

testObjectShapedExpectedEvidenceIsEnforced()
testObjectShapedExpectedArtifactsAreEnforced()

function testManifestExpectedArtifactsRejectNegativeArtifactFields() {
  const result = assessGpuExecutionEvidence({
    stageName: 'Implementation',
    success: true,
    output: JSON.stringify({
      cuda_available: true,
      gpu_name: 'Test GPU',
      tensor_sum: 120,
      runtime_seconds: 0.02,
      artifact_error: 'missing metrics.json after validation',
      artifact_status: 'not saved: metrics.json',
    }),
    preparationManifest: manifestWithExpectedArtifacts(['metrics.json']),
  })

  assert.strictEqual(result.valid, false)
  assert.match(result.reason, /expected artifacts/)
  assert.match(result.reason, /metrics\.json/)
}

testManifestExpectedArtifactsRejectNegativeArtifactFields()

function testManifestExpectedArtifactsRejectStatusOnlyMentions() {
  const result = assessGpuExecutionEvidence({
    stageName: 'Implementation',
    success: true,
    output: JSON.stringify({
      cuda_available: true,
      gpu_name: 'Test GPU',
      tensor_sum: 120,
      runtime_seconds: 0.02,
      artifact_status: 'saved metrics.json after validation',
    }),
    preparationManifest: manifestWithExpectedArtifacts(['metrics.json']),
  })

  assert.strictEqual(result.valid, false)
  assert.match(result.reason, /expected artifacts/)
  assert.match(result.reason, /metrics\.json/)
}

testManifestExpectedArtifactsRejectStatusOnlyMentions()

function testManifestExpectedArtifactsRejectNegativeStructuredSibling() {
  const result = assessGpuExecutionEvidence({
    stageName: 'Implementation',
    success: true,
    output: JSON.stringify({
      cuda_available: true,
      gpu_name: 'Test GPU',
      tensor_sum: 120,
      runtime_seconds: 0.02,
      artifacts: [
        {
          path: '/tmp/ar3-workbenches/negative-sibling/metrics.json',
          exists: false,
        },
      ],
    }),
    preparationManifest: manifestWithExpectedArtifacts(['metrics.json']),
  })

  assert.strictEqual(result.valid, false)
  assert.match(result.reason, /expected artifacts/)
  assert.match(result.reason, /metrics\.json/)
}

function testManifestExpectedArtifactsAcceptPositiveStructuredSibling() {
  const result = assessGpuExecutionEvidence({
    stageName: 'Implementation',
    success: true,
    output: JSON.stringify({
      cuda_available: true,
      gpu_name: 'Test GPU',
      tensor_sum: 120,
      runtime_seconds: 0.02,
      artifacts: [
        {
          path: '/tmp/ar3-workbenches/positive-sibling/metrics.json',
          exists: true,
        },
      ],
    }),
    preparationManifest: manifestWithExpectedArtifacts(['metrics.json']),
  })

  assert.strictEqual(result.valid, true, result.reason)
}

testManifestExpectedArtifactsRejectNegativeStructuredSibling()
testManifestExpectedArtifactsAcceptPositiveStructuredSibling()

function testSnakeCaseManifestEvidenceAliasesAreEnforced() {
  const result = assessGpuExecutionEvidence({
    stageName: 'Implementation',
    success: true,
    output: JSON.stringify({
      cuda_available: true,
      gpu_name: 'Test GPU',
      runtime_seconds: 0.02,
      artifacts: ['/tmp/ar3-workbenches/alias-smoke/metrics.json'],
    }),
    preparationManifest: {
      smoke_tests: [
        {
          name: 'alias-smoke',
          expected_evidence: ['cuda_available', 'tensor_sum'],
        },
      ],
      grading_criteria: [
        'stdout contains JSON metrics with cuda_available and tensor_sum',
      ],
      workbench: {
        reuse_key: 'alias-smoke',
        expected_artifacts: ['metrics.json'],
      },
    },
  })

  assert.strictEqual(result.valid, false)
  assert.match(result.reason, /expected evidence/)
  assert.match(result.reason, /tensor_sum/)
}

function testSnakeCaseManifestArtifactAliasesAreEnforced() {
  const result = assessGpuExecutionEvidence({
    stageName: 'Implementation',
    success: true,
    output: JSON.stringify({
      cuda_available: true,
      gpu_name: 'Test GPU',
      tensor_sum: 120,
      runtime_seconds: 0.02,
      artifacts: ['/tmp/ar3-workbenches/alias-smoke/metrics.json'],
    }),
    preparationManifest: {
      smoke_tests: [
        {
          name: 'alias-smoke',
          expected_evidence: ['cuda_available', 'tensor_sum'],
        },
      ],
      grading_criteria: [
        'stdout contains JSON metrics with cuda_available and tensor_sum',
      ],
      workbench: {
        reuse_key: 'alias-smoke',
        expected_artifacts: ['metrics.json', 'model-status.json'],
      },
    },
  })

  assert.strictEqual(result.valid, false)
  assert.match(result.reason, /expected artifacts/)
  assert.match(result.reason, /model-status\.json/)
}

testSnakeCaseManifestEvidenceAliasesAreEnforced()
testSnakeCaseManifestArtifactAliasesAreEnforced()

function testEvidenceParserPrefersMetricsJsonLineOverTrailingStatus() {
  const result = assessGpuExecutionEvidence({
    stageName: 'Implementation',
    success: true,
    output: [
      'starting deterministic experiment',
      JSON.stringify({
        cuda_available: true,
        gpu_name: 'Test GPU',
        tensor_sum: 120,
        runtime_seconds: 0.02,
        artifacts: ['/tmp/ar3-workbenches/json-lines/metrics.json'],
      }),
      JSON.stringify({ status: 'done' }),
    ].join('\n'),
    preparationManifest: manifestWithExpectedArtifacts(['metrics.json']),
  })

  assert.strictEqual(result.valid, true, result.reason)
}

testEvidenceParserPrefersMetricsJsonLineOverTrailingStatus()

function testObjectShapedGradingCriteriaAreEnforced() {
  const result = assessGpuExecutionEvidence({
    stageName: 'Implementation',
    success: true,
    output: JSON.stringify({
      cuda_available: true,
      gpu_name: 'Test GPU',
      runtime_seconds: 0.02,
      tensor_sum: 120,
      artifacts: ['/tmp/ar3-workbenches/object-criteria/metrics.json'],
    }),
    preparationManifest: {
      gradingCriteria: [
        {
          criterion: 'stdout metrics must include metrics.latent_vector_norm',
          evidence: ['metrics.latent_vector_norm'],
        },
      ],
    },
  })

  assert.strictEqual(result.valid, false)
  assert.match(result.reason, /grading criteria/)
  assert.match(result.reason, /latent_vector_norm/)
}

function testObjectShapedGradingCriteriaAcceptConcreteNestedEvidence() {
  const result = assessGpuExecutionEvidence({
    stageName: 'Implementation',
    success: true,
    output: JSON.stringify({
      cuda_available: true,
      gpu_name: 'Test GPU',
      runtime_seconds: 0.02,
      metrics: {
        latent_vector_norm: 3.14,
      },
      artifacts: ['/tmp/ar3-workbenches/object-criteria/metrics.json'],
    }),
    preparationManifest: {
      grading_criteria: [
        {
          criterion: 'stdout metrics must include metrics.latent_vector_norm',
          expected_evidence: ['metrics.latent_vector_norm'],
        },
      ],
    },
  })

  assert.strictEqual(result.valid, true, result.reason)
}

testObjectShapedGradingCriteriaAreEnforced()
testObjectShapedGradingCriteriaAcceptConcreteNestedEvidence()

function testSnakeCaseSuccessCriteriaThresholdsAreEnforced() {
  const result = assessGpuExecutionEvidence({
    stageName: 'Implementation',
    success: true,
    output: JSON.stringify({
      cuda_available: true,
      gpu_name: 'Test GPU',
      runtime_seconds: 0.02,
      metrics: {
        trajectory_cosine_similarity: 0.61,
      },
      artifacts: ['/tmp/ar3-workbenches/success-threshold/metrics.json'],
    }),
    preparationManifest: {
      smoke_tests: [
        {
          name: 'trajectory-smoke',
          expected_evidence: ['cuda_available', 'metrics.trajectory_cosine_similarity'],
        },
      ],
      grading_criteria: [
        'metrics.trajectory_cosine_similarity is reported in stdout',
      ],
      success_criteria: [
        {
          name: 'trajectory similarity',
          metric: 'metrics.trajectory_cosine_similarity',
          threshold: '>= 0.75',
          evidence: 'metrics.trajectory_cosine_similarity',
        },
      ],
      workbench: {
        expected_artifacts: ['metrics.json'],
      },
    },
  })

  assert.strictEqual(result.valid, false)
  assert.match(result.reason, /success-criteria thresholds/)
  assert.match(result.reason, /trajectory_cosine_similarity >= 0.75/)
}

function testSuccessCriteriaThresholdsAcceptPassingMetric() {
  const result = assessGpuExecutionEvidence({
    stageName: 'Implementation',
    success: true,
    output: JSON.stringify({
      cuda_available: true,
      gpu_name: 'Test GPU',
      runtime_seconds: 0.02,
      metrics: {
        trajectory_cosine_similarity: 0.81,
      },
      artifacts: ['/tmp/ar3-workbenches/success-threshold/metrics.json'],
    }),
    preparationManifest: {
      smokeTests: [
        {
          name: 'trajectory-smoke',
          expectedEvidence: ['cuda_available', 'metrics.trajectory_cosine_similarity'],
        },
      ],
      gradingCriteria: [
        'metrics.trajectory_cosine_similarity is reported in stdout',
      ],
      successCriteria: [
        {
          name: 'trajectory similarity',
          metric: 'metrics.trajectory_cosine_similarity',
          threshold: '>= 0.75',
          evidence: 'metrics.trajectory_cosine_similarity',
        },
      ],
      workbench: {
        expectedArtifacts: ['metrics.json'],
      },
    },
  })

  assert.strictEqual(result.valid, true, result.reason)
}

testSnakeCaseSuccessCriteriaThresholdsAreEnforced()
testSuccessCriteriaThresholdsAcceptPassingMetric()

function testDeterministicExperimentUsesSnakeCaseManifestAliases() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ar3-deterministic-'))
  const command = buildDeterministicGpuExperimentCommand({
    researchGoal: 'measure deterministic fallback handoff',
    stepDescription: 'reuse snake-case manifest fields',
    stageName: 'Implementation',
    reason: 'model emitted prose',
    preparationManifest: {
      dependencies: [{ import_name: 'json', name: 'json' }],
      models: [],
      smoke_tests: [{ name: 'snake-smoke', expected_evidence: ['cuda_available'] }],
      grading_criteria: ['cuda_available metric is reported in stdout'],
      workbench: { reuse_key: 'snake-case-workbench', expected_artifacts: ['deterministic_gpu_experiment_metrics.json'] },
    },
  })

  const result = childProcess.spawnSync('python3', ['-'], {
    input: command.code,
    encoding: 'utf8',
    env: { ...process.env, AR3_WORKBENCH_ROOT: tempRoot },
  })

  assert.strictEqual(result.status, 0, result.stderr)
  const output = JSON.parse(result.stdout.trim().split(/\n/).pop())
  assert.match(output.workbench, /snake-case-workbench$/)
  assert.deepStrictEqual(output.grading_criteria_checked, ['cuda_available metric is reported in stdout'])
  assert.strictEqual(output.smoke_tests_declared, 1)
  assert.ok(output.run_history_path.endsWith('deterministic_gpu_experiment_run_history.jsonl'))
  assert.ok(fs.existsSync(output.run_history_path), 'generated experiment should persist run history')
}

testDeterministicExperimentUsesSnakeCaseManifestAliases()

function testDeterministicExperimentUsesManifestDependencyVersions() {
  const command = buildDeterministicGpuExperimentCommand({
    researchGoal: 'verify dependency normalization',
    stepDescription: 'build deterministic fallback',
    stageName: 'Implementation',
    reason: 'model emitted prose',
    preparationManifest: {
      dependencies: [
        { package: 'transformers', version: '4.45.2' },
        { name: 'accelerate', versionSpec: '>=0.33.0' },
        { pipPackage: 'sklearn>=0.0' },
        { name: 'torch', version: '2.5.1' },
      ],
      models: [],
      smokeTests: [],
      gradingCriteria: ['cuda_available metric is reported in stdout'],
      workbench: { reuseKey: 'dependency-version-workbench', expectedArtifacts: ['deterministic_gpu_experiment_metrics.json'] },
    },
  })

  assert.ok(command.dependencies.includes('transformers==4.45.2'))
  assert.ok(command.dependencies.includes('accelerate>=0.33.0'))
  assert.ok(command.dependencies.includes('sklearn>=0.0'))
  assert.ok(!command.dependencies.some((dep) => dep.startsWith('torch')), 'torch is installed by worker CUDA pinning')
}

testDeterministicExperimentUsesManifestDependencyVersions()

function testRecommendedExperimentMetricsAreRequiredEvidence() {
  const result = assessGpuExecutionEvidence({
    stageName: 'Investigation',
    success: true,
    output: JSON.stringify({
      cuda_available: true,
      gpu_name: 'RTX 2060 SUPER',
      runtime_seconds: 1.2,
    }),
    preparationManifest: {
      smokeTests: [{ name: 'gpu', expectedEvidence: ['cuda_available'] }],
      recommendedExperiment: {
        metrics: ['latent_vector_norm', 'trajectory_cosine_similarity'],
      },
    },
  })

  assert.strictEqual(result.valid, false)
  assert.match(result.reason, /expected evidence/)
  assert.match(result.reason, /latent_vector_norm/)
}

function testRecommendedExperimentMetricsAcceptConcreteOutput() {
  const result = assessGpuExecutionEvidence({
    stageName: 'Investigation',
    success: true,
    output: JSON.stringify({
      cuda_available: true,
      gpu_name: 'RTX 2060 SUPER',
      runtime_seconds: 1.2,
      latent_vector_norm: 3.14,
      trajectory_cosine_similarity: 0.73,
    }),
    preparationManifest: {
      smokeTests: [{ name: 'gpu', expectedEvidence: ['cuda_available'] }],
      recommendedExperiment: {
        metrics: ['latent_vector_norm', 'trajectory_cosine_similarity'],
      },
    },
  })

  assert.strictEqual(result.valid, true, result.reason)
}

testRecommendedExperimentMetricsAreRequiredEvidence()
testRecommendedExperimentMetricsAcceptConcreteOutput()

function testInvalidPythonFallsBackToDeterministicExperimentWhenManifestExists() {
  const badResponse = JSON.stringify({
    action: 'run_python',
    dependencies: ['torch'],
    code: [
      'import json',
      'import torch',
      'metrics = {',
      '    "cuda_available": torch.cuda.is_available(),',
      '    "probe_timestamp": __import__("os").times()',
      '    "gpu_name": "test"',
      '}',
      'print(json.dumps(metrics))',
    ].join('\n'),
  })
  const selected = selectGpuSubmissionCommand({
    stageName: 'Implementation',
    llmResponse: badResponse,
    researchGoal: 'verify syntax rejection',
    stepDescription: 'run executable fallback',
    preparationManifest: {
      dependencies: [],
      models: [],
      smokeTests: [{ name: 'gpu', expectedEvidence: ['cuda_available'] }],
      gradingCriteria: ['cuda_available metric is reported'],
      workbench: { reuseKey: 'syntax-rejection-workbench', expectedArtifacts: ['deterministic_gpu_experiment_metrics.json'] },
    },
  })

  assert.strictEqual(selected.ok, true, selected.reason)
  assert.match(selected.reason, /deterministic GPU experiment/)
  assert.doesNotMatch(selected.command.code, /probe_timestamp.*os\.times/)
  const result = childProcess.spawnSync('python3', ['-'], {
    input: selected.command.code,
    encoding: 'utf8',
    env: { ...process.env, AR3_WORKBENCH_ROOT: fs.mkdtempSync(path.join(os.tmpdir(), 'ar3-syntax-fallback-')) },
  })
  assert.strictEqual(result.status, 0, result.stderr)
}

testInvalidPythonFallsBackToDeterministicExperimentWhenManifestExists()

function testModelExperimentStepRequiresModelExecutionEvidence() {
  const result = assessGpuStepCompletion(
    [
      '[GPU Execution Result] job:gpu_live_regression',
      JSON.stringify({
        cuda_available: true,
        gpu_name: 'NVIDIA GeForce RTX 2060 SUPER',
        artifacts: ['/tmp/ar3-workbench/deterministic_gpu_experiment_metrics.json'],
        research_metrics: {
          latent_vector_norm: 8.1,
          trajectory_cosine_similarity: 0.99,
        },
      }),
    ].join('\n'),
    {
      stepName: 'Execute initial experiments with two identical LLaDA-8B-Base models on standard prompts',
      stepDescription: 'Compare baseline generation quality with and without the gasket mechanism.',
    },
  )

  assert.strictEqual(result.valid, false)
  assert.match(result.reason, /model load.*experiment.*training attempt/i)
}

function testModelExperimentStepAcceptsHardwareLimitEvidence() {
  const result = assessGpuStepCompletion(
    [
      '[GPU Execution Result] job:gpu_hardware_limit',
      JSON.stringify({
        cuda_available: true,
        gpu_name: 'NVIDIA GeForce RTX 2060 SUPER',
        model_load_attempts: [
          {
            id: 'GSAI-ML/LLaDA-8B-Base',
            attempted: true,
            model_loaded: false,
            hardware_limit: true,
            model_load_error: 'CUDA out of memory',
          },
        ],
      }),
    ].join('\n'),
    {
      stepName: 'Execute initial experiments with two identical LLaDA-8B-Base models on standard prompts',
      stepDescription: 'Compare baseline generation quality with and without the gasket mechanism.',
    },
  )

  assert.strictEqual(result.valid, true, result.reason)
}

testModelExperimentStepRequiresModelExecutionEvidence()
testModelExperimentStepAcceptsHardwareLimitEvidence()

function testModelExperimentCompletionIgnoresSubmittedCodeBlock() {
  const result = assessGpuStepCompletion(
    [
      '[GPU Execution Result] job:gpu_code_block_regression',
      '[CODE]',
      JSON.stringify({
        action: 'run_python',
        code: 'print({"model_load_attempts": []})',
      }),
      '[/CODE]',
      JSON.stringify({
        cuda_available: true,
        gpu_name: 'NVIDIA GeForce RTX 2060 SUPER',
        model_load_attempts: [
          {
            id: 'GSAI-ML/LLaDA-8B-Base',
            attempted: true,
            model_loaded: false,
            hardware_limit: true,
            model_load_error: 'CUDA out of memory',
          },
        ],
      }),
    ].join('\n'),
    {
      stepName: 'Build a multi-model inference pipeline that runs two copies of LLaDA-8B-Base',
      stepDescription: 'Attempt model loading and report a clear hardware limit if VRAM is insufficient.',
    },
  )

  assert.strictEqual(result.valid, true, result.reason)
}

testModelExperimentCompletionIgnoresSubmittedCodeBlock()

function testModelDownloadStepAcceptsWorkerModelResolutionLogs() {
  const result = assessGpuStepCompletion(
    [
      '[GPU Execution Result] job:gpu_model_resolution_logs',
      'preparation_manifest=/tmp/ar3-workbench/preparation_manifest.json',
      'model_resolution:',
      'model_resolve GSAI-ML/LLaDA-8B-Base exit=0',
      'STDOUT:',
      JSON.stringify({
        downloaded_files: [
          'config.json',
          'model-00001-of-00006.safetensors',
        ],
        local_dir: '/opt/AR-3/model_cache/gsai-ml-llada-8b-base',
        ok: true,
        sha: '0f2787f2d87eac5eed8a087d5ecd24277e6255b2',
      }),
      'smoke_test torch_cuda_smoke exit=0',
      'STDOUT:',
      JSON.stringify({ cuda_available: true, device: 'cuda:0', sum: 1 }),
    ].join('\n'),
    {
      stepName: 'Download and organize all 6 model files for LLaDA-8B-Base from the GSAI-ML repos',
      stepDescription: 'Download and organize all 6 model files for LLaDA-8B-Base from the GSAI-ML repository into a structured directory layout for multi-instance loading.',
    },
  )

  assert.strictEqual(result.valid, true, result.reason)
}

testModelDownloadStepAcceptsWorkerModelResolutionLogs()
console.log('gpu-command-contract tests passed')
