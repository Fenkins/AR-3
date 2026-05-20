const assert = require('assert')
const fs = require('fs')
const ts = require('typescript')

const source = fs.readFileSync('lib/research-engine.ts', 'utf8')
const start = source.indexOf('function verifyTestingOutput(')
assert.ok(start >= 0, 'verifyTestingOutput function must exist')
const endMarker = '\n}\n\nexport async function getSpaceStages'
const end = source.indexOf(endMarker, start)
assert.ok(end > start, 'verifyTestingOutput function boundary must be found')
const functionSource = source.slice(start, end + 3)
const compiled = ts.transpileModule(`${functionSource}\nmodule.exports = { verifyTestingOutput }`, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2019 },
}).outputText
const moduleUnderTest = { exports: {} }
new Function('module', 'exports', compiled)(moduleUnderTest, moduleUnderTest.exports)
const { verifyTestingOutput } = moduleUnderTest.exports

const gpuResultWithDefensiveCode = `
[GPU Execution Result] job:gpu_test
[CODE]
try:
    maybe_gpu_model.to("cuda")
except RuntimeError as exc:
    hardware_limit = "out of memory" in str(exc).lower() or "cuda out of memory" in str(exc).lower()
[OUTPUT]
{"verdict":"PASS","metrics":{"accuracy":0.91,"runtime_seconds":1.25},"gpu_name":"NVIDIA GeForce GTX 1080 Ti","torch_cuda_available":true}
VERDICT: PASS
METRICS: accuracy=0.91 runtime_seconds=1.25
`
const verified = verifyTestingOutput('Evidence-First Probe', 'GPU model benchmark', gpuResultWithDefensiveCode)
assert.equal(verified.valid, true, 'Testing verification must scan executed OUTPUT for error indicators, not defensive exception strings in [CODE]')


const gpuResultWithJsonOnlyVerdict = `
[GPU Execution Result] job:gpu_json_verdict
[CODE]
print({"verdict": "PASS", "metrics": {"accuracy": 0.91}})
[OUTPUT]
{"verdict":"PASS","metrics":{"accuracy":0.91,"runtime_seconds":1.25},"gpu_name":"NVIDIA GeForce GTX 1080 Ti","torch_cuda_available":true}
`
const jsonOnlyVerified = verifyTestingOutput('Evidence-First Probe', 'GPU model benchmark', gpuResultWithJsonOnlyVerdict)
assert.equal(jsonOnlyVerified.valid, true, 'Testing verification must accept machine-readable JSON verdict fields without requiring a duplicated VERDICT: text line')



const gpuResultWithStatusOnlyPass = `
[GPU Execution Result] job:gpu_status_verdict
[CODE]
print({"status": "PASS", "metrics": {"diversity_score": 1.42}})
[OUTPUT]
{"status":"PASS","metrics":{"diversity_score":1.42,"runtime_seconds":0.03},"baseline_verdict":{"ensemble_potential":true}}
=== PASS ===
`
const statusOnlyVerified = verifyTestingOutput('Mechanism Isolation', 'GPU benchmark with status field', gpuResultWithStatusOnlyPass)
assert.equal(statusOnlyVerified.valid, true, 'Testing verification must accept executable JSON status PASS plus numeric metrics as a verdict synonym')

const gpuResultWithNonVerdictField = `
[GPU Execution Result] job:gpu_non_verdict
[CODE]
print({"nonverdict": "PASS", "metrics": {"accuracy": 0.91}})
[OUTPUT]
{"nonverdict":"PASS","metrics":{"accuracy":0.91,"runtime_seconds":1.25},"gpu_name":"NVIDIA GeForce GTX 1080 Ti","torch_cuda_available":true}
`
const nonVerdictRejected = verifyTestingOutput('Evidence-First Probe', 'GPU model benchmark', gpuResultWithNonVerdictField)
assert.equal(nonVerdictRejected.valid, false, 'Testing verification must not accept nonverdict or other larger field names as a verdict')
assert.ok(nonVerdictRejected.missingChecks.includes('VERDICT (PASS/FAIL statement)'))

const gpuResultWithRealOutputError = `
[GPU Execution Result] job:gpu_test
[CODE]
print("hello")
[OUTPUT]
RuntimeError: CUDA out of memory while allocating tensor
`
const rejected = verifyTestingOutput('Evidence-First Probe', 'GPU model benchmark', gpuResultWithRealOutputError)
assert.equal(rejected.valid, false, 'Testing verification must still reject real runtime errors in [OUTPUT]')
assert.match(rejected.reason, /error indicators/i)

console.log('testing output verification tests passed')
