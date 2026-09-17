"""Anchor-text editing for the demo `POST /document/edit` endpoint.

Same doctrine as `extract.py`: plain-text, lazy imports so /health never
touches them, and the same source guards. Text replacements whose anchors
were read from the same file — free-form regeneration of styled documents
would produce worse artifacts than honest limitations.

`.docx`/`.pptx`: `old_text` must occur exactly once across the document's
paragraphs and table cells — zero or multiple matches fail with a
plain-language 422 asking for more surrounding context (mirrors the
`edit_file` contract, so the model learns one edit shape across formats).
Replacement splices at run level inside the single matching paragraph, so
surrounding runs keep their formatting.

`.xlsx`: whole-cell match only — the anchor must equal a cell's full text
and match exactly one cell workbook-wide. Substring splices inside cells
are refused with a 422. The save is temp-file + atomic replace.
"""

import os
import tempfile
from pathlib import Path

from agento_intelligence.extract import MAX_SOURCE_BYTES, ExtractionError

EXCERPT_RADIUS_CHARS = 240
EXCERPT_MAX_CHARS = 600


def _cap(text: str) -> str:
    if len(text) > EXCERPT_MAX_CHARS:
        return text[:EXCERPT_MAX_CHARS] + "…"
    return text


def _context(full: str, at: int, span: int) -> str:
    start = max(0, at - EXCERPT_RADIUS_CHARS)
    stop = min(len(full), at + span + EXCERPT_RADIUS_CHARS)
    return _cap(full[start:stop])


def _run_key(run) -> tuple:
    """Formatting identity for coalescing: adjacent runs with the same key
    render identically, so merging them cannot change layout.

    Works for python-docx and python-pptx runs (both expose bold/italic/
    underline/strike; font details live under `.font` on pptx runs and
    directly on docx runs). Missing attributes degrade to None — a run
    that cannot be compared is never merged.
    """
    def _get(obj, name):
        try:
            return getattr(obj, name)
        except Exception:
            return None

    font = _get(run, "font")
    # docx runs carry name/size/color directly; pptx runs under .font.
    name = _get(font, "name") if font is not None else _get(run, "name")
    size = _get(font, "size") if font is not None else _get(run, "size")
    color = None
    color_obj = _get(font, "color") if font is not None else _get(run, "color")
    try:
        color = getattr(color_obj, "rgb", None) if color_obj is not None else None
    except Exception:
        color = None
    return (
        _get(run, "bold"),
        _get(run, "italic"),
        _get(run, "underline"),
        _get(run, "strike"),
        str(name) if name is not None else None,
        str(size) if size is not None else None,
        str(color) if color is not None else None,
    )


def _coalesce_runs(paragraph) -> None:
    """Merge adjacent identically-formatted runs in place (idea from the
    docx skill's merge_runs: Word fragments visible phrases across many
    `<w:r>` for rsids/spellcheck, so anchors spanning runs stay findable
    and splices preserve formatting granularity).

    Only merges when `_run_key` matches exactly; empty runs are folded
    away. Never touches revision wrappers — python-docx/pptx do not
    expose ins/del as runs, so there is nothing to merge across here.
    """
    runs = list(getattr(paragraph, "runs", []) or [])
    if len(runs) < 2:
        return
    try:
        keys = [_run_key(run) for run in runs]
    except Exception:
        return
    first = runs[0]
    try:
        first_key = keys[0]
    except Exception:
        return
    for run, key in zip(runs[1:], keys[1:]):
        try:
            text = run.text
        except Exception:
            continue
        if not text:
            continue
        if key == first_key:
            try:
                first.text = (first.text or "") + text
                run.text = ""
            except Exception:
                # A merged/readonly run — leave it; splice still works.
                first = run
                first_key = key
        else:
            first = run
            first_key = key


