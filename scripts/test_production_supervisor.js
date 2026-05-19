#!/usr/bin/env node
const assert = require('assert')
const fs = require('fs')
const path = require('path')

const script = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'production-supervisor.sh'), 'utf8')
const pidForPattern = script.match(/pid_for_pattern\(\) \{[\s\S]*?\n\}/)
assert.ok(pidForPattern, 'production supervisor must define pid_for_pattern')
assert.match(
  pidForPattern[0],
  /pgrep -af/,
  'pid_for_pattern must inspect full pid+command lines so it can filter false matches',
)
assert.match(
  pidForPattern[0],
  /\$pid" = "\$\$"/,
  'pid_for_pattern must exclude the supervisor process itself',
)
assert.match(
  pidForPattern[0],
  /\$pid" = "\$PPID"/,
  'pid_for_pattern must exclude the parent shell/ssh command that may contain the search pattern as an argument',
)
assert.match(
  pidForPattern[0],
  /production-supervisor\.sh/,
  'pid_for_pattern must exclude production-supervisor command lines from service detection',
)

assert.ok(
  pidForPattern[0].includes('bash\\ -c*|sh\\ -c*)'),
  'pid_for_pattern must exclude shell wrapper commands from SSH/cron checks that mention service filenames',
)

console.log('production supervisor tests passed')
