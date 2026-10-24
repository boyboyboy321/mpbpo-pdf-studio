export const releaseNotes = [
  {
    title: "Merge PDF",
    items: [
      "Combine multiple PDFs into one file and drag files into the required order.",
      "Choose an output folder, or create a timestamped merge folder beside the first PDF. Source files are kept unchanged.",
      "Track merge progress and review file or page errors. A failed batch does not leave a partial output PDF.",
    ],
  },
  {
    title: "Insert pages and TIFF",
    items: [
      "Compact progress shows the current file and page count during insertion.",
      "Failed batches list detected file and page errors together, with details available from one button.",
      "Expanded TIFF support includes multi-page scans, JPEG/YCbCr, CMYK, palette, ICC profiles, fax compression, and recoverable missing strip counts.",
    ],
  },
  {
    title: "Crop",
    items: [
      "Pending crops stay open when clicking outside the page.",
      "Apply and cancel controls make it clear whether a crop is kept or discarded.",
    ],
  },
  {
    title: "PDF output",
    items: [
      "Keep the original PDF version when possible, raising it only when the included content requires a newer version.",
      "Merge preserves page content and embedded image streams without rasterizing pages or reducing image resolution.",
      "Output structure checks cover save, split, and merge. PDF/A conversion remains a separate step.",
    ],
  },
];
