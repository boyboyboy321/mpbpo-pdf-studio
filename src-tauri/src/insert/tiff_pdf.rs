use super::tiff_jpeg::{numbers, orientation_matrix};

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn icc_profile_version_only_raises_the_required_pdf_version() {
        let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../scripts/fixtures/tiff/icc-RGB.tif");
        let mut decoder = Decoder::new(BufReader::new(std::fs::File::open(path).unwrap())).unwrap();
        let original = icc_profile(&mut decoder).unwrap().unwrap();
        for (major, minor, expected) in [(2, 1, "1.3"), (2, 2, "1.4"), (4, 0, "1.5"),
            (4, 1, "1.6"), (4, 2, "1.7"), (4, 4, "1.7")]
        {
            let mut profile = original.clone();
            profile[8] = major;
            profile[9] = minor << 4;
            let mut document = Document::with_version("1.0");
            let Object::Array(color) = color_space(&mut document, 3, Some(&profile)).unwrap() else {
                panic!("Expected ICCBased color space");
            };
            assert_eq!(document.version, expected);
            let stream = document.get_object(color[1].as_reference().unwrap()).unwrap().as_stream().unwrap();
            assert_eq!(stream.get_plain_content().unwrap(), profile);
        }
        let mut document = Document::with_version("2.0");
        color_space(&mut document, 3, Some(&original)).unwrap();
        assert_eq!(document.version, "2.0");
    }
}

use super::{read_tiff_samples, tiff_decoder, tiff_dpi, TiffIndex};
use image_025::GenericImageView;
use lopdf::{
    content::{Content, Operation},
    dictionary, Document, Object, ObjectId, Stream,
};
use std::{
    io::{BufReader, Read, Seek},
    path::Path,
};
use tiff::{
    decoder::{Decoder, DecodingResult},
    tags::Tag,
};

pub(super) fn icc_profile<R: Read + Seek>(
    decoder: &mut Decoder<R>,
) -> Result<Option<Vec<u8>>, String> {
    decoder
        .find_tag(Tag::IccProfile)
        .map_err(|e| e.to_string())?
        .map(|v| v.into_u8_vec().map_err(|e| e.to_string()))
        .transpose()
}

pub(super) fn color_space(
    document: &mut Document,
    channels: u8,
    profile: Option<&[u8]>,
) -> Result<Object, String> {
    let (device, signature) = match channels {
        1 => ("DeviceGray", b"GRAY"),
        3 => ("DeviceRGB", b"RGB "),
        4 => ("DeviceCMYK", b"CMYK"),
        _ => return Err("Unsupported TIFF color channel count".into()),
    };
    let Some(profile) = profile else {
        return Ok(Object::Name(device.as_bytes().to_vec()));
    };
    if profile.len() < 132 || profile.len() > 16 * 1024 * 1024 {
        return Err("Invalid ICC profile size".into());
    }
    let uint = |at| {
        u32::from_be_bytes(profile[at..at + 4].try_into().expect("bounded ICC field")) as usize
    };
    if uint(0) != profile.len()
        || &profile[36..40] != b"acsp"
        || &profile[16..20] != signature
        || !matches!(profile[8], 2 | 4)
        || !matches!(&profile[20..24], b"XYZ " | b"Lab ")
    {
        return Err(
            "ICC profile is invalid, unsupported, or does not match the TIFF color channels".into(),
        );
    }
    let count = uint(128);
    let table_end = count
        .checked_mul(12)
        .and_then(|n| n.checked_add(132))
        .filter(|n| *n <= profile.len())
        .ok_or("Truncated ICC tag table")?;
    if count == 0 {
        return Err("ICC profile has no color tags".into());
    }
    for at in (132..table_end).step_by(12) {
        let (offset, length) = (uint(at + 4), uint(at + 8));
        if offset < table_end
            || length < 8
            || offset
                .checked_add(length)
                .is_none_or(|end| end > profile.len())
        {
            return Err("ICC color tag points outside its profile".into());
        }
    }
    // ISO 32000-1 table 67: preserve the profile and declare its supported generation.
    let minimum = match (profile[8], profile[9] >> 4) {
        (2, 0..=1) => (1, 3),
        (2, _) => (1, 4),
        (4, 0) => (1, 5),
        (4, 1) => (1, 6),
        _ => (1, 7),
    };
    crate::require_pdf_version(document, minimum).map_err(|e| e.to_string())?;
    let mut stream = Stream::new(
        dictionary! { "N" => i64::from(channels), "Alternate" => device },
        profile.to_vec(),
    );
    stream.compress().map_err(|e| e.to_string())?;
    let id = document.add_object(stream);
    Ok(Object::Array(vec![
        Object::Name(b"ICCBased".to_vec()),
        id.into(),
    ]))
}

