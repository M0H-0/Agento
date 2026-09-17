# Report/demo fixture folder generator — report-grade edition (docs/07 §4.1).
#
# Unlike make_fixture.py (blank PDFs + 1x1 images for cheap e2e), this builds
# files with REAL readable content so report screenshots look authentic:
# Arabic-text PDFs printed by Edge headless (proper shaping + logical-order
# text that the app's pypdf extraction reads correctly), Word/Excel/PowerPoint
# with data, and real rendered images (Pillow). 25 files total, deliberately
# messy: Arabic and English names, spaces, duplicates, nested folders.
#
# Run (system python has all deps):
#   python demo/make_report_fixture.py [target_dir]
#
# Default target: demo/report-demo-workspace. Safe to re-run (wipes target).

import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont
from docx import Document
from openpyxl import Workbook
from pptx import Presentation

TARGET = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).parent / "report-demo-workspace"

EDGE_CANDIDATES = [
    Path(r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"),
    Path(r"C:\Program Files\Microsoft\Edge\Application\msedge.exe"),
]
EDGE = next((c for c in EDGE_CANDIDATES if c.exists()), None)

PAGE_CSS = ("@page { size: A4; margin: 2cm; } "
            "body { font-family: Arial, sans-serif; direction: rtl; "
            "line-height: 1.9; font-size: 14px; }")


def print_pdf(html_body: str, dest: Path) -> Path:
    if EDGE is None:
        raise RuntimeError("Microsoft Edge not found — needed to print Arabic PDFs")
    with tempfile.TemporaryDirectory() as td:
        src = Path(td) / "doc.html"
        src.write_text(
            '<!DOCTYPE html><html dir="rtl" lang="ar"><head><meta charset="utf-8">'
            f"<style>{PAGE_CSS}</style></head><body>{html_body}</body></html>",
            encoding="utf-8",
        )
        subprocess.run(
            [str(EDGE), "--headless=new", "--disable-gpu", "--no-pdf-header-footer",
             f"--print-to-pdf={dest}", src.as_uri()],
            check=True, capture_output=True, timeout=60,
        )
    return dest


# ---------------------------------------------------------------- content ---

INVOICE_AR = """<h2>فاتورة رقم 2026-{month:02d}</h2>
<p>شركة نورثويند للتجارة المحدودة — دمشق، سوريا</p>
<p>التاريخ: 2026-{month:02d}-{day:02d}</p>
<p>وصف الخدمة: {service}</p>
<p>المبلغ: {amount} دولار أمريكي</p>
<p>الإجمالي المستحق: <b>{amount} دولار</b> — شروط الدفع: خلال 30 يوماً من تاريخ الفاتورة.</p>
<p>للاستفسار: accounting@northwind.example</p>"""

REPORT_AR = """<h1>{title}</h1>
<p>{intro}</p>
<h3>أولاً: الملخص التنفيذي</h3>
<p>يستعرض هذا التقرير {topic} خلال الفترة المذكورة، ويقدم تحليلاً للأرقام الرئيسية
مع توصيات قابلة للتنفيذ. بلغ إجمالي النمو {growth}% مقارنة بالفترة السابقة.</p>
<h3>ثانياً: النتائج الرئيسية</h3>
<p>1. تحسن مؤشر رضا العملاء بنسبة 12 نقطة وفق الاستبيان الربعي.</p>
<p>2. انخفض متوسط زمن الاستجابة من 48 ساعة إلى 19 ساعة.</p>
<p>3. نمت الإيرادات الشهرية المتكررة إلى {mrr} دولار.</p>
<h3>ثالثاً: التوصيات</h3>
<p>نوصي بتوسيع فريق الدعم بموظفين اثنين، وإعادة التفاوض على عقود التوريد السنوية،
وأتمتة التقارير الشهرية لتوفير نحو 20 ساعة عمل شهرياً.</p>"""

NOTES_AR = (
    "ملاحظات اجتماع — الأسبوع {n}\n\n"
    "ناقشنا مقترح التسعير الخاص بحملة الربع الرابع. يريد العميل تسعيراً متدرجاً:\n"
    "أتعاب ثابتة شهرية + رسوم لكل مقعد إضافي.\n\n"
    "بنود العمل:\n"
    "- تحديث صفحة التسعير قبل الإطلاق\n"
    "- تعميم العقد المعدل على الفريق\n"
    "- حجز اجتماع المتابعة يوم الجمعة\n"
)

NOTES_EN = (
    "Meeting notes — week {n}\n\n"
    "We discussed the pricing proposal for the Q4 campaign. The client wants "
    "tiered pricing: a flat retainer plus per-seat fees.\n\n"
    "Action items:\n"
    "- update the pricing page\n"
    "- circulate the revised contract\n"
    "- book the follow-up for Friday\n"
)

# ------------------------------------------------------------------ makers ---


def make_docx(path: Path, heading: str, lines: list[str]) -> Path:
    d = Document()
    d.add_heading(heading, level=1)
    for line in lines:
        d.add_paragraph(line)
    d.save(str(path))
    return path


def make_pptx(path: Path, title: str, slides: list[tuple[str, list[str]]]) -> Path:
    prs = Presentation()
    slide = prs.slides.add_slide(prs.slide_layouts[0])
    slide.shapes.title.text = title
    slide.placeholders[1].text = "إعداد: فريق المشروع — 2026"
    for stitle, bullets in slides:
        s = prs.slides.add_slide(prs.slide_layouts[1])
        s.shapes.title.text = stitle
        s.placeholders[1].text = "\n".join("• " + b for b in bullets)
    prs.save(str(path))
    return path


def make_xlsx(path: Path, sheet: str, header: list[str], rows: list[list]) -> Path:
    wb = Workbook()
    ws = wb.active
    ws.title = sheet
    ws.append(header)
    for r in rows:
        ws.append(r)
    wb.save(str(path))
    return path


def make_image(path: Path, label: str, color: tuple, accent: tuple, w=900, h=560) -> Path:
    img = Image.new("RGB", (w, h), color)
    dr = ImageDraw.Draw(img)
    for i in range(h):  # simple vertical gradient
        t = i / h
        dr.line([(0, i), (w, i)],
                fill=tuple(int(c * (1 - t) + a * t) for c, a in zip(color, accent)))
    dr.rectangle([30, 30, w - 30, h - 30], outline=(255, 255, 255), width=4)
    try:
        font = ImageFont.truetype(r"C:\Windows\Fonts\segoeui.ttf", 44)
        small = ImageFont.truetype(r"C:\Windows\Fonts\segoeui.ttf", 24)
    except OSError:
        font = small = ImageFont.load_default()
    dr.text((w // 2, h // 2 - 30), label, fill=(255, 255, 255), font=font, anchor="mm")
    dr.text((w // 2, h // 2 + 30), "Agento demo asset — 2026", fill=(255, 255, 255),
            font=small, anchor="mm")
    img.save(str(path))
    return path


# -------------------------------------------------------------------- main ---

def main() -> None:
    if TARGET.exists():
        shutil.rmtree(TARGET)
    (TARGET / "فواتير قديمة").mkdir(parents=True)
    (TARGET / "images" / "screenshots").mkdir(parents=True)
    (TARGET / "أرشيف").mkdir(parents=True)
    created: list[Path] = []

    def reg(p: Path) -> Path:
        created.append(p)
        return p

    # --- 5 Arabic PDFs (invoices + reports) ----------------------------------
    # Kept lean on purpose (2026-09-17): the Act organize run issues ~one tool
    # call per provider round-trip, and Ollama Cloud throttles long runs, so
    # the demo fixture stays small enough to finish in one go.
    services = ["خدمات استشارية شهرية", "تصميم واجهات المستخدم", "إدارة حملة إعلانية"]
    for n in range(1, 4):  # 3 invoices
        html = INVOICE_AR.format(month=n + 2, day=5 + n * 3, service=services[n - 1],
                                 amount=1200 + n * 350)
        reg(print_pdf(html, TARGET / f"فاتورة نورثويند 2026-{n+2:02d}.pdf"))
    reg(print_pdf(REPORT_AR.format(title="تقرير الأداء — الربع الثاني 2026",
                                   intro="يقدم هذا التقرير قراءة تحليلية لأداء الشركة خلال الربع الثاني.",
                                   topic="مؤشرات التشغيل والإيرادات", growth="9", mrr="41,500"),
                  TARGET / "تقرير الأداء الربع الثاني.pdf"))
    reg(print_pdf("<h2>محطات العام وأرقامه المالية والتشغيلية في نظرة واحدة.</h2>",
                  TARGET / "التقرير السنوي المختصر.pdf"))
    # --- 2 English PDFs ------------------------------------------------------
    for n in range(1, 3):
        html = (f"<h2>Invoice 2026-{n+8:02d}</h2><p>Northwind Traders Ltd.</p>"
                f"<p>Consulting services ....... ${1500 + n * 200}.00</p>"
                f"<p>Total due ................ ${1500 + n * 200}.00 — net 30 days.</p>")
        reg(print_pdf(html, TARGET / f"Invoice_2026-{n+8:02d}_northwind.pdf"))

    # --- 3 DOCX --------------------------------------------------------------
    for n in range(1, 3):
        reg(make_docx(TARGET / f"ملاحظات اجتماع التسعير ({n}).docx",
                      f"ملاحظات اجتماع الأسبوع {n}",
                      NOTES_AR.format(n=n).split("\n")))
    reg(make_docx(TARGET / "Q4-pricing-draft.docx", "Q4 Pricing Draft",
                  ["Tier 1: $900/mo retainer + $15/seat",
                   "Tier 2: $1,800/mo retainer + $12/seat",
                   "Annual prepay: 2 months free"]))

    # --- 1 PPTX + 2 XLSX -----------------------------------------------------
    reg(make_pptx(TARGET / "عرض التسعير الجديد.pptx", "عرض التسعير الجديد",
                  [("الطبقات الثلاث", ["أساسية 900$", "متقدمة 1800$", "مؤسسية حسب الطلب"]),
                   ("المقارنة مع المنافسين", ["أرخص 20% من المتوسط", "ميزات فريدة في الأتمتة"])]))
    reg(make_xlsx(TARGET / "ميزانية 2026.xlsx", "الربع الأول",
                  ["البند", "المخطط", "الفعلي"],
                  [["التسويق", 12000, 11400], ["الرواتب", 45000, 45000],
                   ["التجهيزات", 8000, 9250], ["السفر", 3000, 2100]]))
    reg(make_xlsx(TARGET / "clients list 2026.xlsx", "Clients",
                  ["Client", "Country", "MRR"],
                  [["Acme Corp", "US", 2400], ["Brightline", "UK", 1800],
                   ["شركة النور", "SY", 950]]))

    # --- 3 images ------------------------------------------------------------
    reg(make_image(TARGET / "images" / "banner final v2.png", "Banner v2", (30, 90, 120), (10, 40, 60)))
    reg(make_image(TARGET / "images" / "screenshots" / "dashboard preview.png", "Dashboard preview", (20, 100, 80), (5, 45, 35)))
    reg(make_image(TARGET / "صورة المنتج الجديد.png", "Product photo", (90, 90, 110), (40, 40, 55)))

    # --- 8 text / markdown / csv ---------------------------------------------
    reg(TARGET / "notes-week-1.txt")
    (TARGET / "notes-week-1.txt").write_text(NOTES_EN.format(n=1), encoding="utf-8")
    reg(TARGET / "todo.txt")
    (TARGET / "todo.txt").write_text("- ترتيب هذا المجلد\n- إيجاد كل ملف يخص التسعير\n- إرسال الفواتير المتأخرة\n", encoding="utf-8")
    reg(TARGET / "readme final FINAL.md")
    (TARGET / "readme final FINAL.md").write_text("# أين كل شيء؟\n\nفي كل مكان. هذه هي المشكلة.\n", encoding="utf-8")
    reg(TARGET / "بيانات العملاء.csv")
    (TARGET / "بيانات العملاء.csv").write_text(
        "الاسم,المدينة,الهاتف\nأحمد خليل,دمشق,0932123456\nسارة عمر,حلب,0944987654\nليلى حداد,حمص,0955112233\n", encoding="utf-8")
    reg(TARGET / "أرشيف" / "خطة العام القديمة.txt")
    (TARGET / "أرشيف" / "خطة العام القديمة.txt").write_text("خطة 2024 — للأرشفة فقط، لا تعديل.\n", encoding="utf-8")
    reg(TARGET / "أرشيف" / "meeting notes old (copy).txt")
    (TARGET / "أرشيف" / "meeting notes old (copy).txt").write_text(NOTES_EN.format(n=1), encoding="utf-8")
    reg(TARGET / "ملاحظات-أسبوع-1 (نسخة).txt")
    (TARGET / "ملاحظات-أسبوع-1 (نسخة).txt").write_text(NOTES_AR.format(n=1), encoding="utf-8")
    reg(TARGET / "Invoice_2026-09_northwind (copy).pdf")
    shutil.copyfile(TARGET / "Invoice_2026-09_northwind.pdf",
                    TARGET / "Invoice_2026-09_northwind (copy).pdf")
    reg(TARGET / "pricing keywords.txt")
    (TARGET / "pricing keywords.txt").write_text(
        "pricing, tiered pricing, retainer, per-seat fees, Q4 campaign\n", encoding="utf-8")

    kinds = {}
    for p in created:
        ext = p.suffix.lower() or "(none)"
        kinds[ext] = kinds.get(ext, 0) + 1
    print(f"Wrote {len(created)} files under {TARGET}")
    for k in sorted(kinds, key=kinds.get, reverse=True):
        print(f"  {k:8s} x{kinds[k]}")


if __name__ == "__main__":
    main()
