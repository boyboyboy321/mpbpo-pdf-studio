"""Generate small, deterministic TIFF regression fixtures (requires Pillow).

The hand-written directory builder is test data only, never an app decoder.
"""

import io
import json
import struct
from pathlib import Path

from PIL import Image, ImageCms, TiffImagePlugin


ROOT = Path(__file__).resolve().parent / "fixtures" / "tiff"
WIDTH, HEIGHT = 13, 9


def raw_tiff(path, pixels, bits, photo, *, orientation=1, palette=None,
             profile=None, endian="<", big=False, compression=1,
             omit_counts=False, rows=None, planar=1):
    pack = lambda fmt, *values: struct.pack(endian + fmt, *values)
    fields = {
        256: (4, [WIDTH]), 257: (4, [HEIGHT]), 258: (3, bits),
        259: (3, [compression]), 262: (3, [photo]), 273: (4, [0]),
        274: (3, [orientation]), 277: (3, [len(bits)]),
        282: (5, [72, 1]), 283: (5, [72, 1]), 284: (3, [planar]),
        296: (3, [2]),
    }
    if rows is not False:
        fields[278] = (4, [HEIGHT if rows is None else rows])
    if not omit_counts:
        fields[279] = (4, [len(pixels)])
    if palette is not None:
        fields[320] = (3, palette)
    if profile is not None:
        fields[34675] = (7, profile)
    header_size, entry_size, count_size, inline = (16, 20, 8, 8) if big else (8, 12, 2, 4)
    offset = header_size + count_size + entry_size * len(fields) + inline
    extra, entries = bytearray(), bytearray()
    for tag, (kind, values) in sorted(fields.items()):
        data = bytes(values) if kind == 7 else pack({3: "H", 4: "I", 5: "I"}[kind] * len(values), *values)
        count = len(values) // 2 if kind == 5 else len(values)
        entries += pack("HH", tag, kind) + pack("Q" if big else "I", count)
        if len(data) <= inline:
            entries += data.ljust(inline, b"\0")
        else:
            entries += pack("Q" if big else "I", offset + len(extra))
            extra += data
            if len(extra) % 2:
                extra += b"\0"
    pixel_at = offset + len(extra)
    strip_entry = sorted(fields).index(273) * entry_size + (12 if big else 8)
    entries[strip_entry:strip_entry + 4] = pack("I", pixel_at)
    header = (b"II" if endian == "<" else b"MM")
    header += pack("HHHQ", 43, 8, 0, 16) if big else pack("HI", 42, 8)
    path.write_bytes(header + pack("Q" if big else "H", len(fields)) + entries + b"\0" * inline + extra + pixels)