fn raw_image(
    document: &mut Document,
    size: (u32, u32),
    channels: u8,
    bits: u8,
    bytes: Vec<u8>,
    profile: Option<&[u8]>,
) -> Result<ObjectId, String> {
    let expected =
        u64::from(size.0) * u64::from(size.1) * u64::from(channels) * u64::from(bits / 8);
    if expected != bytes.len() as u64 || expected > 256 * 1024 * 1024 {
        return Err("Invalid TIFF pixel buffer size".into());
    }
    let color = color_space(document, channels, profile)?;
    let mut stream = Stream::new(
        dictionary! {
            "Type" => "XObject", "Subtype" => "Image", "Width" => i64::from(size.0), "Height" => i64::from(size.1),
            "ColorSpace" => color, "BitsPerComponent" => i64::from(bits),
        },
        bytes,
    );
    stream.compress().map_err(|e| e.to_string())?;
    Ok(document.add_object(stream))
}

fn write_image_page(
    mut document: Document,
    image: ObjectId,
    size: (u32, u32),
    dpi: Option<(f64, f64)>,
    orientation: u16,
    output: &Path,
) -> Result<(), String> {
    let (w, h) = dpi
        .map(|(x, y)| (f64::from(size.0) * 72.0 / x, f64::from(size.1) * 72.0 / y))
        .unwrap_or(if size.0 >= size.1 {
            (842.0, 595.0)
        } else {
            (595.0, 842.0)
        });
    if w <= 0.0
        || h <= 0.0
        || !w.is_finite()
        || !h.is_finite()
        || w > f64::from(f32::MAX)
        || h > f64::from(f32::MAX)
    {
        return Err("Invalid TIFF physical page size".into());
    }
    let content = Content {
        operations: vec![
            Operation::new("q", vec![]),
            Operation::new("cm", numbers(&orientation_matrix(orientation, w, h)?)),
            Operation::new("cm", numbers(&[w, 0.0, 0.0, h, 0.0, 0.0])),
            Operation::new("Do", vec![Object::Name(b"Im0".to_vec())]),
            Operation::new("Q", vec![]),
        ],
    }
    .encode()
    .map_err(|e| e.to_string())?;
    let content = document.add_object(Stream::new(dictionary! {}, content));
    let pages = document.new_object_id();
    let (w, h) = if (5..=8).contains(&orientation) {
        (h, w)
    } else {
        (w, h)
    };
    let page = document.add_object(dictionary! {
        "Type" => "Page", "Parent" => pages, "MediaBox" => numbers(&[0.0,0.0,w,h]), "Contents" => content,
        "Resources" => dictionary! { "XObject" => dictionary! { "Im0" => image } },
    });
    document.objects.insert(pages, Object::Dictionary(dictionary! { "Type" => "Pages", "Kids" => vec![Object::Reference(page)], "Count" => 1 }));
    let catalog = document.add_object(dictionary! { "Type" => "Catalog", "Pages" => pages });
    document.trailer.set("Root", catalog);
    crate::prepare_pdf_output(&mut document).map_err(|e| e.to_string())?;
    document.save(output).map_err(|e| e.to_string())?;
    Ok(())
}

