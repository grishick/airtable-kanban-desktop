import { useEffect, useRef, useState } from 'react';
import type { Task, TaskStatus, TagOption } from '../types';
import { STATUSES } from '../types';
import RichTextEditor from './RichTextEditor';
import MultiSelectTags from './MultiSelectTags';

interface Props {
  task: Task | null;       // null → create mode
  initialStatus?: TaskStatus;
  tagOptions: TagOption[];
  onSave: (data: Partial<Task>) => Promise<void>;
  onDelete?: () => Promise<void>;
  onClose: () => void;
}

export default function TaskModal({ task, initialStatus, tagOptions, onSave, onDelete, onClose }: Props) {
  const [title, setTitle]       = useState(task?.title ?? '');
  const [desc, setDesc]         = useState(task?.description ?? '');
  const [status, setStatus]     = useState<string>(task?.status ?? initialStatus ?? 'Not Started');
  const [priority, setPriority] = useState(task?.priority ?? '');
  const [dueDate, setDueDate]   = useState(task?.due_date ?? '');
  const [selectedTags, setSelectedTags] = useState<string[]>(
    task?.tags ? task.tags.split(',').map((t) => t.trim()).filter(Boolean) : []
  );
  const [saving, setSaving]     = useState(false);
  const [deleting, setDeleting] = useState(false);
  const titleRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    titleRef.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;
    setSaving(true);
    try {
      await onSave({
        title: title.trim(),
        description: desc.trim(),
        status,
        priority: priority || null,
        due_date: dueDate || null,
        tags: selectedTags.length > 0 ? selectedTags.join(', ') : null,
      });
      onClose();
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!onDelete) return;
    if (!window.confirm('Delete this task? This cannot be undone.')) return;
    setDeleting(true);
    try {
      await onDelete();
      onClose();
    } finally {
      setDeleting(false);
    }
  };

  const handleToggleCheckbox = async (nextDescription: string) => {
    setDesc(nextDescription);
    if (task) {
      await onSave({ description: nextDescription });
    }
  };

  return (
    <div className="modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>{task ? 'Edit Task' : 'New Task'}</h2>
          <button className="modal-close-btn" onClick={onClose}>×</button>
        </div>

        <form onSubmit={handleSubmit}>
          <div className="modal-body">
            <div className="form-group">
              <label htmlFor="task-title">Task Name *</label>
              <input
                id="task-title"
                ref={titleRef}
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="What needs to be done?"
                required
              />
            </div>

            <div className="form-group">
              <label htmlFor="task-desc">Description</label>
              <RichTextEditor
                value={desc}
                onChange={setDesc}
                onToggleCheckbox={handleToggleCheckbox}
              />
            </div>

            <div className="form-row">
              <div className="form-group">
                <label htmlFor="task-status">Status</label>
                <select id="task-status" value={status} onChange={(e) => setStatus(e.target.value)}>
                  {STATUSES.map((s) => (
                    <option key={s} value={s}>{s}</option>
                  ))}
                </select>
              </div>

              <div className="form-group">
                <label htmlFor="task-priority">Priority</label>
                <select id="task-priority" value={priority} onChange={(e) => setPriority(e.target.value)}>
                  <option value="">— None —</option>
                  <option value="High">High</option>
                  <option value="Medium">Medium</option>
                  <option value="Low">Low</option>
                </select>
              </div>
            </div>

            <div className="form-group">
              <label htmlFor="task-due">Due Date</label>
              <input
                id="task-due"
                type="date"
                value={dueDate}
                onChange={(e) => setDueDate(e.target.value)}
              />
            </div>

            <div className="form-group">
              <label>Tags</label>
              <MultiSelectTags
                selected={selectedTags}
                options={tagOptions}
                onChange={setSelectedTags}
              />
            </div>
          </div>

          <div className="modal-footer">
            {task && onDelete && (
              <button
                type="button"
                className="btn btn-danger"
                onClick={handleDelete}
                disabled={deleting}
              >
                {deleting ? 'Deleting…' : 'Delete'}
              </button>
            )}
            <span className="spacer" />
            <button type="button" className="btn btn-secondary" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="btn btn-primary" disabled={saving || !title.trim()}>
              {saving ? 'Saving…' : task ? 'Save Changes' : 'Create Task'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
