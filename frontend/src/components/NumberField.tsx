import { useEffect, useState } from 'react';

interface Props {
  value: number;
  onCommit: (v: number) => void;
  step?: number;
  min?: number;
  max?: number;
  className?: string;
}

/**
 * Numeric input that lets you type freely and commits on Enter/blur.
 * Invalid or out-of-range entries revert to the current value.
 */
export default function NumberField({ value, onCommit, step, min = -Infinity, max = Infinity, className }: Props) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);

  const commit = () => {
    const v = Number(draft);
    if (draft.trim() !== '' && Number.isFinite(v) && v >= min && v <= max) {
      if (v !== value) onCommit(v);
    } else {
      setDraft(String(value));
    }
  };

  return (
    <input
      type="number"
      step={step}
      className={`input ${className ?? ''}`}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
        if (e.key === 'Escape') {
          setDraft(String(value));
          e.currentTarget.blur();
        }
      }}
    />
  );
}
