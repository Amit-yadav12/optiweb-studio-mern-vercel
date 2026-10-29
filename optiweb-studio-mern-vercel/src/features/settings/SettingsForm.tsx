import { useEffect, useState } from "react";
import { Check, Loader2, Save, ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { ErrorState, StatusBadge, useToast } from "@/components/ui/Feedback";
import { Field, Input, Select } from "@/components/ui/Form";
import { DefinitionRow, Panel, PanelHeader } from "@/components/ui/Layout";
import { ApiClientError, api } from "@/lib/api-client";
import { formatBytes, formatDateTime } from "@/lib/format";
import type { FontDisplayPolicy, ImageFormat, Preferences } from "@/types/domain";

const FORMATS: Array<{ value: ImageFormat; label: string }> = [
  { value: "webp", label: "WebP (default)" },
  { value: "avif", label: "AVIF" },
  { value: "jpeg", label: "JPEG" },
  { value: "png", label: "PNG" },
  { value: "original", label: "Keep source format" },
];

const POLICIES: Array<{ value: FontDisplayPolicy; label: string }> = [
  { value: "swap", label: "swap — fallback shows immediately (default)" },
  { value: "fallback", label: "fallback — short block, short swap" },
  { value: "optional", label: "optional — browser may keep the fallback" },
  { value: "block", label: "block — invisible up to ~3s" },
  { value: "auto", label: "auto — browser default" },
];

export function SettingsForm({ defaults }: { defaults: Preferences }) {
  const { push } = useToast();
  const [form, setForm] = useState<Preferences>(defaults);
  const [status, setStatus] = useState<"idle" | "saving" | "saved">("idle");
  const [failure, setFailure] = useState<{ message: string; hint?: string } | null>(null);
  const [session, setSession] = useState<{ shortCode: string; issued: boolean } | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const [clearing, setClearing] = useState(false);

  useEffect(() => {
    api
      .get<Preferences>("/api/v1/preferences")
      .then((stored) => setForm(stored))
      .catch(() => {
        /* keep built-in defaults */
      });
    api
      .get<{ shortCode: string; issued: boolean }>("/api/v1/session")
      .then(setSession)
      .catch(() => setSession(null));
  }, []);

  const save = async () => {
    setStatus("saving");
    setFailure(null);
    try {
      const saved = await api.put<Preferences>("/api/v1/preferences", {
        defaultImageFormat: form.defaultImageFormat,
        defaultQuality: form.defaultQuality,
        defaultMaxWidth: form.defaultMaxWidth,
        fontDisplayPolicy: form.fontDisplayPolicy,
        analyzerThresholdKb: form.analyzerThresholdKb,
        reduceMotion: form.reduceMotion,
      });
      setForm(saved);
      setStatus("saved");
      push({ tone: "ok", title: "Defaults saved", description: "New jobs start from these values." });
      setTimeout(() => setStatus("idle"), 2000);
    } catch (error) {
      const message = error instanceof ApiClientError ? error.message : "The settings could not be saved.";
      setFailure({ message, hint: error instanceof ApiClientError ? error.hint : undefined });
      setStatus("idle");
      push({ tone: "danger", title: "Save failed", description: message });
    }
  };

  const clearHistory = async () => {
    setClearing(true);
    try {
      const result = await api.del<{ removed: number }>("/api/v1/history");
      push({ tone: "ok", title: "Session cleared", description: `${result.removed} job${result.removed === 1 ? "" : "s"} removed.` });
    } catch (error) {
      const message = error instanceof ApiClientError ? error.message : "History could not be cleared.";
      push({ tone: "danger", title: "Clear failed", description: message });
    } finally {
      setClearing(false);
      setConfirmClear(false);
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <Panel aria-labelledby="optimizer-defaults">
        <PanelHeader
          id="optimizer-defaults"
          title="Optimizer defaults"
          description="Applied to every new job in this session. Changing them does not alter results already produced."
          meta={form.updatedAt ? <StatusBadge tone="neutral">saved {formatDateTime(form.updatedAt)}</StatusBadge> : <StatusBadge tone="accent">built-in defaults</StatusBadge>}
        />
        <div className="grid gap-5 md:grid-cols-2">
          <Field label="Default output format" htmlFor="pref-format" hint="Used by the Image Optimizer on load.">
            <Select
              id="pref-format"
              value={form.defaultImageFormat}
              onChange={(event) => setForm({ ...form, defaultImageFormat: event.target.value as ImageFormat })}
            >
              {FORMATS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field
            label="Default quality"
            htmlFor="pref-quality"
            hint="30 is aggressively small, 100 is closest to the source."
            trailing={<span className="font-mono text-xs text-muted tnum">{form.defaultQuality}</span>}
          >
            <input
              id="pref-quality"
              type="range"
              min={30}
              max={100}
              value={form.defaultQuality}
              onChange={(event) => setForm({ ...form, defaultQuality: Number(event.target.value) })}
              className="mt-2.5 h-1.5 w-full accent-accent"
            />
          </Field>
          <Field
            label="Default max width (px)"
            htmlFor="pref-width"
            hint="Leave empty to keep the source dimensions. Images are never enlarged."
          >
            <Input
              id="pref-width"
              inputMode="numeric"
              placeholder="e.g. 1920"
              value={form.defaultMaxWidth ?? ""}
              onChange={(event) => {
                const raw = event.target.value.replace(/[^\d]/g, "");
                setForm({ ...form, defaultMaxWidth: raw ? Number(raw) : null });
              }}
            />
          </Field>
          <Field
            label="Analyzer size threshold"
            htmlFor="pref-threshold"
            hint="Files above this size are flagged as large. It is a heuristic, not a rule."
            trailing={<span className="font-mono text-xs text-muted tnum">{form.analyzerThresholdKb} KB</span>}
          >
            <input
              id="pref-threshold"
              type="range"
              min={50}
              max={4000}
              step={50}
              value={form.analyzerThresholdKb}
              onChange={(event) => setForm({ ...form, analyzerThresholdKb: Number(event.target.value) })}
              className="mt-2.5 h-1.5 w-full accent-accent"
            />
          </Field>
          <Field
            label="CSS font-display policy"
            htmlFor="pref-policy"
            hint="The value inserted by the Font Optimizer. No single value is best for every project."
          >
            <Select
              id="pref-policy"
              value={form.fontDisplayPolicy}
              onChange={(event) => setForm({ ...form, fontDisplayPolicy: event.target.value as FontDisplayPolicy })}
            >
              {POLICIES.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Motion" htmlFor="pref-motion" hint="Reduces non-essential interface animation. Your system setting is always respected.">
            <label htmlFor="pref-motion" className="flex h-9.5 items-center gap-2.5 text-sm text-ink">
              <input
                id="pref-motion"
                type="checkbox"
                checked={form.reduceMotion}
                onChange={(event) => setForm({ ...form, reduceMotion: event.target.checked })}
                className="size-4 accent-accent"
              />
              Minimise interface motion
            </label>
          </Field>
        </div>

        <div className="mt-6 flex flex-wrap items-center gap-3 border-t border-line pt-4">
          <Button variant="primary" onClick={save} loading={status === "saving"} leading={status === "saved" ? <Check className="size-3.5" aria-hidden /> : <Save className="size-3.5" aria-hidden />}>
            {status === "saved" ? "Saved" : "Save defaults"}
          </Button>
          <Button variant="ghost" onClick={() => setForm(defaults)} disabled={status === "saving"}>
            Reset to built-ins
          </Button>
        </div>

        {failure ? (
          <div className="mt-4">
            <ErrorState title="Save failed" message={failure.message} hint={failure.hint} />
          </div>
        ) : null}
      </Panel>

      <div className="grid gap-6 lg:grid-cols-2">
        <Panel aria-labelledby="session-data">
          <PanelHeader
            id="session-data"
            title="This session"
            description="OptiWeb has no accounts. An anonymous cookie identifies your session so history stays private to you."
          />
          <dl>
            <DefinitionRow label="Session" value={session?.shortCode ?? "not issued yet"} />
            <DefinitionRow label="Mode" value="guest" />
            <DefinitionRow label="Artifact retention" value="30 days by default (configurable)" />
            <DefinitionRow label="Uploaded bytes kept" value="none — only produced results" />
          </dl>
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <Button variant="danger" size="sm" onClick={() => setConfirmClear(true)} leading={<ShieldAlert className="size-3.5" aria-hidden />}>
              Clear session history
            </Button>
            {clearing ? (
              <span className="flex items-center gap-1.5 text-xs text-muted">
                <Loader2 className="size-3.5 animate-spin" aria-hidden />
                Clearing…
              </span>
            ) : null}
          </div>
        </Panel>

        <Panel aria-labelledby="limits">
          <PanelHeader id="limits" title="Enforced limits" description="These are validated on the server; the interface mirrors them." />
          <dl>
            <DefinitionRow label="Max file size" value={formatBytes(10 * 1024 * 1024)} />
            <DefinitionRow label="Max files per batch" value="8" />
            <DefinitionRow label="Quality range" value="30 – 100" />
            <DefinitionRow label="Dimension cap" value="8000 px" />
            <DefinitionRow label="CSS length cap" value="400,000 characters" />
            <DefinitionRow label="Requests" value="20 optimizations / minute / session" />
          </dl>
        </Panel>
      </div>

      <ConfirmDialog
        open={confirmClear}
        title="Clear all session history?"
        description="Every job record and stored artifact for this session will be deleted. Your preferences are kept."
        confirmLabel="Clear history"
        tone="danger"
        loading={clearing}
        onCancel={() => setConfirmClear(false)}
        onConfirm={clearHistory}
      />
    </div>
  );
}
