from __future__ import annotations

import json
import math
import re
from dataclasses import dataclass
from pathlib import Path

from PIL import Image, ImageEnhance, ImageOps
from reportlab.lib.colors import Color, HexColor
from reportlab.lib.pagesizes import A4
from reportlab.lib.utils import ImageReader
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas


ROOT = Path(__file__).resolve().parents[1]
DATA_PATH = ROOT / "data" / "catalog_products.json"
ASSETS = ROOT / "Imagenes"
WEBP = ROOT / "output" / "images" / "webp"
OUTPUT_DIR = ROOT / "output" / "pdf"
TMP_DIR = ROOT / "tmp" / "pdfs" / "catalog-variants"

PAGE_W, PAGE_H = A4
NAVY = HexColor("#1C2630")
GOLD = HexColor("#D48D01")
CREAM = HexColor("#F6F0E7")
PAPER = HexColor("#FFFDF9")
PALE_GOLD = HexColor("#F0D5A2")
MUTED = HexColor("#6F736F")
SOFT_GRAY = HexColor("#E9E5DE")
WHITE = HexColor("#FFFFFF")

FONT_DISPLAY = "AbrilFatface"
FONT_BODY = "Quicksand"

OUTPUTS = {
    "classic": OUTPUT_DIR / "catalogo-atelier-del-puerto.pdf",
    "editorial": OUTPUT_DIR / "catalogo-atelier-editorial.pdf",
    "contemporary": OUTPUT_DIR / "catalogo-atelier-contemporaneo.pdf",
}


@dataclass(frozen=True)
class Product:
    category: str
    name: str
    price: int
    image: str | None = None
    note: str | None = None


def load_products() -> list[Product]:
    raw = json.loads(DATA_PATH.read_text(encoding="utf-8"))
    return [Product(**item) for item in raw]


def register_fonts() -> None:
    if FONT_DISPLAY not in pdfmetrics.getRegisteredFontNames():
        pdfmetrics.registerFont(TTFont(FONT_DISPLAY, ASSETS / "AbrilFatface-Regular.ttf"))
    if FONT_BODY not in pdfmetrics.getRegisteredFontNames():
        pdfmetrics.registerFont(TTFont(FONT_BODY, ASSETS / "Quicksand-VariableFont_wght.ttf"))


def fmt_price(value: int) -> str:
    return "$" + f"{value:,}".replace(",", ".")


def image_path(filename: str) -> Path:
    optimized = WEBP / f"{Path(filename).stem}.webp"
    return optimized if optimized.exists() else ASSETS / filename


