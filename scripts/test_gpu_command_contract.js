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

const { assessGpuExecutionEvidence, buildAutonomousPreparationCommand, buildDeterministicGpuExperimentCommand, extractStrictGpuCommand } = loadTsModule('lib/gpu-command-contract.ts')

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

testStrictGpuExtractorAcceptsPyFence()
testStrictGpuExtractorAcceptsGenericCodeFence()
testStrictGpuExtractorStillRejectsProseInGenericFence()

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
console.log('gpu-command-contract tests passed')
