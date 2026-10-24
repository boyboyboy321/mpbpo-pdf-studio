use std::collections::HashSet;
use std::fs::{self, File};
use std::io::{BufReader, BufWriter, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use image_025::{DynamicImage, GenericImageView, ImageBuffer};
use lopdf::{dictionary, Document, Object, ObjectId, Stream};
use pdfium_render::prelude::*;
use serde::Serialize;
use tiff::decoder::{Decoder, DecodingResult};
use tiff::tags::Tag;

use super::{AppError, InsertPageMetadata, PageSource};

const MAX_PAGE_CONTENT_BYTES: usize = 64 * 1024 * 1024;

mod tiff_jpeg;
mod tiff_pdf;
mod tiff_view;
#[cfg(windows)]
mod tiff_wic;

fn checked_operation<T>(operation: impl FnOnce() -> Result<T, String>) -> Result<T, String> {
    std::panic::catch_unwind(std::panic::AssertUnwindSafe(operation))
        .unwrap_or_else(|_| Err("Decoder panicked while checking this page".into()))
}

fn load_insert_pdf(path: &Path) -> Result<Document, String> {
    checked_operation(|| {
        Document::load_with_options(
            path,
            lopdf::LoadOptions::with_max_decompressed_size(MAX_PAGE_CONTENT_BYTES),
        )
        .map_err(|error| error.to_string())
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct InsertBatchResult {
    pages: Vec<InsertPageMetadata>,
    issues: Vec<InsertIssue>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct InsertIssue {
    file_path: String,
    file_name: String,
    page_number: Option<u32>,
    message: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
enum Phase {
    Scanning,
    Preparing,
    Complete,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct InsertProgress {
    run_id: String,
    phase: Phase,
    completed_files: usize,
    total_files: usize,
    current_file_name: String,
    completed_pages: usize,
    total_pages: Option<usize>,
    issues: Vec<InsertIssue>,
}

struct Progress<F> {
    value: InsertProgress,
    emit: F,
    last_emit: Option<Instant>,
}

impl<F: FnMut(&InsertProgress)> Progress<F> {
    fn publish(&mut self, force: bool) {
        let now = Instant::now();
        if force
            || self
                .last_emit
                .is_none_or(|last| now.duration_since(last) >= Duration::from_millis(100))
        {
            (self.emit)(&self.value);
            self.last_emit = Some(now);
        }
    }

    fn issue(&mut self, path: &Path, page: Option<u32>, message: impl ToString) {
        self.value.issues.push(InsertIssue {
            file_path: path.to_string_lossy().into_owned(),
            file_name: file_name(path),
            page_number: page,
            message: message.to_string(),
        });
    }

    fn page_done(&mut self) {
        self.value.completed_pages += 1;
        self.publish(false);
    }
}

enum InputKind {
    Pdf(u32),
    Image,
    Tiff(TiffIndex),
    Failed,
}

#[derive(Default)]
pub(super) struct InsertSourceStore {
    directories: Mutex<Vec<tempfile::TempDir>>,
}

impl InsertSourceStore {
    pub(super) fn retain(&self, directory: tempfile::TempDir) -> Result<(), String> {
        // Undo and unsaved pages can retain these paths until the entire app session ends.
        self.directories
            .lock()
            .map_err(|_| "Insert source store lock was poisoned".to_string())?
            .push(directory);
        Ok(())
    }

    pub(super) fn cleanup(&self) {
        self.directories
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .clear();
    }
}

pub(super) fn read_insert_pages_impl(
    paths: Vec<String>,
    run_id: String,
    staging_root: &Path,
    emit: impl FnMut(&InsertProgress),
    mut allow_image: impl FnMut(&Path) -> Result<(), String>,
    mut retain_staging: impl FnMut(tempfile::TempDir) -> Result<(), String>,
    pdfium: Result<&Pdfium, &str>,
) -> Result<InsertBatchResult, AppError> {
    let mut progress = Progress {
        value: InsertProgress {
            run_id,
            phase: Phase::Scanning,
            completed_files: 0,
            total_files: paths.len(),
            current_file_name: String::new(),
            completed_pages: 0,
            total_pages: None,
            issues: Vec::new(),
        },
        emit,
        last_emit: None,
    };
    progress.publish(true);
    let mut inputs = Vec::with_capacity(paths.len());
    let mut total = 0;
    let mut count_complete = true;
    for path in paths {
        let path = PathBuf::from(path);
        progress.value.current_file_name = file_name(&path);
        progress.publish(true);
        let kind = if !path.is_file() {
            progress.issue(&path, None, "File does not exist or is not a regular file");
            count_complete = false;
            InputKind::Failed
        } else if super::is_pdf(&path) {
            match load_insert_pdf(&path).and_then(|document| {
                super::document_page_count(&document).map_err(|error| error.to_string())
            }) {
                Ok(count) => {
                    total += count as usize;
                    InputKind::Pdf(count)
                }
                Err(error) => {
                    progress.issue(&path, None, error);
                    count_complete = false;
                    InputKind::Failed
                }
            }
        } else if is_tiff(&path) {
            match index_tiff(&path) {
                Ok(index) => {
                    total += index.offsets.len();
                    if let Some((page, message)) = &index.issue {
                        progress.issue(&path, Some(*page), message);
                        count_complete = false;
                    }
                    InputKind::Tiff(index)
                }
                Err(error) => {
                    progress.issue(&path, None, error);
                    count_complete = false;
                    InputKind::Failed
                }
            }
        } else if super::is_supported_image(&path) {
            total += 1;
            InputKind::Image
        } else {
            progress.issue(
                &path,
                None,
                "Unsupported insert file; expected PDF, PNG, JPEG, TIF, or TIFF",
            );
            InputKind::Failed
        };
        inputs.push((path, kind));
        progress.value.completed_files += 1;
        progress.publish(true);
    }

    progress.value.phase = Phase::Preparing;
    progress.value.completed_files = 0;
    progress.value.total_pages = count_complete.then_some(total);
    progress.value.current_file_name.clear();
    progress.publish(true);
    let mut staged: Option<tempfile::TempDir> = None;
    let mut pages = Vec::new();
    for (file_index, (path, kind)) in inputs.iter().enumerate() {
        progress.value.current_file_name = file_name(path);
        progress.publish(true);
        match kind {
            InputKind::Pdf(count) => {
                prepare_pdf(path, *count, pdfium, &mut pages, &mut progress);
            }
            InputKind::Image => {
                let result = checked_operation(|| {
                    image_025::open(path)
                        .map_err(|error| error.to_string())
                        .and_then(|image| {
                            if image.width() == 0 || image.height() == 0 {
                                return Err("Image has no pixels".into());
                            }
                            allow_image(path)?;
                            Ok(image_source(path, path, image.dimensions()))
                        })
                });
                match result {
                    Ok(page) => pages.push(page),
                    Err(error) => progress.issue(path, Some(1), error),
                }
                progress.page_done();
            }
            InputKind::Tiff(index) => {
                for (page_index, offset) in index.offsets.iter().enumerate() {
                    let result = checked_operation(|| {
                        if staged.is_none() {
                            fs::create_dir_all(staging_root).map_err(|error| error.to_string())?;
                            staged = Some(
                                tempfile::Builder::new()
                                    .prefix("batch-")
                                    .tempdir_in(staging_root)
                                    .map_err(|error| error.to_string())?,
                            );
                        }
                        let directory = staged.as_ref().ok_or("Staging directory unavailable")?;
                        let output = directory
                            .path()
                            .join(format!("{file_index}-{page_index}.png"));
                        let pdf_output = output.with_extension("pdf");
                        if tiff_jpeg::write_page(path, index, *offset, &pdf_output)?
                            || tiff_pdf::write_page(path, index, *offset, &pdf_output)?
                        {
                            return Ok(InsertPageMetadata {
                                source: PageSource::Pdf {
                                    file_name: file_name(path),
                                    file_path: pdf_output.to_string_lossy().into_owned(),
                                    page_number: 1,
                                },
                            });
                        }
                        let (image, dpi) = decode_tiff_page(path, index, *offset)?;
                        write_staged_png(&output, &image, dpi)?;
                        allow_image(&output)?;
                        Ok::<_, String>(image_source(path, &output, image.dimensions()))
                    });
                    match result {
                        Ok(page) => pages.push(page),
                        Err(error) => progress.issue(path, Some(page_index as u32 + 1), error),
                    }
                    progress.page_done();
                }
            }
            InputKind::Failed => {}
        }
        progress.value.completed_files += 1;
        progress.publish(true);
    }
    if progress.value.issues.is_empty() {
        // Sources belong to the unsaved document, not to the evictable thumbnail cache.
        if let Some(directory) = staged {
            if let Err(error) = retain_staging(directory) {
                pages.clear();
                progress.issue(staging_root, None, error);
            }
        }
    } else {
        pages.clear();
        if let Some(directory) = staged {
            if let Err(error) = directory.close() {
                progress.issue(
                    staging_root,
                    None,
                    format!("Could not remove failed insert staging: {error}"),
                );
            }
        }
    }
    progress.value.phase = Phase::Complete;
    progress.publish(true);
    Ok(InsertBatchResult {
        pages,
        issues: progress.value.issues,
    })
}

fn file_name(path: &Path) -> String {
    path.file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .into_owned()
}

fn image_source(original: &Path, source: &Path, (width, height): (u32, u32)) -> InsertPageMetadata {
    InsertPageMetadata {
        source: PageSource::Image {
            file_name: file_name(original),
            file_path: source.to_string_lossy().into_owned(),
            width,
            height,
        },
    }
}

fn prepare_pdf<F: FnMut(&InsertProgress)>(
    path: &Path,
    count: u32,
    pdfium: Result<&Pdfium, &str>,
    pages: &mut Vec<InsertPageMetadata>,
    progress: &mut Progress<F>,
) {
    // Only the current source is parsed in memory; PDFium uses file-backed reads.
    let document = load_insert_pdf(path);
    let page_ids = document
        .as_ref()
        .map(Document::get_pages)
        .unwrap_or_default();
    let rendered = pdfium.map_err(str::to_owned).and_then(|pdfium| {
        let _lock = super::PDFIUM_RENDER_LOCK
            .lock()
            .map_err(|_| "PDF renderer lock was poisoned".to_string())?;
        pdfium
            .load_pdf_from_file(path, None)
            .map_err(|error| error.to_string())
    });
    let mut checked_objects = HashSet::new();
    for number in 1..=count {
        let mut errors = Vec::new();
        let edit_check = checked_operation(|| {
            document.as_ref().map_err(String::clone).and_then(|doc| {
                let id = page_ids
                    .get(&number)
                    .ok_or_else(|| "Page disappeared after scanning".to_string())?;
                validate_pdf_page(doc, *id, &mut checked_objects)
            })
        });
        if let Err(error) = edit_check {
            errors.push(format!("Editing validation: {error}"));
        }
        let render_check = if errors.is_empty() {
            checked_operation(|| {
                rendered.as_ref().map_err(String::clone).and_then(|doc| {
                    let _lock = super::PDFIUM_RENDER_LOCK
                        .lock()
                        .map_err(|_| "PDF renderer lock was poisoned".to_string())?;
                    let index = PdfPageIndex::try_from(number - 1)
                        .map_err(|_| "PDF page index exceeds renderer limit".to_string())?;
                    let page = doc.pages().get(index).map_err(|error| error.to_string())?;
                    if !page.width().value.is_finite()
                        || !page.height().value.is_finite()
                        || page.width().value <= 0.0
                        || page.height().value <= 0.0
                    {
                        return Err("Invalid PDF page dimensions".into());
                    }
                    // Exercise the real rendering path, without rasterizing or replacing the source.
                    page.render_with_config(
                        &PdfRenderConfig::new()
                            .set_target_width(64)
                            .set_maximum_height(64)
                            .render_form_data(false),
                    )
                    .map_err(|error| error.to_string())?;
                    Ok(())
                })
            })
        } else {
            Ok(())
        };
        if let Err(error) = render_check {
            errors.push(format!("Render validation: {error}"));
        }
        if errors.is_empty() {
            pages.push(InsertPageMetadata {
                source: PageSource::Pdf {
                    file_name: file_name(path),
                    file_path: path.to_string_lossy().into_owned(),
                    page_number: number,
                },
            });
        } else {
            progress.issue(path, Some(number), errors.join("; "));
        }
        progress.page_done();
    }
    if page_ids.len() != count as usize
        || rendered
            .as_ref()
            .is_ok_and(|doc| u32::from(doc.pages().len()) != count)
    {
        progress.issue(
            path,
            None,
            "PDF page count changed or differs between editing and rendering engines",
        );
    }
    let _lock = super::PDFIUM_RENDER_LOCK
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    drop(rendered);
}

pub(crate) fn validate_pdf_page(
    document: &Document,
    id: ObjectId,
    checked: &mut HashSet<ObjectId>,
) -> Result<(), String> {
    validate_pdf_page_with_limit(document, id, checked, MAX_PAGE_CONTENT_BYTES)
}

fn validate_pdf_page_with_limit(
    document: &Document,
    id: ObjectId,
    checked: &mut HashSet<ObjectId>,
    limit: usize,
) -> Result<(), String> {
    let page =
        super::standalone_page_dictionary(document, id).map_err(|error| error.to_string())?;
    let root = Object::Dictionary(page);
    let mut stack = vec![&root];
    let mut visited = HashSet::new();
    while let Some(object) = stack.pop() {
        match object {
            Object::Reference(id) if !checked.contains(id) && visited.insert(*id) => {
                stack.push(
                    document
                        .objects
                        .get(id)
                        .ok_or_else(|| format!("Missing referenced object {} {}", id.0, id.1))?,
                );
            }
            Object::Array(values) => stack.extend(values),
            Object::Dictionary(dict) => stack.extend(dict.iter().map(|(_, value)| value)),
            Object::Stream(stream) => stack.extend(stream.dict.iter().map(|(_, value)| value)),
            _ => {}
        }
    }
    let page = root.as_dict().map_err(|error| error.to_string())?;
    if let Ok(contents) = page.get(b"Contents") {
        let mut stack = vec![(contents, None)];
        let mut active = HashSet::new();
        let mut remaining = limit;
        while let Some((content, exit)) = stack.pop() {
            if let Some(id) = exit {
                active.remove(&id);
                continue;
            }
            match content {
                Object::Reference(id) => {
                    if !active.insert(*id) {
                        return Err("Cyclic PDF content reference".into());
                    }
                    stack.push((content, Some(*id)));
                    stack.push((
                        document
                            .objects
                            .get(id)
                            .ok_or("Missing PDF content object")?,
                        None,
                    ));
                }
                Object::Array(values) => {
                    stack.extend(values.iter().rev().map(|value| (value, None)))
                }
                Object::Stream(stream) => {
                    remaining = remaining
                        .checked_sub(checked_content_size(stream, remaining)?)
                        .ok_or("PDF page content exceeds validation memory budget")?;
                }
                Object::Null => {}
                _ => return Err("PDF page Contents is not a stream or stream array".into()),
            }
        }
    }
    checked.extend(visited);
    Ok(())
}

fn checked_content_size(stream: &Stream, limit: usize) -> Result<usize, String> {
    if !stream.dict.has(b"Filter") {
        return if stream.content.len() <= limit {
            Ok(stream.content.len())
        } else {
            Err("PDF page content exceeds validation memory budget".into())
        };
    }
    let filters = stream.filters().map_err(|error| error.to_string())?;
    if filters.as_slice() == [b"FlateDecode".as_slice()] || filters.as_slice() == [b"Fl".as_slice()]
    {
        // lopdf tolerates some invalid Flate streams; use its underlying proven codec strictly.
        let mut decoder =
            flate2::read::ZlibDecoder::new(stream.content.as_slice()).take(limit as u64 + 1);
        let size = std::io::copy(&mut decoder, &mut std::io::sink())
            .map_err(|error| format!("Invalid Flate content: {error}"))?;
        return if size <= limit as u64 {
            Ok(size as usize)
        } else {
            Err("PDF page content exceeds validation memory budget".into())
        };
    }
    // PDFium supports filters that lopdf does not. Do not reject a valid page for that reason.
    match stream.decompressed_content_with_limit(limit) {
        Ok(bytes) => Ok(bytes.len()),
        Err(lopdf::Error::Unimplemented(_)) => Ok(0),
        Err(error) => Err(error.to_string()),
    }
}

fn is_tiff(path: &Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| ext.eq_ignore_ascii_case("tif") || ext.eq_ignore_ascii_case("tiff"))
}

struct TiffIndex {
    offsets: Vec<u64>,
    header: Vec<u8>,
    little_endian: bool,
    big: bool,
    issue: Option<(u32, String)>,
}

fn read_uint(reader: &mut impl Read, size: usize, little: bool) -> Result<u64, String> {
    let mut bytes = [0_u8; 8];
    if little {
        reader
            .read_exact(&mut bytes[..size])
            .map_err(|error| error.to_string())?;
        Ok(u64::from_le_bytes(bytes))
    } else {
        reader
            .read_exact(&mut bytes[8 - size..])
            .map_err(|error| error.to_string())?;
        Ok(u64::from_be_bytes(bytes))
    }
}

fn index_tiff(path: &Path) -> Result<TiffIndex, String> {
    let mut file = BufReader::new(File::open(path).map_err(|error| error.to_string())?);
    let length = file
        .get_ref()
        .metadata()
        .map_err(|error| error.to_string())?
        .len();
    let mut order = [0; 2];
    file.read_exact(&mut order)
        .map_err(|error| error.to_string())?;
    let little = match &order {
        b"II" => true,
        b"MM" => false,
        _ => return Err("Invalid TIFF byte order".into()),
    };
    let big = match read_uint(&mut file, 2, little)? {
        42 => false,
        43 => {
            if read_uint(&mut file, 2, little)? != 8 || read_uint(&mut file, 2, little)? != 0 {
                return Err("Unsupported BigTIFF offset format".into());
            }
            true
        }
        _ => return Err("Invalid TIFF signature".into()),
    };
    let mut offset = read_uint(&mut file, if big { 8 } else { 4 }, little)?;
    let mut header = vec![0; if big { 16 } else { 8 }];
    file.rewind().map_err(|error| error.to_string())?;
    file.read_exact(&mut header)
        .map_err(|error| error.to_string())?;
    let mut index = TiffIndex {
        offsets: Vec::new(),
        header,
        little_endian: little,
        big,
        issue: None,
    };
    let mut seen = HashSet::new();
    // Traverse only IFD framing here: Decoder::new rejects an unsupported first page,
    // preventing discovery of later pages. Pixel/tag interpretation stays in the tiff crate.
    while offset != 0 {
        let result = (|| {
            if !seen.insert(offset) {
                return Err("Cyclic TIFF directory chain".to_string());
            }
            if offset >= length {
                return Err("Truncated TIFF directory; later pages cannot be enumerated".into());
            }
            file.seek(SeekFrom::Start(offset))
                .map_err(|error| error.to_string())?;
            let count_size = if big { 8 } else { 2 };
            let count = read_uint(&mut file, count_size, little)?;
            let next_position = count
                .checked_mul(if big { 20 } else { 12 })
                .and_then(|size| offset.checked_add(count_size as u64)?.checked_add(size))
                .ok_or("TIFF directory size overflow")?;
            let pointer_size = if big { 8 } else { 4 };
            if next_position
                .checked_add(pointer_size)
                .is_none_or(|end| end > length)
            {
                return Err("Truncated TIFF directory; later pages cannot be enumerated".into());
            }
            file.seek(SeekFrom::Start(next_position))
                .map_err(|error| error.to_string())?;
            read_uint(&mut file, pointer_size as usize, little)
        })();
        match result {
            Ok(next) => {
                index.offsets.push(offset);
                offset = next;
            }
            Err(error) => {
                index.issue = Some((index.offsets.len() as u32 + 1, error));
                break;
            }
        }
    }
    if index.offsets.is_empty() && index.issue.is_none() {
        return Err("TIFF contains no pages".into());
    }
    Ok(index)
}

fn tiff_decoder(
    path: &Path,
    index: &TiffIndex,
    offset: u64,
) -> Result<Decoder<BufReader<tiff_view::PageReader>>, String> {
    let reader = tiff_view::PageReader::new(path, index, offset, &[])?;
    Decoder::new(BufReader::new(reader)).map_err(|error| format!("TIFF decoder: {error}"))
}

fn decode_tiff_page(
    path: &Path,
    index: &TiffIndex,
    offset: u64,
) -> Result<(DynamicImage, Option<(f64, f64)>), String> {
    let mut decoder = tiff_decoder(path, index, offset)?;
    let (width, height) = decoder.dimensions().map_err(|error| error.to_string())?;
    if width == 0 || height == 0 {
        return Err("TIFF page has no pixels".into());
    }
    let mut color = decoder.colortype().map_err(|error| error.to_string())?;
    let extra_samples = decoder
        .find_tag_unsigned_vec::<u16>(Tag::ExtraSamples)
        .map_err(|error| error.to_string())?;
    if extra_samples
        .as_ref()
        .is_some_and(|samples| samples.iter().any(|sample| *sample != 2))
    {
        return Err(
            "TIFF associated alpha or unspecified extra samples are not supported losslessly"
                .into(),
        );
    }
    if let tiff::ColorType::Multiband {
        bit_depth,
        num_samples: 2,
    } = color
    {
        if extra_samples.as_deref() == Some(&[2])
            && decoder
                .get_tag_u32(Tag::PhotometricInterpretation)
                .map_err(|error| error.to_string())?
                == 1
        {
            color = tiff::ColorType::GrayA(bit_depth);
        }
    }
    let orientation = decoder
        .find_tag_unsigned::<u16>(Tag::Orientation)
        .map_err(|error| error.to_string())?
        .unwrap_or(1);
    let mut dpi = tiff_dpi(&mut decoder);
    let samples = read_tiff_samples(&mut decoder, width, height)?;
    macro_rules! image {
        ($variant:ident, $data:expr) => {
            DynamicImage::$variant(
                ImageBuffer::from_raw(width, height, $data)
                    .ok_or("TIFF pixel buffer has an invalid length")?,
            )
        };
    }
    let mut image = match (color, samples) {
        (tiff::ColorType::Gray(bits @ (1 | 2 | 4)), DecodingResult::U8(data)) => {
            let stride = (width as usize * bits as usize).div_ceil(8);
            if data.len() != stride * height as usize { return Err("Invalid packed TIFF scanline size".into()); }
            let max = (1_u16 << bits) - 1;
            let mut pixels = Vec::with_capacity(width as usize * height as usize);
            for row in data.chunks_exact(stride) {
                for x in 0..width as usize {
                    let bit = x * bits as usize;
                    let sample = (row[bit / 8] >> (8 - bits as usize - bit % 8)) as u16 & max;
                    pixels.push((sample * 255 / max) as u8);
                }
            }
            image!(ImageLuma8, pixels)
        }
        (tiff::ColorType::Gray(8), DecodingResult::U8(data)) => image!(ImageLuma8, data),
        (tiff::ColorType::Gray(16), DecodingResult::U16(data)) => image!(ImageLuma16, data),
        (tiff::ColorType::GrayA(8), DecodingResult::U8(data)) => image!(ImageLumaA8, data),
        (tiff::ColorType::GrayA(16), DecodingResult::U16(data)) => image!(ImageLumaA16, data),
        (tiff::ColorType::RGB(8), DecodingResult::U8(data)) => image!(ImageRgb8, data),
        (tiff::ColorType::RGB(16), DecodingResult::U16(data)) => image!(ImageRgb16, data),
        (tiff::ColorType::RGBA(8), DecodingResult::U8(data)) => image!(ImageRgba8, data),
        (tiff::ColorType::RGBA(16), DecodingResult::U16(data)) => image!(ImageRgba16, data),
        _ => return Err(format!("Unsupported lossless TIFF color/sample format: {color:?}; supported: unsigned Gray 1/2/4/8/16, GrayA/RGB/RGBA 8/16")),
    };
    let transform = image_025::metadata::Orientation::from_exif(
        u8::try_from(orientation).map_err(|_| "Invalid TIFF orientation")?,
    )
    .ok_or("Invalid TIFF orientation")?;
    image.apply_orientation(transform);
    if (5..=8).contains(&orientation) {
        dpi = dpi.map(|(x, y)| (y, x));
    }
    Ok((image, dpi))
}

fn read_tiff_samples<R: Read + Seek>(
    decoder: &mut Decoder<R>,
    width: u32,
    height: u32,
) -> Result<DecodingResult, String> {
    let mut samples = DecodingResult::U8(Vec::new());
    let layout = decoder
        .read_image_to_buffer(&mut samples)
        .map_err(|error| format!("TIFF pixel decode: {error}"))?;
    if samples.as_buffer(0).byte_len() != layout.complete_len {
        return Err(
            "TIFF page exceeds the decoder memory limit; not all planes were decoded".into(),
        );
    }
    if layout.planes > 1 {
        fn interleave<T: Copy>(
            data: Vec<T>,
            planes: usize,
            pixels: usize,
        ) -> Result<Vec<T>, String> {
            if data.len()
                != planes
                    .checked_mul(pixels)
                    .ok_or("TIFF plane size overflow")?
            {
                return Err("Unsupported padded TIFF plane layout".into());
            }
            let mut output = Vec::with_capacity(data.len());
            for pixel in 0..pixels {
                for plane in 0..planes {
                    output.push(data[plane * pixels + pixel]);
                }
            }
            Ok(output)
        }
        let pixels = (width as usize)
            .checked_mul(height as usize)
            .ok_or("TIFF image size overflow")?;
        samples = match samples {
            DecodingResult::U8(data) => DecodingResult::U8(interleave(data, layout.planes, pixels)?),
            DecodingResult::U16(data) => DecodingResult::U16(interleave(data, layout.planes, pixels)?),
            _ => return Err("Unsupported TIFF planar sample type; only unsigned 8/16-bit samples can be staged losslessly".into()),
        };
    }
    Ok(samples)
}

fn tiff_dpi<R: Read + Seek>(decoder: &mut Decoder<R>) -> Option<(f64, f64)> {
    let unit = decoder.get_tag_u32(Tag::ResolutionUnit).ok().unwrap_or(2);
    let factor = match unit {
        2 => 1.0,
        3 => 2.54,
        _ => return None,
    };
    let rational = |value| match value {
        tiff::decoder::ifd::Value::Rational(numerator, denominator) if denominator != 0 => {
            Some(f64::from(numerator) / f64::from(denominator))
        }
        _ => None,
    };
    let x = rational(decoder.get_tag(Tag::XResolution).ok()?)? * factor;
    let y = rational(decoder.get_tag(Tag::YResolution).ok()?)? * factor;
    (x.is_finite() && y.is_finite() && x > 0.0 && y > 0.0).then_some((x, y))
}

fn image_bytes(image: &DynamicImage) -> Result<(Vec<u8>, png::ColorType, png::BitDepth), String> {
    use image_025::ColorType;
    let (color, depth) = match image.color() {
        ColorType::L8 => (png::ColorType::Grayscale, png::BitDepth::Eight),
        ColorType::La8 => (png::ColorType::GrayscaleAlpha, png::BitDepth::Eight),
        ColorType::Rgb8 => (png::ColorType::Rgb, png::BitDepth::Eight),
        ColorType::Rgba8 => (png::ColorType::Rgba, png::BitDepth::Eight),
        ColorType::L16 => (png::ColorType::Grayscale, png::BitDepth::Sixteen),
        ColorType::La16 => (png::ColorType::GrayscaleAlpha, png::BitDepth::Sixteen),
        ColorType::Rgb16 => (png::ColorType::Rgb, png::BitDepth::Sixteen),
        ColorType::Rgba16 => (png::ColorType::Rgba, png::BitDepth::Sixteen),
        color => return Err(format!("Unsupported lossless image color type: {color:?}")),
    };
    let bytes = if depth == png::BitDepth::Sixteen {
        image
            .as_bytes()
            .chunks_exact(2)
            .flat_map(|sample| u16::from_ne_bytes([sample[0], sample[1]]).to_be_bytes())
            .collect()
    } else {
        image.as_bytes().to_vec()
    };
    Ok((bytes, color, depth))
}

fn write_staged_png(
    path: &Path,
    image: &DynamicImage,
    dpi: Option<(f64, f64)>,
) -> Result<(), String> {
    let (bytes, color, depth) = image_bytes(image)?;
    let file = File::create(path).map_err(|error| error.to_string())?;
    let mut output = BufWriter::new(file);
    {
        let mut encoder = png::Encoder::new(&mut output, image.width(), image.height());
        encoder.set_color(color);
        encoder.set_depth(depth);
        if let Some((x, y)) = dpi {
            let (xppu, yppu) = ((x / 0.0254).round(), (y / 0.0254).round());
            if xppu >= 1.0
                && yppu >= 1.0
                && xppu <= f64::from(u32::MAX)
                && yppu <= f64::from(u32::MAX)
            {
                encoder.set_pixel_dims(Some(png::PixelDimensions {
                    xppu: xppu as u32,
                    yppu: yppu as u32,
                    unit: png::Unit::Meter,
                }));
            } else {
                return Err("TIFF resolution is outside the lossless PNG metadata range".into());
            }
        }
        let mut writer = encoder.write_header().map_err(|error| error.to_string())?;
        writer
            .write_image_data(&bytes)
            .map_err(|error| error.to_string())?;
        writer.finish().map_err(|error| error.to_string())?;
    }
    output.flush().map_err(|error| error.to_string())?;
    output
        .get_ref()
        .sync_all()
        .map_err(|error| error.to_string())
}

pub(super) fn image_page_size(path: &Path, width: u32, height: u32) -> (f64, f64) {
    image_physical_size(path, width, height).unwrap_or(if width >= height {
        (842.0, 595.0)
    } else {
        (595.0, 842.0)
    })
}

pub(super) fn image_physical_size(path: &Path, width: u32, height: u32) -> Option<(f64, f64)> {
    (|| {
        if !path.extension()?.eq_ignore_ascii_case("png") {
            return None;
        }
        let reader = png::Decoder::new(BufReader::new(File::open(path).ok()?))
            .read_info()
            .ok()?;
        let dims = reader.info().pixel_dims?;
        if dims.unit != png::Unit::Meter || dims.xppu == 0 || dims.yppu == 0 {
            return None;
        }
        Some((
            f64::from(width) * 72.0 / (f64::from(dims.xppu) * 0.0254),
            f64::from(height) * 72.0 / (f64::from(dims.yppu) * 0.0254),
        ))
    })()
}

pub(super) fn append_lossless_image(
    document: &mut Document,
    image: &DynamicImage,
) -> Result<ObjectId, AppError> {
    let (bytes, color, depth) = image_bytes(image).map_err(AppError::Preview)?;
    let alpha = matches!(color, png::ColorType::GrayscaleAlpha | png::ColorType::Rgba);
    let gray = matches!(
        color,
        png::ColorType::Grayscale | png::ColorType::GrayscaleAlpha
    );
    let bits = if depth == png::BitDepth::Sixteen {
        16
    } else {
        8
    };
    let channels = if gray { 1 } else { 3 };
    let mut colors = Vec::new();
    let mut mask = Vec::new();
    let bytes = if alpha {
        let color_bytes = channels * bits / 8;
        for pixel in bytes.chunks_exact((channels + 1) * bits / 8) {
            colors.extend_from_slice(&pixel[..color_bytes]);
            mask.extend_from_slice(&pixel[color_bytes..]);
        }
        colors
    } else {
        bytes
    };
    let mut dict = dictionary! {
        "Type" => "XObject", "Subtype" => "Image", "Width" => image.width() as i64,
        "Height" => image.height() as i64, "BitsPerComponent" => bits as i64,
        "ColorSpace" => if gray { "DeviceGray" } else { "DeviceRGB" },
    };
    if alpha {
        let mut stream = Stream::new(
            dictionary! {
                "Type" => "XObject", "Subtype" => "Image", "Width" => image.width() as i64,
                "Height" => image.height() as i64, "BitsPerComponent" => bits as i64, "ColorSpace" => "DeviceGray",
            },
            mask,
        );
        stream.compress()?;
        dict.set("SMask", document.add_object(stream));
    }
    let mut stream = Stream::new(dict, bytes);
    stream.compress()?;
    Ok(document.add_object(stream))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tiff::encoder::{colortype, Rational, TiffEncoder};

    fn temp() -> tempfile::TempDir {
        tempfile::tempdir().unwrap()
    }

    fn png(path: &Path, value: u8) {
        image_025::GrayImage::from_pixel(2, 3, image_025::Luma([value]))
            .save(path)
            .unwrap();
    }

    fn multipage(path: &Path) {
        let mut encoder = TiffEncoder::new(File::create(path).unwrap()).unwrap();
        encoder
            .write_image::<colortype::Gray8>(2, 1, &[0, 255])
            .unwrap();
        encoder
            .write_image::<colortype::RGB8>(1, 1, &[13, 29, 251])
            .unwrap();
    }

    fn batch(
        paths: &[PathBuf],
        root: &Path,
        store: &InsertSourceStore,
    ) -> (InsertBatchResult, Vec<InsertProgress>) {
        let mut events = Vec::new();
        let result = read_insert_pages_impl(
            paths
                .iter()
                .map(|path| path.to_string_lossy().into_owned())
                .collect(),
            "test-run".into(),
            root,
            |event| events.push(event.clone()),
            |_| Ok(()),
            |directory| store.retain(directory),
            Err("No renderer needed for image tests"),
        )
        .unwrap();
        (result, events)
    }

    fn source_path(page: &InsertPageMetadata) -> &str {
        match &page.source {
            PageSource::Image { file_path, .. } | PageSource::Pdf { file_path, .. } => file_path,
        }
    }

    #[test]
    fn insert_collects_failures_in_files_five_and_six_and_rolls_back_everything() {
        let temp = temp();
        let staging = temp.path().join("staging");
        let store = InsertSourceStore::default();
        let mut paths = Vec::new();
        let first = temp.path().join("1.tiff");
        multipage(&first);
        paths.push(first);
        for number in 2..=8 {
            let path = temp.path().join(format!("{number}.png"));
            if number == 5 || number == 6 {
                fs::write(&path, b"invalid image").unwrap();
            } else {
                png(&path, number);
            }
            paths.push(path);
        }
        let (result, events) = batch(&paths, &staging, &store);
        assert!(result.pages.is_empty());
        assert_eq!(
            result
                .issues
                .iter()
                .map(|issue| issue.file_name.as_str())
                .collect::<Vec<_>>(),
            ["5.png", "6.png"]
        );
        assert!(result
            .issues
            .iter()
            .all(|issue| issue.page_number == Some(1)));
        assert_eq!(fs::read_dir(&staging).unwrap().count(), 0);
        let last = events.last().unwrap();
        assert_eq!(last.phase, Phase::Complete);
        assert_eq!(last.completed_files, 8);
        assert_eq!(last.completed_pages, 9);
        assert_eq!(last.total_pages, Some(9));
        assert_eq!(last.issues.len(), 2);
    }

    #[test]
    fn insert_orders_mixed_images_and_tiff_pages_and_keeps_sources_until_session_drop() {
        let temp = temp();
        let staging = temp.path().join("insert-sources");
        let before = temp.path().join("before.png");
        let tiff = temp.path().join("scan.TIFF");
        let after = temp.path().join("after.png");
        png(&before, 7);
        multipage(&tiff);
        png(&after, 9);
        let original = fs::read(&tiff).unwrap();
        let store = InsertSourceStore::default();
        let (result, _) = batch(
            &[before.clone(), tiff.clone(), after.clone()],
            &staging,
            &store,
        );
        assert!(result.issues.is_empty(), "{:?}", result.issues);
        assert_eq!(result.pages.len(), 4);
        assert_eq!(Path::new(source_path(&result.pages[0])), before);
        assert_eq!(Path::new(source_path(&result.pages[3])), after);
        let page1 = PathBuf::from(source_path(&result.pages[1]));
        let page2 = PathBuf::from(source_path(&result.pages[2]));
        assert!(page1.starts_with(&staging));
        assert_eq!(
            image_025::open(&page1).unwrap().to_luma8().into_raw(),
            [0, 255]
        );
        assert_eq!(
            image_025::open(&page2).unwrap().to_rgb8().into_raw(),
            [13, 29, 251]
        );
        assert_eq!(fs::read(tiff).unwrap(), original);
        let cache = temp.path().join("thumbnail-cache");
        fs::create_dir(&cache).unwrap();
        fs::remove_dir_all(cache).unwrap();
        assert!(page1.exists() && page2.exists());
        drop(store);
        assert!(!page1.exists() && !page2.exists());
    }

    fn change_long_tag(path: &Path, page: usize, tag: u16, value: u32) {
        let index = index_tiff(path).unwrap();
        let mut bytes = fs::read(path).unwrap();
        let start = index.offsets[page] as usize;
        let count = u16::from_le_bytes(bytes[start..start + 2].try_into().unwrap()) as usize;
        for position in (start + 2..start + 2 + count * 12).step_by(12) {
            if u16::from_le_bytes(bytes[position..position + 2].try_into().unwrap()) == tag {
                bytes[position + 8..position + 12].copy_from_slice(&value.to_le_bytes());
                fs::write(path, bytes).unwrap();
                return;
            }
        }
        panic!("tag not found");
    }

    #[test]
    fn insert_checks_pages_after_unsupported_and_truncated_tiff_pages() {
        let temp = temp();
        let path = temp.path().join("damaged.tif");
        {
            let mut encoder = TiffEncoder::new(File::create(&path).unwrap()).unwrap();
            encoder
                .write_image::<colortype::Gray32Float>(1, 1, &[0.5])
                .unwrap();
            encoder
                .write_image::<colortype::Gray8>(1, 1, &[100])
                .unwrap();
            encoder
                .write_image::<colortype::Gray8>(1, 1, &[200])
                .unwrap();
        }
        change_long_tag(&path, 1, 273, u32::MAX);
        let staging = temp.path().join("staging");
        let (result, events) = batch(&[path], &staging, &InsertSourceStore::default());
        assert!(result.pages.is_empty());
        assert_eq!(
            result
                .issues
                .iter()
                .map(|issue| issue.page_number)
                .collect::<Vec<_>>(),
            [Some(1), Some(2)]
        );
        assert!(result.issues[0]
            .message
            .contains("Unsupported lossless TIFF"));
        assert_eq!(events.last().unwrap().completed_pages, 3);
        assert_eq!(fs::read_dir(staging).unwrap().count(), 0);
    }

    #[test]
    fn insert_reports_truncated_directory_and_still_checks_following_files() {
        let temp = temp();
        let broken = temp.path().join("truncated.tif");
        fs::write(&broken, [b'I', b'I', 42, 0, 250, 0, 0, 0]).unwrap();
        let valid = temp.path().join("valid.png");
        png(&valid, 1);
        let (result, events) = batch(
            &[broken, valid],
            &temp.path().join("stage"),
            &InsertSourceStore::default(),
        );
        assert!(result.pages.is_empty());
        assert_eq!(result.issues.len(), 1);
        assert_eq!(result.issues[0].page_number, Some(1));
        assert!(result.issues[0].message.contains("cannot be enumerated"));
        assert_eq!(events.last().unwrap().completed_files, 2);
        assert_eq!(events.last().unwrap().completed_pages, 1);
        assert_eq!(events.last().unwrap().total_pages, None);
    }

    #[test]
    fn insert_preserves_16_bit_samples_dpi_and_pdf_image_data() {
        let temp = temp();
        let path = temp.path().join("16bit.tif");
        let samples = [1_u16, 257, 32769, 65534, 12345, 54321];
        {
            let mut encoder = TiffEncoder::new(File::create(&path).unwrap()).unwrap();
            let mut image = encoder.new_image::<colortype::RGB16>(2, 1).unwrap();
            image.resolution_unit(tiff::tags::ResolutionUnit::Inch);
            image.x_resolution(Rational { n: 300, d: 1 });
            image.y_resolution(Rational { n: 150, d: 1 });
            image.write_data(&samples).unwrap();
        }
        let store = InsertSourceStore::default();
        let (result, _) = batch(&[path], &temp.path().join("stage"), &store);
        assert!(result.issues.is_empty(), "{:?}", result.issues);
        let staged = Path::new(source_path(&result.pages[0]));
        let image = image_025::open(staged).unwrap();
        assert_eq!(image.color(), image_025::ColorType::Rgb16);
        assert_eq!(image.to_rgb16().into_raw(), samples);
        let size = image_page_size(staged, 2, 1);
        assert!((size.0 - 0.48).abs() < 0.0001);
        assert!((size.1 - 0.48).abs() < 0.0001);
        let mut doc = Document::with_version("1.7");
        let id = append_lossless_image(&mut doc, &image).unwrap();
        let stream = doc.get_object(id).unwrap().as_stream().unwrap();
        assert_eq!(
            stream
                .dict
                .get(b"BitsPerComponent")
                .unwrap()
                .as_i64()
                .unwrap(),
            16
        );
        let bytes = if stream.dict.has(b"Filter") {
            stream.decompressed_content().unwrap()
        } else {
            stream.content.clone()
        };
        assert_eq!(
            bytes,
            samples
                .into_iter()
                .flat_map(u16::to_be_bytes)
                .collect::<Vec<_>>()
        );
        let pages_id = doc.new_object_id();
        let mut refs = Vec::new();
        super::super::append_image_page(&mut doc, pages_id, &mut refs, staged, 0, &[]).unwrap();
        let page = doc.get_dictionary(refs[0].as_reference().unwrap()).unwrap();
        let content = doc.get_page_content(refs[0].as_reference().unwrap());
        assert!(String::from_utf8(content)
            .unwrap()
            .contains("0.48 0 0 0.48 0 0 cm"));
        assert!(page.has(b"MediaBox"));
    }

    #[test]
    fn insert_output_version_legacy_pdf_and_16_bit_tiff_save_and_split() {
        use super::super::{EditPagePlan, PagePaintEdit, PageRange};

        fn samples(path: &Path) -> Vec<Vec<u8>> {
            let document = Document::load(path).unwrap();
            let mut samples: Vec<_> = document
                .objects
                .values()
                .filter_map(|object| object.as_stream().ok())
                .filter(|stream| {
                    stream.dict.get(b"Subtype").and_then(Object::as_name).ok() == Some(b"Image")
                        && stream
                            .dict
                            .get(b"BitsPerComponent")
                            .and_then(Object::as_i64)
                            .ok()
                            == Some(16)
                })
                .map(|stream| stream.get_plain_content().unwrap())
                .collect();
            samples.sort();
            if !samples.is_empty() {
                assert_eq!(document.version, "1.5");
            }
            samples
        }

        let temp = temp();
        let store = InsertSourceStore::default();
        let old_image = temp.path().join("old.png");
        png(&old_image, 140);
        let (old_pages, _) = batch(&[old_image], &temp.path().join("stage"), &store);
        let old_pdf = temp.path().join("legacy.pdf");
        export_inserted_pages(old_pages.pages, &old_pdf);
        let mut old_document = Document::load(&old_pdf).unwrap();
        old_document.version = "1.2".into();
        old_document.reference_table.cross_reference_type =
            lopdf::xref::XrefType::CrossReferenceTable;
        old_document.save(&old_pdf).unwrap();

        let rgb_path = temp.path().join("rgb16.tif");
        TiffEncoder::new(File::create(&rgb_path).unwrap())
            .unwrap()
            .write_image::<colortype::RGB16>(
                2,
                2,
                &[1, 2000, 50000, 65000, 9, 100, 4000, 32000, 9000, 12, 24, 48],
            )
            .unwrap();
        let fixtures = Path::new(env!("CARGO_MANIFEST_DIR")).join("../scripts/fixtures/tiff");
        let artifacts = std::env::var_os("PDF_VERSION_TEST_OUTPUT_DIR").map(PathBuf::from);
        if let Some(root) = &artifacts {
            fs::create_dir_all(root).unwrap();
        }
        for (label, path) in [
            ("rgb16", rgb_path),
            ("palette16", fixtures.join("palette-16-le.tif")),
            ("cmyk16", fixtures.join("cmyk-16-le.tif")),
        ] {
            let original_tiff = fs::read(&path).unwrap();
            let (mut inserted, _) = batch(&[path.clone()], &temp.path().join("stage"), &store);
            assert!(inserted.issues.is_empty(), "{:?}", inserted.issues);
            let page = inserted.pages.remove(0);
            let source = page.source.clone();
            let reference = temp.path().join("reference.pdf");
            export_inserted_pages(vec![page], &reference);
            let expected = samples(&reference);
            assert!(!expected.is_empty());
            let target = temp.path().join(format!("{label}.pdf"));
            fs::copy(&old_pdf, &target).unwrap();
            let plans = vec![
                EditPagePlan {
                    source: PageSource::Pdf {
                        file_name: format!("{label}.pdf"),
                        file_path: target.to_string_lossy().into_owned(),
                        page_number: 1,
                    },
                    rotation: 0,
                    paint_edits: Vec::new(),
                },
                EditPagePlan {
                    source,
                    rotation: 90,
                    paint_edits: vec![
                        PagePaintEdit::Cover {
                            color: "#ff00ff".into(),
                            x: 0.2,
                            y: 0.25,
                            width: 0.3,
                            height: 0.35,
                        },
                        PagePaintEdit::Crop {
                            x: 0.1,
                            y: 0.1,
                            width: 0.8,
                            height: 0.8,
                        },
                    ],
                },
            ];
            let direct = super::super::split_pdf_with_edits_impl(
                target.to_string_lossy().into_owned(),
                plans.clone(),
                vec![2],
                "version-test".into(),
                None,
                |_| {},
            )
            .unwrap();
            super::super::save_pdf_edits_impl(target.to_string_lossy().into_owned(), plans)
                .unwrap();
            assert_eq!(Document::load(&target).unwrap().get_pages().len(), 2);
            assert_eq!(Document::load(&target).unwrap().version, "1.5");
            assert_eq!(samples(&target), expected);
            if let Some(root) = &artifacts {
                fs::copy(&target, root.join(format!("{label}-saved.pdf"))).unwrap();
            }
            let normal = super::super::split_pdf_impl(
                target.to_string_lossy().into_owned(),
                vec![2],
                "version-test".into(),
                None,
                |_| {},
            )
            .unwrap();
            for (kind, result) in [("direct", direct), ("normal", normal)] {
                assert_eq!(result.files.len(), 2);
                for (index, file) in result.files.iter().enumerate() {
                    let output = Path::new(&file.file_path);
                    assert_eq!(Document::load(output).unwrap().get_pages().len(), 1);
                    assert_eq!(Document::load(output).unwrap().version,
                        if kind == "direct" && index == 0 { "1.2" } else { "1.5" });
                    assert_eq!(
                        samples(output),
                        if index == 1 { expected.clone() } else { vec![] }
                    );
                    if let Some(root) = &artifacts {
                        fs::copy(output, root.join(format!("{label}-{kind}-{index}.pdf"))).unwrap();
                    }
                }
            }
            let fallback = temp.path().join("fallback.pdf");
            super::super::write_page_range_by_deletion(
                &Document::load(&target).unwrap(),
                &target,
                &fallback,
                2,
                PageRange { start: 2, end: 2 },
            )
            .unwrap();
            assert_eq!(samples(&fallback), expected);
            if let Some(root) = &artifacts {
                fs::copy(&fallback, root.join(format!("{label}-fallback.pdf"))).unwrap();
            }
            assert_eq!(fs::read(&path).unwrap(), original_tiff);
        }
    }


    #[test]
    fn insert_output_version_preserves_pdf14_unless_inserted_data_requires_more() {
        use super::super::{EditPagePlan, PagePaintEdit, PageRange};
        let temp = temp();
        let store = InsertSourceStore::default();
        let base = temp.path().join("base.pdf");
        let real_source = std::env::var_os("PDF_VERSION_REAL_INPUT").map(PathBuf::from);
        let original_bytes = real_source.as_ref().map(|path| fs::read(path).unwrap());
        if let Some(bytes) = &original_bytes {
            fs::write(&base, bytes).unwrap();
        } else {
            let image = temp.path().join("base.png");
            png(&image, 140);
            let (pages, _) = batch(&[image], &temp.path().join("stage"), &store);
            export_inserted_pages(pages.pages, &base);
            let mut document = Document::load(&base).unwrap();
            document.version = "1.4".into();
            document.reference_table.cross_reference_type = lopdf::xref::XrefType::CrossReferenceTable;
            document.save(&base).unwrap();
        }
        let base_document = Document::load(&base).unwrap();
        assert_eq!(super::super::output_pdf_version([&base_document]).unwrap(), "1.4");
        let source_images: Vec<_> = base_document.objects.values().filter_map(|obj| obj.as_stream().ok())
            .filter(|stream| stream.dict.get(b"Subtype").and_then(Object::as_name).ok() == Some(b"Image"))
            .map(|stream| stream.content.clone()).collect();
        let artifacts = std::env::var_os("PDF_VERSION_TEST_OUTPUT_DIR").map(PathBuf::from);
        if let Some(root) = &artifacts { fs::create_dir_all(root).unwrap(); }
        let original_split = temp.path().join("original-split.pdf");
        super::super::write_page_range(&base_document, &original_split, PageRange { start: 1, end: 1 }).unwrap();
        assert_eq!(Document::load(&original_split).unwrap().version, "1.4");
        if let Some(root) = &artifacts { fs::copy(&original_split, root.join("pdf14-original-split.pdf")).unwrap(); }

        let rgb8 = temp.path().join("rgb8.tif");
        TiffEncoder::new(File::create(&rgb8).unwrap()).unwrap()
            .write_image::<colortype::RGB8>(2, 1, &[0, 128, 255, 17, 93, 40]).unwrap();
        let gray8 = temp.path().join("gray8.tif");
        TiffEncoder::new(File::create(&gray8).unwrap()).unwrap()
            .write_image::<colortype::Gray8>(2, 1, &[0, 255]).unwrap();
        let rgba8 = temp.path().join("rgba8.tif");
        TiffEncoder::new(File::create(&rgba8).unwrap()).unwrap()
            .write_image::<colortype::RGBA8>(2, 1, &[0, 128, 255, 150, 17, 93, 40, 255]).unwrap();
        let rgb16 = temp.path().join("rgb16.tif");
        TiffEncoder::new(File::create(&rgb16).unwrap()).unwrap()
            .write_image::<colortype::RGB16>(2, 1, &[1, 12800, 65535, 17, 9300, 40000]).unwrap();
        let fixtures = Path::new(env!("CARGO_MANIFEST_DIR")).join("../scripts/fixtures/tiff");
        for (label, input, expected) in [
            ("rgb8", rgb8, "1.4"),
            ("gray8", gray8, "1.4"),
            ("rgba8", rgba8, "1.4"),
            ("rgb16", rgb16, "1.5"),
            ("cmyk8", fixtures.join("cmyk-8-le.tif"), "1.4"),
            ("jpeg8", fixtures.join("missing-count.tif"), "1.4"),
            ("icc4", fixtures.join("icc-RGB.tif"), "1.7"),
        ] {
            let (mut inserted, _) = batch(&[input], &temp.path().join("stage"), &store);
            assert!(inserted.issues.is_empty(), "{:?}", inserted.issues);
            let target = temp.path().join(format!("{label}.pdf"));
            fs::copy(&base, &target).unwrap();
            let plans = vec![
                EditPagePlan {
                    source: PageSource::Pdf {
                        file_name: format!("{label}.pdf"), file_path: target.to_string_lossy().into_owned(), page_number: 1,
                    },
                    rotation: 90,
                    paint_edits: vec![
                        PagePaintEdit::Cover { color: "#ff00ff".into(), x: 0.2, y: 0.3, width: 0.1, height: 0.1 },
                        PagePaintEdit::Crop { x: 0.1, y: 0.1, width: 0.8, height: 0.8 },
                        PagePaintEdit::Text { bold: false, italic: false, underline: false,
                            color: "#000000".into(), font_family: "Arial".into(), font_size: 12.0,
                            text_align: "left".into(), text: "Version test".into(),
                            x: 0.1, y: 0.2, width: 0.4, height: 0.1 },
                    ],
                },
                EditPagePlan { source: inserted.pages.remove(0).source, rotation: 0, paint_edits: vec![] },
            ];
            let direct = super::super::split_pdf_with_edits_impl(
                target.to_string_lossy().into_owned(), plans.clone(), vec![2], "preserve".into(), None, |_| {},
            ).unwrap();
            // An inserted high-version page must not raise the original page's separate output.
            assert_eq!(Document::load(&direct.files[0].file_path).unwrap().version, "1.4");
            super::super::save_pdf_edits_impl(target.to_string_lossy().into_owned(), plans).unwrap();
            let saved = Document::load(&target).unwrap();
            assert_eq!(saved.version, expected, "{label}");
            assert_eq!(saved.get_pages().len(), 2);
            for bytes in &source_images {
                assert!(saved.objects.values().filter_map(|obj| obj.as_stream().ok()).any(|stream| &stream.content == bytes));
            }
            let normal = super::super::split_pdf_impl(
                target.to_string_lossy().into_owned(), vec![2], "preserve".into(), None, |_| {},
            ).unwrap();
            let fallback = temp.path().join("fallback.pdf");
            super::super::write_page_range_by_deletion(&saved, &target, &fallback, 2, PageRange { start: 1, end: 1 }).unwrap();
            assert_eq!(Document::load(&fallback).unwrap().version, expected);
            for file in &normal.files { assert_eq!(Document::load(&file.file_path).unwrap().version, expected); }
            if let Some(root) = &artifacts {
                fs::copy(&target, root.join(format!("pdf14-{label}-saved.pdf"))).unwrap();
                fs::copy(&fallback, root.join(format!("pdf14-{label}-fallback.pdf"))).unwrap();
                for (kind, result) in [("direct", direct), ("normal", normal)] {
                    for (index, file) in result.files.iter().enumerate() {
                        fs::copy(&file.file_path, root.join(format!("pdf14-{label}-{kind}-{index}.pdf"))).unwrap();
                    }
                }
            }
        }
        if let Some(path) = real_source { assert_eq!(fs::read(path).unwrap(), original_bytes.unwrap()); }
    }
    #[test]
    fn insert_keeps_16_bit_alpha_in_pdf_soft_mask() {
        let image = DynamicImage::ImageRgba16(
            ImageBuffer::from_raw(1, 1, vec![1, 257, 65534, 32769]).unwrap(),
        );
        let mut doc = Document::with_version("1.7");
        let id = append_lossless_image(&mut doc, &image).unwrap();
        let stream = doc.get_object(id).unwrap().as_stream().unwrap();
        let mask = stream.dict.get(b"SMask").unwrap().as_reference().unwrap();
        let mask = doc.get_object(mask).unwrap().as_stream().unwrap();
        assert_eq!(
            mask.dict
                .get(b"BitsPerComponent")
                .unwrap()
                .as_i64()
                .unwrap(),
            16
        );
        assert_eq!(mask.content, 32769_u16.to_be_bytes());
    }

    fn fax_tiff(path: &Path, compression: u16, data: &[u8]) {
        let mut encoder = TiffEncoder::new(File::create(path).unwrap()).unwrap();
        for _ in 0..2 {
            let mut directory = encoder.image_directory().unwrap();
            let offset = directory.write_data(data).unwrap();
            directory.write_tag(Tag::ImageWidth, 8_u32).unwrap();
            directory.write_tag(Tag::ImageLength, 1_u32).unwrap();
            directory.write_tag(Tag::BitsPerSample, 1_u16).unwrap();
            directory.write_tag(Tag::Compression, compression).unwrap();
            directory
                .write_tag(Tag::PhotometricInterpretation, 0_u16)
                .unwrap();
            directory.write_tag(Tag::SamplesPerPixel, 1_u16).unwrap();
            directory.write_tag(Tag::RowsPerStrip, 1_u32).unwrap();
            directory
                .write_tag(Tag::StripOffsets, offset as u32)
                .unwrap();
            directory
                .write_tag(Tag::StripByteCounts, data.len() as u32)
                .unwrap();
            directory.finish().unwrap();
        }
    }

    #[test]
    fn insert_decodes_ccitt_group3_and_group4_per_page() {
        let temp = temp();
        let store = InsertSourceStore::default();
        for (compression, encoded) in [
            (3, vec![0x00, 0x19, 0x80]),
            (4, vec![0x80, 0x08, 0x00, 0x80]),
        ] {
            let path = temp.path().join(format!("fax{compression}.tif"));
            fax_tiff(&path, compression, &encoded);
            let (result, _) = batch(&[path], &temp.path().join("stage"), &store);
            if compression == 3 && !cfg!(windows) {
                assert!(result.pages.is_empty());
                assert_eq!(result.issues.len(), 2);
                assert!(result
                    .issues
                    .iter()
                    .all(|issue| issue.message.contains("Windows imaging codec")));
                continue;
            }
            assert!(result.issues.is_empty(), "{:?}", result.issues);
            assert_eq!(result.pages.len(), 2);
            for page in result.pages {
                if compression == 3 {
                    let document = lopdf::Document::load(source_path(&page)).unwrap();
                    let images: Vec<_> = document
                        .objects
                        .values()
                        .filter_map(|object| {
                            object.as_stream().ok().filter(|stream| {
                                stream.dict.get(b"Subtype").and_then(Object::as_name).ok()
                                    == Some(b"Image")
                            })
                        })
                        .collect();
                    assert_eq!(images.len(), 1);
                    assert_eq!(images[0].get_plain_content().unwrap(), [255; 8]);
                    continue;
                }
                assert_eq!(
                    image_025::open(source_path(&page))
                        .unwrap()
                        .to_luma8()
                        .into_raw(),
                    [255; 8]
                );
            }
        }
    }

    #[test]
    fn insert_asset_grant_failure_rolls_back_and_continues() {
        let temp = temp();
        let path = temp.path().join("two.tiff");
        multipage(&path);
        let staging = temp.path().join("stage");
        let mut checked = 0;
        let result = read_insert_pages_impl(
            vec![path.to_string_lossy().into_owned()],
            "denied".into(),
            &staging,
            |_| {},
            |_| {
                checked += 1;
                Err("Asset scope denied".into())
            },
            |_| Ok(()),
            Err("unused"),
        )
        .unwrap();
        assert_eq!(checked, 2);
        assert_eq!(result.issues.len(), 2);
        assert!(result.pages.is_empty());
        assert_eq!(fs::read_dir(staging).unwrap().count(), 0);
    }

    #[test]
    fn insert_contains_image_and_tiff_page_panics_and_continues() {
        let temp = temp();
        let image = temp.path().join("image.png");
        let tiff = temp.path().join("two.tif");
        png(&image, 42);
        multipage(&tiff);
        let staging = temp.path().join("stage");
        let mut checked = 0;
        let mut completed = 0;
        let result = read_insert_pages_impl(
            vec![
                image.to_string_lossy().into_owned(),
                tiff.to_string_lossy().into_owned(),
            ],
            "panics".into(),
            &staging,
            |event| completed = event.completed_pages,
            |_| {
                checked += 1;
                if checked <= 2 {
                    panic!("simulated image page preparation panic");
                }
                Ok(())
            },
            |_| Ok(()),
            Err("unused"),
        )
        .unwrap();
        assert!(result.pages.is_empty());
        assert_eq!(result.issues.len(), 2);
        assert!(result
            .issues
            .iter()
            .all(|issue| issue.message.contains("panicked")));
        assert_eq!(completed, 3);
        assert_eq!(checked, 3);
        assert_eq!(fs::read_dir(staging).unwrap().count(), 0);
    }

    #[test]
    fn insert_progress_is_camel_case_and_page_events_are_throttled() {
        let mut events = Vec::new();
        let mut progress = Progress {
            value: InsertProgress {
                run_id: "run".into(),
                phase: Phase::Preparing,
                completed_files: 1,
                total_files: 2,
                current_file_name: "file.pdf".into(),
                completed_pages: 0,
                total_pages: Some(1000),
                issues: Vec::new(),
            },
            emit: |event: &InsertProgress| events.push(event.clone()),
            last_emit: None,
        };
        progress.publish(true);
        for _ in 0..1000 {
            progress.page_done();
        }
        progress.value.phase = Phase::Complete;
        progress.publish(true);
        assert!(
            events.len() <= 3,
            "too many progress events: {}",
            events.len()
        );
        let json = serde_json::to_value(events.last().unwrap()).unwrap();
        assert_eq!(json["completedPages"], 1000);
        assert_eq!(json["runId"], "run");
        assert_eq!(json["phase"], "complete");
        assert!(json.get("completed_pages").is_none());
    }

    fn pdf_with_contents(contents: Object) -> (Document, ObjectId) {
        let mut document = Document::with_version("1.7");
        let id = document.add_object(dictionary! { "Type" => "Page", "MediaBox" => vec![0.into(), 0.into(), 100.into(), 100.into()], "Contents" => contents });
        (document, id)
    }

    #[test]
    fn insert_pdf_validation_accepts_repeated_stream_references_but_rejects_cycles() {
        let stream_id = (42, 0);
        let (mut document, page) =
            pdf_with_contents(Object::Array(vec![stream_id.into(), stream_id.into()]));
        document.objects.insert(
            stream_id,
            Object::Stream(Stream::new(dictionary! {}, b"q Q".to_vec())),
        );
        assert!(validate_pdf_page(&document, page, &mut HashSet::new()).is_ok());
        document
            .objects
            .insert(stream_id, Object::Array(vec![stream_id.into()]));
        assert!(validate_pdf_page(&document, page, &mut HashSet::new())
            .unwrap_err()
            .contains("Cyclic"));
    }

    #[test]
    fn insert_pdf_validation_finds_dangling_references_and_broken_content_streams() {
        let stream_id = (42, 0);
        let (mut document, page) = pdf_with_contents(stream_id.into());
        assert!(validate_pdf_page(&document, page, &mut HashSet::new())
            .unwrap_err()
            .contains("Missing"));
        document.objects.insert(
            stream_id,
            Object::Stream(Stream::new(
                dictionary! { "Filter" => "FlateDecode" },
                b"not zlib".to_vec(),
            )),
        );
        assert!(validate_pdf_page(&document, page, &mut HashSet::new()).is_err());
    }

    #[test]
    fn insert_pdf_validation_does_not_use_panicking_inline_image_parser() {
        let stream = Stream::new(dictionary! {}, b"BI /W 1 /H 1 /BPC 8 ID x EI".to_vec());
        let (document, page) = pdf_with_contents(Object::Stream(stream));
        assert!(
            checked_operation(|| validate_pdf_page(&document, page, &mut HashSet::new())).is_ok()
        );
        let result: Result<(), String> = checked_operation(|| panic!("simulated decoder panic"));
        assert!(result.unwrap_err().contains("Decoder panicked"));
    }

    #[test]
    fn insert_pdf_validation_allows_renderer_supported_filters() {
        for (filter, bytes) in [
            ("ASCIIHexDecode", b"712051>".to_vec()),
            ("RunLengthDecode", vec![2, b'q', b' ', b'Q', 128]),
        ] {
            let stream = Stream::new(dictionary! { "Filter" => filter }, bytes);
            let (document, page) = pdf_with_contents(Object::Stream(stream));
            assert!(
                validate_pdf_page(&document, page, &mut HashSet::new()).is_ok(),
                "{filter}"
            );
        }
    }

    #[test]
    fn insert_pdf_validation_limits_decompressed_and_cumulative_page_content() {
        let mut encoder =
            flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::default());
        encoder.write_all(&[b' '; 1024]).unwrap();
        let compressed = encoder.finish().unwrap();
        let stream = Object::Stream(Stream::new(
            dictionary! { "Filter" => "FlateDecode" },
            compressed,
        ));
        let (document, page) = pdf_with_contents(stream.clone());
        assert!(
            validate_pdf_page_with_limit(&document, page, &mut HashSet::new(), 100)
                .unwrap_err()
                .contains("budget")
        );
        let (document, page) = pdf_with_contents(Object::Array(vec![stream.clone(), stream]));
        assert!(
            validate_pdf_page_with_limit(&document, page, &mut HashSet::new(), 1500)
                .unwrap_err()
                .contains("budget")
        );
    }

    #[test]
    fn insert_decodes_planar_rgb_without_dropping_planes() {
        let temp = temp();
        let path = temp.path().join("planar.tif");
        {
            let mut encoder = TiffEncoder::new(File::create(&path).unwrap()).unwrap();
            let mut dir = encoder.image_directory().unwrap();
            let mut offsets = Vec::new();
            for values in [[1_u8, 2], [3, 4], [5, 6]] {
                offsets.push(dir.write_data(&values[..]).unwrap() as u32);
            }
            dir.write_tag(Tag::ImageWidth, 2_u32).unwrap();
            dir.write_tag(Tag::ImageLength, 1_u32).unwrap();
            dir.write_tag(Tag::BitsPerSample, &[8_u16, 8, 8][..])
                .unwrap();
            dir.write_tag(Tag::Compression, 1_u16).unwrap();
            dir.write_tag(Tag::PhotometricInterpretation, 2_u16)
                .unwrap();
            dir.write_tag(Tag::SamplesPerPixel, 3_u16).unwrap();
            dir.write_tag(Tag::PlanarConfiguration, 2_u16).unwrap();
            dir.write_tag(Tag::RowsPerStrip, 1_u32).unwrap();
            dir.write_tag(Tag::StripOffsets, offsets.as_slice())
                .unwrap();
            dir.write_tag(Tag::StripByteCounts, &[2_u32, 2, 2][..])
                .unwrap();
            dir.finish().unwrap();
        }
        let store = InsertSourceStore::default();
        let (result, _) = batch(&[path], &temp.path().join("stage"), &store);
        assert!(result.issues.is_empty(), "{:?}", result.issues);
        assert_eq!(
            image_025::open(source_path(&result.pages[0]))
                .unwrap()
                .to_rgb8()
                .into_raw(),
            [1, 3, 5, 2, 4, 6]
        );
    }

    #[test]
    fn insert_decodes_gray_alpha_16_from_validated_multiband_tags() {
        let temp = temp();
        let path = temp.path().join("gray-alpha.tif");
        let values = [257_u16, 32769, 65534, 1000];
        {
            let mut encoder = TiffEncoder::new(File::create(&path).unwrap()).unwrap();
            let mut dir = encoder.image_directory().unwrap();
            let offset = dir.write_data(&values[..]).unwrap() as u32;
            dir.write_tag(Tag::ImageWidth, 2_u32).unwrap();
            dir.write_tag(Tag::ImageLength, 1_u32).unwrap();
            dir.write_tag(Tag::BitsPerSample, &[16_u16, 16][..])
                .unwrap();
            dir.write_tag(Tag::Compression, 1_u16).unwrap();
            dir.write_tag(Tag::PhotometricInterpretation, 1_u16)
                .unwrap();
            dir.write_tag(Tag::SamplesPerPixel, 2_u16).unwrap();
            dir.write_tag(Tag::ExtraSamples, &[2_u16][..]).unwrap();
            dir.write_tag(Tag::RowsPerStrip, 1_u32).unwrap();
            dir.write_tag(Tag::StripOffsets, offset).unwrap();
            dir.write_tag(Tag::StripByteCounts, 8_u32).unwrap();
            dir.finish().unwrap();
        }
        let store = InsertSourceStore::default();
        let (result, _) = batch(&[path], &temp.path().join("stage"), &store);
        assert!(result.issues.is_empty(), "{:?}", result.issues);
        let image = image_025::open(source_path(&result.pages[0])).unwrap();
        assert_eq!(image.color(), image_025::ColorType::La16);
        assert_eq!(image.to_luma_alpha16().into_raw(), values);
    }

    #[test]
    fn insert_empty_batch_completes_with_zero_totals() {
        let temp = temp();
        let (result, events) = batch(&[], temp.path(), &InsertSourceStore::default());
        assert!(result.pages.is_empty() && result.issues.is_empty());
        assert_eq!(events.last().unwrap().total_pages, Some(0));
        assert_eq!(events.last().unwrap().completed_files, 0);
    }

    fn jpeg_tiff(path: &Path, orientation: u16, strip_count: u32, tiled: bool) -> Vec<Vec<u8>> {
        let mut encoder = TiffEncoder::new(File::create(path).unwrap()).unwrap();
        let mut dir = encoder.image_directory().unwrap();
        let mut offsets = Vec::new();
        let mut sizes = Vec::new();
        let mut streams = Vec::new();
        for strip in 0..strip_count {
            let image = image_025::RgbImage::from_fn(16, 16, |x, y| {
                image_025::Rgb([(x * 15) as u8, (y * 15) as u8, (strip * 120) as u8])
            });
            let mut jpeg = Vec::new();
            image_025::codecs::jpeg::JpegEncoder::new_with_quality(&mut jpeg, 90)
                .encode_image(&image)
                .unwrap();
            offsets.push(dir.write_data(jpeg.as_slice()).unwrap() as u32);
            sizes.push(jpeg.len() as u32);
            streams.push(jpeg);
        }
        dir.write_tag(Tag::ImageWidth, if tiled { 21_u32 } else { 16 })
            .unwrap();
        dir.write_tag(Tag::ImageLength, if tiled { 27 } else { 16 * strip_count })
            .unwrap();
        dir.write_tag(Tag::BitsPerSample, &[8_u16, 8, 8][..])
            .unwrap();
        dir.write_tag(Tag::Compression, 7_u16).unwrap();
        dir.write_tag(Tag::PhotometricInterpretation, 6_u16)
            .unwrap();
        dir.write_tag(Tag::SamplesPerPixel, 3_u16).unwrap();
        dir.write_tag(Tag::PlanarConfiguration, 1_u16).unwrap();
        dir.write_tag(Tag::Orientation, orientation).unwrap();
        if tiled {
            dir.write_tag(Tag::TileWidth, 16_u32).unwrap();
            dir.write_tag(Tag::TileLength, 16_u32).unwrap();
        } else {
            dir.write_tag(Tag::RowsPerStrip, 16_u32).unwrap();
        }
        dir.write_tag(
            if tiled {
                Tag::TileOffsets
            } else {
                Tag::StripOffsets
            },
            offsets.as_slice(),
        )
        .unwrap();
        dir.write_tag(
            if tiled {
                Tag::TileByteCounts
            } else {
                Tag::StripByteCounts
            },
            sizes.as_slice(),
        )
        .unwrap();
        dir.write_tag(Tag::XResolution, Rational { n: 300, d: 1 })
            .unwrap();
        dir.write_tag(Tag::YResolution, Rational { n: 300, d: 1 })
            .unwrap();
        dir.write_tag(Tag::ResolutionUnit, 2_u16).unwrap();
        dir.finish().unwrap();
        streams
    }

    fn jpeg_streams(path: &Path) -> Vec<Vec<u8>> {
        Document::load(path)
            .unwrap()
            .objects
            .values()
            .filter_map(|object| {
                let stream = object.as_stream().ok()?;
                (stream.dict.get(b"Filter").ok()?.as_name().ok()? == b"DCTDecode")
                    .then(|| stream.content.clone())
            })
            .collect()
    }

    fn export_inserted_pages(pages: Vec<InsertPageMetadata>, output: &Path) {
        let plans: Vec<_> = pages
            .into_iter()
            .map(|page| super::super::EditPagePlan {
                source: page.source,
                rotation: 0,
                paint_edits: Vec::new(),
            })
            .collect();
        let mut sources = super::super::load_edit_source_documents(&plans).unwrap();
        super::super::write_edited_pdf(&mut sources, &plans, output).unwrap();
        super::super::validate_edit_output(output, plans.len() as u32).unwrap();
    }

    #[test]
    fn insert_ycbcr_jpeg_tiff_preserves_compressed_bytes_through_export() {
        let temp = temp();
        for strip_count in [1, 2] {
            let source = temp.path().join(format!("jpeg-{strip_count}.tif"));
            let expected = jpeg_tiff(&source, 1, strip_count, false);
            let original = fs::read(&source).unwrap();
            let store = InsertSourceStore::default();
            let (result, _) = batch(&[source.clone()], &temp.path().join("stage"), &store);
            assert!(result.issues.is_empty(), "{:?}", result.issues);
            assert_eq!(result.pages.len(), 1);
            assert_eq!(
                jpeg_streams(Path::new(source_path(&result.pages[0]))),
                expected
            );
            let output = temp.path().join("saved.pdf");
            export_inserted_pages(result.pages, &output);
            assert_eq!(jpeg_streams(&output), expected);
            assert_eq!(fs::read(&source).unwrap(), original);
        }
    }

    #[test]
    fn insert_jpeg_tiff_orientations_tiles_and_physical_size() {
        let temp = temp();
        for tiled in [false, true] {
            for orientation in 1..=8 {
                let source = temp
                    .path()
                    .join(format!("orientation-{orientation}-{tiled}.tif"));
                let streams = jpeg_tiff(&source, orientation, if tiled { 4 } else { 2 }, tiled);
                let store = InsertSourceStore::default();
                let (result, _) = batch(&[source.clone()], &temp.path().join("stage"), &store);
                assert!(result.issues.is_empty(), "{:?}", result.issues);
                let staged = Path::new(source_path(&result.pages[0]));
                assert_eq!(jpeg_streams(staged), streams);
                let document = Document::load(staged).unwrap();
                let page_id = document.get_pages()[&1];
                let media = document
                    .get_dictionary(page_id)
                    .unwrap()
                    .get(b"MediaBox")
                    .unwrap()
                    .as_array()
                    .unwrap();
                let (w, h) = if tiled { (21, 27) } else { (16, 32) };
                let (ow, oh) = if orientation >= 5 { (h, w) } else { (w, h) };
                assert!(
                    (f64::from(media[2].as_float().unwrap()) - f64::from(ow) * 72.0 / 300.0).abs()
                        < 0.00001
                );
                assert!(
                    (f64::from(media[3].as_float().unwrap()) - f64::from(oh) * 72.0 / 300.0).abs()
                        < 0.00001
                );
                if let Some(root) = std::env::var_os("TIFF_TEST_ARTIFACTS") {
                    let root = PathBuf::from(root);
                    fs::create_dir_all(&root).unwrap();
                    let name = format!("orientation-{orientation}-{tiled}");
                    let mut reference = image_025::RgbImage::new(w, h);
                    for (i, jpeg) in streams.iter().enumerate() {
                        let decoded = image_025::load_from_memory(jpeg).unwrap().to_rgb8();
                        let x = if tiled { (i as u32 % 2) * 16 } else { 0 };
                        let y = if tiled {
                            (i as u32 / 2) * 16
                        } else {
                            i as u32 * 16
                        };
                        image_025::imageops::replace(
                            &mut reference,
                            &decoded,
                            i64::from(x),
                            i64::from(y),
                        );
                    }
                    let mut reference = DynamicImage::ImageRgb8(reference);
                    reference.apply_orientation(
                        image_025::metadata::Orientation::from_exif(orientation as u8).unwrap(),
                    );
                    reference.save(root.join(format!("{name}.png"))).unwrap();
                    export_inserted_pages(result.pages, &root.join(format!("{name}.pdf")));
                }
            }
        }
    }

    #[test]
    fn insert_jpeg_tiff_reports_all_bad_files_without_partial_insert() {
        let temp = temp();
        let valid = temp.path().join("valid.tif");
        let truncated = temp.path().join("truncated.tif");
        let mismatch = temp.path().join("mismatch.tif");
        for path in [&valid, &truncated, &mismatch] {
            jpeg_tiff(path, 1, 1, false);
        }
        change_long_tag(&truncated, 0, 273, u32::MAX);
        change_long_tag(&mismatch, 0, 256, 17);
        let staging = temp.path().join("stage");
        let (result, events) = batch(
            &[valid, truncated, mismatch],
            &staging,
            &InsertSourceStore::default(),
        );
        assert!(result.pages.is_empty());
        assert_eq!(result.issues.len(), 2);
        assert_eq!(result.issues[0].file_name, "truncated.tif");
        assert_eq!(result.issues[1].file_name, "mismatch.tif");
        assert_eq!(events.last().unwrap().completed_files, 3);
        assert_eq!(fs::read_dir(staging).unwrap().count(), 0);
    }

    #[test]
    #[ignore = "Set TIFF_TEST_INPUT to a local sample; optional TIFF_TEST_OUTPUT saves the result"]
    fn insert_real_ycbcr_tiff_sample() {
        let Some(source) = std::env::var_os("TIFF_TEST_INPUT") else {
            return;
        };
        let source = PathBuf::from(source);
        let original = fs::read(&source).unwrap();
        let temp = temp();
        let store = InsertSourceStore::default();
        let (result, _) = batch(&[source.clone()], &temp.path().join("stage"), &store);
        assert!(result.issues.is_empty(), "{:?}", result.issues);
        assert_eq!(result.pages.len(), 1);
        let staged = PathBuf::from(source_path(&result.pages[0]));
        let expected = jpeg_streams(&staged);
        assert!(!expected.is_empty());
        let output = std::env::var_os("TIFF_TEST_OUTPUT")
            .map(PathBuf::from)
            .unwrap_or_else(|| temp.path().join("saved.pdf"));
        export_inserted_pages(result.pages, &output);
        assert_eq!(jpeg_streams(&output), expected);
        assert_eq!(fs::read(&source).unwrap(), original);
    }

    #[test]
    fn insert_extended_tiff_variants_preserve_samples_profiles_and_orientation() {
        fn hex(value: &str) -> Vec<u8> {
            value
                .as_bytes()
                .chunks_exact(2)
                .map(|pair| u8::from_str_radix(std::str::from_utf8(pair).unwrap(), 16).unwrap())
                .collect()
        }
        let fixtures = Path::new(env!("CARGO_MANIFEST_DIR")).join("../scripts/fixtures/tiff");
        let cases: Vec<serde_json::Value> =
            serde_json::from_slice(&fs::read(fixtures.join("manifest.json")).unwrap()).unwrap();
        let temp = temp();
        let store = InsertSourceStore::default();
        let artifacts = std::env::var_os("TIFF_VARIANT_OUTPUT_DIR").map(PathBuf::from);
        if let Some(root) = &artifacts {
            fs::create_dir_all(root).unwrap();
        }
        let mut failures = Vec::new();
        for case in cases {
            let name = case["name"].as_str().unwrap();
            let path = fixtures.join(name);
            let original = fs::read(&path).unwrap();
            let (result, _) = batch(&[path.clone()], &temp.path().join("stage"), &store);
            assert_eq!(
                fs::read(&path).unwrap(),
                original,
                "modified source: {name}"
            );
            if case["error"].as_bool().unwrap() {
                assert!(!result.issues.is_empty(), "accepted broken fixture: {name}");
                assert!(result.pages.is_empty());
                failures.push(path);
                continue;
            }
            assert!(result.issues.is_empty(), "{name}: {:?}", result.issues);
            assert_eq!(result.pages.len(), 1);
            let source = result.pages[0].source.clone();
            let output = temp.path().join("saved.pdf");
            export_inserted_pages(result.pages, &output);
            let document = Document::load(&output).unwrap();
            let channels = case["channels"].as_i64().unwrap();
            let device: &[u8] = match channels {
                1 => b"DeviceGray",
                3 => b"DeviceRGB",
                4 => b"DeviceCMYK",
                _ => panic!("channels"),
            };
            let image = document
                .objects
                .values()
                .filter_map(|object| object.as_stream().ok())
                .find(|stream| {
                    stream.dict.get(b"Subtype").and_then(Object::as_name).ok() == Some(b"Image")
                        && stream.dict.get(b"ColorSpace").is_ok_and(|color| {
                            color.as_name().ok() == Some(device) || color.as_array().is_ok()
                        })
                })
                .unwrap();
            assert_eq!(
                image
                    .dict
                    .get(b"BitsPerComponent")
                    .unwrap()
                    .as_i64()
                    .unwrap(),
                case["bits"].as_i64().unwrap(),
                "{name}"
            );
            let expected = hex(case["pixels"].as_str().unwrap());
            if case["jpeg"].as_bool().unwrap() {
                assert_eq!(image.content, expected, "JPEG bytes changed: {name}");
            } else {
                assert_eq!(
                    image.get_plain_content().unwrap(),
                    expected,
                    "pixel samples changed: {name}"
                );
            }
            if let Some(profile) = case["icc"].as_str() {
                let color = image.dict.get(b"ColorSpace").unwrap().as_array().unwrap();
                assert_eq!(color[0].as_name().unwrap(), b"ICCBased");
                let icc = document
                    .get_object(color[1].as_reference().unwrap())
                    .unwrap()
                    .as_stream()
                    .unwrap();
                assert_eq!(
                    icc.get_plain_content().unwrap(),
                    hex(profile),
                    "ICC changed: {name}"
                );
                assert_eq!(icc.dict.get(b"N").unwrap().as_i64().unwrap(), channels);
            }
            let page = document
                .get_dictionary(*document.get_pages().get(&1).unwrap())
                .unwrap();
            let bounds = page.get(b"MediaBox").unwrap().as_array().unwrap();
            let number = |at: usize| bounds[at].as_float().unwrap();
            let (width, height) = if case["orientation"].as_u64().unwrap() >= 5 {
                (9.0, 13.0)
            } else {
                (13.0, 9.0)
            };
            assert!(
                (number(2) - width).abs() < 0.005 && (number(3) - height).abs() < 0.005,
                "dimensions: {name}"
            );
            assert!(
                page.get(b"Rotate").is_err(),
                "orientation not normalized: {name}"
            );
            if let Some(root) = &artifacts {
                fs::copy(&output, root.join(format!("{name}.pdf"))).unwrap();
                if name.starts_with("orient-") {
                    for rotation in [0, 90, 180, 270] {
                        for cropped in [false, true] {
                            let mut edits = vec![super::super::PagePaintEdit::Cover {
                                color: "#ff00ff".into(),
                                x: 0.2,
                                y: 0.25,
                                width: 0.3,
                                height: 0.35,
                            }];
                            if cropped {
                                edits.push(super::super::PagePaintEdit::Crop {
                                    x: 0.1,
                                    y: 0.1,
                                    width: 0.8,
                                    height: 0.8,
                                });
                            }
                            let plans = vec![super::super::EditPagePlan {
                                source: source.clone(),
                                rotation,
                                paint_edits: edits,
                            }];
                            let mut sources =
                                super::super::load_edit_source_documents(&plans).unwrap();
                            let output = root.join(format!(
                                "{name}-{rotation}-{}.pdf",
                                if cropped { "crop" } else { "paint" }
                            ));
                            super::super::write_edited_pdf(&mut sources, &plans, &output).unwrap();
                        }
                    }
                }
            }
        }
        failures.insert(0, fixtures.join("palette-lzw.tif"));
        let (result, events) = batch(&failures, &temp.path().join("rollback"), &store);
        assert!(result.pages.is_empty());
        assert_eq!(result.issues.len(), failures.len() - 1);
        assert_eq!(events.last().unwrap().phase, Phase::Complete);
        assert_eq!(events.last().unwrap().issues.len(), failures.len() - 1);
    }

    #[test]
    #[ignore = "Set TIFF_TEST_INPUTS and TIFF_TEST_OUTPUT_DIR to verify local TIFF samples"]
    fn insert_local_tiff_samples_save_and_split() {
        let Some(inputs) = std::env::var_os("TIFF_TEST_INPUTS") else {
            return;
        };
        let paths: Vec<_> = std::env::split_paths(&inputs).collect();
        let root =
            PathBuf::from(std::env::var_os("TIFF_TEST_OUTPUT_DIR").expect("output directory"));
        fs::create_dir_all(&root).unwrap();
        let temp = temp();
        let store = InsertSourceStore::default();
        for (number, source) in paths.iter().enumerate() {
            let original = fs::read(source).unwrap();
            let (result, _) = batch(&[source.clone()], &temp.path().join("stage"), &store);
            assert!(result.issues.is_empty(), "{:?}", result.issues);
            assert!(!result.pages.is_empty());
            let mut plans: Vec<_> = result
                .pages
                .into_iter()
                .map(|page| super::super::EditPagePlan {
                    source: page.source,
                    rotation: 0,
                    paint_edits: Vec::new(),
                })
                .collect();
            // The split command requires a cut point; duplicate single-page
            // fixtures only inside this test so both split paths are exercised.
            if plans.len() == 1 {
                plans.push(plans[0].clone());
            }
            let mut sources = super::super::load_edit_source_documents(&plans).unwrap();
            let saved = root.join(format!("sample-{number}-saved.pdf"));
            super::super::write_edited_pdf(&mut sources, &plans, &saved).unwrap();
            super::super::validate_edit_output(&saved, plans.len() as u32).unwrap();
            let cuts: Vec<_> = (2..=plans.len() as u32).collect();
            let normal = super::super::split_pdf_impl(
                saved.to_string_lossy().into_owned(),
                cuts.clone(),
                "tiff-probe".into(),
                None,
                |_| {},
            )
            .unwrap();
            let direct = super::super::split_pdf_with_edits_impl(
                saved.to_string_lossy().into_owned(),
                plans,
                cuts,
                "tiff-probe".into(),
                None,
                |_| {},
            )
            .unwrap();
            for (label, result) in [("split", normal), ("direct-split", direct)] {
                for (page, output) in result.files.iter().enumerate() {
                    fs::copy(
                        &output.file_path,
                        root.join(format!("sample-{number}-{label}-{page}.pdf")),
                    )
                    .unwrap();
                }
            }
            assert_eq!(fs::read(source).unwrap(), original);
            println!("PASS: {} -> save, split, direct split", source.display());
        }
    }
}
