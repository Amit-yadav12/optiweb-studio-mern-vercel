import { useEffect, useRef, useState } from "react";
import { Check, RotateCcw, Save } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Notice, StatusBadge, useToast } from "@/components/ui/Feedback";
import { Field, Input, Select } from "@/components/ui/Form";
import { DefinitionRow, Panel, PanelHeader } from "@/components/ui/Layout";
import { DIMENSION_MAX, DIMENSION_MIN, QUALITY_MAX, QUALITY_MIN, clampDimension } from "@/features/images/engine/plan";
import type { FormatChoice, Strategy } from "@/features/images/engine/types";
import {
  DEFAULT_PREFERENCES,
  THRESHOLD_KB_MAX,
  THRESHOLD_KB_MIN,
  normalizePreferences,
  resetPreferences,
  savePreferences,
  usePreferences,
  type Preferences,
} from "@/lib/preferences";
import { CSS_DRAFT_STORAGE_KEY, PREFERENCES_STORAGE_KEY, REDUCE_MOTION_CLASS, THEME_STORAGE_KEY } from "@/lib/storage-keys";
import type { FontDisplayPolicy } from "@/shared/css";

const FORMATS: Array<{ value: FormatChoice; label: string }> = [
  { value: "webp", label: "WebP (default)" },
  { value: "avif", label: "AVIF" },
  { value: "jpeg", label: "JPEG" },
  { value: "png", label: "PNG" },
  { value: "original", label: "Keep source format" },
];

const STRATEGIES: Array<{ value: Strategy; label: string }> = [
  { value: "single", label: "Single: write the chosen format (default)" },
  { value: "best-effort", label: "Best-effort: smallest of WebP, AVIF and JPEG" },
  { value: "no-regression", label: "No-regression: never larger than the original" },
];

const POLICIES: Array<{ value: FontDisplayPolicy; label: string }> = [
  { value: "swap", label: "swap: fallback shows immediately (default)" },
  { value: "fallback", label: "fallback: short block, short swap" },
  { value: "optional", label: "optional: browser may keep the fallback" },
  { value: "block", label: "block: invisible up to ~3s" },
  { value: "auto", label: "auto: browser default" },
];

const same = (a: Preferences, b: Preferences) => JSON.stringify(a) === JSON.stringify(b);

/**
 * The settings form. Settings are saved in this browser's localStorage and
 * nowhere else.
 */
