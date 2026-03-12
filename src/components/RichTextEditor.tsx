import { useEffect, useRef, useCallback } from 'react';

interface Props {
  value: string;
  onChange: (value: string) => void;
  onToggleCheckbox?: (nextContent: string) => void | Promise<void>;
}

// ── Markdown → HTML ────────────────────────────────────────────────────────

function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const INLINE_RE =
  /(\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\))|(<(https?:\/\/[^\s<>]+)>)|(https?:\/\/[^\s<>[\]()]+)|(\*\*([^*\n]+)\*\*)|(~~([^~\n]+)~~)|(`([^`\n]+)`)|(\*([^*\n]+)\*)(?!\*)|(_([^_\n]+)_)/g;

function inlineMdToHtml(text: string): string {
  let out = '';
  let last = 0;
  INLINE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = INLINE_RE.exec(text)) !== null) {
    out += escHtml(text.slice(last, m.index));
    if (m[1])       out += `<a href="${escHtml(m[3])}">${escHtml(m[2])}</a>`;
    else if (m[4])  out += `<a href="${escHtml(m[5])}">${escHtml(m[5])}</a>`;
    else if (m[6])  out += `<a href="${escHtml(m[6])}">${escHtml(m[6])}</a>`;
    else if (m[7])  out += `<strong>${escHtml(m[8])}</strong>`;
    else if (m[9])  out += `<del>${escHtml(m[10])}</del>`;
    else if (m[11]) out += `<code>${escHtml(m[12])}</code>`;
    else if (m[13]) out += `<em>${escHtml(m[14])}</em>`;
    else if (m[15]) out += `<em>${escHtml(m[16])}</em>`;
    last = INLINE_RE.lastIndex;
  }
  return out + escHtml(text.slice(last));
}

function mdToHtml(md: string): string {
  if (!md.trim()) return '';
  const lines = md.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const html: string[] = [];
  let i = 0;
  while (i < lines.length) {
    while (i < lines.length && !lines[i].trim()) i++;
    if (i >= lines.length) break;
    const s = i;
    while (i < lines.length && lines[i].trim()) i++;
    const block = lines.slice(s, i);
    const isCb  = block.every(l => /^(?:[-*+] )?\[[ xX]\] /.test(l.trim()));
    const isBul = !isCb && block.every(l => /^[-*+] /.test(l.trim()));
    const isOrd = !isCb && block.every(l => /^\d+[.)]\s/.test(l.trim()));
    if (isCb) {
      html.push('<ul class="wys-checklist">');
      for (const l of block) {
        const m = l.trim().match(/^(?:[-*+] )?\[([ xX])\] (.*)/);
        const checked = m ? /x/i.test(m[1]) : false;
        html.push(
          `<li data-checked="${checked}">` +
          `<span class="wys-cb" contenteditable="false">${checked ? '☑' : '☐'}</span>` +
          `\u00A0${inlineMdToHtml(m?.[2] ?? '')}</li>`,
        );
      }
      html.push('</ul>');
    } else if (isBul) {
      html.push('<ul>');
      for (const l of block) html.push(`<li>${inlineMdToHtml(l.trim().replace(/^[-*+] /, ''))}</li>`);
      html.push('</ul>');
    } else if (isOrd) {
      html.push('<ol>');
      for (const l of block) html.push(`<li>${inlineMdToHtml(l.trim().replace(/^\d+[.)]\s+/, ''))}</li>`);
      html.push('</ol>');
    } else {
      const content = block.map(l => inlineMdToHtml(l)).join('<br>');
      html.push(`<p>${content || '<br>'}</p>`);
    }
  }
  return html.join('');
}

// ── DOM → Markdown ─────────────────────────────────────────────────────────

function nodeInlineMd(n: Node): string {
  if (n.nodeType === Node.TEXT_NODE) return (n.textContent ?? '').replace(/\u00A0/g, ' ');
  if (n.nodeType !== Node.ELEMENT_NODE) return '';
  const el = n as HTMLElement;
  if (el.classList.contains('wys-cb')) return '';
  const tag = el.tagName.toLowerCase();
  const inner = Array.from(el.childNodes).map(nodeInlineMd).join('');
  if (tag === 'strong' || tag === 'b') return `**${inner}**`;
  if (tag === 'em'     || tag === 'i') return `*${inner}*`;
  if (tag === 'del'    || tag === 's') return `~~${inner}~~`;
  if (tag === 'code') return `\`${inner}\``;
  if (tag === 'a') {
    const anchor = el as HTMLAnchorElement;
    // .href gives the fully resolved URL; fall back to raw attribute for relative/unusual URLs
    const href = anchor.href || anchor.getAttribute('href') || '';
    // If the visible text is the same as the URL, use angle-bracket autolink form
    if (inner === href || inner === anchor.getAttribute('href')) return `<${href}>`;
    return `[${inner}](${href})`;
  }
  if (tag === 'br') return '\n';
  return inner;
}

