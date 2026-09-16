/**
 * User-controlled display scale for the Wayang web UI.
 *
 * Wayang's layout is rem-based (Tailwind), so scaling the document root font
 * size zooms text and the spacing that surrounds it together, which is what a
 * "make the UI bigger" control should do. The scale persists in
 * localStorage and is applied before React renders so a reload does not flash
 * the default size.
 */

const STORAGE_KEY = "wayang:ui-scale";

export const MIN_UI_SCALE = 0.5;
export const MAX_UI_SCALE = 2;
export const DEFAULT_UI_SCALE = 1;

export interface UiScalePreset {
  scale: number;
  label: string;
}

/** Coarse presets shown as buttons next to the fine-grained slider. */
export const UI_SCALE_PRESETS: readonly UiScalePreset[] = [
  { scale: 0.5, label: "Tiny" },
  { scale: 0.75, label: "Compact" },
  { scale: 1, label: "Default" },
  { scale: 1.25, label: "Large" },
  { scale: 1.5, label: "Larger" },
  { scale: 2, label: "Largest" },
];

/** Keep a scale inside the supported range and free of float noise. */
export function clampUiScale(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_UI_SCALE;
  const bounded = Math.min(MAX_UI_SCALE, Math.max(MIN_UI_SCALE, value));
  return Math.round(bounded * 100) / 100;
}

/** Parse a persisted value, falling back to the default for anything invalid. */
export function parseUiScale(raw: string | null | undefined): number {
  if (raw == null || raw.trim() === "") return DEFAULT_UI_SCALE;
  const parsed = Number.parseFloat(raw);
  return clampUiScale(parsed);
}

export function formatUiScalePercent(scale: number): string {
  return `${Math.round(clampUiScale(scale) * 100)}%`;
}

export function readStoredUiScale(): number {
  if (typeof window === "undefined") return DEFAULT_UI_SCALE;
  try {
    return parseUiScale(window.localStorage.getItem(STORAGE_KEY));
  } catch {
    return DEFAULT_UI_SCALE;
  }
}

/** Apply a scale to the document root. Safe to call before render. */
export function applyUiScale(scale: number): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  const bounded = clampUiScale(scale);
  if (bounded === DEFAULT_UI_SCALE) {
    root.style.removeProperty("font-size");
  } else {
    root.style.setProperty("font-size", `${bounded * 100}%`);
  }
}

/** Apply whatever was stored last, for use at startup. */
export function applyStoredUiScale(): number {
  const scale = readStoredUiScale();
  applyUiScale(scale);
  return scale;
}

/** Persist and apply a new scale; returns the clamped value. */
export function setUiScale(scale: number): number {
  const bounded = clampUiScale(scale);
  if (typeof window !== "undefined") {
    try {
      if (bounded === DEFAULT_UI_SCALE) {
        window.localStorage.removeItem(STORAGE_KEY);
      } else {
        window.localStorage.setItem(STORAGE_KEY, String(bounded));
      }
    } catch {
      // A blocked/absent localStorage must not break the control.
    }
  }
  applyUiScale(bounded);
  return bounded;
}
