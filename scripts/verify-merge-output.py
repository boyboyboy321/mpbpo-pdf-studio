"""Independently check exported merge fixtures with QPDF and PDFium."""
import argparse
import json
from pathlib import Path

import pikepdf
import pypdfium2 as pdfium
from PIL import ImageChops


def render_pages(path):
    rendered = []
    with pdfium.PdfDocument(path) as document:
        for index in range(len(document)):
            page = document[index]
            try:
                text = page.get_textpage()
                try:
                    extracted = text.get_text_range()
                finally:
                    text.close()
                bitmap = page.render(scale=0.5)
                try:
                    rendered.append((bitmap.to_pil().convert("RGB").copy(), extracted))
                finally:
                    bitmap.close()
            finally:
                page.close()
    return rendered


def image_streams(path):
    with pikepdf.Pdf.open(path, attempt_recovery=False) as document:
        assert not document.check_pdf_syntax(), path
        return sorted(obj.read_raw_bytes() for obj in document.objects
                      if isinstance(obj, pikepdf.Stream)
                      and obj.get("/Subtype") == pikepdf.Name.Image)


def verify(directory):
    manifest = json.loads((directory / "manifest.json").read_text(encoding="utf-8"))
    expected = []
    images = []
    for source in manifest["sourceFiles"]:
        expected.extend(render_pages(source))
        images.extend(image_streams(source))
    checks = 0
    for mode in ("customFolder", "siblingFolder"):
        output = manifest[mode]["file"]["filePath"]
        actual = render_pages(output)
        assert len(actual) == manifest["expectedPageCount"] == len(expected)
        assert image_streams(output) == sorted(images), "Image payload changed"
        with pikepdf.Pdf.open(output, attempt_recovery=False) as document:
            assert document.pdf_version == manifest["expectedVersion"]
        for index, ((before, before_text), (after, after_text)) in enumerate(zip(expected, actual)):
            assert before.size == after.size, (output, index, "Page dimensions changed")
            assert ImageChops.difference(before, after).getbbox() is None, (output, index, "Pixels changed")
            assert before_text == after_text, (output, index, "Text changed")
            assert manifest["expectedPageMarkers"][index] in after_text, (output, index, "Wrong page order")
            checks += 1
    print(f"PASS {directory}: {checks} pages, identical rendered pixels/text/image streams and correct order/version")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directories", type=Path, nargs="+")
    for directory in parser.parse_args().directories:
        verify(directory)


if __name__ == "__main__":
    main()