def slug(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")


def crop_for_frame(
    source: Path,
    cache_name: str,
    width_pt: float,
    height_pt: float,
    brightness: float = 1.0,
    focus_y: float = 0.5,
    matte: tuple[int, int, int] | None = None,
) -> Path:
    TMP_DIR.mkdir(parents=True, exist_ok=True)
    matte_key = "none" if matte is None else "-".join(str(value) for value in matte)
    out = TMP_DIR / f"{cache_name}-{round(width_pt)}x{round(height_pt)}-{matte_key}.jpg"
    if out.exists():
        return out
    target_w = max(400, round(width_pt * 2.2))
    target_h = max(400, round(height_pt * 2.2))
    ratio = width_pt / height_pt
    with Image.open(source) as raw:
        prepared = ImageOps.exif_transpose(raw)
        if "A" in prepared.getbands():
            rgba = prepared.convert("RGBA")
            background = Image.new("RGBA", rgba.size, (*((matte or (255, 255, 255))), 255))
            background.alpha_composite(rgba)
            image = background.convert("RGB")
        else:
            image = prepared.convert("RGB")
        current = image.width / image.height
        if current > ratio:
            new_width = round(image.height * ratio)
            left = (image.width - new_width) // 2
            image = image.crop((left, 0, left + new_width, image.height))
        else:
            new_height = round(image.width / ratio)
            top = round((image.height - new_height) * max(0, min(1, focus_y)))
            top = max(0, min(top, image.height - new_height))
            image = image.crop((0, top, image.width, top + new_height))
        image = image.resize((target_w, target_h), Image.Resampling.LANCZOS)
        if brightness != 1.0:
            image = ImageEnhance.Brightness(image).enhance(brightness)
        image.save(out, "JPEG", quality=94, optimize=True, progressive=False, subsampling=0)
    return out


def classic_cover_art(source: Path) -> Path:
    """Preserve the source's built-in RGB gradient and tint it like the v1 cover."""
    TMP_DIR.mkdir(parents=True, exist_ok=True)
    out = TMP_DIR / "classic-cover-v4.jpg"
    target_w = 1600
    target_h = round(target_w * PAGE_H / PAGE_W)
    navy_rgb = (28, 38, 48)

    with Image.open(source) as raw_image:
        # The PNG stores the intended gray-to-warm vignette in RGB beneath its
        # alpha channel. Dropping alpha here intentionally preserves that art.
        hero = ImageOps.exif_transpose(raw_image).convert("RGB")
        fitted = ImageOps.fit(
            hero,
            (target_w, target_h),
            method=Image.Resampling.LANCZOS,
            centering=(0.5, 0.5),
        )
        fitted = ImageEnhance.Brightness(fitted).enhance(0.78)
        navy = Image.new("RGB", fitted.size, navy_rgb)
        finished = Image.blend(
            fitted,
            navy,
            0.80,
        )
        finished.save(
            out,
            "JPEG",
            quality=95,
            optimize=True,
            progressive=False,
            subsampling=0,
        )
    return out


def draw_crop(
    c: canvas.Canvas,
    source: Path,
    x: float,
    y: float,
    w: float,
    h: float,
    cache_name: str,
    radius: float = 0,
    brightness: float = 1.0,
    focus_y: float = 0.5,
    matte: tuple[int, int, int] | None = None,
) -> None:
    cropped = crop_for_frame(
        source,
        cache_name,
        w,
        h,
        brightness=brightness,
        focus_y=focus_y,
        matte=matte,
    )
    c.saveState()
    if radius:
        clip = c.beginPath()
        clip.roundRect(x, y, w, h, radius)
        c.clipPath(clip, stroke=0, fill=0)
    c.drawImage(ImageReader(cropped), x, y, width=w, height=h, mask="auto")
    c.restoreState()


def draw_logo(c: canvas.Canvas, x: float, y: float, width: float) -> None:
    c.drawImage(
        ImageReader(ASSETS / "transparente logo.png"),
        x,
        y,
        width=width,
        height=width,
        preserveAspectRatio=True,
        mask="auto",
    )


def draw_contain(c: canvas.Canvas, source: Path, x: float, y: float, w: float, h: float) -> None:
    with Image.open(source) as image:
        ratio = image.width / image.height
    box_ratio = w / h
    if ratio > box_ratio:
        draw_w = w
        draw_h = w / ratio
    else:
        draw_h = h
        draw_w = h * ratio
    draw_x = x + (w - draw_w) / 2
    draw_y = y + (h - draw_h) / 2
    c.drawImage(ImageReader(source), draw_x, draw_y, width=draw_w, height=draw_h, mask="auto")


def text_width(text: str, font: str, size: float) -> float:
    return pdfmetrics.stringWidth(text, font, size)


def wrap_lines(text: str, font: str, size: float, max_width: float, max_lines: int = 3) -> list[str]:
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
    return lines[:max_lines]


def draw_wrapped(
    c: canvas.Canvas,
    text: str,
    x: float,
    top: float,
    max_width: float,
    font: str,
    size: float,
    color,
    leading: float | None = None,
    max_lines: int = 3,
) -> float:
    lines = wrap_lines(text, font, size, max_width, max_lines=max_lines)
    leading = leading or size * 1.2
    c.setFont(font, size)
    c.setFillColor(color)
    y = top
    for line in lines:
        c.drawString(x, y, line)
        y -= leading
    return y


def footer(c: canvas.Canvas, page_num: int, dark: bool = False) -> None:
    color = PALE_GOLD if dark else MUTED
    c.setFillColor(color)
    c.setFont(FONT_BODY, 7.2)
    c.drawString(42, 23, "ATELIER DEL PUERTO · CATÁLOGO")
    c.drawRightString(PAGE_W - 42, 23, f"{page_num:02d}")


def products_for(products: list[Product], categories: list[str]) -> list[Product]:
    selected = [item for item in products if item.category in categories]
    return sorted(selected, key=lambda item: (item.price, item.name.casefold()))


PAGES = [
    {
        "title": "Panadería & salados",
        "kicker": "PANES, ALIADOS, EMPANADAS Y PIZZA",
        "categories": ["Panadería y aliados", "Empanadas y salados"],
        "features": ["Milagrito.jpg", "Empanadas.jpg", "Pizza.jpg"],
    },
    {
        "title": "Hojaldres & bollería",
        "kicker": "CAPAS, MASAS Y RELLENOS",
        "categories": ["Hojaldres y bollería"],
        "features": ["Croissant.jpg", "Rollos Canela sin glaseado.jpg", "Daneses.jpg"],
    },
    {
        "title": "Pastelería",
        "kicker": "DULCES DE VITRINA Y FORMATOS PARA COMPARTIR",
        "categories": ["Pastelería"],
        "features": ["Berlines.jpg", "Pie limón.jpg", "Napoleón.jpg"],
    },
    {
        "title": "Dulces & café",
        "kicker": "BOCADOS, BEBIDAS Y PEQUEÑOS ANTOJOS",
        "categories": ["Dulces y café"],
        "features": ["variado (1).jpg", "Trenza.jpg", "Jumbo.jpg"],
    },
]


def wholesale_notice(c: canvas.Canvas, x: float, y: float, w: float, dark: bool = False) -> None:
    bg = NAVY if not dark else GOLD
    heading = GOLD if not dark else NAVY
    body = WHITE if not dark else NAVY
    c.setFillColor(bg)
    c.roundRect(x, y, w, 56, 8, fill=1, stroke=0)
    c.setFillColor(heading)
    c.setFont(FONT_BODY, 8.4)
    c.drawString(x + 13, y + 36, "VENTA AL POR MAYOR")
    c.setFillColor(body)
    draw_wrapped(
        c,
        "Desde 12 unidades. Precio a convenir por interno con cada cliente.",
        x + 13,
        y + 20,
        w - 26,
        FONT_BODY,
        8.2,
        body,
        leading=10,
        max_lines=2,
    )


def classic_cover(c: canvas.Canvas) -> None:
    hero = ASSETS / "Croissant Relleno.PNG"
    c.drawImage(ImageReader(classic_cover_art(hero)), 0, 0, width=PAGE_W, height=PAGE_H)
    c.setFillColor(GOLD)
    c.rect(0, 0, 12, PAGE_H, fill=1, stroke=0)
    draw_logo(c, 42, PAGE_H - 235, 165)
    c.setFillColor(PALE_GOLD)
    c.setFont(FONT_BODY, 10)
    c.drawString(48, 334, "PANADERÍA · PASTELERÍA · SALADOS")
    c.setFillColor(WHITE)
    c.setFont(FONT_DISPLAY, 54)
    c.drawString(44, 266, "CATÁLOGO")
    c.setFillColor(PALE_GOLD)
    c.setFont(FONT_BODY, 15)
    c.drawString(48, 226, "Selección completa y precios")
    c.setStrokeColor(GOLD)
    c.setLineWidth(1.4)
    c.line(48, 205, 310, 205)
    c.setFillColor(WHITE)
    c.setFont(FONT_BODY, 8)
    c.drawString(48, 62, "HECHO ARTESANALMENTE EN NUESTRO ATELIER")
    c.showPage()


def classic_row(c: canvas.Canvas, product: Product, x: float, y: float, w: float, show_category: bool) -> None:
    c.setStrokeColor(SOFT_GRAY)
    c.setLineWidth(0.7)
    c.line(x, y - 7, x + w, y - 7)
    name_y = y + 15
    if show_category:
        c.setFillColor(GOLD)
        c.setFont(FONT_BODY, 6.8)
        c.drawString(x, y + 29, product.category.upper())
    draw_wrapped(c, product.name, x, name_y, w - 68, FONT_BODY, 9.2, NAVY, leading=10.6, max_lines=2)
    c.setFillColor(GOLD)
    c.setFont(FONT_DISPLAY, 12.3)
    c.drawRightString(x + w, y + 13, fmt_price(product.price))


def classic_page(c: canvas.Canvas, spec: dict[str, object], page_num: int, products: list[Product]) -> None:
    margin = 64
    c.setFillColor(CREAM)
    c.rect(0, 0, PAGE_W, PAGE_H, fill=1, stroke=0)
    c.setFillColor(GOLD)
    c.setFont(FONT_BODY, 8.7)
    c.drawString(margin, PAGE_H - 44, f"{page_num - 1:02d} / {spec['kicker']}")
    c.setFillColor(NAVY)
    c.setFont(FONT_DISPLAY, 29)
    c.drawString(margin, PAGE_H - 83, str(spec["title"]))
    c.setStrokeColor(GOLD)
    c.line(margin, PAGE_H - 98, PAGE_W - margin, PAGE_H - 98)

    feature_names = list(spec["features"])
    gap = 11
    photo_w = (PAGE_W - margin * 2 - gap * 2) / 3
    for idx, filename in enumerate(feature_names):
        draw_crop(
            c,
            image_path(filename),
            margin + idx * (photo_w + gap),
            500,
            photo_w,
            202,
            f"classic-{page_num}-{idx}",
            radius=11,
            focus_y=0.62 if "Berlines" in filename else 0.5,
        )

    page_products = products_for(products, list(spec["categories"]))
    columns = 2
    rows_per_col = math.ceil(len(page_products) / columns)
    row_h = 47
    top = 458
    col_gap = 28
    col_w = (PAGE_W - margin * 2 - col_gap) / 2
    xs = [margin, margin + col_w + col_gap]
    show_category = len(spec["categories"]) > 1
    for idx, product in enumerate(page_products):
        col = idx // rows_per_col
        row = idx % rows_per_col
        classic_row(c, product, xs[col], top - row * row_h, col_w, show_category)

    wholesale_notice(c, margin, 57, PAGE_W - margin * 2)
    footer(c, page_num)
    c.showPage()


def build_classic(c: canvas.Canvas, products: list[Product]) -> None:
    classic_cover(c)
    for page_num, spec in enumerate(PAGES, start=2):
        classic_page(c, spec, page_num, products)


def editorial_cover(c: canvas.Canvas) -> None:
    c.setFillColor(PAPER)
    c.rect(0, 0, PAGE_W, PAGE_H, fill=1, stroke=0)
    draw_crop(c, image_path("Croissant.jpg"), 252, 0, PAGE_W - 252, PAGE_H, "editorial-cover", focus_y=0.44)
    c.setFillColor(PAPER)
    c.rect(0, 0, 284, PAGE_H, fill=1, stroke=0)
    c.setFillColor(GOLD)
    c.rect(0, 0, 8, PAGE_H, fill=1, stroke=0)
    draw_logo(c, 47, PAGE_H - 204, 145)
    c.setFillColor(NAVY)
    c.setFont(FONT_DISPLAY, 43)
    c.drawString(42, 335, "Catálogo")
    c.setFont(FONT_DISPLAY, 43)
    c.drawString(42, 290, "de sabores")
    c.setFillColor(GOLD)
    c.setFont(FONT_BODY, 9)
    c.drawString(45, 251, "ATELIER DEL PUERTO")
    c.setStrokeColor(GOLD)
    c.line(45, 230, 230, 230)
    c.setFillColor(MUTED)
    c.setFont(FONT_BODY, 8)
    c.drawString(45, 66, "PANADERÍA · PASTELERÍA · SALADOS")
    c.showPage()


def editorial_row(c: canvas.Canvas, product: Product, x: float, y: float, w: float) -> None:
    c.setFillColor(NAVY)
    draw_wrapped(c, product.name, x, y + 12, w - 64, FONT_BODY, 9.1, NAVY, leading=10.2, max_lines=2)
    c.setFillColor(GOLD)
    c.setFont(FONT_BODY, 10.1)
    c.drawRightString(x + w, y + 11, fmt_price(product.price))
    c.setStrokeColor(SOFT_GRAY)
    c.setLineWidth(0.55)
    c.line(x, y - 8, x + w, y - 8)


def editorial_page(c: canvas.Canvas, spec: dict[str, object], page_num: int, products: list[Product]) -> None:
    c.setFillColor(PAPER)
    c.rect(0, 0, PAGE_W, PAGE_H, fill=1, stroke=0)
    c.setFillColor(GOLD)
    c.setFont(FONT_BODY, 7.5)
    c.drawString(42, PAGE_H - 42, f"0{page_num - 1}")
    c.setFillColor(NAVY)
    c.setFont(FONT_DISPLAY, 31)
    c.drawString(42, PAGE_H - 80, str(spec["title"]))
    c.setFillColor(MUTED)
    c.setFont(FONT_BODY, 7.4)
    c.drawString(43, PAGE_H - 101, str(spec["kicker"]))

    feature_names = list(spec["features"])
    draw_crop(c, image_path(feature_names[0]), 42, 483, 300, 215, f"editorial-{page_num}-0", radius=4, focus_y=0.58)
    draw_crop(c, image_path(feature_names[1]), 354, 592, 199, 106, f"editorial-{page_num}-1", radius=4)
    draw_crop(c, image_path(feature_names[2]), 354, 483, 199, 98, f"editorial-{page_num}-2", radius=4)

    page_products = products_for(products, list(spec["categories"]))
    rows_per_col = math.ceil(len(page_products) / 2)
    row_h = 43
    top = 446
    col_w = 245
    xs = [42, PAGE_W - 42 - col_w]
    for idx, product in enumerate(page_products):
        col = idx // rows_per_col
        row = idx % rows_per_col
        editorial_row(c, product, xs[col], top - row * row_h, col_w)

    wholesale_notice(c, 42, 52, PAGE_W - 84)
    footer(c, page_num)
    c.showPage()


def build_editorial(c: canvas.Canvas, products: list[Product]) -> None:
    editorial_cover(c)
    for page_num, spec in enumerate(PAGES, start=2):
        editorial_page(c, spec, page_num, products)


def contemporary_cover(c: canvas.Canvas) -> None:
    c.setFillColor(NAVY)
    c.rect(0, 0, PAGE_W, PAGE_H, fill=1, stroke=0)
    draw_crop(c, image_path("Croissant.jpg"), 0, 198, PAGE_W, 438, "contemporary-cover", brightness=0.92)
    c.setFillColor(NAVY)
    c.rect(0, 636, PAGE_W, PAGE_H - 636, fill=1, stroke=0)
    c.rect(0, 0, PAGE_W, 198, fill=1, stroke=0)
    resource_x = 40
    resource_w = PAGE_W - 80
    resource_h = 118
    top_band_y = 636
    resource_y = top_band_y + (PAGE_H - top_band_y - resource_h) / 2
    draw_contain(c, ASSETS / "recurso horizontal.webp", resource_x + 4, resource_y + 4, resource_w - 8, resource_h - 8)
    c.setFillColor(GOLD)
    c.rect(0, 190, PAGE_W, 8, fill=1, stroke=0)
    draw_logo(c, 36, 33, 122)
    c.setFillColor(WHITE)
    c.setFont(FONT_DISPLAY, 26)
    c.drawCentredString(381, 119, "Hecho para compartir")
    c.setFillColor(PALE_GOLD)
    c.setFont(FONT_BODY, 8)
    c.drawCentredString(381, 87, "PANES · SALADOS · HOJALDRES · DULCES")
    c.showPage()


def contemporary_row(c: canvas.Canvas, product: Product, x: float, y: float, w: float, index: int) -> None:
    row_bottom = y - 10
    row_height = 31
    row_center = row_bottom + row_height / 2
    if index % 2 == 0:
        c.setFillColor(CREAM)
        c.roundRect(x - 8, row_bottom, w + 16, row_height, 6, fill=1, stroke=0)

    name_size = 9.1
    name_leading = 10.2
    name_lines = wrap_lines(product.name, FONT_BODY, name_size, w - 72, max_lines=2)
    name_ascent, name_descent = pdfmetrics.getAscentDescent(FONT_BODY, name_size)
    name_block_offset = (name_ascent + name_descent - (len(name_lines) - 1) * name_leading) / 2
    name_baseline = row_center - name_block_offset
    draw_wrapped(
        c,
        product.name,
        x,
        name_baseline,
        w - 72,
        FONT_BODY,
        name_size,
        NAVY,
        leading=name_leading,
        max_lines=2,
    )

    c.setFillColor(GOLD)
    price_size = 12.3
    price_ascent, price_descent = pdfmetrics.getAscentDescent(FONT_DISPLAY, price_size)
    price_baseline = row_center - (price_ascent + price_descent) / 2
    c.setFont(FONT_DISPLAY, price_size)
    c.drawRightString(x + w, price_baseline, fmt_price(product.price))


def contemporary_page(c: canvas.Canvas, spec: dict[str, object], page_num: int, products: list[Product]) -> None:
    c.setFillColor(NAVY)
    c.rect(0, 0, PAGE_W, PAGE_H, fill=1, stroke=0)
    features = list(spec["features"])
    draw_crop(c, image_path(features[0]), 0, 0, 236, PAGE_H, f"contemporary-{page_num}-0", brightness=0.82, focus_y=0.52)
    c.saveState()
    c.setFillColor(Color(28 / 255, 38 / 255, 48 / 255, alpha=0.18))
    c.rect(0, 0, 236, PAGE_H, fill=1, stroke=0)
    c.restoreState()
    draw_crop(c, image_path(features[1]), 24, 568, 188, 163, f"contemporary-{page_num}-1", radius=14)
    c.setFillColor(GOLD)
    c.circle(199, 580, 22, fill=1, stroke=0)
    c.setFillColor(NAVY)
    c.setFont(FONT_DISPLAY, 13)
    c.drawCentredString(199, 576, f"0{page_num - 1}")

    panel_x = 255
    panel_y = 58
    panel_w = PAGE_W - panel_x - 24
    panel_h = PAGE_H - 116
    c.setFillColor(PAPER)
    c.roundRect(panel_x, panel_y, panel_w, panel_h, 16, fill=1, stroke=0)
    c.setFillColor(GOLD)
    c.setFont(FONT_BODY, 8.5)
    c.drawString(panel_x + 20, PAGE_H - 91, str(spec["kicker"]))
    c.setFillColor(NAVY)
    c.setFont(FONT_DISPLAY, 25)
    draw_wrapped(c, str(spec["title"]), panel_x + 18, PAGE_H - 126, panel_w - 36, FONT_DISPLAY, 24, NAVY, leading=26, max_lines=2)
    c.setStrokeColor(GOLD)
    c.line(panel_x + 18, PAGE_H - 156, panel_x + panel_w - 18, PAGE_H - 156)

    page_products = products_for(products, list(spec["categories"]))
    top = PAGE_H - 190
    available = 505
    row_h = min(39, available / max(1, len(page_products)))
    for idx, product in enumerate(page_products):
        contemporary_row(c, product, panel_x + 20, top - idx * row_h, panel_w - 40, idx)

    wholesale_notice(c, panel_x + 18, 78, panel_w - 36)
    footer(c, page_num, dark=True)
    c.showPage()


def build_contemporary(c: canvas.Canvas, products: list[Product]) -> None:
    contemporary_cover(c)
    for page_num, spec in enumerate(PAGES, start=2):
        contemporary_page(c, spec, page_num, products)


def build_variant(variant: str) -> Path:
    if variant not in OUTPUTS:
        raise ValueError(f"Unknown variant: {variant}")
    register_fonts()
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    products = load_products()
    output = OUTPUTS[variant]
    c = canvas.Canvas(str(output), pagesize=A4, pageCompression=1)
    c.setTitle(f"Catálogo Atelier del Puerto - {variant}")
    c.setAuthor("Atelier del Puerto")
    c.setSubject("Catálogo completo de productos y precios")
    builders = {
        "classic": build_classic,
        "editorial": build_editorial,
        "contemporary": build_contemporary,
    }
    builders[variant](c, products)
    c.save()
    return output


def main() -> None:
    for variant in OUTPUTS:
        print(build_variant(variant))


if __name__ == "__main__":
    main()
