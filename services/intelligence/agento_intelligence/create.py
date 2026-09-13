"""Demo `POST /document/create` endpoint: build a `.docx` document, a `.pptx`
deck, or an `.xlsx` workbook from plain strings.

Same doctrine as `extract.py`/`edit.py`: the model supplies content, never
layout — title + content per paragraph/slide, one row per item for sheets. Lazy
imports so /health never touches them; the save is temp-file + atomic
replace. Input caps (not source guards — nothing is read) keep a runaway
item list from producing a multi-hundred-page document.
"""

import os
import tempfile
from pathlib import Path

from agento_intelligence.extract import ExtractionError

MAX_CREATE_ITEMS = 200
MAX_CREATE_CHARS = 50_000
EXCERPT_MAX_CHARS = 600


def _cap(text: str) -> str:
    if len(text) > EXCERPT_MAX_CHARS:
        return text[:EXCERPT_MAX_CHARS] + "…"
    return text


def _create_docx(target: Path, title: str, items: list[str]) -> str:
    import docx

    document = docx.Document()
    document.add_heading(title or target.stem, level=0)
    for item in items:
        head, _, body = item.partition("\n")
        if body:
            document.add_heading(head, level=1)
            for line in body.split("\n"):
                if line:
                    document.add_paragraph(line)
        else:
            document.add_paragraph(head)
    handle, tmp_name = tempfile.mkstemp(
        dir=str(target.parent), prefix=target.name + ".", suffix=".agento-tmp"
    )
    try:
        os.close(handle)
        document.save(tmp_name)
        os.replace(tmp_name, target)
    finally:
        try:
            os.unlink(tmp_name)
        except OSError:
            pass
    excerpt = "\n".join([title or target.stem, *items])
    return _cap(excerpt)


def _create_pptx(target: Path, title: str, items: list[str]) -> str:
    from pptx import Presentation

    presentation = Presentation()
    title_layout = presentation.slide_layouts[0]
    bullet_layout = presentation.slide_layouts[1]
    first = presentation.slides.add_slide(title_layout)
    first.shapes.title.text = title or target.stem
    if len(first.placeholders) > 1:
        first.placeholders[1].text = "Created with Agento"
    for item in items:
        slide = presentation.slides.add_slide(bullet_layout)
        slide.shapes.title.text = item.split("\n", 1)[0]
        body = item.split("\n", 1)[1] if "\n" in item else ""
        if len(slide.placeholders) > 1:
            slide.placeholders[1].text = body
    handle, tmp_name = tempfile.mkstemp(
        dir=str(target.parent), prefix=target.name + ".", suffix=".agento-tmp"
    )
    try:
        os.close(handle)
        presentation.save(tmp_name)
        os.replace(tmp_name, target)
    finally:
        try:
            os.unlink(tmp_name)
        except OSError:
            pass
    excerpt = "\n".join([title or target.stem, *items])
    return _cap(excerpt)


def _create_xlsx(target: Path, title: str, items: list[str]) -> str:
    from openpyxl import Workbook

    workbook = Workbook()
    sheet = workbook.active
    sheet.title = (title or target.stem)[:31]
    for item in items:
        sheet.append([item])
    handle, tmp_name = tempfile.mkstemp(
        dir=str(target.parent), prefix=target.name + ".", suffix=".agento-tmp"
    )
    try:
        os.close(handle)
        workbook.save(tmp_name)
        os.replace(tmp_name, target)
    finally:
        try:
            os.unlink(tmp_name)
        except OSError:
            pass
    workbook.close()
    excerpt = "\n".join(items)
    return _cap(excerpt)


def _verify_saved_docx(target: Path, suffix: str) -> None:
    """Post-save re-open check so Word/PowerPoint/Excel never get a corrupt
    file (same doctrine as edit.py's verifier, without a cross-module import)."""
    try:
        if suffix == ".xlsx":
            from openpyxl import load_workbook

            workbook = load_workbook(str(target), read_only=True, data_only=True)
            workbook.close()
        elif suffix == ".pptx":
            from pptx import Presentation

            Presentation(str(target))
        else:
            import docx

            docx.Document(str(target))
    except Exception as error:
        raise ExtractionError(
            f'"{target.name}" did not save in a readable form — {error}. '
            "Nothing else was changed.",
            422,
        ) from error


def create_document(path: str, title: str, items: list[str]) -> tuple[str, int]:
    """Build a `.docx`, `.pptx`, or `.xlsx` file from plain strings.

    Returns (after_excerpt, size_bytes). Raises ExtractionError with the
    HTTP status to answer with.
    """
    target = Path(path)
    suffix = target.suffix.lower()
    if suffix not in (".docx", ".pptx", ".xlsx"):
        raise ExtractionError(
            "I can create Word (.docx), PowerPoint (.pptx), and Excel (.xlsx) files — "
            f'"{target.name}" is neither. Text files go through write_file.',
            422,
        )
    if len(items) > MAX_CREATE_ITEMS:
        raise ExtractionError(
            f"That is too much for one file ({len(items)} items > {MAX_CREATE_ITEMS}) — "
            "split it into smaller parts.",
            422,
        )
    total = len(title) + sum(len(item) for item in items)
    if total > MAX_CREATE_CHARS:
        raise ExtractionError(
            "That is too much text for one file — shorten it and try again.",
            422,
        )
    try:
        target.parent.mkdir(parents=True, exist_ok=True)
        if suffix == ".docx":
            excerpt = _create_docx(target, title, items)
        elif suffix == ".pptx":
            excerpt = _create_pptx(target, title, items)
        else:
            excerpt = _create_xlsx(target, title, items)
        _verify_saved_docx(target, suffix)
        return excerpt, target.stat().st_size
    except ExtractionError:
        raise
    except Exception as error:
        raise ExtractionError(
            f'"{target.name}" could not be created — {error}.', 422
        ) from error
