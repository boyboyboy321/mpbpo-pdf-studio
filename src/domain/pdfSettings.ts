export const THUMBNAIL_SCALE_MIN = 0.78;
export const THUMBNAIL_SCALE_MAX = 1.22;
export const THUMBNAIL_SCALE_STEP = 0.02;
export const DEFAULT_THUMBNAIL_SCALE = THUMBNAIL_SCALE_MIN;

export interface RenderQualitySettings {
  detailJpegQuality: number;
  detailWidth: number;
  label: string;
  smallJpegQuality: number;
  smallWidth: number;
}

export const RENDER_QUALITY_LIMITS = {
  detailJpegQualityMax: 96,
  detailJpegQualityMin: 45,
  detailWidthMax: 4200,
  detailWidthMin: 480,
  smallJpegQualityMax: 96,
  smallJpegQualityMin: 45,
  smallWidthMax: 720,
  smallWidthMin: 72,
} as const;

export const RENDER_QUALITY_PRESETS = {
  draft: {
    detailJpegQuality: 60,
    detailWidth: 640,
    label: "Draft",
    smallJpegQuality: 50,
    smallWidth: 82,
  },
  compact: {
    detailJpegQuality: 72,
    detailWidth: 840,
    label: "Light (best for 1/2/3)",
    smallJpegQuality: 58,
    smallWidth: 105,
  },
  balanced: {
    detailJpegQuality: 76,
    detailWidth: 900,
    label: "Balanced (Recommended)",
    smallJpegQuality: 66,
    smallWidth: 124,
  },
  sharp: {
    detailJpegQuality: 82,
    detailWidth: 1080,
    label: "Sharp",
    smallJpegQuality: 74,
    smallWidth: 150,
  },
  ultra: {
    detailJpegQuality: 92,
    detailWidth: 2200,
    label: "Ultra",
    smallJpegQuality: 90,
    smallWidth: 220,
  },
  original: {
    detailJpegQuality: 94,
    detailWidth: 3200,
    label: "Original (not recommended)",
    smallJpegQuality: 92,
    smallWidth: 280,
  },
  custom: {
    detailJpegQuality: 76,
    detailWidth: 900,
    label: "Custom",
    smallJpegQuality: 66,
    smallWidth: 124,
  },
} as const satisfies Record<string, RenderQualitySettings>;

export type RenderQualityPreset = keyof typeof RENDER_QUALITY_PRESETS;

export const DEFAULT_RENDER_QUALITY_PRESET: RenderQualityPreset = "balanced";
export const DEFAULT_CUSTOM_RENDER_QUALITY: RenderQualitySettings = RENDER_QUALITY_PRESETS.custom;

export function isRenderQualityPreset(value: unknown): value is RenderQualityPreset {
  return typeof value === "string" && value in RENDER_QUALITY_PRESETS;
}

export function clampRenderQualitySettings(settings: RenderQualitySettings): RenderQualitySettings {
  return {
    detailJpegQuality: clamp(settings.detailJpegQuality, RENDER_QUALITY_LIMITS.detailJpegQualityMin, RENDER_QUALITY_LIMITS.detailJpegQualityMax),
    detailWidth: clamp(settings.detailWidth, RENDER_QUALITY_LIMITS.detailWidthMin, RENDER_QUALITY_LIMITS.detailWidthMax),
    label: "Custom",
    smallJpegQuality: clamp(settings.smallJpegQuality, RENDER_QUALITY_LIMITS.smallJpegQualityMin, RENDER_QUALITY_LIMITS.smallJpegQualityMax),
    smallWidth: clamp(settings.smallWidth, RENDER_QUALITY_LIMITS.smallWidthMin, RENDER_QUALITY_LIMITS.smallWidthMax),
  };
}

export function getRenderQualitySettings(preset: RenderQualityPreset, customSettings: RenderQualitySettings): RenderQualitySettings {
  return preset === "custom" ? clampRenderQualitySettings(customSettings) : RENDER_QUALITY_PRESETS[preset];
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }

  return Math.round(Math.min(max, Math.max(min, value)));
}
