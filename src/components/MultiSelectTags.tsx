import { useEffect, useRef, useState } from 'react';
import type { TagOption } from '../types';
import { tagColorStyle } from '../tagColors';

interface Props {
  selected: string[];
  options: TagOption[];
  onChange: (selected: string[]) => void;
}

export default function MultiSelectTags({ selected, options, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handleClick = (e: MouseEvent) => {
      if (!containerRef.current?.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [open]);

  const remove = (name: string) => onChange(selected.filter((t) => t !== name));
  const add = (name: string) => { onChange([...selected, name]); setOpen(false); };

  const optionMap = Object.fromEntries(options.map((o) => [o.name, o]));
  const available = options.filter((o) => !selected.includes(o.name));

  return (
    <div className="multi-select" ref={containerRef}>
      <div
        className="multi-select-control"
        onClick={() => available.length > 0 && setOpen((v) => !v)}
      >
        {selected.map((name) => {
          const opt = optionMap[name];
          const style = tagColorStyle(opt?.color ?? null);
          return (
            <span key={name} className="tag-pill" style={style}>
              {name}
              <button
                type="button"
                className="tag-pill-remove"
                style={{ color: style.color }}
                onMouseDown={(e) => { e.stopPropagation(); e.preventDefault(); remove(name); }}
              >
                ×
              </button>
            </span>
          );
        })}
        {available.length > 0 && (
          <span className="multi-select-placeholder">
            {selected.length === 0 ? 'Add tags…' : '+'}
          </span>
        )}
        {selected.length === 0 && available.length === 0 && (
          <span className="multi-select-placeholder">No options available</span>
        )}
      </div>

      {open && available.length > 0 && (
        <div className="multi-select-dropdown">
          {available.map((opt) => {
            const style = tagColorStyle(opt.color);
            return (
              <div
                key={opt.name}
                className="multi-select-option"
                onMouseDown={(e) => { e.preventDefault(); add(opt.name); }}
              >
                <span className="tag-pill" style={style}>{opt.name}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
