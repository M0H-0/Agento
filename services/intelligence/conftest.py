"""Pytest bootstrap for the intelligence sidecar (docs/07; M0.7).

Must run before `agento_intelligence.main` is first imported, for two reasons:

1. EXPECTED_TOKEN is read from the environment at IMPORT time in
   agento_intelligence/main.py (fail-closed when unset), so the token has to
   be set here at module level — pytest imports conftest.py before collecting
   any test module.
2. Import path: the pytest console script (unlike `python -m pytest` or
   uvicorn) does not put the cwd on sys.path. With pytest's default
   "prepend" import mode, this root-level conftest's directory
   (services/intelligence/) is prepended to sys.path, which is how
   `import agento_intelligence` resolves (the project is intentionally
   unpackaged — see pyproject.toml).
"""

import os

os.environ["AGENTO_INTELLIGENCE_TOKEN"] = "m07-pytest-smoke-token"
