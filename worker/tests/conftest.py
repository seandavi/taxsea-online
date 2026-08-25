"""Puts worker/ (main.py's directory) on sys.path so `import main` works from tests/,
and sets the env vars main.py reads at import time before anything imports it."""

import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

os.environ.setdefault("WORKER_SHARED_SECRET", "test-secret")
os.environ.setdefault("RSCRIPT_TIMEOUT_SECONDS", "5")
