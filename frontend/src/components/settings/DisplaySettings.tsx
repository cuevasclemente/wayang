import { useState } from "react";
import { RotateCcw, Type } from "lucide-react";
import {
  DEFAULT_UI_SCALE,
  MAX_UI_SCALE,
  MIN_UI_SCALE,
  UI_SCALE_PRESETS,
  formatUiScalePercent,
  readStoredUiScale,
  setUiScale,
} from "../../lib/uiScale";

/**
 * Display preferences. Currently one control: the UI scale.
 *
 * The scale drives the document root font size, so rem-based text and spacing
 * grow together. Micro px labels deliberately stay fixed; they are annotation,
 * not reading text.
 */
export function DisplaySettings() {
  const [scale, setScale] = useState(readStoredUiScale);

  const update = (next: number) => setScale(setUiScale(next));

  return (
    <section className="w-full max-w-2xl" aria-labelledby="display-settings-title">
      <div className="mb-5">
        <h3 id="display-settings-title" className="text-base font-semibold text-neutral-100">
          Display
        </h3>
        <p className="mt-1 text-sm leading-relaxed text-neutral-400">
          Adjust how large Wayang renders on this device. The setting is stored in this browser and
          applies to text and spacing together, so nothing is shrunk to fit.
        </p>
      </div>

      <div className="rounded-lg border border-neutral-800 bg-neutral-900/40 p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Type size={18} className="shrink-0 text-neutral-400" />
            <p className="text-sm font-medium text-neutral-100">Interface size</p>
          </div>
          <div className="flex items-center gap-2">
            <span data-testid="ui-scale-value" className="font-mono text-xs text-neutral-300">
              {formatUiScalePercent(scale)}
            </span>
            <button
              type="button"
              data-testid="ui-scale-reset"
              onClick={() => update(DEFAULT_UI_SCALE)}
              disabled={scale === DEFAULT_UI_SCALE}
              className="inline-flex items-center gap-1.5 rounded border border-neutral-700 px-2.5 py-1.5 text-xs font-semibold text-neutral-200 hover:bg-neutral-800 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <RotateCcw size={13} /> Reset
            </button>
          </div>
        </div>

        <input
          type="range"
          data-testid="ui-scale-range"
          min={MIN_UI_SCALE}
          max={MAX_UI_SCALE}
          step={0.05}
          value={scale}
          onChange={(event) => update(Number.parseFloat(event.target.value))}
          aria-label="Interface size"
          className="mt-4 w-full accent-blue-500"
        />

        <div className="mt-3 flex flex-wrap gap-2">
          {UI_SCALE_PRESETS.map((preset) => (
            <button
              key={preset.label}
              type="button"
              data-testid={`ui-scale-preset-${preset.label.toLowerCase()}`}
              onClick={() => update(preset.scale)}
              aria-pressed={scale === preset.scale}
              className={`rounded border px-2.5 py-1.5 text-xs font-semibold ${scale === preset.scale ? "border-blue-500 bg-blue-950/60 text-blue-100" : "border-neutral-700 text-neutral-300 hover:bg-neutral-800"}`}
            >
              {preset.label}
            </button>
          ))}
        </div>

        <div className="mt-4 rounded border border-neutral-800 bg-neutral-950/60 px-3 py-3">
          <p className="text-xs uppercase tracking-wider text-neutral-500">Preview</p>
          <p className="mt-1 text-sm text-neutral-200">
            The agent finished the task and left a summary in the transcript.
          </p>
          <p className="mt-1 font-mono text-[11px] text-neutral-400">~/src/wayang · session ready</p>
        </div>
      </div>
    </section>
  );
}
