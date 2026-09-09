"""FastAPI app for the intelligence sidecar (docs/05).

The Electron main process spawns this (docs/02 §2.4) as:

    uv run uvicorn agento_intelligence.main:app --port 7891

from this directory; uvicorn puts the cwd on sys.path, which is how the
`agento_intelligence` package resolves (the project is intentionally
unpackaged — see pyproject.toml). Heavy imports (Docling) stay lazy so
/health answers immediately (docs/05 §1).
"""

import logging
import os
import tomllib
from pathlib import Path

from fastapi import FastAPI, HTTPException

from agento_intelligence.auth import TokenAuthMiddleware
from agento_intelligence.embed import EmbeddingError, embed_texts
from agento_intelligence.extract import ExtractionError, extract_text
from agento_intelligence.heuristics import classify_intent, classify_safety
from agento_intelligence.schemas import (
    Capabilities,
    EmbedRequest,
    EmbedResponse,
    ExtractRequest,
    ExtractResponse,
    HealthResponse,
    IntentClassifyRequest,
    IntentClassifyResponse,
    SafetyClassifyRequest,
    SafetyClassifyResponse,
)

_logger = logging.getLogger("agento_intelligence")

# Per-launch token passed by the spawner (M0.5) via the environment.
EXPECTED_TOKEN = os.environ.get("AGENTO_INTELLIGENCE_TOKEN")
if EXPECTED_TOKEN is None:
    _logger.warning(
        "AGENTO_INTELLIGENCE_TOKEN is not set; refusing every request with 403 "
        "(fail closed, docs/05 §1)."
    )


def _version_from_pyproject() -> str:
    pyproject = Path(__file__).resolve().parent.parent / "pyproject.toml"
    with pyproject.open("rb") as f:
        return str(tomllib.load(f)["project"]["version"])


APP_VERSION = _version_from_pyproject()

app = FastAPI(title="Agento Intelligence", version=APP_VERSION)
app.add_middleware(TokenAuthMiddleware, expected_token=EXPECTED_TOKEN)


@app.get("/health", response_model=HealthResponse)
async def health() -> HealthResponse:
    return HealthResponse(
        status="ok",
        version=APP_VERSION,
        capabilities=Capabilities(),
    )


@app.post("/document/extract", response_model=ExtractResponse)
async def document_extract(request: ExtractRequest) -> ExtractResponse:
    try:
        text, truncated = extract_text(request.path)
    except ExtractionError as error:
        raise HTTPException(status_code=error.status_code, detail=str(error)) from error
    return ExtractResponse(text=text, truncated=truncated)


@app.post("/embed/embed", response_model=EmbedResponse)
async def embed(request: EmbedRequest) -> EmbedResponse:
    try:
        vectors = embed_texts(request.texts)
    except EmbeddingError as error:
        raise HTTPException(status_code=error.status_code, detail=str(error)) from error
    return EmbedResponse(vectors=vectors)


@app.post("/intent/classify", response_model=IntentClassifyResponse)
async def intent_classify(request: IntentClassifyRequest) -> IntentClassifyResponse:
    # Heuristic-only in the MVP (MVP_PLAN.md): the confidence literal is
    # honest provenance — an LLM fallback would return "llm" and never crashes
    # the pipeline into a lower confidence than the heuristic's best guess.
    return IntentClassifyResponse(intent=classify_intent(request.message))


@app.post("/safety/classify", response_model=SafetyClassifyResponse)
async def safety_classify(request: SafetyClassifyRequest) -> SafetyClassifyResponse:
    risk, reason = classify_safety(request.tool, request.args)
    return SafetyClassifyResponse(risk=risk, reason=reason)
