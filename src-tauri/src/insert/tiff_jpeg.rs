use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

use lopdf::{
    content::{Content, Operation},
    dictionary, Dictionary, Document, Object, Stream,
};
use tiff::{
    decoder::{ifd::Value, Decoder},
    tags::Tag,
};
use zune_jpeg::{
    zune_core::{bytestream::ZCursor, colorspace::ColorSpace, options::DecoderOptions},
    JpegDecoder,
};

use super::{tiff_decoder, tiff_dpi, TiffIndex};

const MAX_JPEG_BYTES: u64 = 256 * 1024 * 1024;

// TIFF Technical Note 2: shared tables and each strip/tile are separate JPEG
// streams. Join their framing markers only; never recompress the scan data.
fn join_jpeg(tables: Option<&[u8]>, chunk: &[u8]) -> Result<Vec<u8>, String> {
    fn framed(bytes: &[u8]) -> bool {
        bytes.len() >= 4 && bytes.starts_with(&[0xff, 0xd8]) && bytes.ends_with(&[0xff, 0xd9])
    }
    if !framed(chunk) {
        return Err("TIFF JPEG strip/tile is truncated or has invalid SOI/EOI markers".into());
    }
    match tables {
        Some(tables) if framed(tables) => {
            let mut jpeg = Vec::with_capacity(tables.len() + chunk.len() - 4);
            jpeg.extend_from_slice(&tables[..tables.len() - 2]);
            jpeg.extend_from_slice(&chunk[2..]);
            Ok(jpeg)
        }
        Some(_) => Err("TIFF JPEGTables has invalid SOI/EOI markers".into()),
        None => Ok(chunk.to_vec()),
    }
}

fn standard_rationals<R: Read + Seek>(
    decoder: &mut Decoder<R>,
    tag: Tag,
    expected: &[f64],
    name: &str,
) -> Result<(), String> {
    let Some(value) = decoder.find_tag(tag).map_err(|e| e.to_string())? else {
        return Ok(());
    };
    let values = match value {
        Value::List(values) => values,
        value => vec![value],
    };
    let matches = values.len() == expected.len() && values.iter().zip(expected).all(|(value, expected)| {
        matches!(value, Value::Rational(n, d) if *d != 0 && (f64::from(*n) / f64::from(*d) - expected).abs() < 0.000001)
    });
    if !matches {
        return Err(format!("Nonstandard TIFF {name} cannot be preserved by JPEG passthrough; use a color-managed conversion"));
    }
    Ok(())
}

pub(super) fn orientation_matrix(
    orientation: u16,
    width: f64,
    height: f64,
) -> Result<[f64; 6], String> {
    Ok(match orientation {
        1 => [1.0, 0.0, 0.0, 1.0, 0.0, 0.0],
        2 => [-1.0, 0.0, 0.0, 1.0, width, 0.0],
        3 => [-1.0, 0.0, 0.0, -1.0, width, height],
        4 => [1.0, 0.0, 0.0, -1.0, 0.0, height],
        5 => [0.0, -1.0, -1.0, 0.0, height, width],
        6 => [0.0, -1.0, 1.0, 0.0, 0.0, width],
        7 => [0.0, 1.0, 1.0, 0.0, 0.0, 0.0],
        8 => [0.0, 1.0, -1.0, 0.0, height, 0.0],
        _ => return Err("Invalid TIFF orientation".into()),
    })
}

pub(super) fn numbers(values: &[f64]) -> Vec<Object> {
    values.iter().copied().map(Object::from).collect()
}