export function SettingsForm() {
  const { push } = useToast();
  const stored = usePreferences();
  const [form, setForm] = useState<Preferences>(stored);
  const [width, setWidth] = useState<string>(stored.defaultMaxWidth ? String(stored.defaultMaxWidth) : "");
  const [justSaved, setJustSaved] = useState(false);
  const [notStored, setNotStored] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (savedTimer.current) clearTimeout(savedTimer.current);
  }, []);

  const widthValue = width === "" ? null : Number(width);
  const widthInvalid = widthValue !== null && (widthValue < DIMENSION_MIN || widthValue > DIMENSION_MAX);
  const draft = normalizePreferences({ ...form, defaultMaxWidth: widthInvalid ? stored.defaultMaxWidth : clampDimension(widthValue) });
  const dirty = !same(draft, stored);

  const save = () => {
    if (widthInvalid) return;
    const ok = savePreferences(draft);
    document.documentElement.classList.toggle(REDUCE_MOTION_CLASS, draft.reduceMotion);
    setForm(draft);
    setNotStored(!ok);
    setJustSaved(true);
    if (savedTimer.current) clearTimeout(savedTimer.current);
    savedTimer.current = setTimeout(() => setJustSaved(false), 2000);
    push(
      ok
        ? { tone: "ok", title: "Settings saved in this browser", description: "The tools start from these values." }
        : { tone: "warn", title: "Settings applied, but not stored", description: "This browser refused to store them. They apply until the page is reloaded." },
    );
  };

  const reset = () => {
    resetPreferences();
    document.documentElement.classList.remove(REDUCE_MOTION_CLASS);
    setForm({ ...DEFAULT_PREFERENCES });
    setWidth("");
    setNotStored(false);
    setConfirmReset(false);
    push({ tone: "ok", title: "Settings reset", description: "The stored settings were removed from this browser." });
  };

  const isDefault = same(stored, { ...DEFAULT_PREFERENCES });

  return (
    <div className="flex flex-col gap-6">
      <Panel labelledBy="optimizer-defaults">
        <PanelHeader
          id="optimizer-defaults"
          title="Optimizer defaults"
          description="The Image Optimizer starts from these values. Changing them does not alter results already produced."
          meta={<StatusBadge tone={isDefault ? "accent" : "neutral"}>{isDefault ? "built-in defaults" : "saved in this browser"}</StatusBadge>}
        />
        <div className="grid gap-5 md:grid-cols-2">
          <Field label="Default output format" htmlFor="pref-format" hint="Used when the strategy writes a single format.">
            <Select id="pref-format" value={form.defaultImageFormat} onChange={(event) => setForm({ ...form, defaultImageFormat: event.target.value as FormatChoice })}>
              {FORMATS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Default strategy" htmlFor="pref-strategy" hint="How the result is chosen for each file.">
            <Select id="pref-strategy" value={form.defaultStrategy} onChange={(event) => setForm({ ...form, defaultStrategy: event.target.value as Strategy })}>
              {STRATEGIES.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field
            label="Default quality"
            htmlFor="pref-quality"
            hint={`${QUALITY_MIN} is aggressively small, ${QUALITY_MAX} is closest to the source.`}
            trailing={<span className="font-mono text-xs text-muted tnum">{form.defaultQuality}</span>}
          >
            <input
              id="pref-quality"
              type="range"
              min={QUALITY_MIN}
              max={QUALITY_MAX}
              value={form.defaultQuality}
              onChange={(event) => setForm({ ...form, defaultQuality: Number(event.target.value) })}
              className="mt-2.5 h-1.5 w-full accent-accent"
            />
          </Field>
          <Field
            label="Default max width (px)"
            htmlFor="pref-width"
            hint="Leave empty to keep the source dimensions. Images are never enlarged."
            error={widthInvalid ? `Enter a width between ${DIMENSION_MIN} and ${DIMENSION_MAX.toLocaleString("en-US")}, or leave it empty.` : null}
          >
            <Input id="pref-width" inputMode="numeric" placeholder="e.g. 1920" value={width} invalid={widthInvalid} onChange={(event) => setWidth(event.target.value.replace(/[^\d]/g, "").slice(0, 5))} />
          </Field>
        </div>
      </Panel>

      <Panel labelledBy="analysis-defaults">
        <PanelHeader id="analysis-defaults" title="Analysis defaults" description="Used by the Font Optimizer and the Asset Analyzer." />
        <div className="grid gap-5 md:grid-cols-2">
          <Field label="font-display policy" htmlFor="pref-policy" hint="The value the Font Optimizer proposes for rules that have none.">
            <Select id="pref-policy" value={form.fontDisplayPolicy} onChange={(event) => setForm({ ...form, fontDisplayPolicy: event.target.value as FontDisplayPolicy })}>
              {POLICIES.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Large-file threshold (KB)" htmlFor="pref-threshold" hint={`The Asset Analyzer flags files above this size. ${THRESHOLD_KB_MIN}–${THRESHOLD_KB_MAX.toLocaleString("en-US")}.`}>
            <Input
              id="pref-threshold"
              inputMode="numeric"
              value={String(form.analyzerThresholdKb)}
              onChange={(event) => setForm({ ...form, analyzerThresholdKb: Number(event.target.value.replace(/[^\d]/g, "").slice(0, 5)) || 0 })}
            />
          </Field>
        </div>
        <label className="mt-5 flex cursor-pointer items-start gap-3 border-t border-line pt-4">
          <input type="checkbox" className="mt-0.5 size-4 accent-accent" checked={form.reduceMotion} onChange={(event) => setForm({ ...form, reduceMotion: event.target.checked })} />
          <span>
            <span className="block text-sm font-medium text-ink">Reduce motion</span>
            <span className="mt-0.5 block text-xs leading-relaxed text-muted">
              Turns off the interface's animations. A system-wide "reduce motion" setting is always respected, whatever is chosen here.
            </span>
          </span>
        </label>
      </Panel>

      {notStored ? (
        <Notice tone="warn" title="This browser did not store the settings">
          <p>They apply to this page until it is reloaded. Private browsing modes and a blocked site storage cause this.</p>
        </Notice>
      ) : null}

      <div className="flex flex-wrap items-center gap-3">
        <Button variant="primary" size="lg" onClick={save} disabled={!dirty || widthInvalid} leading={justSaved ? <Check className="size-4" aria-hidden /> : <Save className="size-4" aria-hidden />}>
          {justSaved && !dirty ? "Saved" : "Save settings"}
        </Button>
        <Button variant="ghost" size="lg" onClick={() => setConfirmReset(true)} disabled={isDefault && !dirty} leading={<RotateCcw className="size-3.5" aria-hidden />}>
          Reset to defaults
        </Button>
        {dirty ? <p className="text-xs text-muted">You have changes that are not saved.</p> : null}
      </div>

      <Panel as="aside" labelledBy="stored-here">
        <PanelHeader id="stored-here" title="What this site keeps in your browser" description="Everything it stores is listed here. There are no cookies, no account and no copy on a server." />
        <dl>
          <DefinitionRow label="Settings on this page" value={`localStorage · ${PREFERENCES_STORAGE_KEY}`} />
          <DefinitionRow label="Light or dark theme, when you choose one" value={`localStorage · ${THEME_STORAGE_KEY}`} />
          <DefinitionRow label="Stylesheet draft in the Font Optimizer" value={`sessionStorage · ${CSS_DRAFT_STORAGE_KEY}`} />
          <DefinitionRow label="Images, results and analysis" value="this tab's memory only" />
        </dl>
        <p className="mt-3 text-xs leading-relaxed text-muted">
          The stylesheet draft is removed when the tab closes. Files you select and the results made from them are never written to storage: they are gone
          when you leave the page.
        </p>
      </Panel>

      <ConfirmDialog
        open={confirmReset}
        title="Reset settings to their defaults?"
        description="The settings stored in this browser are removed. Results on other pages of this tab are not affected."
        confirmLabel="Reset"
        tone="danger"
        onConfirm={reset}
        onCancel={() => setConfirmReset(false)}
      />
    </div>
  );
}
