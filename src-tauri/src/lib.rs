use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::fmt::Write as FmtWrite;
use std::fs;
use std::io::BufWriter;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use chrono::Local;
use image_025::codecs::jpeg::JpegEncoder;
use image_025::image_dimensions;
use image_025::GenericImageView;
use lopdf::{
    dictionary, Dictionary, Document as LopdfDocument, Object, ObjectId, Stream, StringFormat,
};
use pdfium_auto::bind_pdfium_silent;
use pdfium_render::prelude::*;
use serde::{Deserialize, Serialize};
use tauri::{Emitter, Manager, State};
use thiserror::Error;
use ttf_parser::Face;

const THUMBNAIL_CACHE_TTL: Duration = Duration::from_secs(60 * 60 * 24);
const THUMBNAIL_CACHE_MAX_BYTES: u64 = 10 * 1024 * 1024 * 1024;
const THUMBNAIL_CACHE_CLEANUP_INTERVAL: Duration = Duration::from_secs(60 * 5);
const THUMBNAIL_CACHE_ROOT_NAME: &str = "SplitPDFStudio";
const THUMBNAIL_CACHE_DIR_NAME: &str = "thumbnail-cache";
const PDF_RENDER_SESSION_IDLE_TTL: Duration = Duration::from_secs(4);
const DETAIL_JPEG_PREVIEW_QUALITY: u8 = 76;
const SMALL_JPEG_PREVIEW_QUALITY: u8 = 66;
const PREVIEW_TARGET_WIDTH_MIN: i32 = 72;
const PREVIEW_TARGET_WIDTH_MAX: i32 = 4200;
const PREVIEW_TARGET_HEIGHT_MAX: i32 = 8400;
const OPEN_PDF_PATHS_EVENT: &str = "open-pdf-paths";
const SPLIT_PROGRESS_EVENT: &str = "split-progress";
const APP_POLICY_URLS: [&str; 2] = [
    "https://raw.githubusercontent.com/boyboyboy321/mpbpo-pdf-studio/main/app-policy.json",
    "https://github.com/boyboyboy321/mpbpo-pdf-studio/releases/latest/download/app-policy.json",
];
const PDF_APP_NAME: &str = "MpBPO PDF Studio";
const PDF_APP_SUBJECT: &str = "PDF processed with MpBPO PDF Studio";
const PAGE_INHERITABLE_KEYS: [&[u8]; 8] = [
    b"Resources",
    b"MediaBox",
    b"CropBox",
    b"Rotate",
    b"BleedBox",
    b"TrimBox",
    b"ArtBox",
    b"UserUnit",
];

static PDFIUM_BIND_LOCK: Mutex<()> = Mutex::new(());
static PDFIUM_RENDER_LOCK: Mutex<()> = Mutex::new(());

#[cfg(target_os = "windows")]
#[link(name = "kernel32")]
unsafe extern "system" {
    fn GetCurrentProcess() -> isize;
    fn SetProcessWorkingSetSize(
        process: isize,
        minimum_working_set_size: usize,
        maximum_working_set_size: usize,
    ) -> i32;
}

#[cfg(target_os = "windows")]
fn trim_process_working_set() {
    unsafe {
        let _ = SetProcessWorkingSetSize(GetCurrentProcess(), usize::MAX, usize::MAX);
    }
}

#[cfg(not(target_os = "windows"))]
fn trim_process_working_set() {}

