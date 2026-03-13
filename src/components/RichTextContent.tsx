import type { ReactNode } from 'react';

interface Props {
  content: string | null | undefined;
  className?: string;
  previewLines?: number;
  onToggleCheckbox?: (nextContent: string) => void | Promise<void>;
}

interface CheckboxItem {
  lineIndex: number;
  checked: boolean;
  text: string;
}

type Block =
  | { type: 'paragraph'; lines: string[] }
  | { type: 'list'; ordered: boolean; items: string[] }
  | { type: 'checkbox-list'; items: CheckboxItem[] };

export default function RichTextContent({ content, className, previewLines, onToggleCheckbox }: Props) {
  const source = content ?? '';
  const normalized = normalizeText(source);
  const blocks = parseBlocks(normalized);
  const classes = ['rich-text-content', className, previewLines ? `rich-text-preview lines-${previewLines}` : '']
    .filter(Boolean)
    .join(' ');

  if (!source.trim()) return null;

  return <div className={classes}>{blocks.map((block, index) => renderBlock(block, index, normalized, onToggleCheckbox))}</div>;
}

function renderBlock(
  block: Block,
  index: number,
  source: string,
  onToggleCheckbox?: (nextContent: string) => void | Promise<void>,
) {
  if (block.type === 'paragraph') {
    return (
      <p key={index}>
        {block.lines.map((line, lineIndex) => (
          <FragmentWithBreak key={lineIndex} text={line} addBreak={lineIndex < block.lines.length - 1} />
        ))}
      </p>
    );
  }

  if (block.type === 'list') {
    const Tag = block.ordered ? 'ol' : 'ul';
    return (
      <Tag key={index}>
        {block.items.map((item, itemIndex) => (
          <li key={itemIndex}>{renderInline(item)}</li>
        ))}
      </Tag>
    );
  }

  return (
    <ul key={index} className="checkbox-list">
      {block.items.map((item) => {
        const nextContent = toggleCheckboxLine(source, item.lineIndex, !item.checked);
        return (
          <li key={item.lineIndex} className="checkbox-list-item">
            <button
              type="button"
              className="checkbox-toggle-btn"
              aria-pressed={item.checked}
              onMouseDown={(e) => e.preventDefault()}
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                onToggleCheckbox?.(nextContent);
              }}
              disabled={!onToggleCheckbox}
              title={item.checked ? 'Mark unchecked' : 'Mark checked'}
            >
              <span className={item.checked ? 'checkbox-icon checked' : 'checkbox-icon'} aria-hidden="true">
                {item.checked ? '☑' : '☐'}
              </span>
              <span className={item.checked ? 'checkbox-rich-text checked' : 'checkbox-rich-text'}>
                {renderInline(item.text)}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function FragmentWithBreak({ text, addBreak }: { text: string; addBreak: boolean }) {
  return (
    <>
      {renderInline(text)}
      {addBreak ? <br /> : null}
    </>
  );
}

function parseBlocks(input: string): Block[] {
  const lines = input.split('\n');
  const blocks: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    while (i < lines.length && !lines[i].trim()) i++;
    if (i >= lines.length) break;

    const start = i;
    while (i < lines.length && lines[i].trim()) i++;
    const blockLines = lines.slice(start, i);

    if (isCheckboxListBlock(blockLines)) {
      blocks.push({
        type: 'checkbox-list',
        items: blockLines.map((line, offset) => {
          const trimmed = line.trim();
          const match = trimmed.match(/^(?:[-*+]\s+)?\[( |x|X)\](?:\s+(.*))?$/);
          return {
            lineIndex: start + offset,
            checked: !!match && /x/i.test(match[1]),
            text: match?.[2] ?? '',
          };
        }),
      });
      continue;
    }

    if (isListBlock(blockLines)) {
      blocks.push({
        type: 'list',
        ordered: blockLines.every((line) => /^\d+[.)]\s+/.test(line.trim())),
        items: blockLines.map((line) => line.trim().replace(/^([-*+])\s+/, '').replace(/^\d+[.)]\s+/, '')),
      });
      continue;
    }

    blocks.push({ type: 'paragraph', lines: blockLines });
  }

  return blocks;
}

function isCheckboxListBlock(lines: string[]): boolean {
  return lines.length > 0 && lines.every((line) => /^(?:[-*+]\s+)?\[( |x|X)\](\s|$)/.test(line.trim()));
}

function isListBlock(lines: string[]): boolean {
  return lines.every((line) => {
    const trimmed = line.trim();
    return /^([-*+])\s+/.test(trimmed) || /^\d+[.)]\s+/.test(trimmed);
  });
}

function renderInline(input: string): ReactNode[] {
  const nodes = parseInlineSequence(input);
  return nodes.length ? nodes : [input];
}

function parseInlineSequence(input: string): ReactNode[] {
  const result: ReactNode[] = [];
  const tokenRegex = /(\[([^\]]+)\]\((https?:\/\/[^\s)]+)\))|(<(https?:\/\/[^\s<>]+)>)|(https?:\/\/[^\s<]+)|(\*\*([^*]+)\*\*)|(~~([^~]+)~~)|(`([^`]+)`)|(\*([^*]+)\*)|(_([^_]+)_)/g;

  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = tokenRegex.exec(input)) !== null) {
    if (match.index > lastIndex) {
      result.push(input.slice(lastIndex, match.index));
    }

    if (match[1]) {
      result.push(anchor(match[3], match[2], match.index));
    } else if (match[4]) {
      result.push(anchor(match[5], match[5], match.index));
    } else if (match[6]) {
      result.push(anchor(match[6], match[6], match.index));
    } else if (match[7]) {
      result.push(<strong key={match.index}>{parseInlineSequence(match[8])}</strong>);
    } else if (match[9]) {
      result.push(<del key={match.index}>{parseInlineSequence(match[10])}</del>);
    } else if (match[11]) {
      result.push(<code key={match.index}>{match[12]}</code>);
    } else if (match[13]) {
      result.push(<em key={match.index}>{parseInlineSequence(match[14])}</em>);
    } else if (match[15]) {
      result.push(<em key={match.index}>{parseInlineSequence(match[16])}</em>);
    }

    lastIndex = tokenRegex.lastIndex;
  }

  if (lastIndex < input.length) {
    result.push(input.slice(lastIndex));
  }

  return result;
}

function anchor(url: string, label: string, key: number) {
  return (
    <a
      href={url}
      key={key}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        window.electronAPI.openLink(url);
      }}
    >
      {label}
    </a>
  );
}

function normalizeText(input: string): string {
  return input.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\\_/g, '_').replace(/\\\*/g, '*');
}

function toggleCheckboxLine(source: string, lineIndex: number, checked: boolean): string {
  const lines = normalizeText(source).split('\n');
  const line = lines[lineIndex] ?? '';
  lines[lineIndex] = line.replace(/^(\s*(?:[-*+]\s+)?\[)( |x|X)(\](?:\s+)?)/, `$1${checked ? 'x' : ' '}$3`);
  return lines.join('\n');
}
