import type { RenderQualityPreset, RenderQualitySettings } from "../domain/pdfSettings";
import {
  clampRenderQualitySettings,
  DEFAULT_CUSTOM_RENDER_QUALITY,
  DEFAULT_RENDER_QUALITY_PRESET,
  DEFAULT_THUMBNAIL_SCALE,
  isRenderQualityPreset,
  THUMBNAIL_SCALE_MAX,
  THUMBNAIL_SCALE_MIN,
} from "../domain/pdfSettings";

export interface EditorPreferences {
  customRenderQuality: RenderQualitySettings;
  detailPanelVisible: boolean;
  renderQualityPreset: RenderQualityPreset;
  thumbnailScale: number;
}

const PREFERENCES_KEY = "splitpdf.editorPreferences.v1";

export const DEFAULT_EDITOR_PREFERENCES: EditorPreferences = {
  customRenderQuality: DEFAULT_CUSTOM_RENDER_QUALITY,
  detailPanelVisible: true,
  renderQualityPreset: DEFAULT_RENDER_QUALITY_PRESET,
  thumbnailScale: DEFAULT_THUMBNAIL_SCALE,
};

export function loadEditorPreferences(): EditorPreferences {
  if (typeof window === "undefined") {
    return DEFAULT_EDITOR_PREFERENCES;
  }

  try {
    const storedValue = window.localStorage.getItem(PREFERENCES_KEY);
    if (!storedValue) {
      return DEFAULT_EDITOR_PREFERENCES;
    }

    const parsedValue: unknown = JSON.parse(storedValue);
    if (!isJsonObject(parsedValue)) {
      return DEFAULT_EDITOR_PREFERENCES;
    }

    return {
      customRenderQuality: parseRenderQualitySettings(parsedValue.customRenderQuality),
      detailPanelVisible:
        typeof parsedValue.detailPanelVisible === "boolean" ? parsedValue.detailPanelVisible : DEFAULT_EDITOR_PREFERENCES.detailPanelVisible,
      renderQualityPreset: isRenderQualityPreset(parsedValue.renderQualityPreset)
        ? parsedValue.renderQualityPreset
        : DEFAULT_EDITOR_PREFERENCES.renderQualityPreset,
      thumbnailScale: typeof parsedValue.thumbnailScale === "number" ? clampThumbnailScale(parsedValue.thumbnailScale) : DEFAULT_EDITOR_PREFERENCES.thumbnailScale,
    };
  } catch {
    return DEFAULT_EDITOR_PREFERENCES;
  }
}

export function saveEditorPreferences(preferences: EditorPreferences) {
  if (typeof window === "undefined") {
    return;
  }

  try {
    window.localStorage.setItem(
      PREFERENCES_KEY,
      JSON.stringify({
        customRenderQuality: clampRenderQualitySettings(preferences.customRenderQuality),
        detailPanelVisible: preferences.detailPanelVisible,
        renderQualityPreset: preferences.renderQualityPreset,
        thumbnailScale: clampThumbnailScale(preferences.thumbnailScale),
      }),
    );
  } catch {
    // Preferences are a convenience; keep the editor usable if the browser denies storage.
  }
}

function clampThumbnailScale(scale: number): number {
  return Math.min(THUMBNAIL_SCALE_MAX, Math.max(THUMBNAIL_SCALE_MIN, scale));
}

function parseRenderQualitySettings(value: unknown): RenderQualitySettings {
  if (!isJsonObject(value)) {
    return DEFAULT_EDITOR_PREFERENCES.customRenderQuality;
  }

  return clampRenderQualitySettings({
    detailJpegQuality: numberOrDefault(value.detailJpegQuality, DEFAULT_EDITOR_PREFERENCES.customRenderQuality.detailJpegQuality),
    detailWidth: numberOrDefault(value.detailWidth, DEFAULT_EDITOR_PREFERENCES.customRenderQuality.detailWidth),
    label: "Custom",
    smallJpegQuality: numberOrDefault(value.smallJpegQuality, DEFAULT_EDITOR_PREFERENCES.customRenderQuality.smallJpegQuality),
    smallWidth: numberOrDefault(value.smallWidth, DEFAULT_EDITOR_PREFERENCES.customRenderQuality.smallWidth),
  });
}

function numberOrDefault(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