#[derive(Debug, Error)]
enum AppError {
    #[error("File does not exist: {0}")]
    NotFound(String),
    #[error("Could not read file metadata: {0}")]
    Metadata(#[from] std::io::Error),
    #[error("Selected file is not a PDF: {0}")]
    NotPdf(String),
    #[error("Could not read PDF pages: {0}")]
    Pdf(#[from] lopdf::Error),
    #[error("PDF has no readable pages")]
    NoPages,
    #[error("Select at least one split point before splitting")]
    NoCutPoints,
    #[error("Invalid split point before page {0}")]
    InvalidCut(u32),
    #[error("Split output validation failed: {0}")]
    SplitValidation(String),
    #[error("Could not render page preview: {0}")]
    Preview(String),
    #[error("PDF render state is unavailable: {0}")]
    State(String),
    #[error("Selected insert file must be a PDF, PNG, JPG, or JPEG: {0}")]
    UnsupportedInsertFile(String),
}

impl Serialize for AppError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::ser::Serializer,
    {
        serializer.serialize_str(self.to_string().as_ref())
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PdfMetadata {
    file_path: String,
    file_name: String,
    size_bytes: u64,
    page_count: u32,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct OpenPdfPathsPayload {
    paths: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PdfPagePreview {
    page_number: u32,
    width: u32,
    height: u32,
    data_url: String,
    file_path: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ImageColorSample {
    color: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SplitOutputFile {
    file_path: String,
    file_name: String,
    start_page: u32,
    end_page: u32,
    page_count: u32,
    size_bytes: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SplitResult {
    output_dir: String,
    files: Vec<SplitOutputFile>,
    source_delete_error: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SplitProgress {
    run_id: String,
    completed_files: usize,
    total_files: usize,
    current_file_name: String,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct AppPolicy {
    app_id: Option<String>,
    blocked: Option<bool>,
    blocked_message: Option<String>,
    blocked_versions: Option<Vec<String>>,
    mandatory_update: Option<bool>,
    message: Option<String>,
    min_version: Option<String>,
    schema_version: Option<u32>,
    version: Option<String>,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
enum SplitOutputMode {
    SiblingFolder,
    OriginalFolderDeleteOriginal,
    CustomFolder,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SplitOutputOptions {
    mode: SplitOutputMode,
    custom_folder_path: Option<String>,
}

impl Default for SplitOutputOptions {
    fn default() -> Self {
        Self {
            mode: SplitOutputMode::SiblingFolder,
            custom_folder_path: None,
        }
    }
}

struct SplitOutputPlan {
    delete_source_after_success: bool,
    output_dir: PathBuf,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
enum PageSource {
    Pdf {
        file_name: String,
        file_path: String,
        page_number: u32,
    },
    Image {
        file_name: String,
        file_path: String,
        width: u32,
        height: u32,
    },
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct EditPagePlan {
    #[serde(default)]
    paint_edits: Vec<PagePaintEdit>,
    source: PageSource,
    rotation: u16,
}

#[derive(Clone, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
enum PagePaintEdit {
    Cover {
        color: String,
        height: f64,
        width: f64,
        x: f64,
        y: f64,
    },
    Crop {
        height: f64,
        width: f64,
        x: f64,
        y: f64,
    },
    Straighten {
        degrees: f64,
    },
    Text {
        bold: bool,
        color: String,
        font_family: String,
        font_size: f64,
        height: f64,
        italic: bool,
        #[serde(default = "default_text_align")]
        text_align: String,
        text: String,
        underline: bool,
        width: f64,
        x: f64,
        y: f64,
    },
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct InsertPageMetadata {
    source: PageSource,
}

#[derive(Clone, Copy)]
struct PageRange {
    start: u32,
    end: u32,
}

#[derive(Clone, Copy)]
struct PageCrop {
    height: f64,
    width: f64,
    x: f64,
    y: f64,
}

struct PageGeometryEdits {
    crop: Option<PageCrop>,
    straighten_degrees: f64,
}

#[derive(Clone, Copy)]
struct PageBox {
    height: f64,
    width: f64,
    x1: f64,
    y1: f64,
    y2: f64,
}

#[derive(Clone, Copy)]
struct NormalizedPoint {
    x: f64,
    y: f64,
}

#[derive(Clone, Copy)]
struct NormalizedRect {
    height: f64,
    width: f64,
    x: f64,
    y: f64,
}

#[derive(Clone, Copy)]
struct PdfPoint {
    x: f64,
    y: f64,
}

#[derive(Clone)]
struct AppState {
    inner: Arc<AppStateInner>,
}

struct AppStateInner {
    renderer: PdfRenderWorker,
    last_cache_cleanup: Mutex<Option<Instant>>,
}

struct PdfRenderWorker {
    sender: Mutex<mpsc::Sender<RenderCommand>>,
}

enum RenderCommand {
    Render(RenderJob),
    Release { response: mpsc::Sender<()> },
}

struct RenderJob {
    fingerprint: PdfFingerprint,
    pages: Vec<RenderPageRequest>,
    target_width: i32,
    maximum_height: i32,
    jpeg_quality: u8,
    response: mpsc::Sender<Result<Vec<PdfPagePreview>, String>>,
}

struct RenderPageRequest {
    page_number: u32,
    cache_file: PathBuf,
}

struct WorkerPdfSession<'a> {
    fingerprint: PdfFingerprint,
    document: PdfDocument<'a>,
}

#[derive(Clone, PartialEq, Eq)]
struct PdfFingerprint {
    canonical_path: PathBuf,
    size_bytes: u64,
    modified_nanos: u128,
}

struct CacheEntry {
    path: PathBuf,
    size_bytes: u64,
    modified: SystemTime,
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
enum RenderLane {
    Thumbnail,
    Zoom,
    Full,
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            inner: Arc::new(AppStateInner {
                renderer: PdfRenderWorker::new(),
                last_cache_cleanup: Mutex::new(None),
            }),
        }
    }
}

impl PdfRenderWorker {
    fn new() -> Self {
        let (sender, receiver) = mpsc::channel();
        thread::Builder::new()
            .name("splitpdf-pdfium-renderer".to_string())
            .spawn(move || render_worker_loop(receiver))
            .expect("start PDF thumbnail renderer");

        Self {
            sender: Mutex::new(sender),
        }
    }

    fn render(
        &self,
        fingerprint: PdfFingerprint,
        pages: Vec<RenderPageRequest>,
        target_width: i32,
        maximum_height: i32,
        jpeg_quality: u8,
    ) -> Result<Vec<PdfPagePreview>, AppError> {
        let (response, result) = mpsc::channel();
        let job = RenderJob {
            fingerprint,
            pages,
            target_width,
            maximum_height,
            jpeg_quality,
            response,
        };

        self.sender
            .lock()
            .map_err(|_| AppError::State("PDF render worker lock was poisoned".to_string()))?
            .send(RenderCommand::Render(job))
            .map_err(|_| AppError::State("PDF render worker stopped".to_string()))?;

        result
            .recv()
            .map_err(|_| AppError::State("PDF render worker did not return a result".to_string()))?
            .map_err(AppError::Preview)
    }

    fn release_session(&self) -> Result<(), AppError> {
        let (response, result) = mpsc::channel();
        self.sender
            .lock()
            .map_err(|_| AppError::State("PDF render worker lock was poisoned".to_string()))?
            .send(RenderCommand::Release { response })
            .map_err(|_| AppError::State("PDF render worker stopped".to_string()))?;

        result.recv().map_err(|_| {
            AppError::State("PDF render worker did not release the current PDF".to_string())
        })
    }
}

impl AppState {
    fn render_pdf_pages(&self, job: RenderJobInput) -> Result<Vec<PdfPagePreview>, AppError> {
        self.inner.renderer.render(
            job.fingerprint,
            job.pages,
            job.target_width,
            job.maximum_height,
            job.jpeg_quality,
        )
    }

    fn release_render_session(&self) -> Result<(), AppError> {
        self.inner.renderer.release_session()
    }

    fn cleanup_thumbnail_cache_if_due(&self) -> Result<(), AppError> {
        let now = Instant::now();
        let mut last_cleanup = self
            .inner
            .last_cache_cleanup
            .lock()
            .map_err(|_| AppError::State("Cache cleanup lock was poisoned".to_string()))?;

        if last_cleanup.is_some_and(|last_cleanup| {
            now.duration_since(last_cleanup) < THUMBNAIL_CACHE_CLEANUP_INTERVAL
        }) {
            return Ok(());
        }

        *last_cleanup = Some(now);
        cleanup_thumbnail_cache();
        Ok(())
    }
}

struct RenderJobInput {
    fingerprint: PdfFingerprint,
    pages: Vec<RenderPageRequest>,
    target_width: i32,
    maximum_height: i32,
    jpeg_quality: u8,
}

#[tauri::command]
fn read_pdf_metadata(path: String) -> Result<PdfMetadata, AppError> {
    let file_path = Path::new(&path);
    validate_pdf_path(file_path, &path)?;
    let metadata = fs::metadata(file_path)?;
    let file_name = file_path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("document.pdf")
        .to_string();
    let page_count = read_page_count(file_path)?;

    Ok(PdfMetadata {
        file_path: file_path.to_string_lossy().to_string(),
        file_name,
        size_bytes: metadata.len(),
        page_count,
    })
}

#[tauri::command]
fn read_startup_pdf_path() -> Option<String> {
    read_startup_pdf_paths().into_iter().next()
}

#[tauri::command]
fn read_startup_pdf_paths() -> Vec<String> {
    std::env::args_os()
        .skip(1)
        .filter_map(|argument| {
            let path = PathBuf::from(argument);
            if path.is_file() && is_pdf(&path) {
                Some(path.to_string_lossy().to_string())
            } else {
                None
            }
        })
        .collect()
}

#[tauri::command]
async fn fetch_app_policy() -> Result<AppPolicy, AppError> {
    tauri::async_runtime::spawn_blocking(fetch_app_policy_impl)
        .await
        .map_err(|error| AppError::State(format!("App policy task failed: {error}")))?
}

fn fetch_app_policy_impl() -> Result<AppPolicy, AppError> {
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(8))
        .user_agent("MpBPO PDF Studio")
        .build()
        .map_err(|error| AppError::State(format!("Could not prepare policy client: {error}")))?;

    let mut errors = Vec::new();

    for url in APP_POLICY_URLS {
        let response = match client
            .get(url)
            .header(reqwest::header::ACCEPT, "application/json")
            .header(reqwest::header::CACHE_CONTROL, "no-cache")
            .send()
        {
            Ok(response) => response,
            Err(error) => {
                errors.push(format!("{url}: {error}"));
                continue;
            }
        };

        if !response.status().is_success() {
            errors.push(format!("{url}: HTTP {}", response.status()));
            continue;
        }

        return response
            .json::<AppPolicy>()
            .map_err(|error| AppError::State(format!("Could not parse app policy: {error}")));
    }

    Err(AppError::State(format!(
        "Could not load app policy from any source: {}",
        errors.join("; ")
    )))
}

#[tauri::command]
async fn sample_image_color(
    file_path: String,
    x: f64,
    y: f64,
    radius: Option<u32>,
) -> Result<ImageColorSample, AppError> {
    tauri::async_runtime::spawn_blocking(move || sample_image_color_impl(file_path, x, y, radius))
        .await
        .map_err(|error| AppError::State(format!("Color sample task failed: {error}")))?
}

fn sample_image_color_impl(
    file_path: String,
    x: f64,
    y: f64,
    radius: Option<u32>,
) -> Result<ImageColorSample, AppError> {
    let path = Path::new(&file_path);
    if !path.exists() {
        return Err(AppError::NotFound(file_path));
    }

    let image = image_025::open(path).map_err(|error| AppError::Preview(error.to_string()))?;
    let rgb = image.to_rgb8();
    let (image_width, image_height) = rgb.dimensions();
    if image_width == 0 || image_height == 0 {
        return Err(AppError::Preview("Image has no pixels".to_string()));
    }

    let radius = radius.unwrap_or(4).min(16);
    let center_x = (x.clamp(0.0, 1.0) * f64::from(image_width.saturating_sub(1))).round() as u32;
    let center_y = (y.clamp(0.0, 1.0) * f64::from(image_height.saturating_sub(1))).round() as u32;
    let left = center_x.saturating_sub(radius);
    let top = center_y.saturating_sub(radius);
    let right = center_x.saturating_add(radius).min(image_width - 1);
    let bottom = center_y.saturating_add(radius).min(image_height - 1);
    let mut red = 0_u64;
    let mut green = 0_u64;
    let mut blue = 0_u64;
    let mut count = 0_u64;

    for sample_y in top..=bottom {
        for sample_x in left..=right {
            let [pixel_red, pixel_green, pixel_blue] = rgb.get_pixel(sample_x, sample_y).0;
            red += u64::from(pixel_red);
            green += u64::from(pixel_green);
            blue += u64::from(pixel_blue);
            count += 1;
        }
    }

    if count == 0 {
        return Err(AppError::Preview("Image sample was empty".to_string()));
    }

    Ok(ImageColorSample {
        color: format!(
            "#{:02x}{:02x}{:02x}",
            red / count,
            green / count,
            blue / count
        ),
    })
}

#[tauri::command]
async fn split_pdf(
    state: State<'_, AppState>,
    app: tauri::AppHandle,
    path: String,
    cut_before_pages: Vec<u32>,
    output_options: Option<SplitOutputOptions>,
    run_id: String,
) -> Result<SplitResult, AppError> {
    state.release_render_session()?;
    let result = tauri::async_runtime::spawn_blocking(move || {
        split_pdf_impl(path, cut_before_pages, run_id, output_options, |progress| {
            let _ = app.emit(SPLIT_PROGRESS_EVENT, progress);
        })
    })
    .await
    .map_err(|error| AppError::State(format!("PDF split task failed: {error}")))?;
    trim_process_working_set();
    result
}

#[tauri::command]
async fn split_pdf_with_edits(
    state: State<'_, AppState>,
    app: tauri::AppHandle,
    path: String,
    pages: Vec<EditPagePlan>,
    cut_before_pages: Vec<u32>,
    output_options: Option<SplitOutputOptions>,
    run_id: String,
) -> Result<SplitResult, AppError> {
    state.release_render_session()?;
    let result = tauri::async_runtime::spawn_blocking(move || {
        split_pdf_with_edits_impl(
            path,
            pages,
            cut_before_pages,
            run_id,
            output_options,
            |progress| {
                let _ = app.emit(SPLIT_PROGRESS_EVENT, progress);
            },
        )
    })
    .await
    .map_err(|error| AppError::State(format!("PDF split task failed: {error}")))?;
    trim_process_working_set();
    result
}

#[tauri::command]
async fn open_folder(path: String) -> Result<(), AppError> {
    tauri::async_runtime::spawn_blocking(move || open_folder_impl(Path::new(&path)))
        .await
        .map_err(|error| AppError::State(format!("Open folder task failed: {error}")))?
}

#[tauri::command]
fn minimize_main_window(app: tauri::AppHandle) -> Result<(), AppError> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| AppError::State("Main window was not found".to_string()))?;

    window
        .minimize()
        .map_err(|error| AppError::State(format!("Could not minimize window: {error}")))
}

#[tauri::command]
fn toggle_main_window_maximize(app: tauri::AppHandle) -> Result<(), AppError> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| AppError::State("Main window was not found".to_string()))?;
    let is_maximized = window
        .is_maximized()
        .map_err(|error| AppError::State(format!("Could not read window state: {error}")))?;

    if is_maximized {
        window
            .unmaximize()
            .map_err(|error| AppError::State(format!("Could not restore window: {error}")))
    } else {
        window
            .maximize()
            .map_err(|error| AppError::State(format!("Could not maximize window: {error}")))
    }
}

#[tauri::command]
fn close_main_window(app: tauri::AppHandle) -> Result<(), AppError> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| AppError::State("Main window was not found".to_string()))?;

    window
        .close()
        .map_err(|error| AppError::State(format!("Could not close window: {error}")))
}

#[tauri::command]
fn start_main_window_drag(app: tauri::AppHandle) -> Result<(), AppError> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| AppError::State("Main window was not found".to_string()))?;

    window
        .start_dragging()
        .map_err(|error| AppError::State(format!("Could not drag window: {error}")))
}

fn split_pdf_impl<F>(
    path: String,
    cut_before_pages: Vec<u32>,
    run_id: String,
    output_options: Option<SplitOutputOptions>,
    mut on_progress: F,
) -> Result<SplitResult, AppError>
where
    F: FnMut(SplitProgress),
{
    let file_path = Path::new(&path);
    validate_pdf_path(file_path, &path)?;

    let source_document = LopdfDocument::load(file_path)?;
    let page_count = document_page_count(&source_document)?;
    let ranges = build_ranges(page_count, cut_before_pages)?;
    let run_prefix = split_run_prefix();
    let output_plan =
        split_output_plan(file_path, output_options.unwrap_or_default(), &run_prefix)?;
    let output_dir = output_plan.output_dir;
    fs::create_dir_all(&output_dir)?;

    let stem = file_path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("document");
    let index_width = output_index_width(ranges.len());

    let mut files = Vec::with_capacity(ranges.len());
    let total_files = ranges.len();

    on_progress(SplitProgress {
        run_id: run_id.clone(),
        completed_files: 0,
        total_files,
        current_file_name: String::new(),
    });

    for (index, range) in ranges.iter().enumerate() {
        let output_file_name = split_output_file_name(stem, index + 1, index_width);
        let output_path = unique_output_path(&output_dir, &output_file_name);
        write_page_range(&source_document, &output_path, *range)
            .and_then(|_| validate_split_output(&output_path, *range))
            .or_else(|_| {
                let _ = fs::remove_file(&output_path);
                write_page_range_by_deletion(
                    &source_document,
                    file_path,
                    &output_path,
                    page_count,
                    *range,
                )?;
                validate_split_output(&output_path, *range)
            })?;
        let output_metadata = fs::metadata(&output_path)?;
        let output_file_name = output_path
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or(output_file_name.as_str())
            .to_string();

        files.push(SplitOutputFile {
            file_path: output_path.to_string_lossy().to_string(),
            file_name: output_file_name.clone(),
            start_page: range.start,
            end_page: range.end,
            page_count: range.end - range.start + 1,
            size_bytes: output_metadata.len(),
        });

        on_progress(SplitProgress {
            run_id: run_id.clone(),
            completed_files: index + 1,
            total_files,
            current_file_name: output_file_name,
        });
    }

    drop(source_document);
    let source_delete_error =
        finalize_split_output(file_path, &files, output_plan.delete_source_after_success)?;

    Ok(SplitResult {
        output_dir: output_dir.to_string_lossy().to_string(),
        files,
        source_delete_error,
    })
}

fn split_pdf_with_edits_impl<F>(
    path: String,
    pages: Vec<EditPagePlan>,
    cut_before_pages: Vec<u32>,
    run_id: String,
    output_options: Option<SplitOutputOptions>,
    mut on_progress: F,
) -> Result<SplitResult, AppError>
where
    F: FnMut(SplitProgress),
{
    if pages.is_empty() {
        return Err(AppError::SplitValidation(
            "Cannot split a PDF with no pages".to_string(),
        ));
    }

    let file_path = Path::new(&path);
    validate_pdf_path(file_path, &path)?;

    let page_count = pages.len() as u32;
    let ranges = build_ranges(page_count, cut_before_pages)?;
    let run_prefix = split_run_prefix();
    let output_plan =
        split_output_plan(file_path, output_options.unwrap_or_default(), &run_prefix)?;
    let output_dir = output_plan.output_dir;
    fs::create_dir_all(&output_dir)?;

    let stem = file_path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("document");
    let index_width = output_index_width(ranges.len());
    let mut source_documents = load_edit_source_documents(&pages)?;
    let mut files = Vec::with_capacity(ranges.len());
    let total_files = ranges.len();

    on_progress(SplitProgress {
        run_id: run_id.clone(),
        completed_files: 0,
        total_files,
        current_file_name: String::new(),
    });

    for (index, range) in ranges.iter().enumerate() {
        let output_file_name = split_output_file_name(stem, index + 1, index_width);
        let output_path = unique_output_path(&output_dir, &output_file_name);
        let start_index = (range.start - 1) as usize;
        let end_index = range.end as usize;
        let page_slice = &pages[start_index..end_index];
        write_edited_pdf(&mut source_documents, page_slice, &output_path)?;
        validate_edit_output(&output_path, page_slice.len() as u32)?;

        let output_metadata = fs::metadata(&output_path)?;
        let output_file_name = output_path
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or(output_file_name.as_str())
            .to_string();

        files.push(SplitOutputFile {
            file_path: output_path.to_string_lossy().to_string(),
            file_name: output_file_name.clone(),
            start_page: range.start,
            end_page: range.end,
            page_count: range.end - range.start + 1,
            size_bytes: output_metadata.len(),
        });

        on_progress(SplitProgress {
            run_id: run_id.clone(),
            completed_files: index + 1,
            total_files,
            current_file_name: output_file_name,
        });
    }

    drop(source_documents);
    let source_delete_error =
        finalize_split_output(file_path, &files, output_plan.delete_source_after_success)?;

    Ok(SplitResult {
        output_dir: output_dir.to_string_lossy().to_string(),
        files,
        source_delete_error,
    })
}

fn open_folder_impl(path: &Path) -> Result<(), AppError> {
    if !path.exists() {
        return Err(AppError::NotFound(path.to_string_lossy().to_string()));
    }

    #[cfg(target_os = "windows")]
    {
        Command::new("explorer").arg(path).spawn()?;
    }

    #[cfg(target_os = "macos")]
    {
        Command::new("open").arg(path).spawn()?;
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        Command::new("xdg-open").arg(path).spawn()?;
    }

    Ok(())
}

#[tauri::command]
async fn read_insert_pages(paths: Vec<String>) -> Result<Vec<InsertPageMetadata>, AppError> {
    tauri::async_runtime::spawn_blocking(move || read_insert_pages_impl(paths))
        .await
        .map_err(|error| AppError::State(format!("Read insert file task failed: {error}")))?
}

fn read_insert_pages_impl(paths: Vec<String>) -> Result<Vec<InsertPageMetadata>, AppError> {
    let mut pages = Vec::new();

    for path in paths {
        let file_path = Path::new(&path);
        if !file_path.exists() {
            return Err(AppError::NotFound(path));
        }

        let file_name = file_path
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("insert")
            .to_string();

        if is_pdf(file_path) {
            let page_count = read_page_count(file_path)?;
            for page_number in 1..=page_count {
                pages.push(InsertPageMetadata {
                    source: PageSource::Pdf {
                        file_name: file_name.clone(),
                        file_path: file_path.to_string_lossy().to_string(),
                        page_number,
                    },
                });
            }
            continue;
        }

        if is_supported_image(file_path) {
            let (width, height) = image_dimensions(file_path)
                .map_err(|error| AppError::Preview(error.to_string()))?;
            pages.push(InsertPageMetadata {
                source: PageSource::Image {
                    file_name,
                    file_path: file_path.to_string_lossy().to_string(),
                    width,
                    height,
                },
            });
            continue;
        }

        return Err(AppError::UnsupportedInsertFile(
            file_path.to_string_lossy().to_string(),
        ));
    }

    Ok(pages)
}

#[tauri::command]
async fn save_pdf_edits(
    state: State<'_, AppState>,
    path: String,
    pages: Vec<EditPagePlan>,
) -> Result<PdfMetadata, AppError> {
    state.release_render_session()?;
    let result = tauri::async_runtime::spawn_blocking(move || save_pdf_edits_impl(path, pages))
        .await
        .map_err(|error| AppError::State(format!("PDF save task failed: {error}")))?;
    trim_process_working_set();
    result
}

#[tauri::command]
async fn render_pdf_pages(
    state: State<'_, AppState>,
    path: String,
    page_numbers: Vec<u32>,
    target_width: i32,
    jpeg_quality: Option<u8>,
    priority: Option<bool>,
    render_lane: Option<RenderLane>,
) -> Result<Vec<PdfPagePreview>, AppError> {
    let state = state.inner().clone();
    let lane = render_lane.unwrap_or_else(|| {
        if priority.unwrap_or(false) {
            RenderLane::Zoom
        } else {
            RenderLane::Thumbnail
        }
    });

    tauri::async_runtime::spawn_blocking(move || {
        render_pdf_pages_impl(&state, path, page_numbers, target_width, lane, jpeg_quality)
    })
    .await
    .map_err(|error| AppError::State(format!("PDF preview task failed: {error}")))?
}

fn render_pdf_pages_impl(
    state: &AppState,
    path: String,
    page_numbers: Vec<u32>,
    target_width: i32,
    lane: RenderLane,
    jpeg_quality: Option<u8>,
) -> Result<Vec<PdfPagePreview>, AppError> {
    let file_path = Path::new(&path);
    validate_pdf_path(file_path, &path)?;

    if page_numbers.is_empty() {
        return Ok(Vec::new());
    }

    state.cleanup_thumbnail_cache_if_due()?;

    let target_width = target_width.clamp(PREVIEW_TARGET_WIDTH_MIN, PREVIEW_TARGET_WIDTH_MAX);
    let maximum_height = (target_width * 3).min(PREVIEW_TARGET_HEIGHT_MAX);
    let jpeg_quality = jpeg_quality
        .map(clamp_jpeg_quality)
        .unwrap_or_else(|| preview_jpeg_quality(lane));
    let mut unique_pages = page_numbers;
    unique_pages.sort_unstable();
    unique_pages.dedup();

    let fingerprint = pdf_fingerprint(file_path)?;
    let cache_key = thumbnail_cache_key(&fingerprint);
    let mut previews_by_page = BTreeMap::new();
    let mut pages_to_render = Vec::new();

    for page_number in unique_pages
        .iter()
        .copied()
        .filter(|page| *page >= 1)
        .take(32)
    {
        let cache_file = thumbnail_cache_file(
            &fingerprint,
            &cache_key,
            page_number,
            target_width,
            jpeg_quality,
            lane,
        )?;
        match cached_preview_from_file(page_number, &cache_file) {
            Some(preview) => {
                previews_by_page.insert(page_number, preview);
            }
            None => pages_to_render.push((page_number, cache_file)),
        }
    }

    if !pages_to_render.is_empty() {
        let rendered_previews = state.render_pdf_pages(RenderJobInput {
            fingerprint,
            pages: pages_to_render
                .into_iter()
                .map(|(page_number, cache_file)| RenderPageRequest {
                    page_number,
                    cache_file,
                })
                .collect(),
            target_width,
            maximum_height,
            jpeg_quality,
        })?;

        for preview in rendered_previews {
            previews_by_page.insert(preview.page_number, preview);
        }
    }

    Ok(unique_pages
        .into_iter()
        .filter_map(|page_number| previews_by_page.remove(&page_number))
        .collect())
}

fn render_worker_loop(receiver: mpsc::Receiver<RenderCommand>) {
    let pdfium = match bind_pdfium_for_worker() {
        Ok(pdfium) => pdfium,
        Err(error) => {
            let message = format!("Could not prepare PDF renderer: {error}");
            for command in receiver {
                match command {
                    RenderCommand::Render(job) => {
                        let _ = job.response.send(Err(message.clone()));
                    }
                    RenderCommand::Release { response } => {
                        let _ = response.send(());
                    }
                }
            }
            return;
        }
    };

    let mut current_session: Option<WorkerPdfSession<'_>> = None;

    loop {
        match receiver.recv_timeout(PDF_RENDER_SESSION_IDLE_TTL) {
            Ok(RenderCommand::Render(job)) => {
                respond_to_render_job(&pdfium, &mut current_session, job);
            }
            Ok(RenderCommand::Release { response }) => {
                if current_session.take().is_some() {
                    trim_process_working_set();
                }
                let _ = response.send(());
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {
                if current_session.take().is_some() {
                    trim_process_working_set();
                }
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }
}

fn bind_pdfium_for_worker() -> Result<Pdfium, String> {
    let _guard = PDFIUM_BIND_LOCK
        .lock()
        .map_err(|_| "PDF renderer bind lock was poisoned".to_string())?;
    bind_pdfium_silent().map_err(|error| error.to_string())
}

fn respond_to_render_job<'a>(
    pdfium: &'a Pdfium,
    current_session: &mut Option<WorkerPdfSession<'a>>,
    job: RenderJob,
) {
    let should_reload = current_session
        .as_ref()
        .is_none_or(|session| session.fingerprint != job.fingerprint);

    let result = if should_reload {
        let load_result = PDFIUM_RENDER_LOCK
            .lock()
            .map_err(|_| "PDF renderer lock was poisoned".to_string())
            .and_then(|_guard| {
                pdfium
                    .load_pdf_from_file(&job.fingerprint.canonical_path, None)
                    .map_err(|error| error.to_string())
            });

        match load_result {
            Ok(document) => {
                *current_session = Some(WorkerPdfSession {
                    fingerprint: job.fingerprint.clone(),
                    document,
                });
                current_session
                    .as_ref()
                    .map(|session| render_worker_job(&session.document, &job))
                    .unwrap_or_else(|| Err("PDF session was not initialized".to_string()))
            }
            Err(error) => Err(error),
        }
    } else {
        current_session
            .as_ref()
            .map(|session| render_worker_job(&session.document, &job))
            .unwrap_or_else(|| Err("PDF session was not initialized".to_string()))
    };

    let _ = job.response.send(result);
}

fn render_worker_job(
    document: &PdfDocument<'_>,
    job: &RenderJob,
) -> Result<Vec<PdfPagePreview>, String> {
    let render_config = PdfRenderConfig::new()
        .set_target_width(job.target_width)
        .set_maximum_height(job.maximum_height)
        .use_print_quality(false)
        .render_form_data(false);
    let page_count = document.pages().len() as u32;
    let mut previews = Vec::with_capacity(job.pages.len());

    for request in &job.pages {
        if request.page_number > page_count {
            continue;
        }

        if let Some(preview) = cached_preview_from_file(request.page_number, &request.cache_file) {
            previews.push(preview);
            continue;
        }

        let page = document
            .pages()
            .get((request.page_number - 1) as PdfPageIndex)
            .map_err(|error| error.to_string())?;
        let image = {
            let _guard = PDFIUM_RENDER_LOCK
                .lock()
                .map_err(|_| "PDF renderer lock was poisoned".to_string())?;
            page.render_with_config(&render_config)
                .map_err(|error| error.to_string())?
                .as_image()
        };
        let (width, height) = image.dimensions();
        write_preview_image(&image, &request.cache_file, job.jpeg_quality)
            .map_err(|error| error.to_string())?;

        previews.push(PdfPagePreview {
            page_number: request.page_number,
            width,
            height,
            data_url: String::new(),
            file_path: request.cache_file.to_string_lossy().to_string(),
        });
    }

    Ok(previews)
}

fn pdf_fingerprint(file_path: &Path) -> Result<PdfFingerprint, AppError> {
    let canonical_path = file_path.canonicalize()?;
    let metadata = fs::metadata(&canonical_path)?;
    let modified_nanos = metadata
        .modified()
        .ok()
        .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();

    Ok(PdfFingerprint {
        canonical_path,
        size_bytes: metadata.len(),
        modified_nanos,
    })
}

fn thumbnail_cache_key(fingerprint: &PdfFingerprint) -> String {
    let mut hash = 0xcbf29ce484222325;
    hash_bytes(
        &mut hash,
        fingerprint.canonical_path.to_string_lossy().as_bytes(),
    );
    hash_bytes(&mut hash, &fingerprint.size_bytes.to_le_bytes());
    hash_bytes(&mut hash, &fingerprint.modified_nanos.to_le_bytes());
    format!("{hash:016x}")
}

fn hash_bytes(hash: &mut u64, bytes: &[u8]) {
    for byte in bytes {
        *hash ^= u64::from(*byte);
        *hash = hash.wrapping_mul(0x100000001b3);
    }
}

fn thumbnail_cache_root() -> PathBuf {
    std::env::temp_dir()
        .join(THUMBNAIL_CACHE_ROOT_NAME)
        .join(THUMBNAIL_CACHE_DIR_NAME)
}

fn thumbnail_cache_document_dir(fingerprint: &PdfFingerprint, cache_key: &str) -> PathBuf {
    let raw_name = fingerprint
        .canonical_path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("document");

    thumbnail_cache_root().join(format!(
        "{}_{}",
        sanitize_cache_component(raw_name),
        cache_key
    ))
}

fn sanitize_cache_component(value: &str) -> String {
    let mut safe = String::with_capacity(value.len());

    for character in value.chars() {
        if character.is_control()
            || matches!(
                character,
                '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*'
            )
        {
            safe.push('_');
        } else if character.is_whitespace() {
            safe.push('_');
        } else {
            safe.push(character);
        }
    }

    let trimmed = safe.trim_matches(|character| matches!(character, '_' | '.' | ' '));
    if trimmed.is_empty() {
        "document".to_string()
    } else {
        trimmed.chars().take(80).collect()
    }
}

fn thumbnail_cache_bucket_name(lane: RenderLane) -> &'static str {
    match lane {
        RenderLane::Thumbnail => "small",
        RenderLane::Zoom | RenderLane::Full => "980px",
    }
}

fn preview_jpeg_quality(lane: RenderLane) -> u8 {
    match lane {
        RenderLane::Thumbnail => SMALL_JPEG_PREVIEW_QUALITY,
        RenderLane::Zoom | RenderLane::Full => DETAIL_JPEG_PREVIEW_QUALITY,
    }
}

fn clamp_jpeg_quality(jpeg_quality: u8) -> u8 {
    jpeg_quality.clamp(45, 96)
}

fn thumbnail_cache_file(
    fingerprint: &PdfFingerprint,
    cache_key: &str,
    page_number: u32,
    target_width: i32,
    jpeg_quality: u8,
    lane: RenderLane,
) -> Result<PathBuf, AppError> {
    let root = thumbnail_cache_document_dir(fingerprint, cache_key)
        .join(thumbnail_cache_bucket_name(lane));
    fs::create_dir_all(&root)?;

    let file_name = format!("w{target_width}_q{jpeg_quality}_p{page_number:06}.jpg");

    Ok(root.join(file_name))
}

fn cached_preview_from_file(page_number: u32, cache_file: &Path) -> Option<PdfPagePreview> {
    if !cache_file.is_file() {
        return None;
    }

    match image_dimensions(cache_file) {
        Ok((width, height)) => Some(PdfPagePreview {
            page_number,
            width,
            height,
            data_url: String::new(),
            file_path: cache_file.to_string_lossy().to_string(),
        }),
        Err(_) => {
            let _ = fs::remove_file(cache_file);
            None
        }
    }
}

fn write_preview_image(
    image: &image_025::DynamicImage,
    cache_file: &Path,
    jpeg_quality: u8,
) -> Result<(), AppError> {
    if let Some(parent) = cache_file.parent() {
        fs::create_dir_all(parent)?;
    }

    let temp_suffix = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let temp_file = cache_file.with_extension(format!("jpg.{}.tmp", temp_suffix));
    {
        let output = fs::File::create(&temp_file)?;
        let mut writer = BufWriter::new(output);
        JpegEncoder::new_with_quality(&mut writer, jpeg_quality)
            .encode_image(image)
            .map_err(|error| AppError::Preview(error.to_string()))?;
    }
    let _ = fs::remove_file(cache_file);
    fs::rename(&temp_file, cache_file)?;
    Ok(())
}

fn cleanup_thumbnail_cache() {
    let root = thumbnail_cache_root();
    if !root.is_dir() {
        return;
    }

    let now = SystemTime::now();
    let mut kept_entries = Vec::new();
    let mut total_size = 0_u64;

    collect_cache_entries(&root, now, &mut kept_entries, &mut total_size);

    if total_size <= THUMBNAIL_CACHE_MAX_BYTES {
        remove_empty_cache_dirs(&root);
        return;
    }

    kept_entries.sort_by_key(|entry| {
        entry
            .modified
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
    });

    for entry in kept_entries {
        if total_size <= THUMBNAIL_CACHE_MAX_BYTES {
            break;
        }

        if fs::remove_file(&entry.path).is_ok() {
            total_size = total_size.saturating_sub(entry.size_bytes);
        }
    }

    remove_empty_cache_dirs(&root);
}

fn collect_cache_entries(
    root: &Path,
    now: SystemTime,
    kept_entries: &mut Vec<CacheEntry>,
    total_size: &mut u64,
) {
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };

    for entry in entries.flatten() {
        let path = entry.path();

        if path.is_dir() {
            collect_cache_entries(&path, now, kept_entries, total_size);
            continue;
        }

        if !path.is_file() {
            continue;
        }

        let Ok(metadata) = entry.metadata() else {
            continue;
        };
        let modified = metadata.modified().unwrap_or(UNIX_EPOCH);
        let is_expired = now
            .duration_since(modified)
            .is_ok_and(|age| age > THUMBNAIL_CACHE_TTL);

        if is_expired {
            let _ = fs::remove_file(path);
            continue;
        }

        let size_bytes = metadata.len();
        *total_size = total_size.saturating_add(size_bytes);
        kept_entries.push(CacheEntry {
            path,
            size_bytes,
            modified,
        });
    }
}

fn remove_empty_cache_dirs(root: &Path) {
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };

    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            remove_empty_cache_dirs(&path);
            let _ = fs::remove_dir(path);
        }
    }
}

fn validate_pdf_path(file_path: &Path, original_path: &str) -> Result<(), AppError> {
    if !file_path.exists() {
        return Err(AppError::NotFound(original_path.to_string()));
    }

    if !is_pdf(file_path) {
        return Err(AppError::NotPdf(original_path.to_string()));
    }

    Ok(())
}

fn read_page_count(file_path: &Path) -> Result<u32, AppError> {
    let document = LopdfDocument::load(file_path)?;
    document_page_count(&document)
}

fn document_page_count(document: &LopdfDocument) -> Result<u32, AppError> {
    let page_count = document.get_pages().len();

    if page_count == 0 {
        return Err(AppError::NoPages);
    }

    Ok(page_count as u32)
}

fn build_ranges(page_count: u32, cut_before_pages: Vec<u32>) -> Result<Vec<PageRange>, AppError> {
    if cut_before_pages.is_empty() {
        return Err(AppError::NoCutPoints);
    }

    let mut cuts = cut_before_pages;
    cuts.sort_unstable();
    cuts.dedup();

    for cut in &cuts {
        if *cut <= 1 || *cut > page_count {
            return Err(AppError::InvalidCut(*cut));
        }
    }

    let mut ranges = Vec::with_capacity(cuts.len() + 1);
    let mut start = 1;

    for cut in cuts {
        ranges.push(PageRange {
            start,
            end: cut - 1,
        });
        start = cut;
    }

    ranges.push(PageRange {
        start,
        end: page_count,
    });
    Ok(ranges)
}

fn output_dir_for(file_path: &Path, run_prefix: &str) -> PathBuf {
    let parent = file_path.parent().unwrap_or_else(|| Path::new("."));
    let stem = file_path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("document");

    parent.join(format!("{}_split_{}", stem, run_prefix))
}

fn split_output_plan(
    file_path: &Path,
    output_options: SplitOutputOptions,
    run_prefix: &str,
) -> Result<SplitOutputPlan, AppError> {
    let parent = file_path.parent().unwrap_or_else(|| Path::new("."));

    match output_options.mode {
        SplitOutputMode::SiblingFolder => Ok(SplitOutputPlan {
            delete_source_after_success: false,
            output_dir: unique_output_dir(output_dir_for(file_path, run_prefix)),
        }),
        SplitOutputMode::OriginalFolderDeleteOriginal => Ok(SplitOutputPlan {
            delete_source_after_success: true,
            output_dir: parent.to_path_buf(),
        }),
        SplitOutputMode::CustomFolder => {
            let custom_folder_path = output_options
                .custom_folder_path
                .as_deref()
                .map(str::trim)
                .filter(|path| !path.is_empty())
                .ok_or_else(|| {
                    AppError::SplitValidation(
                        "Choose an output folder before splitting".to_string(),
                    )
                })?;

            Ok(SplitOutputPlan {
                delete_source_after_success: false,
                output_dir: PathBuf::from(custom_folder_path),
            })
        }
    }
}

fn finalize_split_output(
    source_path: &Path,
    files: &[SplitOutputFile],
    delete_source_after_success: bool,
) -> Result<Option<String>, AppError> {
    if files.is_empty() {
        return Err(AppError::SplitValidation(
            "No split output files were created".to_string(),
        ));
    }

    for file in files {
        let output_path = Path::new(&file.file_path);
        let metadata = fs::metadata(output_path)?;
        if !metadata.is_file() || metadata.len() == 0 {
            return Err(AppError::SplitValidation(format!(
                "Split output is missing or empty: {}",
                file.file_name
            )));
        }

        if delete_source_after_success && output_path == source_path {
            return Err(AppError::SplitValidation(
                "Refusing to delete the original because an output path matches it".to_string(),
            ));
        }
    }

    if delete_source_after_success {
        if let Err(error) = delete_source_file_after_split(source_path) {
            return Ok(Some(error.to_string()));
        }
    }

    Ok(None)
}

fn delete_source_file_after_split(source_path: &Path) -> Result<(), AppError> {
    const DELETE_RETRY_COUNT: usize = 40;
    const DELETE_RETRY_DELAY: Duration = Duration::from_millis(250);
    let mut last_error = String::new();

    for attempt in 0..DELETE_RETRY_COUNT {
        if !source_path.exists() {
            return Ok(());
        }

        match fs::remove_file(source_path) {
            Ok(()) => return Ok(()),
            Err(error) => {
                last_error = error.to_string();
                if attempt + 1 < DELETE_RETRY_COUNT {
                    thread::sleep(DELETE_RETRY_DELAY);
                }
            }
        }
    }

    Err(AppError::State(format!(
        "Could not delete the original PDF after splitting: {last_error}"
    )))
}

fn split_run_prefix() -> String {
    Local::now().format("%Y%m%d_%H%M%S_%3f").to_string()
}

fn output_index_width(total_files: usize) -> usize {
    total_files.to_string().len().max(3)
}

fn split_output_file_name(source_stem: &str, index: usize, index_width: usize) -> String {
    format!(
        "{source_stem}_{index:0index_width$}.pdf",
        index = index,
        index_width = index_width
    )
}

fn unique_output_dir(output_dir: PathBuf) -> PathBuf {
    if !output_dir.exists() {
        return output_dir;
    }

    let folder_name = output_dir
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("split_output");

    for suffix in 2.. {
        let candidate = output_dir.with_file_name(format!("{folder_name}_{suffix}"));

        if !candidate.exists() {
            return candidate;
        }
    }

    unreachable!("infinite suffix search should always find a writable folder name")
}

fn unique_output_path(output_dir: &Path, file_name: &str) -> PathBuf {
    let candidate = output_dir.join(file_name);

    if !candidate.exists() {
        return candidate;
    }

    let file_stem = Path::new(file_name)
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or(file_name);
    let extension = Path::new(file_name)
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("pdf");

    for suffix in 2.. {
        let candidate_name = format!("{file_stem}_{suffix}.{extension}");
        let candidate = output_dir.join(candidate_name);

        if !candidate.exists() {
            return candidate;
        }
    }

    unreachable!("infinite suffix search should always find a writable file name")
}

fn write_page_range(
    source_document: &LopdfDocument,
    output_path: &Path,
    range: PageRange,
) -> Result<(), AppError> {
    let mut output_document = LopdfDocument::with_version(source_document.version.clone());
    let pages_id = output_document.new_object_id();
    let catalog_id = output_document.new_object_id();
    let mut copied_objects = HashMap::new();
    let mut page_refs = Vec::with_capacity((range.end - range.start + 1) as usize);

    for page_number in range.start..=range.end {
        append_pdf_page(
            source_document,
            &mut output_document,
            pages_id,
            &mut page_refs,
            &mut copied_objects,
            page_number,
            0,
            &[],
        )?;
    }

    output_document.objects.insert(
        pages_id,
        Object::Dictionary(dictionary! {
            "Type" => "Pages",
            "Kids" => page_refs,
            "Count" => (range.end - range.start + 1) as i64,
        }),
    );
    output_document.objects.insert(
        catalog_id,
        Object::Dictionary(dictionary! {
            "Type" => "Catalog",
            "Pages" => pages_id,
        }),
    );
    output_document.trailer.set("Root", catalog_id);
    set_split_trailer_id(source_document, &mut output_document, output_path, range);
    stamp_pdf_metadata(&mut output_document, Some(source_document))?;
    output_document.save(output_path)?;
    Ok(())
}

fn save_pdf_edits_impl(path: String, pages: Vec<EditPagePlan>) -> Result<PdfMetadata, AppError> {
    if pages.is_empty() {
        return Err(AppError::SplitValidation(
            "Cannot save a PDF with no pages".to_string(),
        ));
    }

    let target_path = Path::new(&path);
    validate_pdf_path(target_path, &path)?;

    let mut source_documents = load_edit_source_documents(&pages)?;
    let output_path = temporary_edit_output_path(target_path);
    let metadata = (|| {
        write_edited_pdf(&mut source_documents, &pages, &output_path)?;
        validate_edit_output(&output_path, pages.len() as u32)?;
        replace_original_with_saved_pdf(target_path, &output_path)?;
        read_pdf_metadata(path.clone())
    })();

    if metadata.is_err() {
        let _ = fs::remove_file(&output_path);
    }

    metadata
}

fn load_edit_source_documents(
    pages: &[EditPagePlan],
) -> Result<HashMap<PathBuf, LopdfDocument>, AppError> {
    let mut source_documents = HashMap::new();

    for page in pages {
        if let PageSource::Pdf { file_path, .. } = &page.source {
            let source_path = Path::new(file_path);
            validate_pdf_path(source_path, file_path)?;
            let canonical_path = source_path.canonicalize()?;

            if !source_documents.contains_key(&canonical_path) {
                source_documents.insert(canonical_path, LopdfDocument::load(source_path)?);
            }
        }
    }

    Ok(source_documents)
}

fn write_edited_pdf(
    source_documents: &mut HashMap<PathBuf, LopdfDocument>,
    pages: &[EditPagePlan],
    output_path: &Path,
) -> Result<(), AppError> {
    let version = source_documents
        .values()
        .next()
        .map(|document| document.version.clone())
        .unwrap_or_else(|| "1.7".to_string());
    let first_source_id = source_documents
        .values()
        .next()
        .and_then(|document| source_trailer_id(document, 0));
    let mut output_document = LopdfDocument::with_version(version);
    let pages_id = output_document.new_object_id();
    let catalog_id = output_document.new_object_id();
    let mut copied_objects_by_source: HashMap<PathBuf, HashMap<ObjectId, ObjectId>> =
        HashMap::new();
    let mut page_refs = Vec::with_capacity(pages.len());

    for page in pages {
        match &page.source {
            PageSource::Pdf {
                file_path,
                page_number,
                ..
            } => {
                let canonical_path = Path::new(file_path).canonicalize()?;
                let source_document = source_documents.get(&canonical_path).ok_or_else(|| {
                    AppError::SplitValidation(format!("PDF source was not loaded: {file_path}"))
                })?;
                let copied_objects = copied_objects_by_source.entry(canonical_path).or_default();
                append_pdf_page(
                    source_document,
                    &mut output_document,
                    pages_id,
                    &mut page_refs,
                    copied_objects,
                    *page_number,
                    page.rotation,
                    &page.paint_edits,
                )?;
            }
            PageSource::Image { file_path, .. } => append_image_page(
                &mut output_document,
                pages_id,
                &mut page_refs,
                Path::new(file_path),
                page.rotation,
                &page.paint_edits,
            )?,
        }
    }

    output_document.objects.insert(
        pages_id,
        Object::Dictionary(dictionary! {
            "Type" => "Pages",
            "Kids" => page_refs,
            "Count" => pages.len() as i64,
        }),
    );
    output_document.objects.insert(
        catalog_id,
        Object::Dictionary(dictionary! {
            "Type" => "Catalog",
            "Pages" => pages_id,
        }),
    );
    output_document.trailer.set("Root", catalog_id);
    set_output_trailer_id(
        first_source_id,
        &mut output_document,
        output_path,
        "edit",
        PageRange {
            start: 1,
            end: pages.len() as u32,
        },
    );
    let metadata_source = source_documents.values().next();
    stamp_pdf_metadata(&mut output_document, metadata_source)?;
    output_document.save(output_path)?;
    Ok(())
}

fn append_pdf_page(
    source_document: &LopdfDocument,
    output_document: &mut LopdfDocument,
    pages_id: ObjectId,
    page_refs: &mut Vec<Object>,
    copied_objects: &mut HashMap<ObjectId, ObjectId>,
    page_number: u32,
    rotation: u16,
    paint_edits: &[PagePaintEdit],
) -> Result<(), AppError> {
    let source_pages = source_document.get_pages();
    let source_page_id = *source_pages
        .get(&page_number)
        .ok_or_else(|| AppError::SplitValidation(format!("Page {page_number} not found")))?;
    let output_page_id = output_document.new_object_id();
    let previous_page_mapping = copied_objects.insert(source_page_id, output_page_id);

    let mut page_object =
        Object::Dictionary(standalone_page_dictionary(source_document, source_page_id)?);
    remap_references(
        &mut page_object,
        source_document,
        output_document,
        copied_objects,
    )?;

    if let Object::Dictionary(page_dictionary) = &mut page_object {
        page_dictionary.set("Parent", pages_id);
        normalize_page_contents(output_document, page_dictionary)?;
        let source_rotation = page_rotation(page_dictionary);
        apply_page_rotation(page_dictionary, rotation);
        append_paint_edits_to_page(
            output_document,
            page_dictionary,
            paint_edits,
            source_rotation,
        )?;
        apply_page_geometry_edits(
            output_document,
            page_dictionary,
            paint_edits,
            source_rotation,
        )?;
    }

    if let Some(previous_output_id) = previous_page_mapping {
        copied_objects.insert(source_page_id, previous_output_id);
    } else {
        copied_objects.remove(&source_page_id);
    }

    output_document.objects.insert(output_page_id, page_object);
    page_refs.push(Object::Reference(output_page_id));
    Ok(())
}

fn append_image_page(
    output_document: &mut LopdfDocument,
    pages_id: ObjectId,
    page_refs: &mut Vec<Object>,
    image_path: &Path,
    rotation: u16,
    paint_edits: &[PagePaintEdit],
) -> Result<(), AppError> {
    if !image_path.exists() {
        return Err(AppError::NotFound(image_path.to_string_lossy().to_string()));
    }

    if !is_supported_image(image_path) {
        return Err(AppError::UnsupportedInsertFile(
            image_path.to_string_lossy().to_string(),
        ));
    }

    let image =
        image_025::open(image_path).map_err(|error| AppError::Preview(error.to_string()))?;
    let rgb = image.to_rgb8();
    let (image_width, image_height) = rgb.dimensions();
    let (page_width, page_height) = if image_width >= image_height {
        (842.0_f64, 595.0_f64)
    } else {
        (595.0_f64, 842.0_f64)
    };
    let scale = (page_width / f64::from(image_width)).min(page_height / f64::from(image_height));
    let draw_width = f64::from(image_width) * scale;
    let draw_height = f64::from(image_height) * scale;
    let draw_x = (page_width - draw_width) / 2.0;
    let draw_y = (page_height - draw_height) / 2.0;

    let mut image_stream = Stream::new(
        dictionary! {
            "Type" => "XObject",
            "Subtype" => "Image",
            "Width" => image_width as i64,
            "Height" => image_height as i64,
            "ColorSpace" => "DeviceRGB",
            "BitsPerComponent" => 8,
        },
        rgb.into_raw(),
    );
    image_stream.compress()?;
    let image_id = output_document.add_object(image_stream);

    let content = format!(
        "q\n{} 0 0 {} {} {} cm\n/Im1 Do\nQ\n",
        pdf_float(draw_width),
        pdf_float(draw_height),
        pdf_float(draw_x),
        pdf_float(draw_y)
    );
    let mut content_stream = Stream::new(dictionary! {}, content.into_bytes());
    content_stream.compress()?;
    let content_id = output_document.add_object(content_stream);
    let mut page_dictionary = dictionary! {
        "Type" => "Page",
        "Parent" => pages_id,
        "Resources" => dictionary! {
            "XObject" => dictionary! {
                "Im1" => image_id,
            },
        },
        "MediaBox" => vec![0.into(), 0.into(), page_width.into(), page_height.into()],
        "Contents" => content_id,
    };
    apply_page_rotation(&mut page_dictionary, rotation);
    append_paint_edits_to_page(output_document, &mut page_dictionary, paint_edits, 0)?;
    apply_page_geometry_edits(output_document, &mut page_dictionary, paint_edits, 0)?;
    let page_id = output_document.add_object(page_dictionary);
    page_refs.push(Object::Reference(page_id));
    Ok(())
}

fn apply_page_geometry_edits(
    output_document: &mut LopdfDocument,
    page_dictionary: &mut Dictionary,
    paint_edits: &[PagePaintEdit],
    source_rotation: u16,
) -> Result<(), AppError> {
    if paint_edits.is_empty() {
        return Ok(());
    }

    let geometry = page_geometry_edits(paint_edits, source_rotation);
    if geometry.straighten_degrees.abs() > 0.001 {
        apply_page_straighten(
            output_document,
            page_dictionary,
            geometry.straighten_degrees,
        )?;
    }

    if let Some(crop) = geometry.crop {
        apply_page_crop(page_dictionary, crop);
    }

    Ok(())
}

fn apply_page_straighten(
    output_document: &mut LopdfDocument,
    page_dictionary: &mut Dictionary,
    degrees: f64,
) -> Result<(), AppError> {
    let Some(page_box) = page_box(page_dictionary) else {
        return Ok(());
    };

    let radians = (-degrees).to_radians();
    let abs_radians = radians.abs();
    let rotated_width = page_box.width * abs_radians.cos() + page_box.height * abs_radians.sin();
    let rotated_height = page_box.width * abs_radians.sin() + page_box.height * abs_radians.cos();
    if rotated_width <= 0.1 || rotated_height <= 0.1 {
        return Ok(());
    }

    let scale = (page_box.width / rotated_width).min(page_box.height / rotated_height) * 0.985;
    let cos = radians.cos() * scale;
    let sin = radians.sin() * scale;
    let center_x = page_box.x1 + page_box.width / 2.0;
    let center_y = page_box.y1 + page_box.height / 2.0;
    let a = cos;
    let b = sin;
    let c = -sin;
    let d = cos;
    let e = center_x - a * center_x - c * center_y;
    let f = center_y - b * center_x - d * center_y;
    let begin_content = format!(
        "q\n{} {} {} {} {} {} cm\n",
        pdf_float(a),
        pdf_float(b),
        pdf_float(c),
        pdf_float(d),
        pdf_float(e),
        pdf_float(f)
    );
    let end_content = "Q\n".to_string();
    let mut begin_stream = Stream::new(dictionary! {}, begin_content.into_bytes());
    begin_stream.compress()?;
    let begin_id = output_document.add_object(begin_stream);
    let mut end_stream = Stream::new(dictionary! {}, end_content.into_bytes());
    end_stream.compress()?;
    let end_id = output_document.add_object(end_stream);

    prepend_page_content(output_document, page_dictionary, begin_id)?;
    append_page_content(output_document, page_dictionary, end_id)?;
    Ok(())
}

fn apply_page_crop(page_dictionary: &mut Dictionary, crop: PageCrop) {
    let Some(page_box) = page_box(page_dictionary) else {
        return;
    };

    let x = crop.x.clamp(0.0, 0.98);
    let y = crop.y.clamp(0.0, 0.98);
    let width = crop.width.clamp(0.02, 1.0 - x);
    let height = crop.height.clamp(0.02, 1.0 - y);
    if x <= 0.0005 && y <= 0.0005 && (1.0 - width).abs() <= 0.0005 && (1.0 - height).abs() <= 0.0005
    {
        return;
    }

    let left = page_box.x1 + page_box.width * x;
    let right = page_box.x1 + page_box.width * (x + width);
    let top = page_box.y2 - page_box.height * y;
    let bottom = page_box.y2 - page_box.height * (y + height);

    page_dictionary.set(
        "CropBox",
        vec![left.into(), bottom.into(), right.into(), top.into()],
    );
}

fn page_geometry_edits(paint_edits: &[PagePaintEdit], source_rotation: u16) -> PageGeometryEdits {
    let mut crop = None;
    let mut straighten_degrees = 0.0;

    for edit in paint_edits {
        match edit {
            PagePaintEdit::Crop {
                height,
                width,
                x,
                y,
            } => {
                let crop_rect = visual_rect_to_page_rect(
                    NormalizedRect {
                        height: *height,
                        width: *width,
                        x: *x,
                        y: *y,
                    },
                    source_rotation,
                );
                crop = Some(PageCrop {
                    height: crop_rect.height,
                    width: crop_rect.width,
                    x: crop_rect.x,
                    y: crop_rect.y,
                });
            }
            PagePaintEdit::Straighten { degrees } => {
                straighten_degrees += *degrees;
            }
            PagePaintEdit::Cover { .. } | PagePaintEdit::Text { .. } => {}
        }
    }

    PageGeometryEdits {
        crop,
        straighten_degrees: straighten_degrees.clamp(-15.0, 15.0),
    }
}

fn append_paint_edits_to_page(
    output_document: &mut LopdfDocument,
    page_dictionary: &mut Dictionary,
    paint_edits: &[PagePaintEdit],
    source_rotation: u16,
) -> Result<(), AppError> {
    if paint_edits.is_empty() {
        return Ok(());
    }

    let page_box = page_box(page_dictionary).unwrap_or(PageBox {
        height: 842.0,
        width: 595.0,
        x1: 0.0,
        y1: 0.0,
        y2: 842.0,
    });
    let has_text = paint_edits
        .iter()
        .any(|edit| matches!(edit, PagePaintEdit::Text { text, .. } if !text.trim().is_empty()));
    let paint_fonts = if has_text {
        Some(ensure_paint_fonts(
            output_document,
            page_dictionary,
            paint_edits,
        )?)
    } else {
        None
    };

    let content = paint_edits_content(paint_edits, page_box, paint_fonts.as_ref(), source_rotation);
    if content.trim().is_empty() {
        return Ok(());
    }

    let mut content_stream = Stream::new(dictionary! {}, content.into_bytes());
    content_stream.compress()?;
    let content_id = output_document.add_object(content_stream);
    append_page_content(output_document, page_dictionary, content_id)?;
    Ok(())
}

fn paint_edits_content(
    paint_edits: &[PagePaintEdit],
    page_box: PageBox,
    paint_fonts: Option<&PaintFontResources>,
    source_rotation: u16,
) -> String {
    let mut content = String::new();

    for edit in paint_edits {
        match edit {
            PagePaintEdit::Cover {
                color,
                height,
                width,
                x,
                y,
            } => {
                let (r, g, b) = parse_pdf_rgb(color, (1.0, 1.0, 1.0));
                let rect = visual_rect_to_page_rect(
                    NormalizedRect {
                        height: *height,
                        width: *width,
                        x: *x,
                        y: *y,
                    },
                    source_rotation,
                );
                let rect_x = page_box.x1 + normalized_to_page(rect.x, page_box.width);
                let rect_width = normalized_to_page(rect.width, page_box.width);
                let rect_height = normalized_to_page(rect.height, page_box.height);
                let rect_y =
                    page_box.y2 - normalized_to_page(rect.y, page_box.height) - rect_height;

                if rect_width <= 0.1 || rect_height <= 0.1 {
                    continue;
                }

                content.push_str(&format!(
                    "q\n{} {} {} rg\n{} {} {} {} re\nf\nQ\n",
                    pdf_float(r),
                    pdf_float(g),
                    pdf_float(b),
                    pdf_float(rect_x),
                    pdf_float(rect_y),
                    pdf_float(rect_width),
                    pdf_float(rect_height)
                ));
            }
            PagePaintEdit::Text {
                bold,
                color,
                font_family,
                font_size,
                height,
                italic,
                text_align,
                text,
                underline,
                width,
                x,
                y,
            } => {
                let _requested_font_family = font_family;
                let text = text.trim();
                if text.is_empty() {
                    continue;
                }

                let Some(font) = paint_fonts.and_then(|fonts| fonts.get(*bold, *italic)) else {
                    continue;
                };
                let (r, g, b) = parse_pdf_rgb(color, (0.0, 0.0, 0.0));
                let (visual_page_width, visual_page_height) =
                    visual_page_size(page_box, source_rotation);
                let font_size = pdf_text_font_size(*font_size, visual_page_height);
                let text_x = normalized_to_page(*x, visual_page_width);
                let text_width = normalized_to_page(*width, visual_page_width).max(font_size * 2.0);
                let text_height =
                    normalized_to_page(*height, visual_page_height).max(font_size * 1.2);
                let text_top = normalized_to_page(*y, visual_page_height);
                let line_height = font_size * 1.2;
                let max_lines = (text_height / line_height).floor().max(1.0) as usize;
                let lines = wrap_pdf_text(text, text_width, font_size, max_lines, font);
                let (visual_right, visual_up) = visual_text_basis(page_box, source_rotation);

                content.push_str("q\nBT\n");
                append_pdf_text_state_reset(&mut content, line_height);
                content.push_str(&format!(
                    "/{} {} Tf\n{} {} {} rg\n",
                    font.resource_key.as_str(),
                    pdf_float(font_size),
                    pdf_float(r),
                    pdf_float(g),
                    pdf_float(b)
                ));

                for (line_index, line) in lines.iter().enumerate() {
                    let line_width = pdf_text_line_width(line, font_size, font).min(text_width);
                    let line_x = match text_align.as_str() {
                        "center" => text_x + (text_width - line_width) / 2.0,
                        "right" => text_x + text_width - line_width,
                        _ => text_x,
                    };
                    let encoded_text = font.encode_text_hex(line);
                    if encoded_text.is_empty() {
                        continue;
                    }
                    let baseline_y = text_top + font_size + line_height * line_index as f64;
                    let baseline = visual_pdf_point_to_page_pdf_point(
                        page_box,
                        source_rotation,
                        line_x,
                        baseline_y,
                    );
                    content.push_str(&format!(
                        "{} {} {} {} {} {} Tm\n<{}> Tj\n",
                        pdf_float(visual_right.x),
                        pdf_float(visual_right.y),
                        pdf_float(visual_up.x),
                        pdf_float(visual_up.y),
                        pdf_float(baseline.x),
                        pdf_float(baseline.y),
                        encoded_text
                    ));

                    if *underline {
                        let underline_y = baseline_y + font_size * 0.18;
                        let underline_start = visual_pdf_point_to_page_pdf_point(
                            page_box,
                            source_rotation,
                            line_x,
                            underline_y,
                        );
                        let underline_end = visual_pdf_point_to_page_pdf_point(
                            page_box,
                            source_rotation,
                            line_x + line_width,
                            underline_y,
                        );
                        content.push_str(&format!(
                            "ET\n{} {} m\n{} {} l\n{} w\nS\nBT\n",
                            pdf_float(underline_start.x),
                            pdf_float(underline_start.y),
                            pdf_float(underline_end.x),
                            pdf_float(underline_end.y),
                            pdf_float((font_size / 14.0).clamp(0.6, 2.0))
                        ));
                        append_pdf_text_state_reset(&mut content, line_height);
                        content.push_str(&format!(
                            "/{} {} Tf\n{} {} {} rg\n",
                            font.resource_key.as_str(),
                            pdf_float(font_size),
                            pdf_float(r),
                            pdf_float(g),
                            pdf_float(b)
                        ));
                    }
                }

                content.push_str("ET\nQ\n");
            }
            PagePaintEdit::Crop { .. } | PagePaintEdit::Straighten { .. } => {}
        }
    }

    content
}

fn append_page_content(
    document: &mut LopdfDocument,
    page_dictionary: &mut Dictionary,
    content_id: ObjectId,
) -> Result<(), AppError> {
    let content_ref = Object::Reference(content_id);
    let mut contents = flattened_page_contents(document, page_dictionary)?;
    contents.push(content_ref);
    set_page_contents(page_dictionary, contents);
    Ok(())
}

fn prepend_page_content(
    document: &mut LopdfDocument,
    page_dictionary: &mut Dictionary,
    content_id: ObjectId,
) -> Result<(), AppError> {
    let content_ref = Object::Reference(content_id);
    let mut contents = flattened_page_contents(document, page_dictionary)?;
    contents.insert(0, content_ref);
    set_page_contents(page_dictionary, contents);
    Ok(())
}

fn normalize_page_contents(
    document: &mut LopdfDocument,
    page_dictionary: &mut Dictionary,
) -> Result<(), AppError> {
    let contents = flattened_page_contents(document, page_dictionary)?;
    set_page_contents(page_dictionary, contents);
    Ok(())
}

fn flattened_page_contents(
    document: &mut LopdfDocument,
    page_dictionary: &mut Dictionary,
) -> Result<Vec<Object>, AppError> {
    match page_dictionary.remove(b"Contents") {
        Some(contents) => {
            let mut content_refs = Vec::new();
            let mut content_stack = HashSet::new();
            collect_content_stream_refs(document, contents, &mut content_refs, &mut content_stack)?;
            Ok(content_refs)
        }
        None => Ok(Vec::new()),
    }
}

fn collect_content_stream_refs(
    document: &mut LopdfDocument,
    content: Object,
    content_refs: &mut Vec<Object>,
    content_stack: &mut HashSet<ObjectId>,
) -> Result<(), AppError> {
    match content {
        Object::Reference(content_id) => {
            let referenced = document.objects.get(&content_id).cloned().ok_or_else(|| {
                AppError::SplitValidation(format!(
                    "Contents object {} {} was not found",
                    content_id.0, content_id.1
                ))
            })?;
            match referenced {
                Object::Array(values) => {
                    if !content_stack.insert(content_id) {
                        return Err(AppError::SplitValidation(format!(
                            "Contents array {} {} contains a cycle",
                            content_id.0, content_id.1
                        )));
                    }
                    for value in values {
                        collect_content_stream_refs(document, value, content_refs, content_stack)?;
                    }
                    content_stack.remove(&content_id);
                }
                Object::Stream(_) => content_refs.push(Object::Reference(content_id)),
                Object::Null => {}
                other => {
                    return Err(AppError::SplitValidation(format!(
                        "Contents object {} {} is {}, expected a stream or an array",
                        content_id.0,
                        content_id.1,
                        pdf_object_kind(&other)
                    )));
                }
            }
        }
        Object::Array(values) => {
            for value in values {
                collect_content_stream_refs(document, value, content_refs, content_stack)?;
            }
        }
        Object::Stream(stream) => {
            let content_id = document.add_object(stream);
            content_refs.push(Object::Reference(content_id));
        }
        Object::Null => {}
        other => {
            return Err(AppError::SplitValidation(format!(
                "Page Contents is {}, expected a stream or an array",
                pdf_object_kind(&other)
            )));
        }
    }

    Ok(())
}

fn set_page_contents(page_dictionary: &mut Dictionary, mut contents: Vec<Object>) {
    match contents.len() {
        0 => {
            page_dictionary.remove(b"Contents");
        }
        1 => {
            page_dictionary.set("Contents", contents.remove(0));
        }
        _ => {
            page_dictionary.set("Contents", Object::Array(contents));
        }
    }
}

fn pdf_object_kind(object: &Object) -> &'static str {
    match object {
        Object::Null => "null",
        Object::Boolean(_) => "boolean",
        Object::Integer(_) => "integer",
        Object::Real(_) => "real",
        Object::Name(_) => "name",
        Object::String(_, _) => "string",
        Object::Array(_) => "array",
        Object::Dictionary(_) => "dictionary",
        Object::Stream(_) => "stream",
        Object::Reference(_) => "reference",
    }
}

