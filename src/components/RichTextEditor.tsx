import { useEffect, useRef } from 'react';
import Quill, { Delta } from 'quill';
import type { Op } from 'quill';
import 'quill/dist/quill.snow.css';

interface Props {
  value: string;
  onChange: (value: string) => void;
  onToggleCheckbox?: (nextContent: string) => void | Promise<void>;
}

// ── Inline: Markdown text → Delta ops ──────────────────────────────────────
//
// Groups:
//  1,2  **bold**        → { bold: true }
//  3,4  ~~strike~~      → { strike: true }
//  5,6  `code`          → { code: true }
//  7    *italic* inner  → { italic: true }
//  8    _italic_ inner  → { italic: true }
//  9,10 [text](url)     → { link: url }
//  11   <url> inner     → { link: url }
//  12   bare url        → { link: url }
const INLINE_RE =
  /(\*\*([^*\n]+)\*\*)|(~~([^~\n]+)~~)|(`([^`\n]+)`)|\*([^*\n]+)\*(?!\*)|_([^_\n]+)_|\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)|<(https?:\/\/[^\s<>]+)>|(https?:\/\/[^\s<>\[\]()]+)/g;

function parseInlineOps(text: string): Op[] {
  if (!text) return [];
  const ops: Op[] = [];
  let last = 0;
  INLINE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = INLINE_RE.exec(text)) !== null) {
    if (m.index > last) ops.push({ insert: text.slice(last, m.index) });
    if      (m[1])  ops.push({ insert: m[2],  attributes: { bold: true } });
    else if (m[3])  ops.push({ insert: m[4],  attributes: { strike: true } });
    else if (m[5])  ops.push({ insert: m[6],  attributes: { code: true } });
    else if (m[7])  ops.push({ insert: m[7],  attributes: { italic: true } });
    else if (m[8])  ops.push({ insert: m[8],  attributes: { italic: true } });
    else if (m[9])  ops.push({ insert: m[9],  attributes: { link: m[10] } });
    else if (m[11]) ops.push({ insert: m[11], attributes: { link: m[11] } });
    else if (m[12]) ops.push({ insert: m[12], attributes: { link: m[12] } });
    last = INLINE_RE.lastIndex;
  }
  if (last < text.length) ops.push({ insert: text.slice(last) });
  return ops;
}

// ── Inline: Delta ops → Markdown text ──────────────────────────────────────

function lineDeltaToInline(lineDelta: Delta): string {
  let out = '';
  for (const op of lineDelta.ops) {
    if (typeof op.insert !== 'string') continue;
    const text = op.insert;
    const a = op.attributes ?? {};
    if (a['code']) { out += `\`${text}\``; continue; }
    let s = text;
    if (a['link'])   s = `[${s}](${a['link'] as string})`;
    if (a['strike']) s = `~~${s}~~`;
    if (a['italic']) s = `*${s}*`;
    if (a['bold'])   s = `**${s}**`;
    out += s;
  }
  return out;
}

// ── Markdown → Delta ────────────────────────────────────────────────────────

function markdownToDelta(md: string): Delta {
  const ops: Op[] = [];
  const lines = md.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');

  for (const line of lines) {
    const trimmed = line.trim();

    // Checkbox: `[ ] text`, `[x] text`, `- [ ] text`, `- [x] text`
    const cbMatch = trimmed.match(/^(?:[-*+]\s+)?\[([ xX])\]\s*(.*)$/);
    if (cbMatch) {
      ops.push(...parseInlineOps(cbMatch[2]));
      ops.push({ insert: '\n', attributes: { list: /x/i.test(cbMatch[1]) ? 'checked' : 'unchecked' } });
      continue;
    }

    // Ordered list: `1. text` or `1) text`
    const ordMatch = trimmed.match(/^\d+[.)]\s+(.*)$/);
    if (ordMatch) {
      ops.push(...parseInlineOps(ordMatch[1]));
      ops.push({ insert: '\n', attributes: { list: 'ordered' } });
      continue;
    }

    // Bullet list: `- text`, `* text`, `+ text`
    const bulMatch = trimmed.match(/^[-*+]\s+(.*)$/);
    if (bulMatch) {
      ops.push(...parseInlineOps(bulMatch[1]));
      ops.push({ insert: '\n', attributes: { list: 'bullet' } });
      continue;
    }

    // Normal or empty line
    if (trimmed) ops.push(...parseInlineOps(trimmed));
    ops.push({ insert: '\n' });
  }

  return new Delta(ops.length ? ops : [{ insert: '\n' }]);
}

// ── Delta → Markdown ────────────────────────────────────────────────────────

