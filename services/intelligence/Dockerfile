# Agento intelligence sidecar — Docker image (dev/eval only).
#
# Scope: this containerizes ONLY the Python sidecar (FastAPI on port 7891).
# The Electron app (app/) stays native on Windows: GUI window, safeStorage,
# better-sqlite3 Electron-ABI binary, %APPDATA%/Agento storage, and the
# Windows-path sandbox cannot run usefully in Docker (docs/02 §2.4, §5).
#
# Mirrors the native spawn contract in app/src/main/sidecar.ts:
#   cwd = services/intelligence (unpackaged project resolves off cwd)
#   cmd = uv run uvicorn agento_intelligence.main:app --port 7891
#   env = AGENTO_INTELLIGENCE_TOKEN (per-launch, fail-closed 403 when unset)
#         + FASTEMBED_CACHE_PATH (durable, not TEMP) + HF_HUB_OFFLINE=1
#         + UV_LINK_MODE=copy
# Version truth stays in pyproject.toml + uv.lock (STACK.md law) — no pins here.

FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    UV_SYSTEM_PYTHON=1 \
    UV_LINK_MODE=copy \
    HF_HUB_OFFLINE=1 \
    FASTEMBED_CACHE_PATH=/data/fastembed

RUN pip install --no-cache-dir uv

WORKDIR /code/services/intelligence

# Dependency layer first for build cache: only the manifests.
COPY pyproject.toml uv.lock ./
RUN uv sync --locked --no-dev

# Then the unpackaged source (resolves off cwd via uvicorn, not install).
COPY agento_intelligence/ ./agento_intelligence/

VOLUME /data/fastembed
EXPOSE 7891

CMD ["uv", "run", "uvicorn", "agento_intelligence.main:app", "--host", "0.0.0.0", "--port", "7891"]