def main():
    ROOT.mkdir(parents=True, exist_ok=True)
    manifest = []
    rgb = bytes(value for y in range(HEIGHT) for x in range(WIDTH)
                for value in ((x * 19 + y * 7) % 256, (x * 3 + y * 29) % 256, (x * 13 + y * 11) % 256))
    image = Image.frombytes("RGB", (WIDTH, HEIGHT), rgb)
    profile = ImageCms.ImageCmsProfile(ImageCms.createProfile("sRGB")).tobytes()
    # Profile creation stamps the clock; use a fixed legal timestamp for reproducibility.
    profile = profile[:24] + struct.pack(">6H", 2026, 1, 1, 0, 0, 0) + profile[36:]

    def record(name, expected, channels=3, bits=8, orientation=1, icc=None, jpeg=False, error=False):
        manifest.append(dict(name=name, pixels=expected.hex(), channels=channels, bits=bits,
                             orientation=orientation, icc=icc.hex() if icc else None,
                             jpeg=jpeg, error=error))

    for bits in (1, 2, 4, 8, 16):
        entries = 1 << bits
        palette = [((i * (231 + channel * 84) + channel * 9000) % 65536)
                   for channel in range(3) for i in range(entries)]
        indices = [(x + y * 7) % entries for y in range(HEIGHT) for x in range(WIDTH)]
        expected = b"".join(struct.pack(">H", palette[channel * entries + index])
                            for index in indices for channel in range(3))
        for endian, big in (("<", False), (">", True)):
            name = f"palette-{bits}-{'big-be' if big else 'le'}.tif"
            if bits == 16:
                data = struct.pack(endian + "H" * len(indices), *indices)
            else:
                data = bytearray()
                for y in range(HEIGHT):
                    row = bytearray((WIDTH * bits + 7) // 8)
                    for x in range(WIDTH):
                        bit = x * bits
                        row[bit // 8] |= indices[y * WIDTH + x] << (8 - bits - bit % 8)
                    data.extend(row)
            raw_tiff(ROOT / name, data, [bits], 3, palette=palette, endian=endian, big=big)
            record(name, expected, bits=16)

    for bits in (8, 16):
        values = [(x * 37 + y * 11 + c * 59) % (1 << bits)
                  for y in range(HEIGHT) for x in range(WIDTH) for c in range(4)]
        if bits == 16:
            values = [(v * 127) % 65536 for v in values]
        expected = struct.pack(">" + ("H" if bits == 16 else "B") * len(values), *values)
        for endian in ("<", ">"):
            name = f"cmyk-{bits}-{'le' if endian == '<' else 'be'}.tif"
            data = struct.pack(endian + ("H" if bits == 16 else "B") * len(values), *values)
            raw_tiff(ROOT / name, data, [bits] * 4, 5, endian=endian)
            record(name, expected, channels=4, bits=bits)

    for compression in ("raw", "tiff_lzw", "tiff_adobe_deflate", "packbits", "jpeg"):
        name = f"cmyk-{compression}.tif"
        cmyk = image.convert("CMYK")
        cmyk.save(ROOT / name, compression=compression, dpi=(72, 72))
        with Image.open(ROOT / name) as source:
            record(name, source.tobytes(), channels=4)

    for mode in ("RGB", "RGBA"):
        name = f"icc-{mode}.tif"
        converted = image.convert(mode)
        converted.save(ROOT / name, compression="tiff_lzw", icc_profile=profile, dpi=(72, 72))
        record(name, rgb, icc=profile)

    palette_image = image.quantize(colors=16)
    name = "palette-lzw.tif"
    palette_image.save(ROOT / name, compression="tiff_lzw", dpi=(72, 72))
    with Image.open(ROOT / name) as source:
        color_map = source.tag_v2[320]
        expected = b"".join(struct.pack(">H", color_map[c * 256 + i]) for i in source.tobytes() for c in range(3))
        record(name, expected, bits=16)

    fax = image.convert("L").point(lambda value: 255 if value > 120 else 0, "1")
    for compression, options in (("group3", 0), ("group3", 1), ("group3", 4), ("group3", 5), ("group4", 0), ("tiff_ccitt", 0)):
        name = f"fax-{compression}-{options}.tif"
        tags = TiffImagePlugin.ImageFileDirectory_v2()
        if compression == "group3":
            tags[292] = options
        fax.save(ROOT / name, compression=compression, tiffinfo=tags, dpi=(72, 72))
        with Image.open(ROOT / name) as source:
            record(name, source.convert("L").tobytes(), channels=1, error=compression == "tiff_ccitt")

    jpeg_buffer = io.BytesIO()
    image.save(jpeg_buffer, format="JPEG", quality=93)
    jpeg = jpeg_buffer.getvalue()
    raw_tiff(ROOT / "missing-count.tif", jpeg, [8] * 3, 6, compression=7, omit_counts=True, rows=False)
    record("missing-count.tif", jpeg, jpeg=True)
    raw_tiff(ROOT / "missing-count-big-be.tif", jpeg, [8] * 3, 6, compression=7,
             omit_counts=True, rows=False, endian=">", big=True)
    record("missing-count-big-be.tif", jpeg, jpeg=True)
    raw_tiff(ROOT / "bad-missing-count-truncated.tif", jpeg[:-3], [8] * 3, 6, compression=7, omit_counts=True)
    record("bad-missing-count-truncated.tif", b"", error=True)
    raw_tiff(ROOT / "bad-missing-count-multi-strip.tif", jpeg, [8] * 3, 6, compression=7, omit_counts=True, rows=2)
    record("bad-missing-count-multi-strip.tif", b"", error=True)
    raw_tiff(ROOT / "bad-icc.tif", rgb, [8] * 3, 2, profile=b"broken profile")
    record("bad-icc.tif", b"", error=True)
    raw_tiff(ROOT / "bad-palette.tif", bytes(WIDTH * HEIGHT), [8], 3, palette=[0, 1, 2])
    record("bad-palette.tif", b"", error=True)

    for orientation in range(1, 9):
        for kind in ("palette", "icc", "jpeg"):
            name = f"orient-{kind}-{orientation}.tif"
            if kind == "palette":
                indices = bytes((x + y * 7) % 16 for y in range(HEIGHT) for x in range(WIDTH))
                palette = [i * 257 if c == 0 else (255-i) * 257 for c in range(3) for i in range(256)]
                raw_tiff(ROOT / name, indices, [8], 3, palette=palette, orientation=orientation)
                expected = b"".join(struct.pack(">H", palette[c*256+i]) for i in indices for c in range(3))
                record(name, expected, bits=16, orientation=orientation)
            elif kind == "icc":
                raw_tiff(ROOT / name, rgb, [8] * 3, 2, profile=profile, orientation=orientation)
                oriented = Image.frombytes("RGB", (WIDTH, HEIGHT), rgb)
                transforms = {2: Image.Transpose.FLIP_LEFT_RIGHT, 3: Image.Transpose.ROTATE_180,
                              4: Image.Transpose.FLIP_TOP_BOTTOM, 5: Image.Transpose.TRANSPOSE,
                              6: Image.Transpose.ROTATE_270, 7: Image.Transpose.TRANSVERSE,
                              8: Image.Transpose.ROTATE_90}
                if orientation in transforms:
                    oriented = oriented.transpose(transforms[orientation])
                record(name, oriented.tobytes(), icc=profile, orientation=orientation)
            else:
                raw_tiff(ROOT / name, jpeg, [8]*3, 6, compression=7, orientation=orientation, profile=profile)
                record(name, jpeg, icc=profile, jpeg=True, orientation=orientation)
    (ROOT / "manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    print(f"Generated {len(manifest)} TIFF fixtures in {ROOT}")


if __name__ == "__main__":
    main()
