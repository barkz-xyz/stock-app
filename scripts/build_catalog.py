from __future__ import annotations

from pathlib import Path
from typing import Iterable

from PIL import Image, ImageEnhance, ImageOps
from reportlab.lib.colors import HexColor, Color
from reportlab.lib.pagesizes import A4
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas
from reportlab.lib.utils import ImageReader


ROOT = Path(__file__).resolve().parents[1]
ASSETS = ROOT / "Imagenes"
OUTPUT_DIR = ROOT / "output" / "pdf"
TMP_DIR = ROOT / "tmp" / "pdfs" / "catalogo-atelier"
OUTPUT_PDF = OUTPUT_DIR / "catalogo-atelier-del-puerto.pdf"

PAGE_W, PAGE_H = A4
NAVY = HexColor("#1C2630")
GOLD = HexColor("#D48D01")
CREAM = HexColor("#F6F0E7")
PAPER = HexColor("#FFFDF9")
PALE_GOLD = HexColor("#F0D5A2")
MUTED = HexColor("#6F736F")
WHITE = HexColor("#FFFFFF")

FONT_DISPLAY = "AbrilFatface"
FONT_BODY = "Quicksand"


def register_fonts() -> None:
    pdfmetrics.registerFont(TTFont(FONT_DISPLAY, ASSETS / "AbrilFatface-Regular.ttf"))
    pdfmetrics.registerFont(TTFont(FONT_BODY, ASSETS / "Quicksand-VariableFont_wght.ttf"))


def fit_crop(source: Path, out_name: str, ratio: float, brightness: float = 1.0) -> Path:
    """Create a high-resolution center crop for a fixed PDF frame."""
    out = TMP_DIR / out_name
    with Image.open(source) as image:
        image = ImageOps.exif_transpose(image).convert("RGB")
        current_ratio = image.width / image.height
        if current_ratio > ratio:
            new_width = round(image.height * ratio)
            left = (image.width - new_width) // 2
            image = image.crop((left, 0, left + new_width, image.height))
        else:
            new_height = round(image.width / ratio)
            top = (image.height - new_height) // 2
            image = image.crop((0, top, image.width, top + new_height))
        if brightness != 1.0:
            image = ImageEnhance.Brightness(image).enhance(brightness)
        image.save(out, quality=94, optimize=True)
    return out


def draw_crop(
    c: canvas.Canvas,
    image_path: Path,
    x: float,
    y: float,
    w: float,
    h: float,
    cache_name: str,
    radius: float = 0,
    brightness: float = 1.0,
) -> None:
    cropped = fit_crop(image_path, cache_name, w / h, brightness=brightness)
    c.saveState()
    if radius:
        clip = c.beginPath()
        clip.roundRect(x, y, w, h, radius)
        c.clipPath(clip, stroke=0, fill=0)
    c.drawImage(ImageReader(cropped), x, y, width=w, height=h, preserveAspectRatio=False, mask="auto")
    c.restoreState()


def draw_logo(c: canvas.Canvas, x: float, y: float, w: float) -> None:
    path = ASSETS / "transparente logo.png"
    c.drawImage(ImageReader(path), x, y, width=w, height=w, preserveAspectRatio=True, mask="auto")


def text_width(text: str, font: str, size: float) -> float:
    return pdfmetrics.stringWidth(text, font, size)


def draw_wrapped(
    c: canvas.Canvas,
    text: str,
    x: float,
    y_top: float,
    max_width: float,
    font: str,
    size: float,
    color,
    leading: float | None = None,
    max_lines: int = 3,
) -> float:
    words = text.split()
    lines: list[str] = []
    current = ""
    for word in words:
        trial = word if not current else f"{current} {word}"
        if text_width(trial, font, size) <= max_width:
            current = trial
        else:
            if current:
                lines.append(current)
            current = word
    if current:
        lines.append(current)
    lines = lines[:max_lines]
    leading = leading or size * 1.22
    c.setFont(font, size)
    c.setFillColor(color)
    y = y_top
    for line in lines:
        c.drawString(x, y, line)
        y -= leading
    return y


def draw_section_header(c: canvas.Canvas, index: str, title: str, dark: bool = False) -> None:
    ink = WHITE if dark else NAVY
    c.setFillColor(GOLD)
    c.setFont(FONT_BODY, 9)
    c.drawString(44, PAGE_H - 48, index)
    c.setFillColor(ink)
    c.setFont(FONT_DISPLAY, 31)
    c.drawString(44, PAGE_H - 87, title)
    c.setStrokeColor(GOLD)
    c.setLineWidth(1.2)
    c.line(44, PAGE_H - 103, PAGE_W - 44, PAGE_H - 103)


