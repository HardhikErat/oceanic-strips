// Draggable divider between panels. Sizes are remembered per browser; double-click resets.
import { useCallback, useEffect, useRef, useState } from 'react';

export function usePanelSize(key: string, def: () => number, min: number, max: () => number) {
  const clamp = (v: number) => Math.round(Math.max(min, Math.min(max(), v)));
  const [size, setSize] = useState(() => {
    try {
      const v = Number(localStorage.getItem(key));
      if (Number.isFinite(v) && v > 0) return clamp(v);
    } catch { /* storage unavailable */ }
    return clamp(def());
  });
  useEffect(() => {
    try { localStorage.setItem(key, String(size)); } catch { /* ignore */ }
  }, [key, size]);
  // keep within limits when the window shrinks
  useEffect(() => {
    const onResize = () => setSize((s) => clamp(s));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const change = useCallback((delta: number) => setSize((s) => clamp(s + delta)), []);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const reset = useCallback(() => setSize(clamp(def())), []);
  return [size, change, reset] as const;
}

interface Props {
  /** 'col' = vertical bar resizing widths, 'row' = horizontal bar resizing heights */
  dir: 'col' | 'row';
  onDrag: (delta: number) => void;
  onReset?: () => void;
  className?: string;
}

export function Splitter({ dir, onDrag, onReset, className = '' }: Props) {
  const last = useRef<number | null>(null);
  return (
    <div
      className={`splitter ${dir} ${className}`}
      role="separator"
      aria-orientation={dir === 'col' ? 'vertical' : 'horizontal'}
      title="Drag to resize · double-click to reset"
      onPointerDown={(e) => {
        try { (e.currentTarget as Element).setPointerCapture(e.pointerId); } catch { /* still works without capture */ }
        last.current = dir === 'col' ? e.clientX : e.clientY;
        document.body.classList.add(dir === 'col' ? 'resizing-col' : 'resizing-row');
      }}
      onPointerMove={(e) => {
        if (last.current === null) return;
        const p = dir === 'col' ? e.clientX : e.clientY;
        if (p !== last.current) onDrag(p - last.current);
        last.current = p;
      }}
      onPointerUp={() => {
        last.current = null;
        document.body.classList.remove('resizing-col', 'resizing-row');
      }}
      onDoubleClick={onReset}
    />
  );
}
