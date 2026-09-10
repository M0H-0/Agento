# Demo fixture folder generator (docs/07 §4.1 recording prep).
#
# Builds a deliberately messy "Downloads"-style workspace: 42 files — PDFs,
# Word docs, text/markdown, images, spreadsheets-of-noise, duplicates, and
# junk folders — so the on-camera ask ("organize this folder by file type,
# then summarize every PDF") has real work to do.
#
# Run with the sidecar's environment (it already has pypdf + python-docx):
#   cd services/intelligence
#   uv run python ../../demo/make_fixture.py [target_dir]
#
# Default target: demo/demo-workspace next to this script. Safe to re-run:
# it wipes and rebuilds the target folder.

import base64
import shutil
import sys
from pathlib import Path

from docx import Document
from pypdf import PdfWriter

TARGET = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).parent / "demo-workspace"

# 1x1 transparent PNG — a valid image without a binary blob in this source.
PNG_BYTES = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGBgAAAABQAB"
    "h6FO1AAAAABJRU5ErkJggg=="
)

INVOICE_TEXT = (
    "INVOICE {n}\n"
    "Northwind Traders Ltd.\n"
    "Date: 2026-{month:02d}-{day:02d}\n\n"
    "Consulting services .......... ${amount}.00\n"
    "Tax (0%) ..................... $0.00\n"
    "Total due .................... ${amount}.00\n"
    "Payment terms: net 30 days.\n"
)

NOTES_TEXT = (
    "Meeting notes — week {n}\n\n"
    "We discussed the pricing proposal for the Q4 campaign. The client wants "
    "tiered pricing: a flat retainer plus per-seat fees. Pricing page copy "
    "needs to reflect this before launch.\n\n"
    "Action items:\n"
    "- update the pricing page\n"
    "- circulate the revised contract\n"
    "- book the follow-up for Friday\n"
)


def make_pdf(path: Path, title: str, pages: int = 1) -> None:
    writer = PdfWriter()
    for page in range(pages):
        writer.add_blank_page(width=612, height=792)
    with path.open("wb") as handle:
        writer.write(handle)
    # pypdf blank pages carry no text; the plain-language cards and the
    # summarizer work off the sidecar's extraction, so keep expectations
    # honest via the filename/title metadata instead.
    writer.add_metadata({"/Title": title})


def make_docx(path: Path, heading: str, body: str) -> None:
    document = Document()
    document.add_heading(heading, level=1)
    for paragraph in body.split("\n"):
        document.add_paragraph(paragraph)
    document.save(str(path))


def main() -> None:
    if TARGET.exists():
        shutil.rmtree(TARGET)
    (TARGET / "invoices").mkdir(parents=True)
    (TARGET / "images" / "screenshots").mkdir(parents=True)
    (TARGET / "old" / "archive-2024").mkdir(parents=True)

    created: list[Path] = []

    # 12 invoice PDFs across months — the summarize-every-PDF payload.
    for n in range(1, 13):
        month = (n - 1) % 12 + 1
        path = TARGET / "invoices" / f"invoice_2026-{month:02d}_northwind.pdf"
        make_pdf(path, f"Invoice {n} — Northwind Traders")
        created.append(path)

    # 6 Word documents (meeting notes / pricing drafts).
    for n in range(1, 7):
        path = TARGET / f"Q4-pricing-meeting-{n}.docx"
        make_docx(path, f"Meeting notes — week {n}", NOTES_TEXT.format(n=n))
        created.append(path)

    # 12 text/markdown files.
    for n in range(1, 13):
        ext = "md" if n % 2 == 0 else "txt"
        path = TARGET / f"notes-week-{n}.{ext}"
        path.write_text(NOTES_TEXT.format(n=n), encoding="utf-8")
        created.append(path)

    # 6 images, some nested, some with Windows-hostile-but-legal names.
    images = [
        TARGET / "images" / "banner final v2.png",
        TARGET / "images" / "banner final v3 (actually final).png",
        TARGET / "images" / "screenshots" / "error 2026-09-01 14-32.png",
        TARGET / "images" / "logo — large.png",
        TARGET / "images" / "diagram:pricing flow.png".replace(":", "-"),
        TARGET / "images" / "squeanly_1x1.png",
    ]
    for path in images:
        path.write_bytes(PNG_BYTES)
        created.append(path)

    # 4 duplicates (byte-identical copies in other folders) + 2 strays.
    shutil.copyfile(created[0], TARGET / "old" / "invoice_2026-01_northwind (copy).pdf")
    shutil.copyfile(created[12], TARGET / "old" / "Q4-pricing-meeting-1 (copy).docx")
    shutil.copyfile(images[0], TARGET / "old" / "banner final v2 (copy).png")
    shutil.copyfile(created[20], TARGET / "old" / "archive-2024" / "notes-week-1 (copy).txt")
    (TARGET / "todo.txt").write_text(
        "- clean up this folder\n- find every file about pricing\n", encoding="utf-8"
    )
    (TARGET / "readme final FINAL.md").write_text(
        "# Where things are\n\nThey are everywhere. That is the problem.\n",
        encoding="utf-8",
    )

    total = len(created) + 6  # duplicates + strays
    print(f"Wrote {total} files under {TARGET}")
    print(f"  12 invoice PDFs, 6 .docx, 12 text/markdown, 6 images, 6 duplicates/strays")


if __name__ == "__main__":
    main()