function liText(li: HTMLElement): string {
  return Array.from(li.childNodes)
    .filter(n => !(n.nodeType === Node.ELEMENT_NODE && (n as HTMLElement).classList.contains('wys-cb')))
    .map(nodeInlineMd).join('').replace(/^\u00A0/, '').replace(/\u00A0/g, ' ').trim();
}

function domToMd(root: HTMLElement): string {
  const parts: string[] = [];
  const push = (line: string) => {
    if (line === '' && (parts.length === 0 || parts[parts.length - 1] === '')) return;
    parts.push(line);
  };

  for (const child of root.childNodes) {
    if (child.nodeType === Node.TEXT_NODE) {
      const t = (child.textContent ?? '').replace(/\u00A0/g, ' ').trim();
      if (t) push(t);
      continue;
    }
    if (child.nodeType !== Node.ELEMENT_NODE) continue;
    const el = child as HTMLElement;
    const tag = el.tagName.toLowerCase();

    if (tag === 'p' || tag === 'div') {
      const line = Array.from(el.childNodes).map(nodeInlineMd).join('').trimEnd();
      if (parts.length > 0 && parts[parts.length - 1] !== '') push('');
      if (line) push(line);
    } else if (tag === 'ul' || tag === 'ol') {
      push('');
      const isCb = el.classList.contains('wys-checklist');
      let idx = 1;
      for (const li of Array.from(el.children) as HTMLElement[]) {
        const text = liText(li);
        if (isCb)         push(`[${li.dataset.checked === 'true' ? 'x' : ' '}] ${text}`);
        else if (tag === 'ol') push(`${idx++}. ${text}`);
        else              push(`- ${text}`);
      }
      push('');
    } else if (tag === 'br') {
      push('');
    }
  }

  while (parts.length && parts[parts.length - 1] === '') parts.pop();
  return parts.join('\n');
}

// ── Component ───────────────────────────────────────────────────────────────