def draw_footer(c: canvas.Canvas, page_number: int, dark: bool = False) -> None:
    color = PALE_GOLD if dark else MUTED
    c.setFillColor(color)
    c.setFont(FONT_BODY, 7.5)
    c.drawString(44, 24, "ATELIER DEL PUERTO · PASTELERÍA")
    page = f"{page_number:02d}"
    c.drawRightString(PAGE_W - 44, 24, page)


def draw_product_card(
    c: canvas.Canvas,
    *,
    x: float,
    y: float,
    w: float,
    h: float,
    image: Path,
    cache_name: str,
    name: str,
    price: str,
    note: str | None = None,
) -> None:
    c.setFillColor(PAPER)
    c.roundRect(x, y, w, h, 12, fill=1, stroke=0)
    photo_h = h - 83
    draw_crop(c, image, x, y + h - photo_h, w, photo_h, cache_name, radius=12)
    c.setFillColor(NAVY)
    c.setFont(FONT_BODY, 11)
    draw_wrapped(c, name, x + 14, y + 56, w - 88, FONT_BODY, 11, NAVY, leading=13, max_lines=2)
    c.setFillColor(GOLD)
    c.setFont(FONT_DISPLAY, 17)
    c.drawRightString(x + w - 14, y + 49, price)
    if note:
        c.setFillColor(MUTED)
        c.setFont(FONT_BODY, 7.5)
        c.drawString(x + 14, y + 17, note)


def draw_text_card(
    c: canvas.Canvas,
    *,
    x: float,
    y: float,
    w: float,
    h: float,
    name: str,
    price: str,
    variant: int,
) -> None:
    backgrounds = [NAVY, GOLD, PAPER]
    title_colors = [WHITE, NAVY, NAVY]
    price_colors = [PALE_GOLD, WHITE, GOLD]
    bg = backgrounds[variant % len(backgrounds)]
    c.setFillColor(bg)
    c.roundRect(x, y, w, h, 12, fill=1, stroke=0)
    c.setFillColor(price_colors[variant % len(backgrounds)])
    c.circle(x + w - 22, y + h - 22, 4, fill=1, stroke=0)
    draw_wrapped(c, name, x + 15, y + h - 40, w - 30, FONT_DISPLAY, 16, title_colors[variant % len(backgrounds)], leading=18, max_lines=3)
    c.setFillColor(price_colors[variant % len(backgrounds)])
    c.setFont(FONT_BODY, 10)
    c.drawString(x + 15, y + 18, price)


def page_cover(c: canvas.Canvas) -> None:
    draw_crop(
        c,
        ASSETS / "Croissant Relleno.PNG",
        0,
        0,
        PAGE_W,
        PAGE_H,
        "cover.jpg",
        brightness=0.78,
    )
    c.saveState()
    c.setFillColor(Color(28 / 255, 38 / 255, 48 / 255, alpha=0.80))
    c.rect(0, 0, PAGE_W, PAGE_H, fill=1, stroke=0)
    c.restoreState()
    c.setFillColor(GOLD)
    c.rect(0, 0, 12, PAGE_H, fill=1, stroke=0)
    draw_logo(c, 42, PAGE_H - 235, 165)
    c.setFillColor(PALE_GOLD)
    c.setFont(FONT_BODY, 10)
    c.drawString(48, 334, "PASTELERÍA ARTESANAL")
    c.setFillColor(WHITE)
    c.setFont(FONT_DISPLAY, 55)
    c.drawString(44, 266, "CATÁLOGO")
    c.setFillColor(PALE_GOLD)
    c.setFont(FONT_BODY, 15)
    c.drawString(48, 226, "Precios y especialidades")
    c.setStrokeColor(GOLD)
    c.setLineWidth(1.4)
    c.line(48, 205, 290, 205)
    c.setFillColor(WHITE)
    c.setFont(FONT_BODY, 8)
    c.drawString(48, 62, "HOJALDRES · DULCES · PASTELES")
    c.showPage()


