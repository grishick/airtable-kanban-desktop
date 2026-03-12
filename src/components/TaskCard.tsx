import type { Task, TagOption } from '../types';
import { tagColorStyle } from '../tagColors';
import RichTextContent from './RichTextContent';

interface Props {
  task: Task;
  tagOptions: TagOption[];
  onClick: () => void;
  onDragStart: (e: React.DragEvent) => void;
  onToggleCheckbox?: (nextDescription: string) => Promise<void>;
}

export default function TaskCard({ task, tagOptions, onClick, onDragStart, onToggleCheckbox }: Props) {
  const isOverdue =
    task.due_date && new Date(task.due_date) < new Date(new Date().toDateString());

  const tags = task.tags
    ? task.tags
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean)
    : [];

  const optionMap = Object.fromEntries(tagOptions.map((o) => [o.name, o]));

  const hasPendingSync = !task.synced_at || task.synced_at < task.updated_at;

  return (
    <div
      className="task-card"
      draggable
      onDragStart={onDragStart}
      onClick={onClick}
      title="Click to edit"
    >
      {hasPendingSync && (
        <span className="card-sync-dot" title="Has unsynced local changes" />
      )}

      <div className="task-card-title">{task.title}</div>

      {task.description && (
        <RichTextContent
          content={task.description}
          className="task-card-description"
          previewLines={3}
          onToggleCheckbox={onToggleCheckbox}
        />
      )}

      <div className="task-card-meta">
        {task.priority && (
          <span className={`priority-badge ${task.priority}`}>{task.priority}</span>
        )}
        {task.due_date && (
          <span className={`due-date-badge ${isOverdue ? 'overdue' : ''}`}>
            📅 {formatDate(task.due_date)}
          </span>
        )}
        {tags.slice(0, 2).map((tag) => {
          const opt = optionMap[tag];
          const style = tagColorStyle(opt?.color ?? null);
          return (
            <span key={tag} className="tag-pill tag-pill-sm" style={style}>{tag}</span>
          );
        })}
        {tags.length > 2 && (
          <span className="tag-badge">+{tags.length - 2}</span>
        )}
      </div>
    </div>
  );
}

function formatDate(iso: string): string {
  // iso is a date string like "2024-03-15"
  const [year, month, day] = iso.split('-').map(Number);
  const d = new Date(year, month - 1, day);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