function deltaToMarkdown(delta: Delta): string {
  const lines: string[] = [];
  let ordCounter = 0;

  // eachLine is a quill-delta method: calls predicate per line (split on \n)
  (delta as Delta & {
    eachLine(fn: (line: Delta, attrs: Record<string, unknown>) => void): void;
  }).eachLine((lineDelta, attrs) => {
    const text = lineDeltaToInline(lineDelta);
    const list = attrs['list'] as string | undefined;

    if (list === 'ordered') {
      lines.push(`${++ordCounter}. ${text}`);
      return;
    }
    ordCounter = 0;
    if      (list === 'bullet')    lines.push(`- ${text}`);
    else if (list === 'checked')   lines.push(`- [x] ${text}`);
    else if (list === 'unchecked') lines.push(`- [ ] ${text}`);
    else                           lines.push(text);
  });

  return lines.join('\n').trimEnd();
}

// ── Detect checkbox-only change (for auto-save) ─────────────────────────────
// A true checkbox toggle: all ops are retains, and at least one op changes
// the `list` attribute to 'checked' or 'unchecked' (not null / other formats).
// This excludes Enter-to-exit-list, which emits { list: null }.

function isCheckboxToggle(changeDelta: Delta): boolean {
  let hasCheckboxChange = false;
  const allValid = changeDelta.ops.every((op) => {
    if (op.retain === undefined) return false;          // insert or delete → not a toggle
    if (!op.attributes) return true;                    // plain retain → ok
    const keys = Object.keys(op.attributes);
    if (keys.length !== 1 || !('list' in op.attributes)) return false;
    const v = op.attributes['list'];
    if (v !== 'checked' && v !== 'unchecked') return false; // null / 'bullet' etc → not a checkbox toggle
    hasCheckboxChange = true;
    return true;
  });
  return allValid && hasCheckboxChange;
}

// ── Component ───────────────────────────────────────────────────────────────

export default function RichTextEditor({ value, onChange, onToggleCheckbox }: Props) {
  // wrapperRef  → the outer .wys-editor div (holds border / focus styles)
  // containerRef → inner div passed to Quill; Quill inserts .ql-toolbar BEFORE
  //                this element (inside wrapperRef), keeping everything inside
  //                our styled wrapper.
  const wrapperRef   = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const quillRef     = useRef<Quill | null>(null);
  // Track the last markdown we emitted so the sync effect doesn't echo it back
  const lastEmittedRef = useRef(value);

  // Keep callbacks in refs so the Quill event handler always sees fresh values
  const onChangeRef          = useRef(onChange);
  const onToggleCheckboxRef  = useRef(onToggleCheckbox);
  onChangeRef.current         = onChange;
  onToggleCheckboxRef.current = onToggleCheckbox;

  // Initialize Quill once on mount
  useEffect(() => {
    const container = containerRef.current;
    if (!container || quillRef.current) return;

    const quill = new Quill(container, {
      theme: 'snow',
      modules: {
        toolbar: [
          ['bold', 'italic', 'strike', 'code'],
          [{ list: 'ordered' }, { list: 'bullet' }, { list: 'check' }],
          ['link', 'clean'],
        ],
      },
      placeholder: 'Optional details…',
    });

    lastEmittedRef.current = value;
    quill.setContents(markdownToDelta(lastEmittedRef.current), 'silent' as Parameters<typeof quill.setContents>[1]);
    quillRef.current = quill;

    const handleTextChange = (changeDelta: Delta, _old: Delta, source: string) => {
      if (source === 'silent') return;
      const md = deltaToMarkdown(quill.getContents());
      lastEmittedRef.current = md;
      onChangeRef.current(md);
      if (onToggleCheckboxRef.current && isCheckboxToggle(changeDelta)) {
        void onToggleCheckboxRef.current(md);
      }
    };

    // Intercept link clicks — open via Electron rather than navigating
    const handleClick = (e: MouseEvent) => {
      const anchor = (e.target as HTMLElement).closest('a[href]') as HTMLAnchorElement | null;
      if (anchor) {
        e.preventDefault();
        const url = anchor.getAttribute('href') || anchor.href;
        if (url) void window.electronAPI.openLink(url);
      }
    };

    quill.on('text-change', handleTextChange as Parameters<typeof quill.on>[1]);
    container.addEventListener('click', handleClick);

    return () => {
      quill.off('text-change', handleTextChange as Parameters<typeof quill.off>[1]);
      container.removeEventListener('click', handleClick);
      quillRef.current = null;
      // Remove Quill-injected toolbar (it sits before containerRef inside wrapperRef)
      const toolbar = container.previousElementSibling;
      if (toolbar?.classList.contains('ql-toolbar')) toolbar.remove();
      container.innerHTML = '';
      container.className = '';
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // intentionally empty — Quill is initialized once

  // Sync external value → Quill when editor is not focused
  useEffect(() => {
    const quill = quillRef.current;
    if (!quill || quill.hasFocus()) return;
    // Skip if we ourselves just emitted this value (avoid echo-back loop)
    if (value === lastEmittedRef.current) return;
    const current = deltaToMarkdown(quill.getContents());
    if (current !== value) {
      lastEmittedRef.current = value;
      quill.setContents(markdownToDelta(value), 'silent' as Parameters<typeof quill.setContents>[1]);
    }
  }, [value]);

  return (
    <div className="wys-editor" ref={wrapperRef}>
      <div ref={containerRef} />
    </div>
  );
}