pub(super) fn write_page(
    path: &Path,
    index: &TiffIndex,
    offset: u64,
    output: &Path,
) -> Result<bool, String> {
    let mut decoder = tiff_decoder(path, index, offset)?;
    let photometric = decoder
        .get_tag_u32(Tag::PhotometricInterpretation)
        .map_err(|e| e.to_string())?;
    let compression = decoder
        .get_tag_u32(Tag::Compression)
        .map_err(|e| e.to_string())?;
    let profile = icc_profile(&mut decoder)?;
    if !matches!(photometric, 3 | 5) && compression != 3 && profile.is_none() {
        return Ok(false);
    }
    let size = decoder.dimensions().map_err(|e| e.to_string())?;
    if size.0 == 0 || size.1 == 0 {
        return Err("TIFF page has no pixels".into());
    }
    let orientation = decoder
        .find_tag_unsigned::<u16>(Tag::Orientation)
        .map_err(|e| e.to_string())?
        .unwrap_or(1);
    let dpi = tiff_dpi(&mut decoder);
    let mut document = Document::with_version("1.0");
    let image;
    if compression == 3 {
        if !matches!(photometric, 0 | 1)
            || decoder
                .get_tag_u16_vec(Tag::BitsPerSample)
                .map_err(|e| e.to_string())?
                != [1]
        {
            return Err("CCITT TIFF must be a one-bit grayscale image".into());
        }
        let tiled = decoder
            .find_tag(Tag::TileOffsets)
            .map_err(|e| e.to_string())?
            .is_some();
        let (offset_tag, count_tag) = if tiled {
            (Tag::TileOffsets, Tag::TileByteCounts)
        } else {
            (Tag::StripOffsets, Tag::StripByteCounts)
        };
        let offsets = decoder
            .get_tag_u64_vec(offset_tag)
            .map_err(|e| e.to_string())?;
        let lengths = decoder
            .get_tag_u64_vec(count_tag)
            .map_err(|e| e.to_string())?;
        let file_size = std::fs::metadata(path).map_err(|e| e.to_string())?.len();
        if offsets.is_empty()
            || offsets.len() != lengths.len()
            || offsets.iter().zip(&lengths).any(|(offset, length)| {
                *length == 0
                    || offset
                        .checked_add(*length)
                        .is_none_or(|end| end > file_size)
            })
        {
            return Err("TIFF fax strip/tile data is missing or truncated".into());
        }
        #[cfg(windows)]
        {
            let page = index
                .offsets
                .iter()
                .position(|candidate| *candidate == offset)
                .ok_or("TIFF page not indexed")?;
            let pixels = super::tiff_wic::decode_fax(path, page as u32, size)?;
            image = raw_image(&mut document, size, 1, 8, pixels, profile.as_deref())?;
        }
        #[cfg(not(windows))]
        return Err("CCITT Group 3 TIFF requires the Windows imaging codec".into());
    } else if photometric == 3 {
        if decoder
            .find_tag(Tag::ExtraSamples)
            .map_err(|e| e.to_string())?
            .is_some()
        {
            return Err("Palette TIFF extra samples are not supported".into());
        }
        let depths = decoder
            .get_tag_u16_vec(Tag::BitsPerSample)
            .map_err(|e| e.to_string())?;
        let bits = *depths.first().ok_or("Missing TIFF palette depth")?;
        if depths.len() != 1 || !matches!(bits, 1 | 2 | 4 | 8 | 16) {
            return Err("Unsupported TIFF palette depth".into());
        }
        let palette = decoder
            .get_tag_u16_vec(Tag::ColorMap)
            .map_err(|e| e.to_string())?;
        let entries = 1_usize << bits;
        if palette.len() != entries * 3 {
            return Err("Incomplete TIFF color palette".into());
        }
        // Decode palette indices as unsigned grayscale without changing sample bits.
        let reader = super::tiff_view::PageReader::new(path, index, offset, &[(262, 1)])?;
        let mut indices = Decoder::new(BufReader::new(reader)).map_err(|e| e.to_string())?;
        let samples = read_tiff_samples(&mut indices, size.0, size.1)?;
        let required = u64::from(size.0) * u64::from(size.1) * 6;
        if required > 256 * 1024 * 1024 {
            return Err("Expanded TIFF palette exceeds the memory limit".into());
        }
        let mut rgb = Vec::with_capacity(required as usize);
        let mut append = |index: usize| {
            for channel in 0..3 {
                rgb.extend_from_slice(&palette[channel * entries + index].to_be_bytes());
            }
        };
        match samples {
            DecodingResult::U8(data) if bits <= 8 => {
                let stride = (size.0 as usize * bits as usize).div_ceil(8);
                if data.len() != stride * size.1 as usize {
                    return Err("Invalid TIFF palette scanline length".into());
                }
                for row in data.chunks_exact(stride) {
                    for x in 0..size.0 as usize {
                        let bit = x * bits as usize;
                        append(
                            ((row[bit / 8] >> (8 - bits as usize - bit % 8)) as usize)
                                & (entries - 1),
                        );
                    }
                }
            }
            DecodingResult::U16(data) if bits == 16 => {
                for value in data {
                    append(value as usize);
                }
            }
            _ => return Err("Unsupported TIFF palette sample type".into()),
        }
        image = raw_image(&mut document, size, 3, 16, rgb, profile.as_deref())?;
    } else if photometric == 5 {
        if decoder
            .find_tag_unsigned::<u16>(Tag::Unknown(332))
            .map_err(|e| e.to_string())?
            .unwrap_or(1)
            != 1
            || decoder
                .find_tag(Tag::ExtraSamples)
                .map_err(|e| e.to_string())?
                .is_some()
        {
            return Err(
                "Only standard CMYK TIFF without extra ink/alpha channels is supported".into(),
            );
        }
        let bits = match decoder.colortype().map_err(|e| e.to_string())? {
            tiff::ColorType::CMYK(bits @ (8 | 16)) => bits,
            _ => return Err("CMYK TIFF must use unsigned 8/16-bit samples".into()),
        };
        let bytes = match read_tiff_samples(&mut decoder, size.0, size.1)? {
            DecodingResult::U8(data) if bits == 8 => data,
            DecodingResult::U16(data) if bits == 16 => {
                data.into_iter().flat_map(u16::to_be_bytes).collect()
            }
            _ => return Err("Unsupported CMYK TIFF sample format".into()),
        };
        image = raw_image(&mut document, size, 4, bits, bytes, profile.as_deref())?;
    } else {
        let (decoded, dpi) = super::decode_tiff_page(path, index, offset)?;
        let image =
            super::append_lossless_image(&mut document, &decoded).map_err(|e| e.to_string())?;
        let channels = if matches!(
            decoded.color(),
            image_025::ColorType::L8
                | image_025::ColorType::L16
                | image_025::ColorType::La8
                | image_025::ColorType::La16
        ) {
            1
        } else {
            3
        };
        let color = color_space(&mut document, channels, profile.as_deref())?;
        document
            .get_object_mut(image)
            .map_err(|e| e.to_string())?
            .as_stream_mut()
            .map_err(|e| e.to_string())?
            .dict
            .set("ColorSpace", color);
        write_image_page(document, image, decoded.dimensions(), dpi, 1, output)?;
        return Ok(true);
    }
    write_image_page(document, image, size, dpi, orientation, output)?;
    Ok(true)
}