def _splice_runs(paragraph, anchor: str, replacement: str) -> None:
    """Replace the anchor inside one paragraph, preserving untouched runs."""
    try:
        _coalesce_runs(paragraph)
    except Exception:
        pass
    runs = paragraph.runs
    full = "".join(run.text for run in runs)
    idx = full.find(anchor)
    if idx < 0 or full.find(anchor, idx + len(anchor)) >= 0:
        raise ExtractionError(
            "That text does not match the document exactly — include more "
            "surrounding context so it matches exactly once.",
            422,
        )
    if not runs:
        paragraph.add_run(full[:idx] + replacement + full[idx + len(anchor):])
        return
    end = idx + len(anchor)
    offsets: list[tuple[int, int]] = []
    pos = 0
    for run in runs:
        offsets.append((pos, pos + len(run.text)))
        pos += len(run.text)
    overlapping = [k for k, (a, b) in enumerate(offsets) if a < end and b > idx]
    first, last = overlapping[0], overlapping[-1]
    for k in overlapping:
        a, b = offsets[k]
        if k == first and k == last:
            runs[k].text = runs[k].text[: idx - a] + replacement + runs[k].text[end - a:]
        elif k == first:
            runs[k].text = runs[k].text[: idx - a] + replacement
        elif k == last:
            runs[k].text = runs[k].text[end - a:]
        else:
            runs[k].text = ""


def _holders(document):
    """Every editable text holder: body paragraphs + each table cell's paragraphs."""
    holders = list(document.paragraphs)
    for table in document.tables:
        for row in table.rows:
            for cell in row.cells:
                holders.extend(cell.paragraphs)
    return holders


def _holders_pptx(presentation):
    """Every editable text holder in a deck: shape text frames (in slide
    order) + table cells. python-pptx paragraphs expose the same `.runs`
    splice surface as python-docx, so `_splice_runs` is reused unchanged."""
    holders = []
    for slide in presentation.slides:
        for shape in slide.shapes:
            if shape.has_text_frame:
                holders.extend(shape.text_frame.paragraphs)
            if shape.has_table:
                for row in shape.table.rows:
                    for cell in row.cells:
                        holders.extend(cell.text_frame.paragraphs)
    return holders


def _save_atomic(target: Path, save) -> None:
    handle, tmp_name = tempfile.mkstemp(
        dir=str(target.parent), prefix=target.name + ".", suffix=".agento-tmp"
    )
    try:
        os.close(handle)
        save(tmp_name)
        os.replace(tmp_name, target)
    finally:
        try:
            os.unlink(tmp_name)
        except OSError:
            pass


def _apply_anchor_edits(holders, edits, label: str) -> tuple[str, str, int]:
    """Exactly-once anchor splices over run-level holders (`.docx`/`.pptx`)."""
    before_parts: list[str] = []
    after_parts: list[str] = []
    for edit in edits:
        anchor = edit.get("anchor", "")
        replacement = edit.get("replacement", "")
        if not anchor:
            raise ExtractionError(
                "One of the edits has no text to find — say what text to replace.", 422
            )
        total = sum(holder.text.count(anchor) for holder in holders)
        if total == 0:
            raise ExtractionError(
                f'That text does not match the {label} — include more '
                "surrounding context so I can find the right spot.",
                422,
            )
        if total > 1:
            raise ExtractionError(
                "That text matches more than one place — include more "
                "surrounding context so it matches exactly once.",
                422,
            )
        holder = next(h for h in holders if anchor in h.text)
        at = holder.text.find(anchor)
        before_parts.append(_context(holder.text, at, len(anchor)))
        _splice_runs(holder, anchor, replacement)
        after_parts.append(_context(holder.text, at, len(replacement)))
    joiner = "\n…\n"
    return _cap(joiner.join(before_parts)), _cap(joiner.join(after_parts)), len(edits)