fn wrap_pdf_text(
    text: &str,
    width: f64,
    font_size: f64,
    max_lines: usize,
    font: &PdfUnicodeFont,
) -> Vec<String> {
    let mut lines = Vec::new();

    for source_line in text.lines() {
        let mut current_line = String::new();

        for word in source_line.split_whitespace() {
            let candidate = if current_line.is_empty() {
                word.to_string()
            } else {
                format!("{current_line} {word}")
            };

            if pdf_text_line_width(&candidate, font_size, font) > width && !current_line.is_empty()
            {
                lines.push(current_line);
                current_line = String::new();

                if lines.len() >= max_lines {
                    return lines;
                }
            }

            if !current_line.is_empty() {
                current_line.push(' ');
            }
            current_line.push_str(word);
        }

        if !current_line.is_empty() {
            lines.push(current_line);
        }

        if lines.len() >= max_lines {
            lines.truncate(max_lines);
            return lines;
        }
    }

    lines
}

fn pdf_text_line_width(text: &str, font_size: f64, font: &PdfUnicodeFont) -> f64 {
    text.chars()
        .map(|character| font.width_for_character(character) * font_size / 1000.0)
        .sum()
}

fn pdf_text_font_size(visual_font_size: f64, visual_page_height: f64) -> f64 {
    let visual_font_size = visual_font_size.clamp(6.0, 96.0);
    let scale = (visual_page_height / 842.0).clamp(0.45, 8.0);
    (visual_font_size * scale).clamp(4.0, 360.0)
}

