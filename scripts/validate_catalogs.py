from __future__ import annotations

import json
import re
from pathlib import Path

import pdfplumber


ROOT = Path(__file__).resolve().parents[1]
PRODUCTS = json.loads((ROOT / "data" / "catalog_products.json").read_text(encoding="utf-8"))
PDFS = [
    ROOT / "output" / "pdf" / "catalogo-atelier-del-puerto.pdf",
    ROOT / "output" / "pdf" / "catalogo-atelier-editorial.pdf",
    ROOT / "output" / "pdf" / "catalogo-atelier-contemporaneo.pdf",
]


def fmt_price(value: int) -> str:
    return "$" + f"{value:,}".replace(",", ".")


def main() -> None:
    failures: list[str] = []
    for path in PDFS:
        with pdfplumber.open(path) as pdf:
            full_parts: list[str] = []
            searchable_parts: list[str] = []
            for page in pdf.pages:
                full_parts.append(page.extract_text() or "")
                searchable_parts.append(page.extract_text() or "")
                midpoint = page.width / 2
                searchable_parts.append(page.crop((0, 0, midpoint, page.height)).extract_text() or "")
                searchable_parts.append(page.crop((midpoint, 0, page.width, page.height)).extract_text() or "")
            text = "\n".join(full_parts)
            searchable_text = "\n".join(searchable_parts)
            page_count = len(pdf.pages)
        product_text = re.sub(r"\$\d{1,3}(?:\.\d{3})*", " ", searchable_text)
        normalized_text = re.sub(r"\s+", " ", product_text)
        missing_products = [
            item["name"]
            for item in PRODUCTS
            if re.sub(r"\s+", " ", item["name"]) not in normalized_text
        ]
        expected_prices = sorted({fmt_price(int(item["price"])) for item in PRODUCTS})
        missing_prices = [price for price in expected_prices if price not in text]
        wholesale_count = text.count("Desde 12 unidades")
        wholesale_ok = wholesale_count == 4 and text.count("Precio a convenir por interno") == 4
        print(
            path.name,
            f"pages={page_count}",
            f"missing_products={missing_products}",
            f"missing_prices={missing_prices}",
            f"wholesale_pages={wholesale_count}/4",
            f"bytes={path.stat().st_size}",
        )
        if page_count != 5 or missing_products or missing_prices or not wholesale_ok:
            failures.append(path.name)
    if failures:
        raise SystemExit(f"Validation failed: {failures}")


if __name__ == "__main__":
    main()