def _is_formula_cell(cell) -> bool:
    """True when the cell holds a formula rather than a plain value.

    MVP guard (xlsx skill idea): openpyxl writes formulas with no cached
    values and strips cached values of untouched formulas on save, so
    overwriting a formula — or writing a new `=...` string — ships blank
    or `#NAME?` cells. Until a recalc step exists, formulas are refused
    with a plain-language 422 instead of being silently corrupted.
    """
    try:
        if getattr(cell, "data_type", None) == "f":
            return True
    except Exception:
        pass
    try:
        value = cell.value
        return isinstance(value, str) and value.startswith("=")
    except Exception:
        return False


def _apply_cell_edits(workbook, edits) -> tuple[str, str, int]:
    """Whole-cell replacements over a workbook: the anchor must equal a
    cell's full text and match exactly one cell workbook-wide."""
    worksheets = [workbook[name] for name in workbook.sheetnames]
    before_parts: list[str] = []
    after_parts: list[str] = []
    for edit in edits:
        anchor = edit.get("anchor", "")
        replacement = edit.get("replacement", "")
        if not anchor:
            raise ExtractionError(
                "One of the edits has no text to find — say what text to replace.", 422
            )
        if isinstance(replacement, str) and replacement.startswith("="):
            raise ExtractionError(
                "I write plain values in spreadsheets in this version — "
                "formulas (starting with `=`) would come back blank until "
                "a recalculation step exists, so say the value to put in.",
                422,
            )
        # Refuse formula cells before the whole-cell match so a formula is
        # never reported as "no match" or silently replaced by a literal.
        formula_hits = [
            (sheet, cell)
            for sheet in worksheets
            for row in sheet.iter_rows()
            for cell in row
            if _is_formula_cell(cell)
            and isinstance(cell.value, str)
            and anchor in cell.value
        ]
        if formula_hits:
            sheet, cell = formula_hits[0]
            raise ExtractionError(
                f'That text lives in a formula at {cell.coordinate} on sheet '
                f'"{sheet.title}" — I leave formulas untouched in this '
                "version so the sheet keeps calculating. Say a plain "
                "value cell to change instead.",
                422,
            )
        matches = [
            (sheet, cell)
            for sheet in worksheets
            for row in sheet.iter_rows()
            for cell in row
            if isinstance(cell.value, str) and cell.value == anchor
        ]
        if not matches:
            substrings = [
                (sheet.title, cell.coordinate)
                for sheet in worksheets
                for row in sheet.iter_rows()
                for cell in row
                if isinstance(cell.value, str) and anchor in cell.value
            ]
            if substrings:
                sheet_title, coordinate = substrings[0]
                raise ExtractionError(
                    "Cells only change as a whole — the closest cell is "
                    f"{coordinate} on sheet \"{sheet_title}\", so use its full "
                    "text as the anchor.",
                    422,
                )
            raise ExtractionError(
                "That text does not match any cell — use a cell's full text "
                "so I can find the right spot.",
                422,
            )
        if len(matches) > 1:
            raise ExtractionError(
                "That text matches more than one cell — say which sheet it's on.",
                422,
            )
        sheet, cell = matches[0]
        try:
            merged = sheet.merged_cells
            if merged is not None and cell.coordinate in merged:
                # Only the top-left anchor of a merged range is writable;
                # anything else is a read-only MergedCell in openpyxl.
                top_left = None
                for span in merged.ranges:
                    if cell.coordinate in span:
                        top_left = span.coord.split(":")[0]
                        break
                if top_left is not None and cell.coordinate != top_left:
                    raise ExtractionError(
                        f"{cell.coordinate} on sheet \"{sheet.title}\" is part "
                        f"of a merged range starting at {top_left} — use "
                        f"{top_left} as the anchor.",
                        422,
                    )
        except ExtractionError:
            raise
        except Exception:
            pass
        before_parts.append(
            f'Sheet "{sheet.title}" {cell.coordinate}: {anchor}'
        )
        try:
            cell.value = replacement
        except AttributeError as error:
            raise ExtractionError(
                f"{cell.coordinate} on sheet \"{sheet.title}\" cannot be "
                "written directly (merged or read-only cell) — use its "
                "top-left cell as the anchor.",
                422,
            ) from error
        after_parts.append(
            f'Sheet "{sheet.title}" {cell.coordinate}: {replacement}'
        )
    joiner = "\n…\n"
    return _cap(joiner.join(before_parts)), _cap(joiner.join(after_parts)), len(edits)