fn append_pdf_text_state_reset(content: &mut String, line_height: f64) {
    content.push_str("0 Tr\n100 Tz\n0 Tc\n0 Tw\n0 Ts\n");
    let _ = writeln!(content, "{} TL", pdf_float(line_height));
}

fn default_text_align() -> String {
    "left".to_string()
}

#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
enum PaintFontStyle {
    Regular,
    Bold,
    Italic,
    BoldItalic,
}

impl PaintFontStyle {
    fn from_flags(bold: bool, italic: bool) -> Self {
        match (bold, italic) {
            (true, true) => Self::BoldItalic,
            (true, false) => Self::Bold,
            (false, true) => Self::Italic,
            (false, false) => Self::Regular,
        }
    }

    fn suffix(self) -> &'static str {
        match self {
            Self::Regular => "Regular",
            Self::Bold => "Bold",
            Self::Italic => "Italic",
            Self::BoldItalic => "BoldItalic",
        }
    }
}

struct PaintFontResources {
    fonts: HashMap<PaintFontStyle, PdfUnicodeFont>,
}

impl PaintFontResources {
    fn get(&self, bold: bool, italic: bool) -> Option<&PdfUnicodeFont> {
        let style = PaintFontStyle::from_flags(bold, italic);
        self.fonts
            .get(&style)
            .or_else(|| self.fonts.get(&PaintFontStyle::Regular))
    }
}