def page_laminados(c: canvas.Canvas) -> None:
    c.setFillColor(CREAM)
    c.rect(0, 0, PAGE_W, PAGE_H, fill=1, stroke=0)
    draw_section_header(c, "01 / SELECCIÓN", "Hojaldres y masas")
    gap = 16
    card_w = (PAGE_W - 88 - gap) / 2
    card_h = 292
    top_y = PAGE_H - 418
    bottom_y = 48
    cards = [
        ("Croissant salado", "$2.000", ASSETS / "Croissant.jpg", "croissant-salado.jpg", None),
        ("Croissant dulce", "$2.500", ASSETS / "Croissant Relleno.PNG", "croissant-dulce.jpg", None),
        ("Rollo de canela", "$1.250", ASSETS / "Rollo de canela.jpg", "rollo.jpg", None),
        ("Palmeritas", "$1.100", ASSETS / "Palmerita.jpg", "palmerita.jpg", None),
    ]
    positions = [(44, top_y), (44 + card_w + gap, top_y), (44, bottom_y), (44 + card_w + gap, bottom_y)]
    for (name, price, image, cache_name, note), (x, y) in zip(cards, positions):
        draw_product_card(c, x=x, y=y, w=card_w, h=card_h, image=image, cache_name=cache_name, name=name, price=price, note=note)
    draw_footer(c, 2)
    c.showPage()


def page_vitrina(c: canvas.Canvas) -> None:
    c.setFillColor(CREAM)
    c.rect(0, 0, PAGE_W, PAGE_H, fill=1, stroke=0)
    draw_section_header(c, "02 / VITRINA", "Pastelería clásica")
    gap = 16
    card_w = (PAGE_W - 88 - gap) / 2
    draw_product_card(
        c,
        x=44,
        y=372,
        w=card_w,
        h=340,
        image=ASSETS / "Napoleón.jpg",
        cache_name="napoleon.jpg",
        name="Napoleón",
        price="$1.900",
    )
    draw_product_card(
        c,
        x=44 + card_w + gap,
        y=372,
        w=card_w,
        h=340,
        image=ASSETS / "Pie limón.jpg",
        cache_name="pie-limon.jpg",
        name="Pie de limón",
        price="$1.800",
        note="Formato entero: $13.000",
    )
    small_gap = 12
    small_w = (PAGE_W - 88 - small_gap * 2) / 3
    items = [
        ("Hoja crema manjar", "$2.000"),
        ("Cachito crema chantilly", "$1.500"),
        ("Berlines", "$1.100"),
    ]
    for i, (name, price) in enumerate(items):
        draw_text_card(c, x=44 + i * (small_w + small_gap), y=132, w=small_w, h=205, name=name, price=price, variant=i)
    draw_footer(c, 3)
    c.showPage()


def draw_specialty_row(
    c: canvas.Canvas,
    y: float,
    name: str,
    price: str,
    note: str | None = None,
) -> None:
    c.setFillColor(NAVY)
    c.setFont(FONT_DISPLAY, 19)
    c.drawString(318, y, name)
    c.setFillColor(GOLD)
    c.setFont(FONT_DISPLAY, 18)
    c.drawRightString(PAGE_W - 44, y, price)
    if note:
        c.setFillColor(MUTED)
        c.setFont(FONT_BODY, 8.5)
        c.drawString(318, y - 19, note)
    c.setStrokeColor(PALE_GOLD)
    c.setLineWidth(0.8)
    c.line(318, y - 34, PAGE_W - 44, y - 34)


def page_especialidades(c: canvas.Canvas) -> None:
    c.setFillColor(CREAM)
    c.rect(0, 0, PAGE_W, PAGE_H, fill=1, stroke=0)
    draw_crop(c, ASSETS / "Jumbo.jpg", 0, 0, 277, PAGE_H, "jumbo-hero.jpg", brightness=0.86)
    c.saveState()
    c.setFillColor(Color(28 / 255, 38 / 255, 48 / 255, alpha=0.32))
    c.rect(0, 0, 277, PAGE_H, fill=1, stroke=0)
    c.restoreState()
    draw_logo(c, 52, PAGE_H - 206, 164)
    c.setFillColor(WHITE)
    c.setFont(FONT_DISPLAY, 31)
    c.drawString(38, 139, "Dulces de")
    c.drawString(38, 104, "la casa")
    c.setFillColor(PALE_GOLD)
    c.setFont(FONT_BODY, 8)
    c.drawString(40, 77, "HECHOS PARA COMPARTIR")

    c.setFillColor(GOLD)
    c.setFont(FONT_BODY, 9)
    c.drawString(318, PAGE_H - 52, "03 / ESPECIALIDADES")
    c.setFillColor(NAVY)
    c.setFont(FONT_DISPLAY, 30)
    c.drawString(318, PAGE_H - 92, "Dulces de la casa")
    c.setStrokeColor(GOLD)
    c.line(318, PAGE_H - 108, PAGE_W - 44, PAGE_H - 108)

    draw_specialty_row(c, 640, "Pastel de plátano", "$2.500")
    draw_specialty_row(c, 526, "Tartaleta", "$1.800", "Manjar y coco")
    draw_specialty_row(c, 412, "Kuchen", "$2.000", "Formato entero: $15.000")
    draw_specialty_row(c, 298, "Queque", "$3.000", "Nuez o arándano")

    c.setFillColor(MUTED)
    c.setFont(FONT_BODY, 8)
    c.drawString(318, 162, "Venta al por mayor desde 12 unidades.")
    c.drawString(318, 148, "Precio a convenir por interno con cada cliente.")
    c.drawString(318, 134, "Pie de limón y Kuchen disponibles enteros.")
    draw_footer(c, 4)
    c.showPage()