def _verify_saved(target: Path, suffix: str) -> None:
    """MVP post-save re-open check: the file must exist, be non-empty,
    and load again with its own library. Catches saves that python libs
    accept but Word/PowerPoint/Excel would call corrupt (subset of the
    office validate.py idea, without new deps or shell-outs)."""
    try:
        if not target.is_file() or target.stat().st_size == 0:
            raise ExtractionError(
                f'"{target.name}" did not save correctly — the file came '
                "back empty. Nothing was applied.",
                422,
            )
    except ExtractionError:
        raise
    except OSError as error:
        raise ExtractionError(
            f'"{target.name}" could not be checked after saving — {error}.', 422
        ) from error
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
    except ExtractionError:
        raise
    except Exception as error:
        raise ExtractionError(
            f'"{target.name}" did not save in a readable form — {error}. '
            "Nothing else was changed.",
            422,
        ) from error


def edit_document(path: str, edits: list[dict]) -> tuple[str, str, int]:
    """Apply anchor replacements to a `.docx`, `.pptx`, or `.xlsx` file.

    Returns (before_excerpt, after_excerpt, edits_applied). Raises
    ExtractionError with the HTTP status to answer with.
    """
    target = Path(path)
    if not target.is_file():
        # Basename only — same absolute-path-leak doctrine as extract.py.
        raise ExtractionError(f'No document at "{target.name}".', 404)
    try:
        if target.stat().st_size > MAX_SOURCE_BYTES:
            raise ExtractionError(
                f'"{target.name}" is too large to edit '
                f"({target.stat().st_size} bytes > {MAX_SOURCE_BYTES}).",
                413,
            )
    except OSError as error:
        raise ExtractionError(f'No document at "{target.name}" — {error}.', 404) from error

    suffix = target.suffix.lower()
    if suffix not in (".docx", ".pptx", ".xlsx"):
        raise ExtractionError(
            "I can edit Word, PowerPoint, and Excel documents (.docx/.pptx/.xlsx) "
            f'and text files (.md/.txt) — "{target.name}" is neither.',
            422,
        )
    if not edits:
        raise ExtractionError("No edits were given — say what text to replace.", 422)

    try:
        if suffix == ".xlsx":
            from openpyxl import load_workbook

            try:
                workbook = load_workbook(str(target))
            except Exception as error:
                raise ExtractionError(
                    f'"{target.name}" could not be read as an Excel file — {error}.',
                    422,
                ) from error
            try:
                result = _apply_cell_edits(workbook, edits)
                _save_atomic(target, workbook.save)
                workbook.close()
            except ExtractionError:
                workbook.close()
                raise
            _verify_saved(target, suffix)
            return result

        if suffix == ".pptx":
            from pptx import Presentation

            try:
                presentation = Presentation(str(target))
            except Exception as error:
                raise ExtractionError(
                    f'"{target.name}" could not be read as a PowerPoint file — {error}.',
                    422,
                ) from error
            before, after, applied = _apply_anchor_edits(
                _holders_pptx(presentation), edits, "presentation"
            )
            _save_atomic(target, presentation.save)
            _verify_saved(target, suffix)
            return before, after, applied

        import docx

        try:
            document = docx.Document(str(target))
        except Exception as error:
            raise ExtractionError(
                f'"{target.name}" could not be read as a Word document — {error}.', 422
            ) from error
        before, after, applied = _apply_anchor_edits(
            _holders(document), edits, "document"
        )
        _save_atomic(target, document.save)
        _verify_saved(target, suffix)
        return before, after, applied
    except ExtractionError:
        raise
    except Exception as error:
        raise ExtractionError(f'"{target.name}" could not be edited — {error}.', 422) from error