struct PdfUnicodeFont {
    cid_by_char: HashMap<char, u16>,
    resource_key: String,
    width_by_cid: HashMap<u16, f64>,
}

impl PdfUnicodeFont {
    fn encode_text_hex(&self, text: &str) -> String {
        let mut encoded = String::with_capacity(text.len() * 4);
        for character in text.chars() {
            let character = if character == '\t' { ' ' } else { character };
            if let Some(cid) = self.cid_by_char.get(&character) {
                let _ = write!(encoded, "{cid:04X}");
            }
        }
        encoded
    }

    fn width_for_character(&self, character: char) -> f64 {
        let character = if character == '\t' { ' ' } else { character };
        self.cid_by_char
            .get(&character)
            .and_then(|cid| self.width_by_cid.get(cid))
            .copied()
            .unwrap_or(520.0)
    }
}

fn ensure_paint_fonts(
    output_document: &mut LopdfDocument,
    page_dictionary: &mut Dictionary,
    paint_edits: &[PagePaintEdit],
) -> Result<PaintFontResources, AppError> {
    let mut fonts = HashMap::new();
    let mut paint_fonts = Vec::new();

    for (style, characters) in collect_paint_text_characters(paint_edits) {
        let font = create_pdf_unicode_font(output_document, style, &characters)?;
        paint_fonts.push((font.resource_key.clone(), font.font_id));
        fonts.insert(
            style,
            PdfUnicodeFont {
                cid_by_char: font.cid_by_char,
                resource_key: font.resource_key,
                width_by_cid: font.width_by_cid,
            },
        );
    }

    match page_dictionary.get_mut(b"Resources") {
        Ok(Object::Dictionary(resources)) => {
            ensure_font_resource(resources, &paint_fonts);
        }
        Ok(Object::Reference(resources_id)) => {
            if let Some(Object::Dictionary(resources)) =
                output_document.objects.get_mut(resources_id)
            {
                ensure_font_resource(resources, &paint_fonts);
            } else {
                page_dictionary.set(
                    "Resources",
                    dictionary! {
                        "Font" => paint_fonts_dictionary(&paint_fonts),
                    },
                );
            }
        }
        _ => {
            page_dictionary.set(
                "Resources",
                dictionary! {
                    "Font" => paint_fonts_dictionary(&paint_fonts),
                },
            );
        }
    }

    Ok(PaintFontResources { fonts })
}

struct CreatedPdfUnicodeFont {
    cid_by_char: HashMap<char, u16>,
    font_id: ObjectId,
    resource_key: String,
    width_by_cid: HashMap<u16, f64>,
}

fn collect_paint_text_characters(
    paint_edits: &[PagePaintEdit],
) -> BTreeMap<PaintFontStyle, BTreeSet<char>> {
    let mut characters_by_style: BTreeMap<PaintFontStyle, BTreeSet<char>> = BTreeMap::new();

    for edit in paint_edits {
        let PagePaintEdit::Text {
            bold, italic, text, ..
        } = edit
        else {
            continue;
        };

        if text.trim().is_empty() {
            continue;
        }

        let characters = characters_by_style
            .entry(PaintFontStyle::from_flags(*bold, *italic))
            .or_default();
        characters.insert(' ');
        for character in text.chars() {
            match character {
                '\n' | '\r' => {}
                '\t' => {
                    characters.insert(' ');
                }
                _ if character.is_control() => {}
                _ => {
                    characters.insert(character);
                }
            }
        }
    }

    characters_by_style
}

