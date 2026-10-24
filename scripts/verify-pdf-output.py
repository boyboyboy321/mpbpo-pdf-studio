"""Read-only structure/render checks for native save/split regression outputs.

Usage: python scripts/verify-pdf-output.py OUTPUT_DIR [OUTPUT_DIR ...]
Requires pikepdf (QPDF) and pypdfium2 in the test environment, not in the app.
This checks PDF syntax and image bit depth/version compatibility, not PDF/A.
"""

import argparse
from pathlib import Path

import pikepdf
import pypdfium2 as pdfium


def verify(path: Path) -> int:
    with pikepdf.Pdf.open(path, attempt_recovery=False) as document:
        issues = document.check_pdf_syntax()
        assert not issues, (str(path), issues)
        assert document.Root.Type == pikepdf.Name.Catalog
        version = tuple(int(part) for part in document.pdf_version.split("."))
        assert version >= (1, 0), (str(path), "output version", version)
        if version < (1, 5):
            with path.open("rb") as source:
                source.seek(max(0, path.stat().st_size - 128))
                tail = source.read()
                offset = int(tail.rsplit(b"startxref", 1)[1].split()[0])
                source.seek(offset)
                assert source.read(4) == b"xref", (str(path), "xref streams require PDF 1.5")
        page_count = len(document.pages)
        assert page_count > 0
        for page in document.pages:
            contents = page.obj.get("/Contents")
            if isinstance(contents, pikepdf.Array):
                assert all(isinstance(item, pikepdf.Stream) for item in contents), (str(path), "nested page contents")
            else:
                assert isinstance(contents, pikepdf.Stream), (str(path), "page contents")
            pikepdf.parse_content_stream(page)
        for obj in document.objects:
            if isinstance(obj, pikepdf.Stream):
                filters = obj.get("/Filter", [])
                if not isinstance(filters, (pikepdf.Array, list)):
                    filters = [filters]
                for name in filters:
                    minimum = {"/FlateDecode": (1, 2), "/JBIG2Decode": (1, 4), "/JPXDecode": (1, 5)}.get(str(name), (1, 0))
                    assert version >= minimum, (str(path), str(name), version)
            if isinstance(obj, pikepdf.Stream) and obj.get("/Subtype") == pikepdf.Name.Image:
                bits = obj.get("/BitsPerComponent", 8)
                assert bits in (1, 2, 4, 8, 16)
                if bits == 16:
                    assert version >= (1, 5)
                if "/SMask" in obj:
                    assert version >= (1, 4)
    with pdfium.PdfDocument(path) as document:
        assert len(document) == page_count
        for index in range(page_count):
            page = document[index]
            width, height = page.get_size()
            assert width > 0 and height > 0, str(path)
            bitmap = page.render(scale=240 / max(width, height))
            assert bitmap.width > 0 and bitmap.height > 0
            bitmap.close()
            page.close()
    return page_count


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directories", type=Path, nargs="+")
    args = parser.parse_args()
    for directory in args.directories:
        paths = sorted(directory.glob("*.pdf"))
        assert paths, f"No PDFs in {directory}"
        pages = sum(verify(path) for path in paths)
        print(f"PASS {directory}: {len(paths)} PDFs, {pages} pages; QPDF syntax checks without recovery and PDFium rendering")


if __name__ == "__main__":
    main()
