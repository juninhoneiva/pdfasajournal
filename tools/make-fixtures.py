"""Gera PDFs de teste para o pipeline (requer reportlab e Pillow)."""
import os, sys
from reportlab.lib.pagesizes import A4
from reportlab.pdfgen import canvas
from reportlab.lib.utils import ImageReader
from PIL import Image, ImageDraw

OUT = os.path.join(os.path.dirname(__file__), "..", "test", "fixtures")
os.makedirs(OUT, exist_ok=True)

LOREM = ("Lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor "
         "incididunt ut labore et dolore magna aliqua Ut enim ad minim veniam quis nostrud "
         "exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat").split()

def words(n, seed):
    return " ".join(LOREM[(seed + i) % len(LOREM)] for i in range(n))

def wrap(c, text, font, size, width):
    lines, cur = [], ""
    for w in text.split():
        t = (cur + " " + w).strip()
        if c.stringWidth(t, font, size) > width:
            lines.append(cur); cur = w
        else:
            cur = t
    if cur: lines.append(cur)
    return lines

def column(c, x, y, width, paras, size=10, leading=13):
    for kind, text in paras:
        if kind == "h":
            y -= 6
            c.setFont("Helvetica-Bold", 14); c.drawString(x, y, text); y -= 20
            continue
        font = "Times-Roman"
        for i, line in enumerate(wrap(c, text, font, size, width - (12 if kind == "p" else 0))):
            c.setFont(font, size)
            c.drawString(x + (12 if (i == 0 and kind == "p") else 0), y, line)
            y -= leading
        y -= 4
    return y

def make_images():
    # Arte com transparencia real (canal alfa)
    art = Image.new("RGBA", (300, 300), (0, 0, 0, 0))
    d = ImageDraw.Draw(art)
    d.ellipse((20, 20, 280, 280), fill=(180, 40, 40, 255))
    d.polygon([(150, 40), (260, 250), (40, 250)], fill=(240, 200, 60, 255))
    art.save(os.path.join(OUT, "_art_alpha.png"))
    # Arte com fundo branco (sem alfa) -> deve ficar transparente com a opcao
    flat = Image.new("RGB", (300, 200), (255, 255, 255))
    d = ImageDraw.Draw(flat)
    d.rectangle((60, 40, 240, 160), fill=(30, 90, 160))
    flat.save(os.path.join(OUT, "_art_white.png"))
    # Foto (borda nao uniforme) -> nao deve ser recortada
    photo = Image.new("RGB", (200, 200))
    for i in range(200):
        for j in range(200):
            photo.putpixel((i, j), (i, j, (i * j) % 255))
    photo.save(os.path.join(OUT, "_photo.png"))

def two_columns():
    c = canvas.Canvas(os.path.join(OUT, "two-columns.pdf"), pagesize=A4)
    W, H = A4
    for page in range(3):
        c.setFont("Helvetica", 8); c.drawString(50, H - 30, "Manual do Aventureiro")
        c.drawString(W / 2, 25, str(page + 1))
        c.setFont("Helvetica-Bold", 22); c.drawString(50, H - 70, f"Capitulo {page + 1}: A Jornada")
        colw = (W - 100 - 20) / 2
        paras = [("p", words(60, page)), ("h", "Secao de Regras"), ("p", words(45, page + 3)),
                 ("p", words(70, page + 5)), ("p", words(40, page + 7))]
        column(c, 50, H - 110, colw, paras)
        column(c, 50 + colw + 20, H - 110, colw, list(reversed(paras)))
        if page == 0:
            c.drawImage(ImageReader(os.path.join(OUT, "_art_alpha.png")), 50 + colw + 20, 60, 150, 150, mask="auto")
        if page == 1:
            c.drawImage(os.path.join(OUT, "_art_white.png"), 50, 60, 180, 120)
        c.showPage()
    c.save()

def three_columns():
    c = canvas.Canvas(os.path.join(OUT, "three-columns.pdf"), pagesize=A4)
    W, H = A4
    c.setFont("Helvetica-Bold", 22); c.drawString(50, H - 70, "Bestiario")
    c.setFont("Helvetica-Oblique", 11); c.drawString(50, H - 90, "Criaturas das terras do norte")
    colw = (W - 100 - 2 * 18) / 3
    for k in range(3):
        column(c, 50 + k * (colw + 18), H - 120, colw,
               [("h", f"Criatura {k + 1}"), ("p", words(50, k)), ("p", words(35, k + 2))])
    c.drawImage(os.path.join(OUT, "_photo.png"), 50, 80, 120, 120)
    c.showPage(); c.save()

def art_page():
    """Mimics a full-page illustration page: paper spread background, flat mask layer, artwork on
    top, vertical side tab (one letter per line), header and page number."""
    W, H = 594, 774
    paper = Image.new("RGB", (400, 260), (236, 228, 210))
    for i in range(0, 400, 7):
        ImageDraw.Draw(paper).line((i, 0, i, 260), fill=(226, 218, 198))
    paper.save(os.path.join(OUT, "_paper.png"))
    Image.new("RGB", (120, 160), (255, 255, 255)).save(os.path.join(OUT, "_flat.png"))
    c = canvas.Canvas(os.path.join(OUT, "art-page.pdf"), pagesize=(W, H))
    c.drawImage(os.path.join(OUT, "_paper.png"), -10, -10, 1208, 794)  # two-page spread
    c.drawImage(os.path.join(OUT, "_flat.png"), -1, -1, 596, 776)
    c.drawImage(os.path.join(OUT, "_photo.png"), -1, -1, 596, 776)
    c.setFont("Helvetica-Bold", 24)
    for i, ch in enumerate("SERPENTOFYIG"):
        c.drawString(28, H - 76 - i * 34.5, ch)
    c.setFont("Helvetica", 12); c.drawCentredString(W / 2, H - 51, "INTRODUCAO")
    c.setFont("Helvetica", 14); c.drawCentredString(W / 2, H - 733, "176")
    c.showPage(); c.save()

