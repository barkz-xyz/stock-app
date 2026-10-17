from __future__ import annotations

import json
from pathlib import Path

from PIL import Image, ImageOps


ROOT = Path(__file__).resolve().parents[1]
SOURCE_DIR = ROOT / "Imagenes"
OUTPUT_DIR = ROOT / "output" / "images" / "webp"
MAX_EDGE = 2400


def webp_name(path: Path) -> str:
    return f"{path.stem}.webp"


def optimize(source: Path) -> dict[str, object]:
    with Image.open(source) as raw:
        image = ImageOps.exif_transpose(raw)
        had_alpha = "A" in image.getbands()
        if had_alpha:
            image = image.convert("RGBA")
        else:
            image = image.convert("RGB")

        original_size = image.size
        if max(image.size) > MAX_EDGE:
            image.thumbnail((MAX_EDGE, MAX_EDGE), Image.Resampling.LANCZOS)

        destination = OUTPUT_DIR / webp_name(source)
        is_graphic = source.stem.lower() in {
            "transparente logo",
            "logo_atelier",
            "azul atelier",
            "dorado atelier",
        }
        if is_graphic:
            image.save(destination, "WEBP", lossless=True, method=6)
        else:
            image.save(destination, "WEBP", quality=90, method=6)

    return {
        "source": source.name,
        "output": destination.name,
        "original_size": list(original_size),
        "optimized_size": list(image.size),
        "source_bytes": source.stat().st_size,
        "optimized_bytes": destination.stat().st_size,
        "alpha": had_alpha,
    }


def main() -> None:
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    sources = sorted(
        path
        for path in SOURCE_DIR.iterdir()
        if path.is_file() and path.suffix.lower() in {".jpg", ".jpeg", ".png"}
    )
    results = [optimize(path) for path in sources]
    manifest = OUTPUT_DIR / "manifest.json"
    manifest.write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding="utf-8")
    before = sum(int(item["source_bytes"]) for item in results)
    after = sum(int(item["optimized_bytes"]) for item in results)
    print(f"Optimized {len(results)} images")
    print(f"Source bytes: {before}")
    print(f"WebP bytes: {after}")
    print(f"Saved: {manifest}")


if __name__ == "__main__":
    main()
