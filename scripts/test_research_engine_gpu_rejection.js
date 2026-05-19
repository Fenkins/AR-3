#!/usr/bin/env node
const assert = require("assert")
const fs = require("fs")
const path = require("path")

const source = fs.readFileSync(path.join(__dirname, "..", "lib", "research-engine.ts"), "utf8")
const rejectionBlockMatch = source.match(/if \(!selectedGpuCommand\.ok\) \{([\s\S]*?)\n\s*\} else \{/)
assert.ok(rejectionBlockMatch, "research engine must have an explicit strict GPU command rejection branch")
const rejectionBlock = rejectionBlockMatch[1]
assert.match(
  rejectionBlock,
  /gpuEvidenceInvalidReasonForExperiment\s*=/,
  "strict GPU command rejection must mark the experiment failed instead of completing prose-only output"
)
assert.match(
  rejectionBlock,
  /strict GPU command/i,
  "failure reason should preserve strict GPU command context for retry/audit logs"
)
console.log("research-engine strict GPU rejection blocks stage advancement")
