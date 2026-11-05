import { useEffect, useRef, useState } from 'react';

export interface Field {
  key: string;
  label: string;
  value: string;
  placeholder?: string;
  list?: string;
  wide?: boolean;
}

export function Modal({
  title,
  fields,
  hint,
  submitLabel = 'OK',
  onSubmit,
  onClose,
}: {
  title: string;
  fields: Field[];
  hint?: string;
  submitLabel?: string;
  onSubmit: (v: Record<string, string>) => Promise<void> | void;
  onClose: () => void;
}) {
  const [vals, setVals] = useState(() => Object.fromEntries(fields.map((f) => [f.key, f.value])));
  const [err, setErr] = useState('');
  const first = useRef<HTMLInputElement>(null);
  useEffect(() => { first.current?.focus(); first.current?.select(); }, []);
  const submit = async () => {
    try {
      await onSubmit(vals);
      onClose();
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  return (
    <div className="modal-back" onMouseDown={onClose}>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
        <h3>{title}</h3>
        {fields.map((f, i) => (
          <label key={f.key} className={f.wide ? 'wide' : ''}>
            <span>{f.label}</span>
            <input
              ref={i === 0 ? first : undefined}
              className="mono"
              list={f.list}
              placeholder={f.placeholder}
              value={vals[f.key]}
              onChange={(e) => setVals({ ...vals, [f.key]: e.target.value.toUpperCase() })}
              onKeyDown={(e) => { if (e.key === 'Enter') submit(); if (e.key === 'Escape') onClose(); }}
            />
          </label>
        ))}
        {hint && <p className="hint">{hint}</p>}
        {err && <div className="fp-err">{err}</div>}
        <div className="row end">
          <button onClick={onClose}>Cancel</button>
          <button className="primary" onClick={submit}>{submitLabel}</button>
        </div>
      </div>
    </div>
  );
}