def page_price_list(c: canvas.Canvas) -> None:
    c.setFillColor(PAPER)
    c.rect(0, 0, PAGE_W, PAGE_H, fill=1, stroke=0)
    c.setFillColor(NAVY)
    c.rect(0, PAGE_H - 154, PAGE_W, 154, fill=1, stroke=0)
    draw_logo(c, 42, PAGE_H - 142, 106)
    c.setFillColor(PALE_GOLD)
    c.setFont(FONT_BODY, 9)
    c.drawString(167, PAGE_H - 62, "ATELIER DEL PUERTO")
    c.setFillColor(WHITE)
    c.setFont(FONT_DISPLAY, 31)
    c.drawString(164, PAGE_H - 104, "Lista de precios")

    rows = [
        ("Croissant salado", "$2.000", "-"),
        ("Croissant dulce", "$2.500", "-"),
        ("Rollo de canela", "$1.250", "-"),
        ("Pastel de plátano", "$2.500", "-"),
        ("Napoleón", "$1.900", "-"),
        ("Hoja crema manjar", "$2.000", "-"),
        ("Tartaleta manjar coco", "$1.800", "-"),
        ("Kuchen", "$2.000", "Entero $15.000"),
        ("Cachito crema chantilly", "$1.500", "-"),
        ("Pie de limón", "$1.800", "Entero $13.000"),
        ("Palmeritas", "$1.100", "-"),
        ("Berlines", "$1.100", "-"),
        ("Queque nuez o arándano", "$3.000", "-"),
    ]
    left, right = 44, PAGE_W - 44
    top = PAGE_H - 190
    row_h = 39
    col_price = 380
    col_wholesale = 463
    c.setFillColor(GOLD)
    c.roundRect(left, top - 30, right - left, 30, 7, fill=1, stroke=0)
    c.setFillColor(NAVY)
    c.setFont(FONT_BODY, 8)
    c.drawString(left + 13, top - 19, "PRODUCTO")
    c.drawRightString(col_wholesale - 16, top - 19, "DETALLE")
    c.drawRightString(right - 13, top - 19, "FORMATO ENTERO")
    y = top - 30
    for idx, (name, price, wholesale) in enumerate(rows):
        y -= row_h
        if idx % 2 == 0:
            c.setFillColor(CREAM)
            c.rect(left, y, right - left, row_h, fill=1, stroke=0)
        c.setFillColor(NAVY)
        c.setFont(FONT_BODY, 9.2)
        c.drawString(left + 13, y + 15, name)
        c.setFillColor(GOLD)
        c.setFont(FONT_BODY, 9.2)
        c.drawRightString(col_wholesale - 16, y + 15, price)
        c.setFillColor(MUTED)
        c.drawRightString(right - 13, y + 15, wholesale)
    c.setFillColor(NAVY)
    c.roundRect(left, 54, right - left, 44, 8, fill=1, stroke=0)
    c.setFillColor(GOLD)
    c.setFont(FONT_BODY, 8)
    c.drawString(left + 14, 80, "VENTA AL POR MAYOR")
    c.setFillColor(WHITE)
    c.setFont(FONT_BODY, 8.3)
    c.drawString(left + 14, 65, "Desde 12 unidades. Precio a convenir por interno con cada cliente.")
    draw_footer(c, 5)
    c.showPage()


def build() -> Path:
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    TMP_DIR.mkdir(parents=True, exist_ok=True)
    register_fonts()
    c = canvas.Canvas(str(OUTPUT_PDF), pagesize=A4, pageCompression=1)
    c.setTitle("Catálogo - Atelier del Puerto")
    c.setAuthor("Atelier del Puerto")
    c.setSubject("Catálogo de pastelería y lista de precios")
    page_cover(c)
    page_laminados(c)
    page_vitrina(c)
    page_especialidades(c)
    page_price_list(c)
    c.save()
    return OUTPUT_PDF


if __name__ == "__main__":
    from build_catalog_variants import build_variant

    print(build_variant("classic"))
