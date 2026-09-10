"""Plain-text extraction for the MVP `/document/extract` endpoint.

The MVP cut (MVP_PLAN.md, 2026-09-10) uses pypdf + python-docx for the two
binary document formats instead of Docling (STACK.md's M4.7 structured
parser stays the full-build choice). Heavy imports are lazy per the app's
stated convention — /health must answer without touching them.

Extracted text is capped at MAX_EXTRACT_CHARS with an honest `truncated`
flag; the caller (src/main/agent tools) applies its own smaller caps.
"""

from pathlib import Path

# ~200k chars ≈ a 200+ page text PDF; past this the caller's own cap makes
# more extraction pointless for MVP-sized files.
MAX_EXTRACT_CHARS = 200_000
# Source guards: extraction never reads unbounded input into memory.
# 20 MB covers real MVP documents; past it the caller gets an honest 413
# instead of an OOM or a multi-minute parse.
MAX_SOURCE_BYTES = 20_000_000
MAX_PDF_PAGES = 500
MAX_DOCX_BLOCKS = 20_000

_TEXT_SUFFIXES = {".txt", ".md", ".markdown"}


class ExtractionError(Exception):
    """Plain-language extraction failure with the HTTP status to answer with."""

    def __init__(self, message: str, status_code: int) -> None:
        super().__init__(message)
        self.status_code = status_code


def extract_text(path: str) -> tuple[str, bool]:
    """Extract plain text from a document. Returns (text, truncated)."""
    target = Path(path)
    if not target.is_file():
        raise ExtractionError(f'No document at "{path}".', 404)

    try:
        if target.stat().st_size > MAX_SOURCE_BYTES:
            raise ExtractionError(
                f'"{target.name}" is too large to extract '
                f"({target.stat().st_size} bytes > {MAX_SOURCE_BYTES}).",
                413,
            )
    except OSError as error:
        raise ExtractionError(f'No document at "{path}" — {error}.', 404) from error

    suffix = target.suffix.lower()
    if suffix == ".pdf":
        text = _extract_pdf(target)
    elif suffix == ".docx":
        text = _extract_docx(target)
    elif suffix in _TEXT_SUFFIXES:
        text = target.read_text(encoding="utf-8", errors="replace")
    else:
        raise ExtractionError(
            f'I can only extract text from .pdf, .docx, .txt and .md files — '
            f'"{target.name}" is not one of those.',
            422,
        )

    if len(text) > MAX_EXTRACT_CHARS:
        return text[:MAX_EXTRACT_CHARS], True
    return text, False


def _extract_pdf(target: Path) -> str:
    # Lazy import: pypdf (~wheel) must not sit on /health's import path.
    from pypdf import PdfReader

    try:
        reader = PdfReader(str(target))
        if len(reader.pages) > MAX_PDF_PAGES:
            raise ExtractionError(
                f'"{target.name}" has too many pages '
                f"({len(reader.pages)} > {MAX_PDF_PAGES}).",
                413,
            )
        collected: list[str] = []
        total = 0
        for page in reader.pages:
            chunk = page.extract_text() or ""
            if not chunk:
                continue
            collected.append(chunk)
            total += len(chunk)
            # Stop early past the char cap — no point parsing 500 pages
            # when the caller only keeps the first 200k chars.
            if total > MAX_EXTRACT_CHARS:
                break
    except ExtractionError:
        raise
    except Exception as error:  # pypdf raises a zoo of parse exceptions
        raise ExtractionError(
            f'"{target.name}" could not be read as a PDF — {error}.', 422
        ) from error
    return "\n".join(collected)


def _extract_docx(target: Path) -> str:
    # Lazy import: python-docx pulls lxml — same /health argument.
    import docx

    try:
        document = docx.Document(str(target))
        paragraphs = [p.text for p in document.paragraphs]
        # Tables ride along as tab-joined cell rows — cheap and keeps the
        # "summarize my report" path honest for tabular .docx files.
        for table in document.tables:
            for row in table.rows:
                paragraphs.append("\t".join(cell.text for cell in row.cells))
                if len(paragraphs) > MAX_DOCX_BLOCKS:
                    raise ExtractionError(
                        f'"{target.name}" has too many text blocks '
                        f"(> {MAX_DOCX_BLOCKS}).",
                        413,
                    )
        if len(paragraphs) > MAX_DOCX_BLOCKS:
            raise ExtractionError(
                f'"{target.name}" has too many text blocks '
                f"(> {MAX_DOCX_BLOCKS}).",
                413,
            )
    except ExtractionError:
        raise
    except Exception as error:  # python-docx raises on malformed packages
        raise ExtractionError(
            f'"{target.name}" could not be read as a Word document — {error}.', 422
        ) from error
    return "\n".join(p for p in paragraphs if p)
