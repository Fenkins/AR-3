# Diagnostics Scripts

This directory contains small operator-only inspection helpers for local or
deployed AR-3 instances. They are not part of the application runtime.

Run them from the repository root after the app dependencies and Prisma client
are installed, for example:

```bash
node scripts/diagnostics/check_status.js
node scripts/diagnostics/check_spaces.js
```

Keep one-off patch applicators, hardcoded secrets, and environment-specific
mutation scripts out of the repository. If a fix is still needed, apply it to
the source file and cover it with a focused test instead.