def sections():
    """Five pages: sections crossing page breaks, a heading in the middle of a page, an untitled
    first page and repeated header/footer."""
    c = canvas.Canvas(os.path.join(OUT, "sections.pdf"), pagesize=A4)
    W, H = A4
    plan = [
        [("p", words(220, 1))],                                   # 1: untitled (continues a section)
        [("h1", "NARRANDO"), ("p", words(200, 2))],               # 2: opens "NARRANDO"
        [("p", words(230, 3))],                                   # 3: continuation
        [("p", words(180, 4)), ("h1", "DRAMATIS PERSONAE:"), ("p", words(60, 5))],  # 4: heading mid-page
        [("h1", "A FUNDACAO PENHEW"), ("p", words(150, 6))],      # 5: opens a new section
    ]
    for n, blocks in enumerate(plan, start=1):
        c.setFont("Helvetica", 8); c.drawString(50, H - 30, "Mascaras de Nyarlathotep"); c.drawString(W / 2, 25, str(175 + n))
        y = H - 80
        for kind, text in blocks:
            if kind == "h1":
                c.setFont("Helvetica-Bold", 20); c.drawString(50, y, text); y -= 34
            else:
                y = column(c, 50, y, W - 100, [("p", text)]) - 10
        c.showPage()
    c.save()

def soft_mask():
    """Hand-written PDF: an image drawn through a Luminosity soft mask whose content is another
    image (white center, black border), like the rounded shadows and torn edges of the book."""
    import zlib
    w, h = 40, 30
    content = bytes([200, 30, 30] * (w * h))
    mask = bytearray()
    for y in range(h):
        for x in range(w):
            mask.append(255 if 6 <= x < w - 6 and 6 <= y < h - 6 else 0)
    def stream(dict_body, data):
        data = zlib.compress(bytes(data))
        return f"<< {dict_body} /Filter /FlateDecode /Length {len(data)} >>\nstream\n".encode() + data + b"\nendstream"
    page_ops = b"q /GS1 gs 200 0 0 150 50 500 cm /Im1 Do Q BT /F1 12 Tf 50 450 Td (Mask test) Tj ET"
    mask_ops = b"q 200 0 0 150 50 500 cm /Im2 Do Q"
    objs = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << "
        b"/XObject << /Im1 5 0 R >> /ExtGState << /GS1 << /SMask << /Type /Mask /S /Luminosity /G 6 0 R >> >> >> "
        b"/Font << /F1 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> >> >> >>",
        stream("", page_ops),
        stream(f"/Type /XObject /Subtype /Image /Width {w} /Height {h} /ColorSpace /DeviceRGB /BitsPerComponent 8", content),
        stream("/Type /XObject /Subtype /Form /BBox [0 0 595 842] /Group << /S /Transparency /CS /DeviceGray >> /Resources << /XObject << /Im2 7 0 R >> >>", mask_ops),
        stream(f"/Type /XObject /Subtype /Image /Width {w} /Height {h} /ColorSpace /DeviceGray /BitsPerComponent 8", mask),
    ]
    out = bytearray(b"%PDF-1.7\n")
    offsets = []
    for i, body in enumerate(objs, start=1):
        offsets.append(len(out))
        out += f"{i} 0 obj\n".encode() + body + b"\nendobj\n"
    xref = len(out)
    out += f"xref\n0 {len(objs) + 1}\n0000000000 65535 f \n".encode()
    for off in offsets:
        out += f"{off:010d} 00000 n \n".encode()
    out += f"trailer\n<< /Size {len(objs) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode()
    open(os.path.join(OUT, "soft-mask.pdf"), "wb").write(out)

def page_break():
    """Two-column section whose last paragraph is cut mid-sentence by the page break."""
    c = canvas.Canvas(os.path.join(OUT, "page-break.pdf"), pagesize=A4)
    W, H = A4
    colw = (W - 100 - 20) / 2
    c.setFont("Helvetica-Bold", 20); c.drawString(50, H - 70, "VIAGEM")
    column(c, 50, H - 110, colw, [("p", words(120, 1) + ".")])
    column(c, 50 + colw + 20, H - 110, colw, [("p", words(60, 2) + "."), ("p", "Os trens de Londres sao operados por quatro grupos privados. " + words(30, 4) + " Existem")])
    c.showPage()
    column(c, 50, H - 80, colw, [("p", "passagens de primeira e de terceira classe. " + words(20, 3) + "."), ("p", "Outro paragrafo " + words(40, 5) + ".")])
    column(c, 50 + colw + 20, H - 80, colw, [("p", words(50, 6) + ".")])
    c.showPage()
    c.save()

make_images(); two_columns(); three_columns(); art_page(); sections(); soft_mask(); page_break()
print("ok")