export default function RichTextEditor({ value, onChange, onToggleCheckbox }: Props) {
  const ref     = useRef<HTMLDivElement>(null);
  const focused = useRef(false);

  // Sync prop → DOM only when editor is not focused
  useEffect(() => {
    if (ref.current && !focused.current) {
      const html = mdToHtml(value);
      ref.current.innerHTML = html;
      ref.current.dataset.empty = String(!html);
    }
  }, [value]);

  const serialize = useCallback(() => {
    if (!ref.current) return;
    const md = domToMd(ref.current);
    ref.current.dataset.empty = String(!md.trim());
    onChange(md);
  }, [onChange]);

  // ── Toolbar actions ──────────────────────────────────────────────────────

  const exec = (cmd: string, arg?: string) => {
    ref.current?.focus();
    document.execCommand(cmd, false, arg);
    serialize();
  };

  const insertInlineCode = () => {
    ref.current?.focus();
    const sel = window.getSelection();
    const selected = sel?.toString() || 'code';
    document.execCommand('insertHTML', false, `<code>${escHtml(selected)}</code>`);
    serialize();
  };

  const insertLink = () => {
    const sel = window.getSelection();
    const selectedText = sel?.toString() ?? '';
    // Save range before prompt steals focus
    const savedRange = sel?.rangeCount ? sel.getRangeAt(0).cloneRange() : null;
    const url = window.prompt('Enter URL:', 'https://');
    if (!url) return;
    ref.current?.focus();
    if (savedRange) {
      sel?.removeAllRanges();
      sel?.addRange(savedRange);
    }
    document.execCommand('insertHTML', false,
      `<a href="${escHtml(url)}">${escHtml(selectedText || url)}</a>`,
    );
    serialize();
  };

  const insertChecklist = () => {
    ref.current?.focus();
    document.execCommand(
      'insertHTML', false,
      '<ul class="wys-checklist"><li data-checked="false">' +
      '<span class="wys-cb" contenteditable="false">☐</span>\u00A0</li></ul>',
    );
    serialize();
  };

  // ── Enter inside checklist → new checklist item ──────────────────────────

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== 'Enter') return;
    const sel = window.getSelection();
    if (!sel?.rangeCount) return;
    const range = sel.getRangeAt(0);
    const anchor = range.startContainer.nodeType === Node.TEXT_NODE
      ? range.startContainer.parentElement
      : (range.startContainer as HTMLElement);
    const li = anchor?.closest?.('li') as HTMLElement | null;
    const ul = li?.closest('ul.wys-checklist') as HTMLElement | null;
    if (!ul || !li) return;

    e.preventDefault();
    const newLi = document.createElement('li');
    newLi.dataset.checked = 'false';
    const cb = document.createElement('span');
    cb.className = 'wys-cb';
    cb.contentEditable = 'false';
    cb.textContent = '☐';
    const space = document.createTextNode('\u00A0');
    newLi.appendChild(cb);
    newLi.appendChild(space);
    li.after(newLi);
    const r = document.createRange();
    r.setStartAfter(space);
    r.collapse(true);
    sel.removeAllRanges();
    sel.addRange(r);
    serialize();
  };

  // ── Checkbox toggle ──────────────────────────────────────────────────────

  const handleClick = (e: React.MouseEvent) => {
    const target = e.target as HTMLElement;

    // Open links via the configured target (browser or in-app window)
    const anchor = target.closest('a[href]') as HTMLAnchorElement | null;
    if (anchor) {
      e.preventDefault();
      const url = anchor.href || anchor.getAttribute('href') || '';
      if (url) window.electronAPI.openLink(url);
      return;
    }

    if (!target.classList.contains('wys-cb')) return;
    e.preventDefault();
    const li = target.closest('li') as HTMLElement | null;
    if (!li) return;
    const checked = li.dataset.checked !== 'true';
    li.dataset.checked = String(checked);
    target.textContent = checked ? '☑' : '☐';
    const md = domToMd(ref.current!);
    ref.current!.dataset.empty = String(!md.trim());
    onChange(md);
    onToggleCheckbox?.(md);
  };

  const prevent = (e: React.MouseEvent) => e.preventDefault();

  return (
    <div className="wys-editor">
      <div className="wys-toolbar" role="toolbar" aria-label="Formatting">
        <button type="button" className="tb-btn tb-bold"   onMouseDown={prevent} onClick={() => exec('bold')}   title="Bold (Ctrl+B)"><b>B</b></button>
        <button type="button" className="tb-btn tb-italic" onMouseDown={prevent} onClick={() => exec('italic')} title="Italic (Ctrl+I)"><i>I</i></button>
        <button type="button" className="tb-btn tb-strike" onMouseDown={prevent} onClick={() => exec('strikeThrough')} title="Strikethrough"><s>S</s></button>
        <button type="button" className="tb-btn tb-code"   onMouseDown={prevent} onClick={insertInlineCode}    title="Inline code">{'{ }'}</button>
        <span className="tb-sep" />
        <button type="button" className="tb-btn" onMouseDown={prevent} onClick={() => exec('insertUnorderedList')} title="Bullet list">• List</button>
        <button type="button" className="tb-btn" onMouseDown={prevent} onClick={() => exec('insertOrderedList')}   title="Numbered list">1. List</button>
        <button type="button" className="tb-btn" onMouseDown={prevent} onClick={insertChecklist}                   title="Checklist">☐ Check</button>
        <span className="tb-sep" />
        <button type="button" className="tb-btn" onMouseDown={prevent} onClick={insertLink} title="Insert link">Link</button>
      </div>

      <div
        ref={ref}
        contentEditable
        suppressContentEditableWarning
        className="wys-content"
        onInput={serialize}
        onFocus={() => { focused.current = true; }}
        onBlur={() => { focused.current = false; serialize(); }}
        onClick={handleClick}
        onKeyDown={handleKeyDown}
        data-placeholder="Optional details…"
        data-empty={!value.trim() ? 'true' : 'false'}
        spellCheck={false}
      />
    </div>
  );
}
