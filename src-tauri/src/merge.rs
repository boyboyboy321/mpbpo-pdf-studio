use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs;
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use chrono::Local;
use lopdf::{dictionary, Document, Object, ObjectId};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};
use tempfile::NamedTempFile;

use super::{AppError, AppState, PdfMetadata};

const MERGE_PROGRESS_EVENT: &str = "merge-progress";
const MAX_DECOMPRESSED_BYTES: usize = 64 * 1024 * 1024;
const MAX_NAME_ATTEMPTS: usize = 10_000;

#[derive(Clone, Copy, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
enum MergeOutputMode {
    #[default]
    CustomFolder,
    SiblingFolder,
}

#[derive(Default, Deserialize)]
#[serde(default, deny_unknown_fields, rename_all = "camelCase")]
pub(crate) struct MergeOutputOptions {
    mode: MergeOutputMode,
    custom_folder_path: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct MergeIssue {
    file_path: String,
    file_name: String,
    page_number: Option<u32>,
    message: String,
}

impl MergeIssue {
    fn new(path: &Path, page_number: Option<u32>, message: impl Into<String>) -> Self {
        Self {
            file_path: path.to_string_lossy().into_owned(),
            file_name: file_name(path),
            page_number,
            message: message.into(),
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MergeResult {
    file: Option<PdfMetadata>,
    output_dir: Option<String>,
    issues: Vec<MergeIssue>,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
enum Phase {
    Checking,
    Merging,
    Writing,
    Complete,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct MergeProgress {
    run_id: String,
    phase: Phase,
    completed_files: usize,
    total_files: usize,
    current_file_name: String,
    completed_pages: usize,
    total_pages: Option<usize>,
}

struct Progress<F> {
    value: MergeProgress,
    emit: F,
    last_emit: Instant,
}

impl<F: FnMut(&MergeProgress)> Progress<F> {
    fn send(&mut self, force: bool) {
        if force || self.last_emit.elapsed() >= Duration::from_millis(80) {
            (self.emit)(&self.value);
            self.last_emit = Instant::now();
        }
    }
}

#[tauri::command]
pub(crate) async fn read_merge_metadata(path: String) -> Result<PdfMetadata, AppError> {
    tauri::async_runtime::spawn_blocking(move || {
        std::panic::catch_unwind(|| super::read_pdf_metadata(path)).unwrap_or_else(|_| {
            Err(AppError::State(
                "PDF parser panicked while reading metadata".into(),
            ))
        })
    })
    .await
    .map_err(|error| AppError::State(format!("PDF metadata task failed: {error}")))?
}

#[tauri::command]
pub(crate) async fn merge_pdf(
    state: State<'_, AppState>,
    app: AppHandle,
    paths: Vec<String>,
    output_options: MergeOutputOptions,
    run_id: String,
) -> Result<MergeResult, AppError> {
    state.release_render_session()?;
    let result = tauri::async_runtime::spawn_blocking(move || {
        let prefix = format!("merge_{}", Local::now().format("%Y%m%d_%H%M%S_%3f"));
        merge_pdf_impl(paths, output_options, run_id, &prefix, |progress| {
            let _ = app.emit(MERGE_PROGRESS_EVENT, progress);
        })
    })
    .await;
    super::trim_process_working_set();
    result.map_err(|error| AppError::State(format!("PDF merge task failed: {error}")))?
}

fn checked_operation<T>(operation: impl FnOnce() -> Result<T, String>) -> Result<T, String> {
    std::panic::catch_unwind(std::panic::AssertUnwindSafe(operation))
        .unwrap_or_else(|_| Err("PDF parser panicked while processing this file or page".into()))
}

fn file_name(path: &Path) -> String {
    path.file_name()
        .unwrap_or(path.as_os_str())
        .to_string_lossy()
        .into_owned()
}

fn load_pdf(path: &Path) -> Result<Document, String> {
    checked_operation(|| {
        let document = Document::load_with_options(
            path,
            lopdf::LoadOptions::with_max_decompressed_size(MAX_DECOMPRESSED_BYTES),
        )
        .map_err(|error| error.to_string())?;
        if document.trailer.has(b"Encrypt") {
            return Err("Password-protected PDF cannot be merged without unlocking it".into());
        }
        Ok(document)
    })
}

fn destination_parent(first: &Path, options: &MergeOutputOptions) -> Result<PathBuf, AppError> {
    let directory = match options.mode {
        MergeOutputMode::CustomFolder => {
            let path = options
                .custom_folder_path
                .as_deref()
                .filter(|path| !path.trim().is_empty())
                .ok_or_else(|| {
                    AppError::State("Choose a destination folder before merging".into())
                })?;
            Path::new(path)
        }
        MergeOutputMode::SiblingFolder => {
            let parent = first
                .parent()
                .filter(|path| !path.as_os_str().is_empty())
                .unwrap_or_else(|| Path::new("."));
            // Still scan later inputs when the first source's parent is missing.
            return Ok(if parent.is_absolute() {
                parent.to_path_buf()
            } else {
                std::env::current_dir()?.join(parent)
            });
        }
    };
    let directory = directory.canonicalize()?;
    if !directory.is_dir() {
        return Err(AppError::State("Merge destination must be a folder".into()));
    }
    Ok(directory)
}

fn merge_pdf_impl(
    paths: Vec<String>,
    options: MergeOutputOptions,
    run_id: String,
    prefix: &str,
    on_progress: impl FnMut(&MergeProgress),
) -> Result<MergeResult, AppError> {
    let first = paths
        .first()
        .ok_or_else(|| AppError::State("Choose at least one PDF to merge".into()))?;
    let parent = destination_parent(Path::new(first), &options)?;
    let mut progress = Progress {
        value: MergeProgress {
            run_id,
            phase: Phase::Checking,
            completed_files: 0,
            total_files: paths.len(),
            current_file_name: String::new(),
            completed_pages: 0,
            total_pages: None,
        },
        emit: on_progress,
        last_emit: Instant::now(),
    };
    progress.send(true);
    let mut result = MergeResult {
        file: None,
        output_dir: None,
        issues: Vec::new(),
    };
    let mut output = Document::with_version("1.0");
    let pages_id = output.new_object_id();
    let catalog_id = output.new_object_id();
    let mut page_refs = Vec::new();
    let mut known_pages = 0_usize;
    let mut all_counts_known = true;

    for (index, path) in paths.iter().enumerate() {
        let path = Path::new(path);
        progress.value.phase = Phase::Checking;
        progress.value.current_file_name = file_name(path);
        progress.send(true);
        let source = checked_operation(|| {
            super::validate_pdf_path(path, &path.to_string_lossy())
                .map_err(|error| error.to_string())?;
            load_pdf(path)
        });
        match source {
            Err(error) => {
                all_counts_known = false;
                result.issues.push(MergeIssue::new(path, None, error));
            }
            Ok(source) => {
                // The source and its copy/validation caches are dropped at each file boundary.
                let pages = checked_operation(|| Ok(source.get_pages()));
                match pages {
                    Err(error) => {
                        all_counts_known = false;
                        result.issues.push(MergeIssue::new(path, None, error));
                    }
                    Ok(pages) => {
                        known_pages += pages.len();
                        if let Err(error) =
                            checked_operation(|| validate_page_tree(&source, &pages))
                        {
                            all_counts_known = false;
                            result.issues.push(MergeIssue::new(path, None, error));
                        }
                        if let Err(error) = checked_operation(|| {
                            super::output_pdf_version([&source]).map_err(|error| error.to_string())
                        }) {
                            result.issues.push(MergeIssue::new(path, None, error));
                        }
                        if index == 0 {
                            if let Err(error) = checked_operation(|| {
                                super::stamp_pdf_metadata(&mut output, Some(&source))
                                    .map_err(|error| error.to_string())
                            }) {
                                result.issues.push(MergeIssue::new(path, None, error));
                            }
                        }
                        let mut checked = HashSet::new();
                        let mut copied = HashMap::new();
                        progress.value.phase = Phase::Merging;
                        progress.send(true);
                        for (number, id) in pages {
                            let validation = checked_operation(|| {
                                super::insert::validate_pdf_page(&source, id, &mut checked)
                            });
                            if let Err(error) = validation {
                                result
                                    .issues
                                    .push(MergeIssue::new(path, Some(number), error));
                            } else if result.issues.is_empty() {
                                let append = checked_operation(|| {
                                    super::append_pdf_page(
                                        &source,
                                        &mut output,
                                        pages_id,
                                        &mut page_refs,
                                        &mut copied,
                                        number,
                                        0,
                                        &[],
                                    )
                                    .map_err(|error| error.to_string())
                                });
                                if let Err(error) = append {
                                    result
                                        .issues
                                        .push(MergeIssue::new(path, Some(number), error));
                                }
                            }
                            progress.value.completed_pages += 1;
                            progress.send(false);
                        }
                    }
                }
            }
        }
        progress.value.completed_files = index + 1;
        progress.send(true);
    }

    progress.value.total_pages = all_counts_known.then_some(known_pages);
    if result.issues.is_empty() {
        progress.value.phase = Phase::Writing;
        progress.value.current_file_name = format!("{prefix}.pdf");
        progress.send(true);
        let written = checked_operation(|| {
            let page_count = u32::try_from(known_pages)
                .map_err(|_| "Merged PDF exceeds the supported page count".to_string())?;
            if page_refs.len() != known_pages {
                return Err("Not all source pages were appended to the merged PDF".into());
            }
            output.objects.insert(
                pages_id,
                Object::Dictionary(dictionary! {
                    "Type" => "Pages", "Kids" => page_refs, "Count" => i64::from(page_count),
                }),
            );
            output.objects.insert(
                catalog_id,
                Object::Dictionary(dictionary! {
                    "Type" => "Catalog", "Pages" => pages_id,
                }),
            );
            output.trailer.set("Root", catalog_id);
            super::prepare_pdf_output(&mut output).map_err(|error| error.to_string())?;
            let directory = create_output_directory(&parent, options.mode, prefix)?;
            let write_result =
                checked_operation(|| write_output(output, &directory, prefix, page_count));
            if write_result.is_err() && matches!(options.mode, MergeOutputMode::SiblingFolder) {
                // Only remove our own empty directory; never remove a source or another run's files.
                let _ = fs::remove_dir(&directory);
            }
            write_result.map(|file| (file, directory))
        });
        match written {
            Ok((file, directory)) => {
                progress.value.current_file_name = file.file_name.clone();
                result.file = Some(file);
                result.output_dir = Some(directory.to_string_lossy().into_owned());
            }
            Err(error) => result.issues.push(MergeIssue::new(
                &parent.join(format!("{prefix}.pdf")),
                None,
                format!("Could not write merged PDF: {error}"),
            )),
        }
    }
    progress.value.phase = Phase::Complete;
    progress.send(true);
    Ok(result)
}

fn validate_page_tree(document: &Document, pages: &BTreeMap<u32, ObjectId>) -> Result<(), String> {
    if pages.is_empty() {
        return Err("PDF has no readable pages".into());
    }
    let root = document
        .catalog()
        .and_then(|catalog| catalog.get(b"Pages"))
        .and_then(Object::as_reference)
        .map_err(|error| error.to_string())?;
    let mut stack = vec![(root, None, false)];
    let mut seen = HashSet::new();
    let mut counts = HashMap::<ObjectId, usize>::new();
    while let Some((id, parent, exiting)) = stack.pop() {
        if !exiting && !seen.insert(id) {
            return Err("PDF page tree contains a cycle or repeated page reference".into());
        }
        let node = document
            .get_dictionary(id)
            .map_err(|error| error.to_string())?;
        if let Some(parent) = parent {
            if node.get(b"Parent").and_then(Object::as_reference).ok() != Some(parent) {
                return Err(format!(
                    "PDF page tree has an invalid Parent at object {} {}",
                    id.0, id.1
                ));
            }
        }
        match node
            .get(b"Type")
            .and_then(Object::as_name)
            .map_err(|error| error.to_string())?
        {
            b"Page" if parent.is_some() => {
                counts.insert(id, 1);
            }
            b"Pages" => {
                let kids = node
                    .get_deref(b"Kids", document)
                    .and_then(Object::as_array)
                    .map_err(|error| error.to_string())?;
                if exiting {
                    let count = kids.iter().try_fold(0_usize, |count, kid| {
                        let id = kid.as_reference().map_err(|error| error.to_string())?;
                        count
                            .checked_add(*counts.get(&id).ok_or("Unreadable page tree child")?)
                            .ok_or_else(|| "PDF page count overflow".to_string())
                    })?;
                    let declared = node
                        .get_deref(b"Count", document)
                        .and_then(Object::as_i64)
                        .map_err(|error| error.to_string())?;
                    if usize::try_from(declared).ok() != Some(count) {
                        return Err("PDF page tree Count does not match its pages".into());
                    }
                    counts.insert(id, count);
                } else {
                    stack.push((id, parent, true));
                    for kid in kids.iter().rev() {
                        stack.push((
                            kid.as_reference().map_err(|error| error.to_string())?,
                            Some(id),
                            false,
                        ));
                    }
                }
            }
            _ => return Err("PDF page tree contains a node with an invalid Type".into()),
        }
    }
    if counts.get(&root).copied() != Some(pages.len()) {
        return Err("PDF page enumeration omitted one or more pages".into());
    }
    Ok(())
}

fn validate_output(path: &Path, expected_pages: u32) -> Result<(), String> {
    let document = load_pdf(path)?;
    let pages = document.get_pages();
    if pages.len() != expected_pages as usize {
        return Err(format!(
            "Expected {expected_pages} output pages, found {}",
            pages.len()
        ));
    }
    validate_page_tree(&document, &pages)?;
    let mut checked = HashSet::new();
    for id in pages.values() {
        super::insert::validate_pdf_page(&document, *id, &mut checked)?;
    }
    let mut pending: Vec<_> = document
        .objects
        .values()
        .chain(document.trailer.iter().map(|(_, value)| value))
        .collect();
    while let Some(object) = pending.pop() {
        match object {
            Object::Reference(id) if !document.objects.contains_key(id) => {
                return Err(format!("Output has missing reference {} {}", id.0, id.1));
            }
            Object::Array(values) => pending.extend(values),
            Object::Dictionary(dict) => pending.extend(dict.iter().map(|(_, value)| value)),
            Object::Stream(stream) => pending.extend(stream.dict.iter().map(|(_, value)| value)),
            _ => {}
        }
    }
    Ok(())
}

fn candidate_name(prefix: &str, attempt: usize) -> String {
    if attempt == 0 {
        prefix.into()
    } else {
        format!("{prefix}_{}", attempt + 1)
    }
}

fn create_output_directory(
    parent: &Path,
    mode: MergeOutputMode,
    prefix: &str,
) -> Result<PathBuf, String> {
    if matches!(mode, MergeOutputMode::CustomFolder) {
        return Ok(parent.to_path_buf());
    }
    for attempt in 0..MAX_NAME_ATTEMPTS {
        let path = parent.join(candidate_name(prefix, attempt));
        match fs::create_dir(&path) {
            Ok(()) => return Ok(path),
            Err(error)
                if error.kind() == std::io::ErrorKind::AlreadyExists
                    || path.symlink_metadata().is_ok() => {}
            Err(error) => return Err(error.to_string()),
        }
    }
    Err("Could not reserve a unique merge folder".into())
}

fn write_output(
    mut document: Document,
    directory: &Path,
    prefix: &str,
    page_count: u32,
) -> Result<PdfMetadata, String> {
    let mut temporary = tempfile::Builder::new()
        .prefix(".merge-")
        .suffix(".tmp")
        .tempfile_in(directory)
        .map_err(|error| error.to_string())?;
    {
        let mut writer = BufWriter::new(temporary.as_file_mut());
        document
            .save_to(&mut writer)
            .map_err(|error| error.to_string())?;
        writer.flush().map_err(|error| error.to_string())?;
    }
    drop(document);
    temporary
        .as_file()
        .sync_all()
        .map_err(|error| error.to_string())?;
    checked_operation(|| validate_output(temporary.path(), page_count))?;
    let size_bytes = temporary
        .as_file()
        .metadata()
        .map_err(|error| error.to_string())?
        .len();
    let path = persist_output(temporary, directory, prefix)?;
    Ok(PdfMetadata {
        file_name: file_name(&path),
        file_path: path.to_string_lossy().into_owned(),
        page_count,
        size_bytes,
    })
}

fn persist_output(
    mut temporary: NamedTempFile,
    directory: &Path,
    prefix: &str,
) -> Result<PathBuf, String> {
    for attempt in 0..MAX_NAME_ATTEMPTS {
        let path = directory.join(format!("{}.pdf", candidate_name(prefix, attempt)));
        match temporary.persist_noclobber(&path) {
            Ok(_) => return Ok(path),
            Err(error)
                if error.error.kind() == std::io::ErrorKind::AlreadyExists
                    || path.symlink_metadata().is_ok() =>
            {
                temporary = error.file;
            }
            Err(error) => return Err(error.error.to_string()),
        }
    }
    Err("Could not reserve a unique merge filename".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use lopdf::Stream;

    const PREFIX: &str = "merge_20261024_123456_789";

    fn create_pdf(path: &Path, labels: &[&str], version: &str, catalog_version: Option<&str>) {
        let mut document = Document::with_version(version);
        document.reference_table.cross_reference_type = lopdf::xref::XrefType::CrossReferenceTable;
        let pages_id = document.new_object_id();
        let mut kids = Vec::<Object>::new();
        for label in labels {
            let content = document.add_object(Stream::new(
                dictionary! {},
                format!("q\n% {label}\nQ\n").into_bytes(),
            ));
            let page = document.add_object(dictionary! {
                "Type" => "Page", "Parent" => pages_id,
                "Contents" => content, "MergeMarker" => Object::string_literal(*label),
            });
            kids.push(page.into());
        }
        document.objects.insert(
            pages_id,
            Object::Dictionary(dictionary! {
                "Type" => "Pages", "Kids" => kids, "Count" => labels.len() as i64,
                "MediaBox" => vec![0.into(), 0.into(), 612.into(), 792.into()],
                "Resources" => dictionary! {},
            }),
        );
        let mut catalog = dictionary! { "Type" => "Catalog", "Pages" => pages_id };
        if let Some(version) = catalog_version {
            let version_id = document.add_object(Object::Name(version.as_bytes().to_vec()));
            catalog.set("Version", version_id);
        }
        let root = document.add_object(catalog);
        let info = document
            .add_object(dictionary! { "Author" => Object::string_literal("Original Author") });
        document.trailer.set("Root", root);
        document.trailer.set("Info", info);
        document.save(path).unwrap();
    }

    fn custom(path: &Path) -> MergeOutputOptions {
        MergeOutputOptions {
            mode: MergeOutputMode::CustomFolder,
            custom_folder_path: Some(path.to_string_lossy().into_owned()),
        }
    }

    fn sibling() -> MergeOutputOptions {
        MergeOutputOptions {
            mode: MergeOutputMode::SiblingFolder,
            custom_folder_path: None,
        }
    }

    fn run(paths: &[&Path], options: MergeOutputOptions) -> MergeResult {
        merge_pdf_impl(
            paths
                .iter()
                .map(|path| path.to_string_lossy().into_owned())
                .collect(),
            options,
            "test-run".into(),
            PREFIX,
            |_| {},
        )
        .unwrap()
    }

    fn labels(document: &Document) -> Vec<String> {
        document
            .get_pages()
            .values()
            .map(|id| {
                String::from_utf8(
                    document
                        .get_dictionary(*id)
                        .unwrap()
                        .get(b"MergeMarker")
                        .unwrap()
                        .as_str()
                        .unwrap()
                        .to_vec(),
                )
                .unwrap()
            })
            .collect()
    }

    fn image_bytes(document: &Document) -> Vec<(Vec<u8>, Vec<u8>)> {
        let mut images: Vec<_> = document
            .objects
            .values()
            .filter_map(|object| {
                let stream = object.as_stream().ok()?;
                (stream.dict.get(b"Subtype").and_then(Object::as_name).ok() == Some(b"Image")).then(
                    || {
                        (
                            stream
                                .dict
                                .get(b"Filter")
                                .unwrap()
                                .as_name()
                                .unwrap()
                                .to_vec(),
                            stream.content.clone(),
                        )
                    },
                )
            })
            .collect();
        images.sort();
        images
    }

    fn add_compressed_images(path: &Path) -> Vec<(Vec<u8>, Vec<u8>)> {
        let mut document = Document::load(path).unwrap();
        let mut compressor =
            flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::default());
        compressor.write_all(&[20, 70, 190]).unwrap();
        let flate = compressor.finish().unwrap();
        let mut jpeg = Vec::new();
        image_025::codecs::jpeg::JpegEncoder::new_with_quality(&mut jpeg, 91)
            .encode(&[20, 70, 190], 1, 1, image_025::ExtendedColorType::Rgb8)
            .unwrap();
        let mut resources = lopdf::Dictionary::new();
        for (name, filter, content) in
            [("Flate", "FlateDecode", flate), ("Jpeg", "DCTDecode", jpeg)]
        {
            let id = document.add_object(Stream::new(
                dictionary! {
                    "Type" => "XObject", "Subtype" => "Image", "Width" => 1, "Height" => 1,
                    "BitsPerComponent" => 8, "ColorSpace" => "DeviceRGB", "Filter" => filter,
                },
                content,
            ));
            resources.set(name, id);
        }
        let pages_id = document
            .catalog()
            .unwrap()
            .get(b"Pages")
            .unwrap()
            .as_reference()
            .unwrap();
        document
            .get_dictionary_mut(pages_id)
            .unwrap()
            .set("Resources", dictionary! { "XObject" => resources });
        document.save(path).unwrap();
        image_bytes(&Document::load(path).unwrap())
    }

    #[test]
    fn custom_merge_preserves_order_versions_images_and_sources() {
        let directory = tempfile::tempdir().unwrap();
        let first = directory.path().join("z-first.pdf");
        let second = directory.path().join("a-second.pdf");
        let out = directory.path().join("destination");
        fs::create_dir(&out).unwrap();
        create_pdf(&first, &["first-1", "first-2"], "1.2", None);
        create_pdf(&second, &["second-1"], "1.4", Some("2.0"));
        let expected_images = add_compressed_images(&first);
        let originals = [fs::read(&first).unwrap(), fs::read(&second).unwrap()];
        let mut events = Vec::new();
        let result = merge_pdf_impl(
            vec![
                first.to_string_lossy().into_owned(),
                second.to_string_lossy().into_owned(),
            ],
            custom(&out),
            "ordered".into(),
            PREFIX,
            |event| events.push(event.clone()),
        )
        .unwrap();
        assert!(result.issues.is_empty(), "{:?}", result.issues);
        let file = result.file.unwrap();
        assert_eq!(file.page_count, 3);
        assert_eq!(file.file_name, format!("{PREFIX}.pdf"));
        assert_eq!(
            Path::new(&file.file_path).parent().unwrap(),
            out.canonicalize().unwrap()
        );
        assert_eq!(
            result.output_dir.unwrap(),
            out.canonicalize().unwrap().to_string_lossy()
        );
        let document = Document::load(&file.file_path).unwrap();
        assert_eq!(labels(&document), ["first-1", "first-2", "second-1"]);
        assert_eq!(document.version, "2.0");
        assert_eq!(image_bytes(&document), expected_images);
        let info = super::super::pdf_info_dictionary(&document).unwrap();
        assert_eq!(
            info.get(b"Author").unwrap().as_str().unwrap(),
            b"Original Author"
        );
        assert_eq!(
            info.get(b"Producer").unwrap().as_str().unwrap(),
            super::super::PDF_APP_NAME.as_bytes()
        );
        assert_eq!(fs::read(&first).unwrap(), originals[0]);
        assert_eq!(fs::read(&second).unwrap(), originals[1]);
        assert_eq!(fs::read_dir(&out).unwrap().count(), 1);
        for phase in [
            Phase::Checking,
            Phase::Merging,
            Phase::Writing,
            Phase::Complete,
        ] {
            assert!(events.iter().any(|event| event.phase == phase));
        }
        assert!(events
            .iter()
            .all(|event| event.run_id == "ordered" && event.total_files == 2));
        let last = events.last().unwrap();
        assert_eq!(last.completed_files, 2);
        assert_eq!(last.completed_pages, 3);
        assert_eq!(last.total_pages, Some(3));
        let event = serde_json::to_value(last).unwrap();
        assert_eq!(event["phase"], "complete");
        assert_eq!(event["runId"], "ordered");
    }

    #[test]
    fn versions_follow_highest_source_header_catalog_and_written_features() {
        let directory = tempfile::tempdir().unwrap();
        let first = directory.path().join("first.pdf");
        let second = directory.path().join("second.pdf");
        for (header, catalog, expected) in [
            ("1.2", None, "1.2"),
            ("1.4", None, "1.4"),
            ("1.4", Some("1.7"), "1.7"),
            ("2.0", Some("1.7"), "2.0"),
        ] {
            create_pdf(&first, &["A"], "1.0", None);
            create_pdf(&second, &["B"], header, catalog);
            for ordered in [
                [first.as_path(), second.as_path()],
                [second.as_path(), first.as_path()],
            ] {
                let result = run(&ordered, custom(directory.path()));
                assert!(result.issues.is_empty(), "{:?}", result.issues);
                let document = Document::load(result.file.unwrap().file_path).unwrap();
                assert_eq!(document.version, expected);
                if expected < "1.5" {
                    assert!(matches!(
                        document.reference_table.cross_reference_type,
                        lopdf::xref::XrefType::CrossReferenceTable
                    ));
                }
            }
        }
        create_pdf(&first, &["image"], "1.0", None);
        add_compressed_images(&first);
        let result = run(&[&first], custom(directory.path()));
        assert_eq!(
            Document::load(result.file.unwrap().file_path)
                .unwrap()
                .version,
            "1.2"
        );
    }

    #[test]
    fn sibling_folder_is_beside_first_ordered_source_and_never_reused() {
        let directory = tempfile::tempdir().unwrap();
        let a = directory.path().join("a");
        let b = directory.path().join("b");
        fs::create_dir(&a).unwrap();
        fs::create_dir(&b).unwrap();
        let first = a.join("first.pdf");
        let second = b.join("second.pdf");
        create_pdf(&first, &["a"], "1.4", None);
        create_pdf(&second, &["b"], "1.4", None);
        let existing = b.join(PREFIX);
        fs::create_dir(&existing).unwrap();
        fs::write(existing.join("sentinel"), b"untouched").unwrap();
        let original = fs::read(&second).unwrap();
        let result = run(&[&second, &first], sibling());
        assert!(result.issues.is_empty(), "{:?}", result.issues);
        assert_eq!(
            PathBuf::from(result.output_dir.unwrap()),
            b.join(format!("{PREFIX}_2"))
        );
        let file = result.file.unwrap();
        assert_eq!(file.file_name, format!("{PREFIX}.pdf"));
        assert_eq!(labels(&Document::load(file.file_path).unwrap()), ["b", "a"]);
        assert_eq!(fs::read(&second).unwrap(), original);
        assert_eq!(fs::read(existing.join("sentinel")).unwrap(), b"untouched");
        assert_eq!(fs::read_dir(&a).unwrap().count(), 1);
    }

    #[test]
    fn reports_all_bad_files_and_pages_and_publishes_nothing() {
        let directory = tempfile::tempdir().unwrap();
        let good = directory.path().join("good.pdf");
        let damaged = directory.path().join("damaged.pdf");
        let later = directory.path().join("later.pdf");
        let missing = directory.path().join("missing.pdf");
        let broken = directory.path().join("broken.pdf");
        let not_pdf = directory.path().join("not-pdf.txt");
        let empty = directory.path().join("empty.pdf");
        let out = directory.path().join("out");
        fs::create_dir(&out).unwrap();
        create_pdf(&good, &["good"], "1.4", None);
        create_pdf(&damaged, &["bad-ref", "bad-content", "valid"], "1.4", None);
        create_pdf(&later, &["bad-later"], "1.4", None);
        create_pdf(&empty, &[], "1.4", None);
        fs::write(&broken, b"not a PDF").unwrap();
        fs::write(&not_pdf, b"not a PDF").unwrap();
        let mut document = Document::load(&damaged).unwrap();
        let pages = document.get_pages();
        document
            .get_dictionary_mut(pages[&1])
            .unwrap()
            .set("Contents", Object::Reference((90_000, 0)));
        let bad_stream = document.add_object(Stream::new(
            dictionary! { "Filter" => "FlateDecode" },
            b"not zlib".to_vec(),
        ));
        document
            .get_dictionary_mut(pages[&2])
            .unwrap()
            .set("Contents", bad_stream);
        document.save(&damaged).unwrap();
        let mut document = Document::load(&later).unwrap();
        let page = document.get_pages()[&1];
        document
            .get_dictionary_mut(page)
            .unwrap()
            .set("Contents", Object::Integer(7));
        document.save(&later).unwrap();
        let paths = [&good, &missing, &damaged, &broken, &not_pdf, &empty, &later];
        let snapshots: Vec<_> = paths.iter().map(|path| fs::read(path).ok()).collect();
        for options in [custom(&out), sibling()] {
            let mut events = Vec::new();
            let result = merge_pdf_impl(
                paths
                    .iter()
                    .map(|path| path.to_string_lossy().into_owned())
                    .collect(),
                options,
                "bad-batch".into(),
                PREFIX,
                |event| events.push(event.clone()),
            )
            .unwrap();
            assert!(result.file.is_none());
            assert!(result.output_dir.is_none());
            for path in [&missing, &broken, &not_pdf, &empty] {
                assert!(
                    result
                        .issues
                        .iter()
                        .any(|issue| issue.file_path == path.to_string_lossy()
                            && issue.page_number.is_none()),
                    "{:?}",
                    result.issues
                );
            }
            for (path, page) in [(&damaged, 1), (&damaged, 2), (&later, 1)] {
                assert!(
                    result
                        .issues
                        .iter()
                        .any(|issue| issue.file_path == path.to_string_lossy()
                            && issue.page_number == Some(page)),
                    "{:?}",
                    result.issues
                );
            }
            assert!(!events.iter().any(|event| event.phase == Phase::Writing));
            let last = events.last().unwrap();
            assert_eq!(last.phase, Phase::Complete);
            assert_eq!(last.completed_files, paths.len());
            assert!(last.total_pages.is_none());
            let json = serde_json::to_value(result).unwrap();
            assert!(json["file"].is_null() && json["outputDir"].is_null());
            assert!(json["issues"][0]["pageNumber"].is_null());
        }
        assert_eq!(fs::read_dir(&out).unwrap().count(), 0);
        assert!(!directory.path().join(PREFIX).exists());
        for (path, snapshot) in paths.iter().zip(snapshots) {
            assert_eq!(fs::read(path).ok(), snapshot);
        }
    }

    #[test]
    fn incomplete_or_cyclic_page_trees_cancel_the_batch() {
        let directory = tempfile::tempdir().unwrap();
        let source = directory.path().join("source.pdf");
        for corrupt in 0..3 {
            create_pdf(&source, &["page"], "1.4", None);
            let mut document = Document::load(&source).unwrap();
            let root = document
                .catalog()
                .unwrap()
                .get(b"Pages")
                .unwrap()
                .as_reference()
                .unwrap();
            let tree = document.get_dictionary_mut(root).unwrap();
            match corrupt {
                0 => tree.set("Count", 2),
                1 => tree.set("Kids", vec![Object::Reference((99_999, 0))]),
                _ => tree.set("Kids", vec![Object::Reference(root)]),
            }
            document.save(&source).unwrap();
            let result = run(&[&source], sibling());
            assert!(result.file.is_none() && !result.issues.is_empty());
            assert!(!directory.path().join(PREFIX).exists());
        }
    }

    #[test]
    fn custom_filename_collision_never_overwrites_a_source_or_existing_output() {
        let directory = tempfile::tempdir().unwrap();
        let source = directory.path().join(format!("{PREFIX}.pdf"));
        create_pdf(&source, &["source"], "1.4", None);
        let original = fs::read(&source).unwrap();
        let occupied = directory.path().join(format!("{PREFIX}_2.pdf"));
        fs::write(&occupied, b"existing output").unwrap();
        for suffix in [3, 4] {
            let result = run(&[&source], custom(directory.path()));
            assert!(result.issues.is_empty(), "{:?}", result.issues);
            assert_eq!(
                result.file.unwrap().file_name,
                format!("{PREFIX}_{suffix}.pdf")
            );
        }
        assert_eq!(fs::read(&source).unwrap(), original);
        assert_eq!(fs::read(&occupied).unwrap(), b"existing output");
    }

    #[test]
    fn concurrent_publication_and_sibling_reservation_are_collision_safe() {
        let directory = tempfile::tempdir().unwrap();
        let source = directory.path().join("source.pdf");
        create_pdf(&source, &["page"], "1.4", None);
        for mode in [
            MergeOutputMode::CustomFolder,
            MergeOutputMode::SiblingFolder,
        ] {
            let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
            let outputs: Vec<_> = std::thread::scope(|scope| {
                let handles: Vec<_> = (0..2)
                    .map(|_| {
                        let barrier = barrier.clone();
                        let source = &source;
                        let directory = directory.path();
                        scope.spawn(move || {
                            let options = match mode {
                                MergeOutputMode::CustomFolder => custom(directory),
                                MergeOutputMode::SiblingFolder => sibling(),
                            };
                            barrier.wait();
                            let result = run(&[source], options);
                            assert!(result.issues.is_empty(), "{:?}", result.issues);
                            result.file.unwrap().file_path
                        })
                    })
                    .collect();
                handles
                    .into_iter()
                    .map(|handle| handle.join().unwrap())
                    .collect()
            });
            assert_ne!(outputs[0], outputs[1]);
            for output in outputs {
                assert_eq!(labels(&Document::load(output).unwrap()), ["page"]);
            }
        }
        assert!(source.is_file());
    }

    #[test]
    fn output_validation_failure_removes_temporary_file_without_publishing() {
        let directory = tempfile::tempdir().unwrap();
        let source = directory.path().join("source.pdf");
        let out = directory.path().join("out");
        fs::create_dir(&out).unwrap();
        create_pdf(&source, &["page"], "1.4", None);
        let mut document = Document::load(&source).unwrap();
        document.add_object(dictionary! { "Unresolved" => Object::Reference((99_999, 0)) });
        assert!(write_output(document, &out, PREFIX, 1).is_err());
        assert_eq!(fs::read_dir(&out).unwrap().count(), 0);
        let document = Document::load(&source).unwrap();
        assert!(write_output(document, &out, PREFIX, 2).is_err());
        assert_eq!(fs::read_dir(&out).unwrap().count(), 0);
        assert!(source.is_file());
    }

    #[test]
    fn write_failure_returns_issues_and_completion_without_touching_sources() {
        let directory = tempfile::tempdir().unwrap();
        let source = directory.path().join("source.pdf");
        let out = directory.path().join("out");
        fs::create_dir(&out).unwrap();
        create_pdf(&source, &["page"], "1.4", None);
        let original = fs::read(&source).unwrap();
        let mut last_phase = Phase::Checking;
        let result = merge_pdf_impl(
            vec![source.to_string_lossy().into_owned()],
            custom(&out),
            "write-failure".into(),
            PREFIX,
            |event| {
                last_phase = event.phase;
                if event.phase == Phase::Writing {
                    fs::remove_dir(&out).unwrap();
                }
            },
        )
        .unwrap();
        assert!(result.file.is_none() && result.output_dir.is_none());
        assert_eq!(result.issues.len(), 1);
        assert!(result.issues[0]
            .message
            .contains("Could not write merged PDF"));
        assert_eq!(last_phase, Phase::Complete);
        assert_eq!(fs::read(&source).unwrap(), original);
        assert!(!out.exists());
    }

    #[test]
    fn duplicate_inputs_are_preserved_in_requested_order() {
        let directory = tempfile::tempdir().unwrap();
        let source = directory.path().join("source.pdf");
        create_pdf(&source, &["one", "two"], "1.4", None);
        let result = run(&[&source, &source], sibling());
        assert!(result.issues.is_empty(), "{:?}", result.issues);
        assert_eq!(
            labels(&Document::load(result.file.unwrap().file_path).unwrap()),
            ["one", "two", "one", "two"]
        );
    }

    #[test]
    fn options_default_to_custom_require_destination_and_reject_delete_options() {
        let options: MergeOutputOptions = serde_json::from_str("{}").unwrap();
        assert!(matches!(options.mode, MergeOutputMode::CustomFolder));
        assert!(destination_parent(Path::new("source.pdf"), &options).is_err());
        for json in [
            r#"{"mode":"originalFolderDeleteOriginal"}"#,
            r#"{"deleteOriginal":true}"#,
            r#"{"deleteSource":false}"#,
            r#"{"delete":false}"#,
        ] {
            assert!(serde_json::from_str::<MergeOutputOptions>(json).is_err());
        }
        assert!(serde_json::from_str::<MergeOutputOptions>(r#"{"mode":"siblingFolder"}"#).is_ok());
        assert!(merge_pdf_impl(Vec::new(), sibling(), "empty".into(), PREFIX, |_| {}).is_err());
    }

    #[test]
    fn sibling_missing_first_parent_does_not_hide_later_file_errors() {
        let directory = tempfile::tempdir().unwrap();
        let missing = directory.path().join("absent").join("missing.pdf");
        let later = directory.path().join("broken.pdf");
        fs::write(&later, b"broken").unwrap();
        let result = run(&[&missing, &later], sibling());
        assert_eq!(result.issues.len(), 2);
        assert!(result.file.is_none());
        assert!(!directory.path().join("absent").exists());
    }

    #[test]
    fn optional_inspection_fixture_exports_sources_and_both_merge_modes() {
        let Some(root) = std::env::var_os("MERGE_TEST_OUTPUT_DIR") else {
            return;
        };
        let root = PathBuf::from(root);
        fs::create_dir_all(&root).unwrap();
        let directory =
            create_output_directory(&root, MergeOutputMode::SiblingFolder, "merge-fixture")
                .unwrap()
                .canonicalize()
                .unwrap();
        let first = directory.join("source-a.pdf");
        let second = directory.join("source-b.pdf");
        let destination = directory.join("custom-output");
        fs::create_dir(&destination).unwrap();
        create_pdf(&first, &["source-a-1", "source-a-2"], "1.2", None);
        create_pdf(&second, &["source-b-1"], "1.4", Some("2.0"));
        let expected_images = add_compressed_images(&first);
        for (path, color) in [(&first, "0.10 0.45 0.70"), (&second, "0.65 0.15 0.30")] {
            let mut document = Document::load(path).unwrap();
            let font = document.add_object(dictionary! {
                "Type" => "Font", "Subtype" => "Type1", "BaseFont" => "Helvetica",
            });
            for id in document.get_pages().values() {
                let mut page = super::super::standalone_page_dictionary(&document, *id).unwrap();
                let marker =
                    String::from_utf8(page.get(b"MergeMarker").unwrap().as_str().unwrap().to_vec())
                        .unwrap();
                let mut resources = page.get(b"Resources").unwrap().as_dict().unwrap().clone();
                resources.set("Font", dictionary! { "F1" => font });
                let mut content = format!(
                    "q\n{color} rg\n48 620 516 90 re f\nQ\nBT /F1 24 Tf 48 570 Td ({marker}) Tj ET\n"
                );
                if path == &first {
                    content.push_str("q 150 0 0 150 48 350 cm /Flate Do Q\nq 150 0 0 150 240 350 cm /Jpeg Do Q\n");
                }
                let contents =
                    document.add_object(Stream::new(dictionary! {}, content.into_bytes()));
                page.set("Resources", resources);
                page.set("Contents", contents);
                let target = document.get_dictionary_mut(*id).unwrap();
                target.set("Resources", page.get(b"Resources").unwrap().clone());
                target.set("Contents", contents);
            }
            document.save(path).unwrap();
        }
        let originals = [fs::read(&first).unwrap(), fs::read(&second).unwrap()];
        let custom_result = run(&[&first, &second], custom(&destination));
        let sibling_result = run(&[&first, &second], sibling());
        for result in [&custom_result, &sibling_result] {
            assert!(result.issues.is_empty(), "{:?}", result.issues);
            let file = result.file.as_ref().unwrap();
            let document = Document::load(&file.file_path).unwrap();
            assert_eq!(
                labels(&document),
                ["source-a-1", "source-a-2", "source-b-1"]
            );
            assert_eq!(document.version, "2.0");
            assert_eq!(image_bytes(&document), expected_images);
            validate_output(Path::new(&file.file_path), 3).unwrap();
        }
        assert_eq!(fs::read(&first).unwrap(), originals[0]);
        assert_eq!(fs::read(&second).unwrap(), originals[1]);
        let manifest = serde_json::json!({
            "expectedPageCount": 3,
            "expectedVersion": "2.0",
            "expectedPageMarkers": ["source-a-1", "source-a-2", "source-b-1"],
            "sourceFiles": [first, second],
            "customFolder": custom_result,
            "siblingFolder": sibling_result,
        });
        fs::write(
            directory.join("manifest.json"),
            serde_json::to_vec_pretty(&manifest).unwrap(),
        )
        .unwrap();
        println!("Merge inspection fixture: {}", directory.display());
    }

    #[test]
    fn parser_panics_become_errors() {
        let result = checked_operation::<()>(|| panic!("simulated decoder panic"));
        assert!(result.unwrap_err().contains("panicked"));
    }
}