fn create_pdf_unicode_font(
    output_document: &mut LopdfDocument,
    style: PaintFontStyle,
    characters: &BTreeSet<char>,
) -> Result<CreatedPdfUnicodeFont, AppError> {
    let font_bytes = fs::read(paint_font_path(style))?;
    let face = Face::parse(&font_bytes, 0)
        .map_err(|_| AppError::Preview("Could not load the PDF text font.".to_string()))?;
    let units_per_em = f64::from(face.units_per_em());
    let fallback_glyph = face.glyph_index('?').or_else(|| face.glyph_index(' '));
    let mut cid_by_char = HashMap::new();
    let mut cid_to_gid = vec![0_u16];
    let mut width_by_cid = HashMap::new();

    for (index, character) in characters.iter().enumerate() {
        let cid = u16::try_from(index + 1).map_err(|_| {
            AppError::SplitValidation("Too many unique text characters on one page".to_string())
        })?;
        let glyph = face
            .glyph_index(*character)
            .or(fallback_glyph)
            .ok_or_else(|| {
                AppError::Preview("Could not map a text glyph into the PDF font.".to_string())
            })?;
        let advance = face
            .glyph_hor_advance(glyph)
            .map(f64::from)
            .unwrap_or(units_per_em * 0.52);
        cid_by_char.insert(*character, cid);
        cid_to_gid.push(glyph.0);
        width_by_cid.insert(cid, advance * 1000.0 / units_per_em);
    }

    let font_name = format!("MPBPOArial{}", style.suffix());
    let descriptor = font_descriptor_dictionary(&face, &font_name, style);
    let mut font_file_stream = Stream::new(
        dictionary! {
            "Length1" => font_bytes.len() as i64,
        },
        font_bytes,
    );
    font_file_stream.compress()?;
    let font_file_id = output_document.add_object(font_file_stream);
    let mut descriptor = descriptor;
    descriptor.set("FontFile2", font_file_id);
    let descriptor_id = output_document.add_object(descriptor);

    let mut cid_to_gid_bytes = Vec::with_capacity(cid_to_gid.len() * 2);
    for gid in cid_to_gid {
        cid_to_gid_bytes.extend_from_slice(&gid.to_be_bytes());
    }
    let mut cid_to_gid_stream = Stream::new(dictionary! {}, cid_to_gid_bytes);
    cid_to_gid_stream.compress()?;
    let cid_to_gid_id = output_document.add_object(cid_to_gid_stream);

    let width_objects: Vec<Object> = (1..=characters.len())
        .map(|index| {
            let cid = index as u16;
            Object::Integer(width_by_cid.get(&cid).copied().unwrap_or(520.0).round() as i64)
        })
        .collect();
    let cid_font_id = output_document.add_object(dictionary! {
        "Type" => "Font",
        "Subtype" => "CIDFontType2",
        "BaseFont" => Object::Name(font_name.as_bytes().to_vec()),
        "CIDSystemInfo" => dictionary! {
            "Registry" => Object::string_literal("Adobe"),
            "Ordering" => Object::string_literal("Identity"),
            "Supplement" => 0,
        },
        "FontDescriptor" => descriptor_id,
        "CIDToGIDMap" => cid_to_gid_id,
        "W" => Object::Array(vec![Object::Integer(1), Object::Array(width_objects)]),
    });

    let mut to_unicode_stream = Stream::new(
        dictionary! {},
        to_unicode_cmap(&font_name, &cid_by_char).into_bytes(),
    );
    to_unicode_stream.compress()?;
    let to_unicode_id = output_document.add_object(to_unicode_stream);
    let font_id = output_document.add_object(dictionary! {
        "Type" => "Font",
        "Subtype" => "Type0",
        "BaseFont" => Object::Name(font_name.as_bytes().to_vec()),
        "Encoding" => "Identity-H",
        "DescendantFonts" => Object::Array(vec![Object::Reference(cid_font_id)]),
        "ToUnicode" => to_unicode_id,
    });

    Ok(CreatedPdfUnicodeFont {
        cid_by_char,
        font_id,
        resource_key: format!("SPF{}", font_id.0),
        width_by_cid,
    })
}

fn paint_font_path(style: PaintFontStyle) -> PathBuf {
    let windows_fonts = Path::new(r"C:\Windows\Fonts");
    let styled_font = match style {
        PaintFontStyle::Regular => windows_fonts.join("arial.ttf"),
        PaintFontStyle::Bold => windows_fonts.join("arialbd.ttf"),
        PaintFontStyle::Italic => windows_fonts.join("ariali.ttf"),
        PaintFontStyle::BoldItalic => windows_fonts.join("arialbi.ttf"),
    };

    if styled_font.exists() {
        return styled_font;
    }

    let regular_font = windows_fonts.join("arial.ttf");
    if regular_font.exists() {
        return regular_font;
    }

    windows_fonts.join("segoeui.ttf")
}

fn font_descriptor_dictionary(
    face: &Face<'_>,
    font_name: &str,
    style: PaintFontStyle,
) -> Dictionary {
    let units_per_em = f64::from(face.units_per_em());
    let bbox = face.global_bounding_box();
    let flags = match style {
        PaintFontStyle::Italic | PaintFontStyle::BoldItalic => 96,
        _ => 32,
    };

    dictionary! {
        "Type" => "FontDescriptor",
        "FontName" => Object::Name(font_name.as_bytes().to_vec()),
        "Flags" => flags,
        "FontBBox" => Object::Array(vec![
            Object::Integer(font_metric(bbox.x_min, units_per_em)),
            Object::Integer(font_metric(bbox.y_min, units_per_em)),
            Object::Integer(font_metric(bbox.x_max, units_per_em)),
            Object::Integer(font_metric(bbox.y_max, units_per_em)),
        ]),
        "Ascent" => font_metric(face.ascender(), units_per_em),
        "Descent" => font_metric(face.descender(), units_per_em),
        "CapHeight" => font_metric(face.ascender(), units_per_em),
        "ItalicAngle" => if matches!(style, PaintFontStyle::Italic | PaintFontStyle::BoldItalic) { -12 } else { 0 },
        "StemV" => if matches!(style, PaintFontStyle::Bold | PaintFontStyle::BoldItalic) { 110 } else { 80 },
    }
}

fn font_metric(value: i16, units_per_em: f64) -> i64 {
    (f64::from(value) * 1000.0 / units_per_em).round() as i64
}

fn to_unicode_cmap(font_name: &str, cid_by_char: &HashMap<char, u16>) -> String {
    let mut entries: Vec<(u16, char)> = cid_by_char
        .iter()
        .map(|(character, cid)| (*cid, *character))
        .collect();
    entries.sort_by_key(|(cid, _)| *cid);

    let mut cmap = String::new();
    let _ = writeln!(cmap, "/CIDInit /ProcSet findresource begin");
    let _ = writeln!(cmap, "12 dict begin");
    let _ = writeln!(cmap, "begincmap");
    let _ = writeln!(
        cmap,
        "/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def"
    );
    let _ = writeln!(cmap, "/CMapName /{font_name}-ToUnicode def");
    let _ = writeln!(cmap, "/CMapType 2 def");
    let _ = writeln!(cmap, "1 begincodespacerange");
    let _ = writeln!(cmap, "<0000> <FFFF>");
    let _ = writeln!(cmap, "endcodespacerange");

    for chunk in entries.chunks(100) {
        let _ = writeln!(cmap, "{} beginbfchar", chunk.len());
        for (cid, character) in chunk {
            let _ = writeln!(cmap, "<{cid:04X}> <{}>", unicode_hex(*character));
        }
        let _ = writeln!(cmap, "endbfchar");
    }

    let _ = writeln!(cmap, "endcmap");
    let _ = writeln!(cmap, "CMapName currentdict /CMap defineresource pop");
    let _ = writeln!(cmap, "end");
    let _ = writeln!(cmap, "end");
    cmap
}

fn unicode_hex(character: char) -> String {
    let mut encoded = String::new();
    let mut buffer = [0_u16; 2];
    for unit in character.encode_utf16(&mut buffer) {
        let _ = write!(encoded, "{unit:04X}");
    }
    encoded
}

fn ensure_font_resource(resources: &mut Dictionary, paint_fonts: &[(String, ObjectId)]) {
    match resources.get_mut(b"Font") {
        Ok(Object::Dictionary(fonts)) => {
            for (font_key, font_id) in paint_fonts {
                fonts.set(font_key.as_str(), *font_id);
            }
        }
        _ => {
            resources.set("Font", paint_fonts_dictionary(paint_fonts));
        }
    }
}

fn paint_fonts_dictionary(paint_fonts: &[(String, ObjectId)]) -> Dictionary {
    let mut fonts = Dictionary::new();
    for (font_key, font_id) in paint_fonts {
        fonts.set(font_key.as_str(), *font_id);
    }
    fonts
}

fn page_box(page_dictionary: &Dictionary) -> Option<PageBox> {
    page_dictionary
        .get(b"CropBox")
        .ok()
        .and_then(page_box_from_object)
        .or_else(|| {
            page_dictionary
                .get(b"MediaBox")
                .ok()
                .and_then(page_box_from_object)
        })
}

fn page_box_from_object(object: &Object) -> Option<PageBox> {
    let values = object.as_array().ok()?;
    if values.len() < 4 {
        return None;
    }

    let x1 = object_number_to_f64(&values[0])?;
    let y1 = object_number_to_f64(&values[1])?;
    let x2 = object_number_to_f64(&values[2])?;
    let y2 = object_number_to_f64(&values[3])?;
    let left = x1.min(x2);
    let right = x1.max(x2);
    let bottom = y1.min(y2);
    let top = y1.max(y2);

    Some(PageBox {
        height: top - bottom,
        width: right - left,
        x1: left,
        y1: bottom,
        y2: top,
    })
}

fn object_number_to_f64(object: &Object) -> Option<f64> {
    object
        .as_float()
        .ok()
        .map(f64::from)
        .or_else(|| object.as_i64().ok().map(|value| value as f64))
}

fn normalized_to_page(value: f64, page_size: f64) -> f64 {
    value.clamp(0.0, 1.0) * page_size
}

fn normalize_pdf_rotation(rotation: i64) -> u16 {
    match rotation.rem_euclid(360) {
        90 => 90,
        180 => 180,
        270 => 270,
        _ => 0,
    }
}

fn page_rotation(page_dictionary: &Dictionary) -> u16 {
    page_dictionary
        .get(b"Rotate")
        .and_then(Object::as_i64)
        .map(normalize_pdf_rotation)
        .unwrap_or(0)
}

fn visual_point_to_page_point(point: NormalizedPoint, rotation: u16) -> NormalizedPoint {
    match rotation % 360 {
        90 => NormalizedPoint {
            x: point.y,
            y: 1.0 - point.x,
        },
        180 => NormalizedPoint {
            x: 1.0 - point.x,
            y: 1.0 - point.y,
        },
        270 => NormalizedPoint {
            x: 1.0 - point.y,
            y: point.x,
        },
        _ => point,
    }
}

fn normalized_rect_from_points(start: NormalizedPoint, end: NormalizedPoint) -> NormalizedRect {
    let x = start.x.min(end.x);
    let y = start.y.min(end.y);

    NormalizedRect {
        height: (end.y - start.y).abs(),
        width: (end.x - start.x).abs(),
        x,
        y,
    }
}

fn visual_rect_to_page_rect(rect: NormalizedRect, rotation: u16) -> NormalizedRect {
    let start = visual_point_to_page_point(
        NormalizedPoint {
            x: rect.x,
            y: rect.y,
        },
        rotation,
    );
    let end = visual_point_to_page_point(
        NormalizedPoint {
            x: rect.x + rect.width,
            y: rect.y + rect.height,
        },
        rotation,
    );

    normalized_rect_from_points(start, end)
}

fn visual_page_size(page_box: PageBox, rotation: u16) -> (f64, f64) {
    match rotation % 360 {
        90 | 270 => (page_box.height.max(0.1), page_box.width.max(0.1)),
        _ => (page_box.width.max(0.1), page_box.height.max(0.1)),
    }
}

fn visual_pdf_point_to_page_pdf_point(
    page_box: PageBox,
    rotation: u16,
    visual_x: f64,
    visual_y: f64,
) -> PdfPoint {
    let (visual_page_width, visual_page_height) = visual_page_size(page_box, rotation);
    let visual_point = NormalizedPoint {
        x: (visual_x / visual_page_width).clamp(0.0, 1.0),
        y: (visual_y / visual_page_height).clamp(0.0, 1.0),
    };
    let page_point = visual_point_to_page_point(visual_point, rotation);

    PdfPoint {
        x: page_box.x1 + normalized_to_page(page_point.x, page_box.width),
        y: page_box.y2 - normalized_to_page(page_point.y, page_box.height),
    }
}

fn visual_text_basis(page_box: PageBox, rotation: u16) -> (PdfPoint, PdfPoint) {
    let origin = visual_pdf_point_to_page_pdf_point(page_box, rotation, 0.0, 0.0);
    let right = visual_pdf_point_to_page_pdf_point(page_box, rotation, 1.0, 0.0);
    let down = visual_pdf_point_to_page_pdf_point(page_box, rotation, 0.0, 1.0);

    (
        PdfPoint {
            x: right.x - origin.x,
            y: right.y - origin.y,
        },
        PdfPoint {
            x: origin.x - down.x,
            y: origin.y - down.y,
        },
    )
}

fn parse_pdf_rgb(value: &str, fallback: (f64, f64, f64)) -> (f64, f64, f64) {
    let hex = value.trim().trim_start_matches('#');
    if hex.len() != 6 {
        return fallback;
    }

    let Ok(red) = u8::from_str_radix(&hex[0..2], 16) else {
        return fallback;
    };
    let Ok(green) = u8::from_str_radix(&hex[2..4], 16) else {
        return fallback;
    };
    let Ok(blue) = u8::from_str_radix(&hex[4..6], 16) else {
        return fallback;
    };

    (
        f64::from(red) / 255.0,
        f64::from(green) / 255.0,
        f64::from(blue) / 255.0,
    )
}

fn apply_page_rotation(page_dictionary: &mut Dictionary, rotation: u16) {
    let rotation = rotation % 360;
    if rotation == 0 {
        return;
    }

    let current_rotation = page_dictionary
        .get(b"Rotate")
        .and_then(Object::as_i64)
        .unwrap_or(0);
    let next_rotation = normalize_pdf_rotation(current_rotation + i64::from(rotation));

    if next_rotation == 0 {
        page_dictionary.remove(b"Rotate");
    } else {
        page_dictionary.set("Rotate", i64::from(next_rotation));
    }
}

fn validate_edit_output(output_path: &Path, expected_pages: u32) -> Result<(), AppError> {
    let actual_pages = read_page_count(output_path)?;

    if actual_pages != expected_pages {
        return Err(AppError::SplitValidation(format!(
            "{} expected {} pages, got {} pages",
            output_path.to_string_lossy(),
            expected_pages,
            actual_pages
        )));
    }

    Ok(())
}

fn replace_original_with_saved_pdf(target_path: &Path, saved_path: &Path) -> Result<(), AppError> {
    let backup_path = temporary_backup_path(target_path);

    fs::rename(target_path, &backup_path)?;
    match fs::rename(saved_path, target_path) {
        Ok(()) => {
            let _ = fs::remove_file(backup_path);
            Ok(())
        }
        Err(error) => {
            let _ = fs::rename(&backup_path, target_path);
            Err(AppError::Metadata(error))
        }
    }
}

fn temporary_edit_output_path(target_path: &Path) -> PathBuf {
    temporary_sibling_path(target_path, "splitpdf-edit", "pdf")
}

fn temporary_backup_path(target_path: &Path) -> PathBuf {
    temporary_sibling_path(target_path, "splitpdf-backup", "bak")
}

fn temporary_sibling_path(target_path: &Path, label: &str, extension: &str) -> PathBuf {
    let parent = target_path.parent().unwrap_or_else(|| Path::new("."));
    let stem = target_path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("document");
    let suffix = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();

    parent.join(format!("{stem}.{label}.{suffix}.{extension}"))
}

fn pdf_float(value: f64) -> String {
    let text = format!("{value:.4}");
    text.trim_end_matches('0').trim_end_matches('.').to_string()
}

fn standalone_page_dictionary(
    source_document: &LopdfDocument,
    source_page_id: ObjectId,
) -> Result<Dictionary, AppError> {
    let page_dictionary = source_document.get_dictionary(source_page_id)?;
    let mut output_dictionary = page_dictionary.clone();
    output_dictionary.remove(b"Parent");
    output_dictionary.remove(b"Metadata");
    output_dictionary.remove(b"PieceInfo");

    for key in PAGE_INHERITABLE_KEYS {
        if !output_dictionary.has(key) {
            if let Some(value) = inherited_page_value(source_document, page_dictionary, key)? {
                output_dictionary.set(key.to_vec(), value);
            }
        }
    }

    Ok(output_dictionary)
}

fn inherited_page_value(
    source_document: &LopdfDocument,
    page_dictionary: &Dictionary,
    key: &[u8],
) -> Result<Option<Object>, AppError> {
    let mut parent_id = page_dictionary
        .get(b"Parent")
        .and_then(Object::as_reference)
        .ok();
    let mut seen = HashSet::new();

    while let Some(current_parent_id) = parent_id {
        if !seen.insert(current_parent_id) {
            break;
        }

        let parent_dictionary = source_document.get_dictionary(current_parent_id)?;
        if let Ok(value) = parent_dictionary.get(key) {
            return Ok(Some(value.clone()));
        }

        parent_id = parent_dictionary
            .get(b"Parent")
            .and_then(Object::as_reference)
            .ok();
    }

    Ok(None)
}

