"""Verify native TIFF regression artifacts, including paint/crop/rotation.

Run after the Rust insert_extended_tiff test with TIFF_VARIANT_OUTPUT_DIR set.
Requires Pillow, numpy, pypdfium2. No app files or user TIFFs are changed.
"""

import io
import json
import sys
from pathlib import Path

import numpy as np
import pypdfium2 as pdfium
from PIL import Image


TRANSFORMS = {2: Image.Transpose.FLIP_LEFT_RIGHT, 3: Image.Transpose.ROTATE_180,
              4: Image.Transpose.FLIP_TOP_BOTTOM, 5: Image.Transpose.TRANSPOSE,
              6: Image.Transpose.ROTATE_270, 7: Image.Transpose.TRANSVERSE,
              8: Image.Transpose.ROTATE_90}


def render(path):
    with pdfium.PdfDocument(path) as document:
        page = document[0]
        bitmap = page.render(scale=40)
        try:
            return bitmap.to_pil().convert("RGB")
        finally:
            bitmap.close()
            page.close()


def verify(folder):
    cases = json.loads((Path(__file__).parent / "fixtures/tiff/manifest.json").read_text())
    checked = 0
    for case in cases:
        if case["error"]:
            continue
        name = case["name"]
        base = render(folder / f"{name}.pdf")
        assert np.asarray(base).std() > 2, (name, "blank image")
        if not name.startswith("orient-"):
            continue
        raw = bytes.fromhex(case["pixels"])
        if case["jpeg"]:
            reference = Image.open(io.BytesIO(raw)).convert("RGB")
        else:
            if case["bits"] == 16:
                raw = (np.frombuffer(raw, dtype=">u2") >> 8).astype(np.uint8).tobytes()
            size = (9, 13) if "icc" in name and case["orientation"] >= 5 else (13, 9)
            reference = Image.frombytes("RGB", size, raw)
        if "icc" not in name and case["orientation"] in TRANSFORMS:
            reference = reference.transpose(TRANSFORMS[case["orientation"]])
        pixels = np.asarray(reference).astype(int)
        # Inspect centers at high zoom to avoid interpolation at source-pixel edges.
        actual = np.asarray(base).astype(int)
        centers = actual[20::40, 20::40][:reference.height, :reference.width]
        difference = np.abs(pixels - centers).max()
        assert difference <= 3, (name, "orientation/color", difference)
        checked += 1
        width, height = base.size
        expected = base.copy()
        overlay = Image.new("RGB", (round(width * 0.3), round(height * 0.35)), (255, 0, 255))
        expected.paste(overlay, (round(width * 0.2), round(height * 0.25)))
        for rotation in (0, 90, 180, 270):
            for cropped in (False, True):
                target = expected
                if cropped:
                    target = target.crop((round(width * 0.1), round(height * 0.1),
                                          round(width * 0.9), round(height * 0.9)))
                if rotation:
                    target = target.rotate(-rotation, expand=True)
                suffix = "crop" if cropped else "paint"
                edited = render(folder / f"{name}-{rotation}-{suffix}.pdf")
                assert abs(edited.width-target.width) <= 1 and abs(edited.height-target.height) <= 1
                a, b = np.asarray(edited), np.asarray(target)
                # A shifted edge can differ by one renderer rounding pixel. Compare
                # interior landmarks and the colored rectangle bounds independently.
                a = a[:b.shape[0], :b.shape[1]].astype(int)
                b = b[:a.shape[0], :a.shape[1]].astype(int)
                delta = np.abs(a-b).max(axis=2)
                interior = delta[7:-7:17, 7:-7:17]
                assert np.quantile(interior, 0.95) <= 3, (name, rotation, suffix, "landmarks", np.quantile(interior, 0.95))
                def bounds(array):
                    mask = (array[:, :, 0] == 255) & (array[:, :, 1] == 0) & (array[:, :, 2] == 255)
                    ys, xs = np.where(mask)
                    return np.array([xs.min(), ys.min(), xs.max(), ys.max()])
                assert np.abs(bounds(a)-bounds(b)).max() <= 1, (name, rotation, suffix, "paint location")
                checked += 1
    print(f"PASS: {folder.name}, nonblank TIFF renders and {checked} orientation/edit image comparisons")


if __name__ == "__main__":
    for argument in sys.argv[1:]:
        verify(Path(argument))