pub(super) fn write_page(
    path: &Path,
    index: &TiffIndex,
    offset: u64,
    output: &Path,
) -> Result<bool, String> {
    let mut decoder = tiff_decoder(path, index, offset)?;
    if decoder
        .get_tag_u32(Tag::PhotometricInterpretation)
        .map_err(|e| e.to_string())?
        != 6
        || decoder
            .get_tag_u32(Tag::Compression)
            .map_err(|e| e.to_string())?
            != 7
    {
        return Ok(false);
    }
    let (width, height) = decoder.dimensions().map_err(|e| e.to_string())?;
    if width == 0 || height == 0 {
        return Err("TIFF page has no pixels".into());
    }
    let mut profile = super::tiff_pdf::icc_profile(&mut decoder)?;
    if decoder
        .find_tag_unsigned::<u16>(Tag::PlanarConfiguration)
        .map_err(|e| e.to_string())?
        .unwrap_or(1)
        != 1
        || decoder
            .find_tag_unsigned_vec::<u16>(Tag::SampleFormat)
            .map_err(|e| e.to_string())?
            .is_some_and(|values| values.iter().any(|value| *value != 1))
        || decoder
            .find_tag(Tag::ExtraSamples)
            .map_err(|e| e.to_string())?
            .is_some()
    {
        return Err(
            "JPEG TIFF passthrough requires unsigned, interleaved YCbCr without extra samples"
                .into(),
        );
    }
    standard_rationals(
        &mut decoder,
        Tag::Unknown(529),
        &[0.299, 0.587, 0.114],
        "YCbCrCoefficients",
    )?;
    standard_rationals(
        &mut decoder,
        Tag::Unknown(532),
        &[0.0, 255.0, 128.0, 255.0, 128.0, 255.0],
        "ReferenceBlackWhite",
    )?;
    if decoder
        .find_tag_unsigned::<u16>(Tag::ChromaPositioning)
        .map_err(|e| e.to_string())?
        .unwrap_or(1)
        != 1
    {
        return Err(
            "Non-centered TIFF chroma positioning requires a color-managed conversion".into(),
        );
    }
    let tables = decoder
        .find_tag(Tag::JPEGTables)
        .map_err(|e| e.to_string())?
        .map(Value::into_u8_vec)
        .transpose()
        .map_err(|e| e.to_string())?;
    let orientation = decoder
        .find_tag_unsigned::<u16>(Tag::Orientation)
        .map_err(|e| e.to_string())?
        .unwrap_or(1);
    let (page_width, page_height) = tiff_dpi(&mut decoder)
        .map(|(x, y)| (f64::from(width) * 72.0 / x, f64::from(height) * 72.0 / y))
        .unwrap_or(if width >= height {
            (842.0, 595.0)
        } else {
            (595.0, 842.0)
        });
    if !page_width.is_finite()
        || !page_height.is_finite()
        || page_width <= 0.0
        || page_height <= 0.0
        || page_width > f64::from(f32::MAX)
        || page_height > f64::from(f32::MAX)
    {
        return Err("Invalid TIFF physical page size".into());
    }
    let matrix = orientation_matrix(orientation, page_width, page_height)?;
    let tiled = decoder
        .find_tag(Tag::TileOffsets)
        .map_err(|e| e.to_string())?
        .is_some();
    let (chunk_width, chunk_height, offsets_tag, counts_tag) = if tiled {
        (
            decoder
                .get_tag_u32(Tag::TileWidth)
                .map_err(|e| e.to_string())?,
            decoder
                .get_tag_u32(Tag::TileLength)
                .map_err(|e| e.to_string())?,
            Tag::TileOffsets,
            Tag::TileByteCounts,
        )
    } else {
        (
            width,
            decoder
                .find_tag_unsigned::<u32>(Tag::RowsPerStrip)
                .map_err(|e| e.to_string())?
                .unwrap_or(height),
            Tag::StripOffsets,
            Tag::StripByteCounts,
        )
    };
    if chunk_width == 0 || chunk_height == 0 {
        return Err("Invalid TIFF strip/tile dimensions".into());
    }
    let across = width.div_ceil(chunk_width);
    let chunk_count = u64::from(across) * u64::from(height.div_ceil(chunk_height));
    let offsets = decoder
        .get_tag_u64_vec(offsets_tag)
        .map_err(|e| e.to_string())?;
    let counts = decoder
        .get_tag_u64_vec(counts_tag)
        .map_err(|e| e.to_string())?;
    if offsets.len() as u64 != chunk_count || counts.len() != offsets.len() {
        return Err("TIFF strip/tile count does not cover the entire page".into());
    }
    let mut file = File::open(path).map_err(|e| e.to_string())?;
    let file_len = file.metadata().map_err(|e| e.to_string())?.len();
    let mut document = Document::with_version("1.0");
    let pages_id = document.new_object_id();
    let mut xobjects = Dictionary::new();
    let mut operations = vec![
        Operation::new("q", vec![]),
        Operation::new("cm", numbers(&matrix)),
    ];
    let (sx, sy) = (
        page_width / f64::from(width),
        page_height / f64::from(height),
    );
    let mut encoded_total = 0_u64;
    let mut page_color_space = None;
    for (number, (&start, &count)) in offsets.iter().zip(&counts).enumerate() {
        if start.checked_add(count).is_none_or(|end| end > file_len) || count > MAX_JPEG_BYTES {
            return Err(format!(
                "TIFF JPEG strip/tile {} is truncated or exceeds the memory limit",
                number + 1
            ));
        }
        file.seek(SeekFrom::Start(start))
            .map_err(|e| e.to_string())?;
        let mut chunk = vec![0; count as usize];
        file.read_exact(&mut chunk).map_err(|e| e.to_string())?;
        let jpeg = join_jpeg(tables.as_deref(), &chunk)?;
        drop(chunk);
        encoded_total = encoded_total
            .checked_add(jpeg.len() as u64)
            .ok_or("TIFF JPEG size overflow")?;
        if encoded_total > MAX_JPEG_BYTES {
            return Err("TIFF JPEG page exceeds the memory limit".into());
        }
        let x = (number as u64 % u64::from(across)) as u32 * chunk_width;
        let y = (number as u64 / u64::from(across)) as u32 * chunk_height;
        let expected = (
            chunk_width,
            if tiled {
                chunk_height
            } else {
                chunk_height.min(height - y)
            },
        );
        let options = DecoderOptions::default()
            .set_max_width(65535)
            .set_max_height(65535)
            .jpeg_set_out_colorspace(ColorSpace::YCbCr);
        let mut jpeg_decoder = JpegDecoder::new_with_options(ZCursor::new(&jpeg), options);
        jpeg_decoder
            .decode_headers()
            .map_err(|e| format!("TIFF JPEG header: {e}"))?;
        let info = jpeg_decoder.info().ok_or("Missing TIFF JPEG header")?;
        if (u32::from(info.width), u32::from(info.height)) != expected
            || info.components != 3
            || jpeg_decoder.input_colorspace() != Some(ColorSpace::YCbCr)
        {
            return Err(format!(
                "TIFF JPEG strip/tile {} dimensions or colors do not match TIFF tags",
                number + 1
            ));
        }
        if let Some(embedded) = jpeg_decoder.icc_profile() {
            if profile.as_ref().is_some_and(|profile| *profile != embedded) {
                return Err("TIFF and embedded JPEG ICC profiles disagree".into());
            }
            if number > 0 && profile.is_none() {
                return Err("TIFF JPEG strips/tiles have inconsistent ICC profiles".into());
            }
            profile = Some(embedded);
        }
        if jpeg_decoder
            .output_buffer_size()
            .is_none_or(|size| size as u64 > MAX_JPEG_BYTES)
        {
            return Err("TIFF JPEG decoded strip/tile exceeds the memory limit".into());
        }
        // Decode one chunk for validation only. The PDF keeps the original JPEG bytes.
        let pixels = jpeg_decoder
            .decode()
            .map_err(|e| format!("TIFF JPEG pixel decode: {e}"))?;
        drop(pixels);
        if page_color_space.is_none() {
            page_color_space = Some(super::tiff_pdf::color_space(
                &mut document,
                3,
                profile.as_deref(),
            )?);
        }
        let color_space = page_color_space.clone().ok_or("Missing JPEG color space")?;
        let image_id = document.add_object(Stream::new(dictionary! {
            "Type" => "XObject", "Subtype" => "Image", "Width" => expected.0 as i64, "Height" => expected.1 as i64,
            "ColorSpace" => color_space, "BitsPerComponent" => 8, "Filter" => "DCTDecode",
            "DecodeParms" => dictionary! { "ColorTransform" => 1 },
        }, jpeg));
        let name = format!("Im{number}");
        xobjects.set(name.as_str(), image_id);
        operations.push(Operation::new("q", vec![]));
        // Clip padded edge tiles without changing their pixel data.
        operations.push(Operation::new(
            "re",
            numbers(&[
                f64::from(x) * sx,
                page_height - f64::from(y + expected.1.min(height - y)) * sy,
                f64::from(chunk_width.min(width - x)) * sx,
                f64::from(expected.1.min(height - y)) * sy,
            ]),
        ));
        operations.push(Operation::new("W", vec![]));
        operations.push(Operation::new("n", vec![]));
        operations.push(Operation::new(
            "cm",
            numbers(&[
                f64::from(expected.0) * sx,
                0.0,
                0.0,
                f64::from(expected.1) * sy,
                f64::from(x) * sx,
                page_height - (f64::from(y) + f64::from(expected.1)) * sy,
            ]),
        ));
        operations.push(Operation::new("Do", vec![Object::Name(name.into_bytes())]));
        operations.push(Operation::new("Q", vec![]));
    }
    operations.push(Operation::new("Q", vec![]));
    let content = Content { operations }.encode().map_err(|e| e.to_string())?;
    let content_id = document.add_object(Stream::new(dictionary! {}, content));
    let (w, h) = if (5..=8).contains(&orientation) {
        (page_height, page_width)
    } else {
        (page_width, page_height)
    };
    let page_id = document.add_object(dictionary! {
        "Type" => "Page", "Parent" => pages_id, "MediaBox" => numbers(&[0.0, 0.0, w, h]),
        "Resources" => dictionary! { "XObject" => xobjects }, "Contents" => content_id,
    });
    document.objects.insert(
        pages_id,
        Object::Dictionary(dictionary! {
            "Type" => "Pages", "Kids" => vec![Object::Reference(page_id)], "Count" => 1,
        }),
    );
    let catalog = document.add_object(dictionary! { "Type" => "Catalog", "Pages" => pages_id });
    document.trailer.set("Root", catalog);
    crate::prepare_pdf_output(&mut document).map_err(|e| e.to_string())?;
    document.save(output).map_err(|e| e.to_string())?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn jpeg_table_join_preserves_payload_and_rejects_truncation() {
        let tables = [0xff, 0xd8, 1, 2, 0xff, 0xd9];
        let chunk = [0xff, 0xd8, 3, 4, 0xff, 0xd9];
        assert_eq!(
            join_jpeg(Some(&tables), &chunk).unwrap(),
            [0xff, 0xd8, 1, 2, 3, 4, 0xff, 0xd9]
        );
        assert_eq!(join_jpeg(None, &chunk).unwrap(), chunk);
        assert!(join_jpeg(Some(&tables[..4]), &chunk).is_err());
        assert!(join_jpeg(None, &chunk[..4]).is_err());
    }
}