fn remap_references(
    object: &mut Object,
    source_document: &LopdfDocument,
    output_document: &mut LopdfDocument,
    copied_objects: &mut HashMap<ObjectId, ObjectId>,
) -> Result<(), AppError> {
    match object {
        Object::Reference(source_id) => {
            *source_id =
                copy_indirect_object(source_document, output_document, copied_objects, *source_id)?;
        }
        Object::Array(values) => {
            for value in values {
                remap_references(value, source_document, output_document, copied_objects)?;
            }
        }
        Object::Dictionary(dictionary) => {
            for (_, value) in dictionary.iter_mut() {
                remap_references(value, source_document, output_document, copied_objects)?;
            }
        }
        Object::Stream(stream) => {
            for (_, value) in stream.dict.iter_mut() {
                remap_references(value, source_document, output_document, copied_objects)?;
            }
        }
        _ => {}
    }

    Ok(())
}

fn copy_indirect_object(
    source_document: &LopdfDocument,
    output_document: &mut LopdfDocument,
    copied_objects: &mut HashMap<ObjectId, ObjectId>,
    source_id: ObjectId,
) -> Result<ObjectId, AppError> {
    if let Some(output_id) = copied_objects.get(&source_id) {
        return Ok(*output_id);
    }

    let output_id = output_document.new_object_id();
    copied_objects.insert(source_id, output_id);

    let mut object = source_document
        .objects
        .get(&source_id)
        .ok_or_else(|| {
            AppError::SplitValidation(format!(
                "Referenced object {} {} was not found",
                source_id.0, source_id.1
            ))
        })?
        .clone();
    remap_references(
        &mut object,
        source_document,
        output_document,
        copied_objects,
    )?;
    output_document.objects.insert(output_id, object);
    Ok(output_id)
}

fn set_split_trailer_id(
    source_document: &LopdfDocument,
    output_document: &mut LopdfDocument,
    output_path: &Path,
    range: PageRange,
) {
    set_output_trailer_id(
        source_trailer_id(source_document, 0),
        output_document,
        output_path,
        "split",
        range,
    );
}

fn set_output_trailer_id(
    source_id: Option<[u8; 16]>,
    output_document: &mut LopdfDocument,
    output_path: &Path,
    label: &str,
    range: PageRange,
) {
    let first_id = source_id.unwrap_or_else(|| split_file_id("source", output_path, range));
    let second_id = split_file_id("split", output_path, range);
    output_document.trailer.set(
        "ID",
        Object::Array(vec![
            pdf_file_id(first_id),
            pdf_file_id(hash_file_id(
                [0x45, 0x44, 0x49, 0x54],
                &[label.as_bytes(), &second_id],
            )),
        ]),
    );
}

fn source_trailer_id(source_document: &LopdfDocument, index: usize) -> Option<[u8; 16]> {
    let Object::Array(ids) = source_document.trailer.get(b"ID").ok()? else {
        return None;
    };

    let id = ids.get(index)?.as_str().ok()?;
    if id.is_empty() {
        return None;
    }

    Some(normalized_file_id(id))
}

fn normalized_file_id(bytes: &[u8]) -> [u8; 16] {
    if bytes.len() == 16 {
        let mut id = [0; 16];
        id.copy_from_slice(bytes);
        return id;
    }

    hash_file_id([0xC0, 0xDE, 0x51, 0x1D], &[bytes])
}

fn split_file_id(label: &str, output_path: &Path, range: PageRange) -> [u8; 16] {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default()
        .to_le_bytes();
    let range_start = range.start.to_le_bytes();
    let range_end = range.end.to_le_bytes();
    let path_text = output_path.to_string_lossy();

    hash_file_id(
        [0x53, 0x50, 0x44, 0x46],
        &[
            label.as_bytes(),
            path_text.as_bytes(),
            &range_start,
            &range_end,
            &now,
        ],
    )
}

fn hash_file_id(seed: [u8; 4], chunks: &[&[u8]]) -> [u8; 16] {
    let mut hash = [
        0x811C_9DC5u32 ^ u32::from_le_bytes(seed),
        0x9E37_79B9u32,
        0x85EB_CA6Bu32,
        0xC2B2_AE35u32,
    ];

    for chunk in chunks {
        for byte in *chunk {
            for value in &mut hash {
                *value ^= u32::from(*byte);
                *value = value.wrapping_mul(16_777_619).rotate_left(5);
            }
            hash.rotate_left(1);
        }
    }

    let mut id = [0; 16];
    for (index, value) in hash.iter().enumerate() {
        id[index * 4..index * 4 + 4].copy_from_slice(&value.to_le_bytes());
    }
    id
}

fn pdf_file_id(id: [u8; 16]) -> Object {
    Object::String(id.to_vec(), StringFormat::Hexadecimal)
}

fn stamp_pdf_metadata(
    output_document: &mut LopdfDocument,
    source_document: Option<&LopdfDocument>,
) -> Result<(), AppError> {
    let source_info = source_document.and_then(pdf_info_dictionary);
    let now = pdf_date_now();

    let mut info = Dictionary::new();
    info.set(
        "Author",
        pdf_info_string_or(source_info, b"Author", PDF_APP_NAME),
    );
    info.set(
        "Subject",
        pdf_info_string_or(source_info, b"Subject", PDF_APP_SUBJECT),
    );
    if let Some(keywords) = pdf_info_string(source_info, b"Keywords") {
        info.set("Keywords", keywords);
    }
    info.set("Creator", Object::string_literal(PDF_APP_NAME));
    info.set("Producer", Object::string_literal(PDF_APP_NAME));
    info.set("CreationDate", Object::string_literal(now.clone()));
    info.set("ModDate", Object::string_literal(now));

    let info_id = output_document.new_object_id();
    output_document
        .objects
        .insert(info_id, Object::Dictionary(info));
    output_document.trailer.set("Info", info_id);
    Ok(())
}

fn pdf_info_dictionary(document: &LopdfDocument) -> Option<&Dictionary> {
    match document.trailer.get(b"Info").ok()? {
        Object::Dictionary(dictionary) => Some(dictionary),
        Object::Reference(id) => match document.objects.get(id)? {
            Object::Dictionary(dictionary) => Some(dictionary),
            _ => None,
        },
        _ => None,
    }
}

fn pdf_info_string_or(
    source_info: Option<&Dictionary>,
    key: &[u8],
    fallback: impl Into<String>,
) -> Object {
    pdf_info_string(source_info, key).unwrap_or_else(|| Object::string_literal(fallback.into()))
}

fn pdf_info_string(source_info: Option<&Dictionary>, key: &[u8]) -> Option<Object> {
    source_info
        .and_then(|dictionary| dictionary.get(key).ok())
        .and_then(|value| match value {
            Object::String(bytes, format) if !bytes.is_empty() => {
                Some(Object::String(bytes.clone(), *format))
            }
            _ => None,
        })
}

fn pdf_date_now() -> String {
    let now = Local::now();
    let offset_seconds = now.offset().local_minus_utc();
    let sign = if offset_seconds >= 0 { '+' } else { '-' };
    let offset_minutes = offset_seconds.abs() / 60;
    let offset_hours = offset_minutes / 60;
    let offset_remainder_minutes = offset_minutes % 60;

    format!(
        "D:{}{}{:02}'{:02}'",
        now.format("%Y%m%d%H%M%S"),
        sign,
        offset_hours,
        offset_remainder_minutes
    )
}

fn write_page_range_by_deletion(
    source_document: &LopdfDocument,
    source_path: &Path,
    output_path: &Path,
    total_pages: u32,
    range: PageRange,
) -> Result<(), AppError> {
    let mut document = LopdfDocument::load(source_path)?;
    let pages_to_delete = (1..=total_pages)
        .filter(|page_number| *page_number < range.start || *page_number > range.end)
        .collect::<Vec<_>>();

    if !pages_to_delete.is_empty() {
        document.delete_pages(&pages_to_delete);
        document.prune_objects();
        document.renumber_objects();
        document.adjust_zero_pages();
    }

    set_split_trailer_id(source_document, &mut document, output_path, range);
    stamp_pdf_metadata(&mut document, Some(source_document))?;
    document.save(output_path)?;
    Ok(())
}

fn validate_split_output(output_path: &Path, range: PageRange) -> Result<(), AppError> {
    let expected_pages = range.end - range.start + 1;
    let actual_pages = read_page_count(output_path)?;

    if actual_pages != expected_pages {
        return Err(AppError::SplitValidation(format!(
            "{} expected {} pages, got {} pages",
            output_path.to_string_lossy(),
            expected_pages,
            actual_pages
        )));
    }

    Ok(())
}

fn is_pdf(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("pdf"))
}

fn is_supported_image(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| {
            extension.eq_ignore_ascii_case("png")
                || extension.eq_ignore_ascii_case("jpg")
                || extension.eq_ignore_ascii_case("jpeg")
        })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(AppState::default())
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            let paths: Vec<String> = args
                .iter()
                .filter_map(|argument| {
                    let path = PathBuf::from(argument);
                    if path.is_file() && is_pdf(&path) {
                        Some(path.to_string_lossy().to_string())
                    } else {
                        None
                    }
                })
                .collect();

            if paths.is_empty() {
                return;
            }

            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_focus();
            }

            let _ = app.emit(OPEN_PDF_PATHS_EVENT, OpenPdfPathsPayload { paths });
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            close_main_window,
            fetch_app_policy,
            minimize_main_window,
            open_folder,
            read_pdf_metadata,
            read_startup_pdf_path,
            read_startup_pdf_paths,
            read_insert_pages,
            render_pdf_pages,
            sample_image_color,
            save_pdf_edits,
            split_pdf,
            split_pdf_with_edits,
            start_main_window_drag,
            toggle_main_window_maximize
        ])
        .run(tauri::generate_context!())
        .expect("error while running MpBPO PDF Studio");
}

#[cfg(test)]
mod tests {
    use super::*;
    use lopdf::content::{Content, Operation};
    use lopdf::{dictionary, Object, Stream};

    #[test]
    #[ignore = "downloads and binds PDFium on first run"]
    fn renders_pdf_page_preview_smoke() {
        let path =
            std::env::temp_dir().join(format!("splitpdf-preview-smoke-{}.pdf", std::process::id()));
        create_smoke_pdf(&path);

        let state = AppState::default();
        let previews = render_pdf_pages_impl(
            &state,
            path.to_string_lossy().to_string(),
            vec![1],
            180,
            RenderLane::Thumbnail,
            None,
        )
        .expect("render preview");

        let _ = fs::remove_file(path);

        assert_eq!(previews.len(), 1);
        assert_eq!(previews[0].page_number, 1);
        assert!(previews[0].width > 0);
        assert!(previews[0].height > 0);
        assert!(previews[0].data_url.is_empty());
        assert!(previews[0].file_path.ends_with(".jpg"));
        assert!(Path::new(&previews[0].file_path).is_file());
    }

    #[test]
    fn split_output_file_name_uses_source_stem_and_padded_index() {
        let file_name = split_output_file_name("Doc103480001", 7, 3);

        assert_eq!(file_name, "Doc103480001_007.pdf");
    }

    #[test]
    fn unique_output_path_adds_suffix_when_file_exists() {
        let output_dir =
            std::env::temp_dir().join(format!("splitpdf-unique-output-{}", std::process::id()));
        fs::create_dir_all(&output_dir).expect("create temp output dir");
        let existing_path = output_dir.join("Doc103480001_001.pdf");
        fs::write(&existing_path, b"existing").expect("create existing output");

        let unique_path = unique_output_path(&output_dir, "Doc103480001_001.pdf");

        let _ = fs::remove_dir_all(output_dir);

        assert!(unique_path.ends_with("Doc103480001_001_2.pdf"));
    }

    #[test]
    fn paint_cover_rectangles_use_crop_box_origin() {
        let page_box = PageBox {
            height: 600.0,
            width: 400.0,
            x1: 120.0,
            y1: 50.0,
            y2: 650.0,
        };
        let content = paint_edits_content(
            &[
                PagePaintEdit::Cover {
                    color: "#00ff00".to_string(),
                    height: 1.0,
                    width: 0.1,
                    x: 0.0,
                    y: 0.0,
                },
                PagePaintEdit::Cover {
                    color: "#00ff00".to_string(),
                    height: 1.0,
                    width: 0.1,
                    x: 0.9,
                    y: 0.0,
                },
            ],
            page_box,
            None,
            0,
        );

        assert!(content.contains("120 50 40 600 re"));
        assert!(content.contains("480 50 40 600 re"));
    }

    #[test]
    fn paint_cover_rectangles_follow_source_rotation() {
        let page_box = PageBox {
            height: 600.0,
            width: 400.0,
            x1: 0.0,
            y1: 0.0,
            y2: 600.0,
        };
        let content = paint_edits_content(
            &[PagePaintEdit::Cover {
                color: "#00ff00".to_string(),
                height: 0.2,
                width: 0.1,
                x: 0.0,
                y: 0.0,
            }],
            page_box,
            None,
            90,
        );

        assert!(content.contains("0 0 80 60 re"));
    }

    #[test]
    fn crop_rectangles_follow_source_rotation() {
        let geometry = page_geometry_edits(
            &[PagePaintEdit::Crop {
                height: 0.2,
                width: 0.1,
                x: 0.0,
                y: 0.0,
            }],
            90,
        );
        let crop = geometry.crop.expect("crop edit");

        assert!((crop.x - 0.0).abs() < 0.0001);
        assert!((crop.y - 0.9).abs() < 0.0001);
        assert!((crop.width - 0.2).abs() < 0.0001);
        assert!((crop.height - 0.1).abs() < 0.0001);
    }

    #[test]
    fn paint_text_uses_unicode_cids_and_scales_with_page_size() {
        let mut cid_by_char = HashMap::new();
        cid_by_char.insert(' ', 1);
        cid_by_char.insert('h', 2);
        cid_by_char.insert('\u{1EC7}', 3);
        let mut width_by_cid = HashMap::new();
        width_by_cid.insert(1, 260.0);
        width_by_cid.insert(2, 520.0);
        width_by_cid.insert(3, 520.0);
        let mut fonts = HashMap::new();
        fonts.insert(
            PaintFontStyle::Regular,
            PdfUnicodeFont {
                cid_by_char,
                resource_key: "SPFTest".to_string(),
                width_by_cid,
            },
        );
        let resources = PaintFontResources { fonts };
        let page_box = PageBox {
            height: 1684.0,
            width: 1190.0,
            x1: 0.0,
            y1: 0.0,
            y2: 1684.0,
        };
        let content = paint_edits_content(
            &[PagePaintEdit::Text {
                bold: false,
                color: "#111827".to_string(),
                font_family: "Arial".to_string(),
                font_size: 13.0,
                height: 0.1,
                italic: false,
                text_align: "left".to_string(),
                text: "h\u{1EC7}".to_string(),
                underline: false,
                width: 0.2,
                x: 0.1,
                y: 0.1,
            }],
            page_box,
            Some(&resources),
            0,
        );

        assert!(content.contains("0 Tr\n100 Tz\n0 Tc\n0 Tw\n0 Ts\n31.2 TL"));
        assert!(content.contains("/SPFTest 26 Tf"));
        assert!(content.contains("<00020003> Tj"));
    }

