"""fastembed embedding pipeline for the MVP semantic search (MVP_PLAN.md).

The model (`all-MiniLM-L6-v2`, 384-dim) runs entirely on-device via ONNX;
it downloads (~90 MB) on first use and is cached by fastembed/huggingface.
`_get_model()` is module-level so tests can monkeypatch it. Both the import
and the model construction are lazy per the app convention — /health must
answer without them.
"""

import threading

_MODEL_NAME = "sentence-transformers/all-MiniLM-L6-v2"

# MVP endpoint guards: a single embed call stays bounded.
MAX_BATCH_TEXTS = 256
MAX_BATCH_CHARS = 400_000

# Reentrant: _get_model() takes the lock and embed_texts() holds it across
# the call — a plain Lock deadlocks on the real (unpatched) path.
_lock = threading.RLock()
_model = None


class EmbeddingError(Exception):
    """Embedding failure with the HTTP status the endpoint should answer."""

    def __init__(self, message: str, status_code: int) -> None:
        super().__init__(message)
        self.status_code = status_code


def _get_model():
    global _model
    with _lock:
        if _model is None:
            try:
                from fastembed import TextEmbedding
            except Exception as error:
                raise EmbeddingError(
                    f"The embedding model could not be loaded — {error}.", 503
                ) from error
            try:
                _model = TextEmbedding(_MODEL_NAME)
            except Exception as error:
                raise EmbeddingError(
                    f"The embedding model could not be built — {error}.", 503
                ) from error
        return _model


def embed_texts(texts: list[str]) -> list[list[float]]:
    """Embed a batch of texts. Serialized behind the lock — the ONNX session
    is not guaranteed thread-safe and MVP serves one user."""
    if len(texts) > MAX_BATCH_TEXTS:
        raise EmbeddingError(
            f"Too many texts in one batch ({len(texts)} > {MAX_BATCH_TEXTS}).", 422
        )
    if not texts:
        return []
    total_chars = sum(len(text) for text in texts)
    if total_chars > MAX_BATCH_CHARS:
        raise EmbeddingError(
            f"Batch too large ({total_chars} chars > {MAX_BATCH_CHARS}).", 422
        )
    with _lock:
        model = _get_model()
        try:
            return [vector.tolist() for vector in model.embed(texts)]
        except EmbeddingError:
            raise
        except Exception as error:
            raise EmbeddingError(
                f"Embedding failed — {error}.", 503
            ) from error
