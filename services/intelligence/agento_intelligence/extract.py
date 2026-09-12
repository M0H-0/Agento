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
MAX_PPTX_SLIDES = 500
MAX_PPTX_BLOCKS = 20_000
MAX_XLSX_SHEETS = 50
MAX_XLSX_ROWS = 100_000

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
    elif suffix == ".pptx":
        text = _extract_pptx(target)
    elif suffix == ".xlsx":
        text = _extract_xlsx(target)
    elif suffix in _TEXT_SUFFIXES:
        text = target.read_text(encoding="utf-8", errors="replace")
    elif suffix in (".xls", ".ppt"):
        raise ExtractionError(
            f'"{target.name}" is a legacy Office file — save it as '
            f'{"Excel (.xlsx)" if suffix == ".xls" else "PowerPoint (.pptx)"} first.',
            422,
        )
    else:
        raise ExtractionError(
            "I can only extract text from .pdf, .docx, .pptx, .xlsx, .txt and .md "
            f'files — "{target.name}" is not one of those.',
            422,
        )

    if len(text) > MAX_EXTRACT_CHARS:
        return text[:MAX_EXTRACT_CHARS], True
    return text, False


def _extract_pdf(target: Path) -> str:
    # Lazy import: pypdf (~wheel) must not sit on /health's import path.
    from pypdf import PdfReader
    from pypdf.errors import PdfReadError

    try:
        reader = PdfReader(str(target))
        if getattr(reader, "is_encrypted", False):
            try:
                # Empty password covers "protected" PDFs that open without
                # one; anything else stays an honest 422 (no OCR in MVP).
                result = reader.decrypt("")
                if result == 0:
                    raise ExtractionError(
                        f'"{target.name}" is password-protected — remove the '
                        "password or save a copy without one first.",
                        422,
                    )
            except ExtractionError:
                raise
            except Exception as error:
                raise ExtractionError(
                    f'"{target.name}" is password-protected — remove the '
                    "password or save a copy without one first.",
                    422,
                ) from error
        if len(reader.pages) > MAX_PDF_PAGES:
            raise ExtractionError(
                f'"{target.name}" has too many pages '
                f"({len(reader.pages)} > {MAX_PDF_PAGES}).",
                413,
            )
        collected: list[str] = []
        total = 0
        for number, page in enumerate(reader.pages, start=1):
            try:
                chunk = page.extract_text() or ""
            except Exception:
                chunk = ""
            chunk = chunk.strip()
            if not chunk:
                continue
            collected.append(f"--- Page {number} ---")
            collected.append(chunk)
            total += len(chunk)
            # Stop early past the char cap — no point parsing 500 pages
            # when the caller only keeps the first 200k chars.
            if total > MAX_EXTRACT_CHARS:
                break
        if not collected:
            raise ExtractionError(
                f'"{target.name}" has no readable text — it may be scanned '
                "images. Save it as searchable text first, or read it as "
                "an image where supported.",
                422,
            )
    except ExtractionError:
        raise
    except (PdfReadError, Exception) as error:  # pypdf raises a zoo of parse exceptions
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


def _extract_pptx(target: Path) -> str:
    # Lazy import: python-pptx pulls lxml/Pillow — same /health argument.
    from pptx import Presentation

    try:
        presentation = Presentation(str(target))
        if len(presentation.slides) > MAX_PPTX_SLIDES:
            raise ExtractionError(
                f'"{target.name}" has too many slides '
                f"({len(presentation.slides)} > {MAX_PPTX_SLIDES}).",
                413,
            )
        collected: list[str] = []
        blocks = 0
        total = 0
        for number, slide in enumerate(presentation.slides, start=1):
            collected.append(f"--- Slide {number} ---")
            for shape in slide.shapes:
                if shape.has_text_frame:
                    for paragraph in shape.text_frame.paragraphs:
                        if paragraph.text:
                            collected.append(paragraph.text)
                            blocks += 1
                            total += len(paragraph.text)
                if shape.has_table:
                    for row in shape.table.rows:
                        line = "\t".join(cell.text for cell in row.cells)
                        collected.append(line)
                        blocks += 1
                        total += len(line)
                if blocks > MAX_PPTX_BLOCKS:
                    raise ExtractionError(
                        f'"{target.name}" has too many text blocks '
                        f"(> {MAX_PPTX_BLOCKS}).",
                        413,
                    )
                # Stop early past the char cap — same doctrine as the PDF path.
                if total > MAX_EXTRACT_CHARS:
                    break
            if total > MAX_EXTRACT_CHARS:
                break
    except ExtractionError:
        raise
    except Exception as error:
        raise ExtractionError(
            f'"{target.name}" could not be read as a PowerPoint file — {error}.', 422
        ) from error
    return "\n".join(collected)


def _extract_xlsx(target: Path) -> str:
    # Lazy import: openpyxl is only needed for spreadsheets.
    from openpyxl import load_workbook

    try:
        workbook = load_workbook(str(target), read_only=True, data_only=True)
        if len(workbook.sheetnames) > MAX_XLSX_SHEETS:
            raise ExtractionError(
                f'"{target.name}" has too many sheets '
                f"({len(workbook.sheetnames)} > {MAX_XLSX_SHEETS}).",
                413,
            )
        collected: list[str] = []
        rows = 0
        total = 0
        for name in workbook.sheetnames:
            collected.append(f"--- Sheet: {name} ---")
            for row in workbook[name].iter_rows(values_only=True):
                cells = ["" if value is None else str(value) for value in row]
                while cells and not cells[-1]:
                    cells.pop()
                if not cells:
                    continue
                line = "\t".join(cells)
                collected.append(line)
                rows += 1
                total += len(line)
                if rows > MAX_XLSX_ROWS:
                    raise ExtractionError(
                        f'"{target.name}" has too many rows (> {MAX_XLSX_ROWS}).',
                        413,
                    )
                # Stop early past the char cap — same doctrine as the PDF path.
                if total > MAX_EXTRACT_CHARS:
                    break
            if total > MAX_EXTRACT_CHARS:
                break
        workbook.close()
    except ExtractionError:
        raise
    except Exception as error:
        raise ExtractionError(
            f'"{target.name}" could not be read as an Excel file — {error}.', 422
        ) from error
    return "\n".join(collected)