    #[test]
    fn paint_text_uses_visual_basis_for_source_rotation() {
        let mut cid_by_char = HashMap::new();
        cid_by_char.insert('A', 1);
        let mut width_by_cid = HashMap::new();
        width_by_cid.insert(1, 520.0);
        let mut fonts = HashMap::new();
        fonts.insert(
            PaintFontStyle::Regular,
            PdfUnicodeFont {
                cid_by_char,
                resource_key: "SPFTest".to_string(),
                width_by_cid,
            },
        );
        let resources = PaintFontResources { fonts };
        let page_box = PageBox {
            height: 600.0,
            width: 400.0,
            x1: 0.0,
            y1: 0.0,
            y2: 600.0,
        };
        let content = paint_edits_content(
            &[PagePaintEdit::Text {
                bold: false,
                color: "#111827".to_string(),
                font_family: "Arial".to_string(),
                font_size: 12.0,
                height: 0.1,
                italic: false,
                text_align: "left".to_string(),
                text: "A".to_string(),
                underline: true,
                width: 0.2,
                x: 0.1,
                y: 0.1,
            }],
            page_box,
            Some(&resources),
            90,
        );

        assert!(content.contains("0 1 -1 0"));
        assert!(content.contains("0 Tr\n100 Tz\n0 Tc\n0 Tw\n0 Ts\n"));
        assert!(content.contains("<0001> Tj"));
        assert!(content.contains(" m\n"));
        assert!(content.contains(" l\n"));
    }

    #[test]
    fn page_content_append_and_prepend_flatten_nested_content_arrays() {
        let mut document = LopdfDocument::with_version("1.5");
        let first_content_id = document.add_object(Stream::new(dictionary! {}, b"q\nQ\n".to_vec()));
        let second_content_id =
            document.add_object(Stream::new(dictionary! {}, b"BT\nET\n".to_vec()));
        let nested_array_id =
            document.add_object(Object::Array(vec![Object::Reference(first_content_id)]));
        let mut page_dictionary = dictionary! {
            "Contents" => Object::Array(vec![
                Object::Reference(nested_array_id),
                Object::Array(vec![Object::Reference(second_content_id)]),
            ]),
        };
        let prepended_content_id =
            document.add_object(Stream::new(dictionary! {}, b"prepended\n".to_vec()));
        let appended_content_id =
            document.add_object(Stream::new(dictionary! {}, b"appended\n".to_vec()));

        prepend_page_content(&mut document, &mut page_dictionary, prepended_content_id)
            .expect("prepend content");
        append_page_content(&mut document, &mut page_dictionary, appended_content_id)
            .expect("append content");

        assert_flat_page_contents(
            &document,
            page_dictionary
                .get(b"Contents")
                .expect("flattened page contents"),
            &[
                prepended_content_id,
                first_content_id,
                second_content_id,
                appended_content_id,
            ],
        );
    }

    #[test]
    fn split_normalizes_indirect_content_array_without_reencoding_images() {
        let work_dir =
            std::env::temp_dir().join(format!("splitpdf-content-normalize-{}", std::process::id()));
        fs::create_dir_all(&work_dir).expect("create content normalize dir");
        let source_path = work_dir.join("IndirectContents.pdf");
        let output_path = work_dir.join("IndirectContents_001.pdf");
        create_pdf_with_indirect_content_array(&source_path);
        let source_document = LopdfDocument::load(&source_path).expect("load source pdf");

        write_page_range(
            &source_document,
            &output_path,
            PageRange { start: 1, end: 1 },
        )
        .expect("write normalized split page");

        let output_document = LopdfDocument::load(&output_path).expect("load split output");
        let output_page_id = *output_document.get_pages().get(&1).expect("output page id");
        let output_page = output_document
            .get_dictionary(output_page_id)
            .expect("output page dictionary");
        assert_flat_page_contents(
            &output_document,
            output_page.get(b"Contents").expect("output contents"),
            &[],
        );
        let image_filters = page_image_filters(&output_document, output_page);
        assert_eq!(image_filters, vec!["/DCTDecode".to_string()]);

        let _ = fs::remove_dir_all(&work_dir);
    }

    #[test]
    fn split_pdf_writes_outputs_to_timestamped_sibling_folder() {
        let work_dir =
            std::env::temp_dir().join(format!("splitpdf-split-output-{}", std::process::id()));
        fs::create_dir_all(&work_dir).expect("create split smoke dir");
        let source_path = work_dir.join("Doc103480001.pdf");
        create_smoke_pdf_with_page_count(&source_path, 4);

        let result = split_pdf_impl(
            source_path.to_string_lossy().to_string(),
            vec![3],
            "test-run".to_string(),
            None,
            |_| {},
        )
        .expect("split smoke pdf");

        let first_output =
            LopdfDocument::load(&result.files[0].file_path).expect("load first split output");
        let first_page_id = *first_output
            .get_pages()
            .get(&1)
            .expect("first split output page");
        let first_page = first_output
            .get_dictionary(first_page_id)
            .expect("first split output page dictionary");
        assert!(first_page.has(b"Resources"));
        assert!(first_page.has(b"MediaBox"));
        assert!(!first_output.catalog().unwrap().has(b"Metadata"));
        assert!(!first_output.catalog().unwrap().has(b"OutputIntents"));
        assert!(matches!(
            first_output.trailer.get(b"ID"),
            Ok(Object::Array(ids)) if ids.len() == 2
        ));
        assert_eq!(
            pdf_info_text(&first_output, b"Producer").as_deref(),
            Some(PDF_APP_NAME)
        );
        assert_eq!(
            pdf_info_text(&first_output, b"Creator").as_deref(),
            Some(PDF_APP_NAME)
        );
        assert!(pdf_info_text(&first_output, b"CreationDate")
            .expect("split output creation date")
            .starts_with("D:"));
        assert!(pdf_info_text(&first_output, b"Title").is_none());
        assert!(pdf_info_text(&first_output, b"Keywords").is_none());

        let output_dir = PathBuf::from(&result.output_dir);
        assert_eq!(output_dir.parent(), Some(work_dir.as_path()));
        let output_folder_name = output_dir
            .file_name()
            .and_then(|value| value.to_str())
            .expect("output folder name");
        assert!(output_folder_name.starts_with("Doc103480001_split_"));
        assert_eq!(
            output_folder_name.len(),
            "Doc103480001_split_".len() + "20260717_152203_367".len()
        );
        assert_eq!(result.files.len(), 2);
        assert_eq!(result.files[0].file_name, "Doc103480001_001.pdf");
        assert_eq!(result.files[1].file_name, "Doc103480001_002.pdf");
        assert_eq!(result.files[0].page_count, 2);
        assert_eq!(result.files[1].page_count, 2);

        let _ = fs::remove_dir_all(&work_dir);
    }

    #[test]
    fn split_pdf_can_write_next_to_original_and_delete_source_after_success() {
        let work_dir = std::env::temp_dir().join(format!(
            "splitpdf-split-delete-source-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&work_dir);
        fs::create_dir_all(&work_dir).expect("create split delete smoke dir");
        let source_path = work_dir.join("DocDeleteSource.pdf");
        create_smoke_pdf_with_page_count(&source_path, 3);

        let result = split_pdf_impl(
            source_path.to_string_lossy().to_string(),
            vec![2, 3],
            "test-run-delete".to_string(),
            Some(SplitOutputOptions {
                custom_folder_path: None,
                mode: SplitOutputMode::OriginalFolderDeleteOriginal,
            }),
            |_| {},
        )
        .expect("split and delete source smoke pdf");

        assert_eq!(PathBuf::from(&result.output_dir), work_dir);
        assert_eq!(result.files.len(), 3);
        assert!(result
            .files
            .iter()
            .all(|file| Path::new(&file.file_path).parent() == Some(work_dir.as_path())));
        assert!(!source_path.exists());

        let _ = fs::remove_dir_all(&work_dir);
    }

    #[test]
    fn save_pdf_edits_overwrites_original_with_selected_pages() {
        let work_dir =
            std::env::temp_dir().join(format!("splitpdf-save-edits-{}", std::process::id()));
        fs::create_dir_all(&work_dir).expect("create save edits smoke dir");
        let source_path = work_dir.join("Editable.pdf");
        create_smoke_pdf_with_page_count(&source_path, 3);

        let metadata = save_pdf_edits_impl(
            source_path.to_string_lossy().to_string(),
            vec![EditPagePlan {
                paint_edits: vec![],
                rotation: 90,
                source: PageSource::Pdf {
                    file_name: "Editable.pdf".to_string(),
                    file_path: source_path.to_string_lossy().to_string(),
                    page_number: 2,
                },
            }],
        )
        .expect("save edited pdf");

        let saved_document = LopdfDocument::load(&source_path).expect("load saved edited pdf");
        let saved_page_id = *saved_document
            .get_pages()
            .get(&1)
            .expect("saved edited page");
        let saved_page = saved_document
            .get_dictionary(saved_page_id)
            .expect("saved edited page dictionary");

        assert_eq!(metadata.page_count, 1);
        assert_eq!(
            read_page_count(&source_path).expect("read saved page count"),
            1
        );
        assert_eq!(
            saved_page
                .get(b"Rotate")
                .and_then(Object::as_i64)
                .expect("saved page rotate"),
            90
        );
        assert_eq!(
            pdf_info_text(&saved_document, b"Producer").as_deref(),
            Some(PDF_APP_NAME)
        );
        assert_eq!(
            pdf_info_text(&saved_document, b"Creator").as_deref(),
            Some(PDF_APP_NAME)
        );
        assert!(pdf_info_text(&saved_document, b"Title").is_none());

        let _ = fs::remove_dir_all(&work_dir);
    }

    #[test]
    fn page_source_serializes_fields_as_camel_case() {
        let value = serde_json::to_value(PageSource::Image {
            file_name: "scan.jpg".to_string(),
            file_path: "C:\\Temp\\scan.jpg".to_string(),
            width: 1200,
            height: 1800,
        })
        .expect("serialize page source");

        assert_eq!(value["type"], "image");
        assert_eq!(value["fileName"], "scan.jpg");
        assert_eq!(value["filePath"], "C:\\Temp\\scan.jpg");
        assert!(value.get("file_name").is_none());
        assert!(value.get("file_path").is_none());
    }

    fn create_smoke_pdf(path: &Path) {
        create_smoke_pdf_with_page_count(path, 1);
    }

    fn create_pdf_with_indirect_content_array(path: &Path) {
        let mut document = LopdfDocument::with_version("1.5");
        let pages_id = document.new_object_id();
        let image_id = document.add_object(Stream::new(
            dictionary! {
                "Type" => "XObject",
                "Subtype" => "Image",
                "Width" => 1,
                "Height" => 1,
                "ColorSpace" => "DeviceRGB",
                "BitsPerComponent" => 8,
                "Filter" => "DCTDecode",
            },
            vec![0xff, 0xd8, 0xff, 0xd9],
        ));
        let content_id = document.add_object(Stream::new(
            dictionary! {},
            b"q\n1 0 0 1 0 0 cm\n/Im0 Do\nQ\n".to_vec(),
        ));
        let content_array_id =
            document.add_object(Object::Array(vec![Object::Reference(content_id)]));
        let page_id = document.add_object(dictionary! {
            "Type" => "Page",
            "Parent" => pages_id,
            "Resources" => dictionary! {
                "XObject" => dictionary! {
                    "Im0" => image_id,
                },
            },
            "MediaBox" => vec![0.into(), 0.into(), 100.into(), 100.into()],
            "Contents" => content_array_id,
        });
        document.objects.insert(
            pages_id,
            Object::Dictionary(dictionary! {
                "Type" => "Pages",
                "Kids" => vec![Object::Reference(page_id)],
                "Count" => 1,
            }),
        );
        let catalog_id = document.add_object(dictionary! {
            "Type" => "Catalog",
            "Pages" => pages_id,
        });
        document.trailer.set("Root", catalog_id);
        document.save(path).expect("save indirect content pdf");
    }

    fn create_smoke_pdf_with_page_count(path: &Path, page_count: u32) {
        let mut document = LopdfDocument::with_version("1.5");
        let pages_id = document.new_object_id();
        let font_id = document.add_object(dictionary! {
            "Type" => "Font",
            "Subtype" => "Type1",
            "BaseFont" => "Courier",
        });
        let resources_id = document.add_object(dictionary! {
            "Font" => dictionary! {
                "F1" => font_id,
            },
        });

        let mut page_ids = Vec::with_capacity(page_count as usize);
        for page_number in 1..=page_count {
            let content = Content {
                operations: vec![
                    Operation::new("BT", vec![]),
                    Operation::new("Tf", vec!["F1".into(), 42.into()]),
                    Operation::new("Td", vec![72.into(), 720.into()]),
                    Operation::new(
                        "Tj",
                        vec![Object::string_literal(format!(
                            "SplitPDF page {page_number}"
                        ))],
                    ),
                    Operation::new("ET", vec![]),
                ],
            };
            let content_id = document.add_object(Stream::new(
                dictionary! {},
                content.encode().expect("encode content"),
            ));
            let page_id = document.add_object(dictionary! {
                "Type" => "Page",
                "Parent" => pages_id,
                "Contents" => content_id,
            });
            page_ids.push(page_id.into());
        }

        let pages = dictionary! {
            "Type" => "Pages",
            "Kids" => page_ids,
            "Count" => page_count as i64,
            "Resources" => resources_id,
            "MediaBox" => vec![0.into(), 0.into(), 595.into(), 842.into()],
        };
        document.objects.insert(pages_id, Object::Dictionary(pages));
        let catalog_id = document.add_object(dictionary! {
            "Type" => "Catalog",
            "Pages" => pages_id,
        });
        document.trailer.set("Root", catalog_id);
        document.compress();
        document.save(path).expect("save smoke pdf");
    }

    fn assert_flat_page_contents(
        document: &LopdfDocument,
        contents: &Object,
        expected_ids: &[ObjectId],
    ) {
        let content_ids = flat_content_ids(document, contents);
        if !expected_ids.is_empty() {
            assert_eq!(content_ids, expected_ids);
        }

        for content_id in content_ids {
            assert!(matches!(
                document.objects.get(&content_id),
                Some(Object::Stream(_))
            ));
        }
    }

    fn flat_content_ids(document: &LopdfDocument, contents: &Object) -> Vec<ObjectId> {
        match contents {
            Object::Reference(id) => match document.objects.get(id) {
                Some(Object::Stream(_)) => vec![*id],
                Some(Object::Array(_)) => panic!("page contents reference an array"),
                other => panic!("page contents reference unexpected object: {other:?}"),
            },
            Object::Array(values) => values
                .iter()
                .flat_map(|value| match value {
                    Object::Reference(id) => match document.objects.get(id) {
                        Some(Object::Stream(_)) => vec![*id],
                        Some(Object::Array(_)) => panic!("nested content array was not flattened"),
                        other => panic!("content array references unexpected object: {other:?}"),
                    },
                    Object::Array(_) => panic!("direct nested content array was not flattened"),
                    other => panic!("content array contains unexpected object: {other:?}"),
                })
                .collect(),
            other => panic!("page contents were not normalized: {other:?}"),
        }
    }

    fn page_image_filters(document: &LopdfDocument, page_dictionary: &Dictionary) -> Vec<String> {
        let mut filters = Vec::new();
        let Ok(resources) = page_dictionary.get(b"Resources") else {
            return filters;
        };
        let Ok(resources) = resources.as_dict() else {
            return filters;
        };
        let Ok(xobjects) = resources.get(b"XObject") else {
            return filters;
        };
        let Ok(xobjects) = xobjects.as_dict() else {
            return filters;
        };

        for (_, object) in xobjects {
            let Ok(object_id) = object.as_reference() else {
                continue;
            };
            let Some(Object::Stream(stream)) = document.objects.get(&object_id) else {
                continue;
            };
            if stream
                .dict
                .get(b"Subtype")
                .ok()
                .and_then(|value| value.as_name().ok())
                == Some(b"Image".as_slice())
            {
                let filter = stream
                    .dict
                    .get(b"Filter")
                    .ok()
                    .and_then(|value| value.as_name().ok())
                    .map(|name| format!("/{}", String::from_utf8_lossy(name)))
                    .unwrap_or_else(|| "None".to_string());
                filters.push(filter);
            }
        }

        filters
    }

    fn pdf_info_text(document: &LopdfDocument, key: &[u8]) -> Option<String> {
        let info = super::pdf_info_dictionary(document)?;
        let bytes = info.get(key).ok()?.as_str().ok()?;
        Some(String::from_utf8_lossy(bytes).to_string())
    }
}
