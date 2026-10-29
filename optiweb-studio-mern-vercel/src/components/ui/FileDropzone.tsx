import { useCallback, useId, useRef, useState, type DragEvent, type ReactNode } from "react";
import { UploadCloud } from "lucide-react";

export type DroppedFile = File;

/**
 * Dropzone scoped to its own box (never the whole window), keyboard operable,
 * and explicit about limits so rejection messages are predictable.
 */
export function FileDropzone({
  accept,
  multiple = true,
  disabled,
  onFiles,
  title,
  description,
  constraints,
  icon,
  selectedCount,
}: {
  accept: string;
  multiple?: boolean;
  disabled?: boolean;
  onFiles: (files: File[]) => void;
  title: string;
  description: string;
  constraints: ReactNode;
  icon?: ReactNode;
  selectedCount?: number;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [active, setActive] = useState(false);
  const hintId = useId();

  const emit = useCallback(
    (list: FileList | null) => {
      if (!list || list.length === 0) return;
      const files = Array.from(list);
      onFiles(files);
    },
    [onFiles],
  );

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setActive(false);
    if (disabled) return;
    emit(event.dataTransfer.files);
  };

  return (
    <div>
      <div
        onDragOver={(event) => {
          event.preventDefault();
          if (!disabled) setActive(true);
        }}
        onDragLeave={() => setActive(false)}
        onDrop={handleDrop}
        className={`relative rounded-lg border border-dashed transition-colors duration-150 ${
          active ? "border-accent bg-accent-soft/60" : "border-line-strong bg-surface-sunken/50 hover:bg-surface-sunken"
        } ${disabled ? "opacity-60" : ""}`}
      >
        <input
          ref={inputRef}
          type="file"
          accept={accept}
          multiple={multiple}
          className="sr-only"
          id={`file-input-${hintId}`}
          aria-label={title}
          aria-describedby={hintId}
          onChange={(event) => {
            emit(event.target.files);
            event.target.value = "";
          }}
        />
        <div
          role="button"
          tabIndex={disabled ? -1 : 0}
          aria-disabled={disabled}
          aria-describedby={hintId}
          onClick={() => !disabled && inputRef.current?.click()}
          onKeyDown={(event) => {
            if (disabled) return;
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              inputRef.current?.click();
            }
          }}
          className="flex cursor-pointer flex-col items-center gap-3 px-5 py-8 text-center sm:px-8 sm:py-10"
        >
          <span className="grid size-10 place-items-center rounded-md border border-line bg-surface text-accent">
            {icon ?? <UploadCloud className="size-4.5" aria-hidden />}
          </span>
          <div>
            <p className="text-sm font-medium text-ink">
              {title}
              {selectedCount ? <span className="ml-1.5 text-muted">· {selectedCount} selected</span> : null}
            </p>
            <p className="mx-auto mt-1 max-w-md text-xs leading-relaxed text-muted">{description}</p>
          </div>
          <span className="text-2xs font-medium tracking-[0.1em] text-muted uppercase">
            Choose files or drop them here
          </span>
        </div>
      </div>
      <p id={hintId} className="mt-2.5 text-xs leading-relaxed text-muted">
        {constraints}
      </p>
    </div>
  );
}

