import { useId, useRef, useState } from "react";
import { MoveHorizontal } from "lucide-react";

/**
 * Draggable before/after viewer. Only rendered when both images share the same
 * intrinsic aspect ratio, so the comparison is never a false visual match.
 */
export function CompareSlider({
  beforeSrc,
  afterSrc,
  alt,
  width,
  height,
}: {
  beforeSrc: string;
  afterSrc: string;
  alt: string;
  width: number;
  height: number;
}) {
  const [position, setPosition] = useState(50);
  const containerRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef(false);
  const inputId = useId();

  const updateFromPointer = (clientX: number) => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const ratio = ((clientX - rect.left) / rect.width) * 100;
    setPosition(Math.min(100, Math.max(0, ratio)));
  };

  return (
    <div className="flex flex-col gap-2">
      <div
        ref={containerRef}
        onPointerDown={(event) => {
          dragRef.current = true;
          updateFromPointer(event.clientX);
        }}
        onPointerMove={(event) => {
          if (dragRef.current) updateFromPointer(event.clientX);
        }}
        onPointerUp={() => {
          dragRef.current = false;
        }}
        onPointerLeave={() => {
          dragRef.current = false;
        }}
        className="checker relative w-full cursor-ew-resize overflow-hidden rounded-md border border-line select-none"
        style={{ aspectRatio: `${width} / ${height}` }}
      >
        <img src={afterSrc} alt={`Optimized: ${alt}`} className="absolute inset-0 size-full object-contain" draggable={false} />
        <div className="absolute inset-0 overflow-hidden" style={{ clipPath: `inset(0 ${100 - position}% 0 0)` }}>
            <img src={beforeSrc} alt={`Original: ${alt}`} className="absolute inset-0 size-full object-contain" draggable={false} />
        </div>
        <div className="absolute inset-y-0 border-l border-white/85 shadow-[0_0_0_1px_rgba(14,22,32,0.35)]" style={{ left: `${position}%` }} aria-hidden />
        <span
          className="absolute top-1/2 grid size-7 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full border border-white/80 bg-navy/85 text-white"
          style={{ left: `${position}%` }}
          aria-hidden
        >
          <MoveHorizontal className="size-3.5" />
        </span>
        <span className="absolute top-2 left-2 rounded bg-navy/75 px-1.5 py-0.5 font-mono text-2xs tracking-wide text-white/85 uppercase">
          original
        </span>
        <span className="absolute top-2 right-2 rounded bg-navy/75 px-1.5 py-0.5 font-mono text-2xs tracking-wide text-white/85 uppercase">
          optimized
        </span>
      </div>
      <div className="flex items-center gap-3">
        <label htmlFor={inputId} className="text-2xs text-muted">
          Comparison position
        </label>
        <input
          id={inputId}
          type="range"
          min={0}
          max={100}
          value={position}
          onChange={(event) => setPosition(Number(event.target.value))}
          className="h-1.5 flex-1 accent-accent"
          aria-label="Comparison position"
        />
        <span className="w-10 text-right font-mono text-2xs text-muted tnum">{Math.round(position)}%</span>
      </div>
    </div>
  );
}
