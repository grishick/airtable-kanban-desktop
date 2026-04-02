import { useEffect, useRef, useState } from 'react';
import type { Task, TagOption, StatusOption, Collaborator } from '../types';
import TaskCard from './TaskCard';
import TaskModal from './TaskModal';

interface Props {
  status: string;
  color: string;
  tasks: Task[];
  /** When true, tasks are ordered by position descending (newest-on-top lane). */
  newestFirst?: boolean;
  allStatuses: string[];
  tagOptions: TagOption[];
  statusOptions: StatusOption[];
  collaborators: Collaborator[];
  pageSize: number;
  onCreateTask: (data: Partial<Task>) => Promise<void>;
  onUpdateTask: (id: string, updates: Partial<Task>) => Promise<void>;
  onDeleteTask: (id: string) => Promise<void>;
  onDrop: (taskId: string, newStatus: string) => Promise<void>;
  onRename: (newName: string) => Promise<void>;
  onMoveLeft: (() => void) | null;
  onMoveRight: (() => void) | null;
  onRemove: (() => void) | null;
}

function calculatePosition(
  tasks: Task[],
  taskId: string,
  insertBeforeIndex: number,
  newestFirst: boolean,
): number {
  const others = tasks.filter((t) => t.id !== taskId);
  const originalIndex = tasks.findIndex((t) => t.id === taskId);
  let idx = insertBeforeIndex;
  if (originalIndex < insertBeforeIndex) idx--;
  idx = Math.max(0, Math.min(idx, others.length));

  if (others.length === 0) return 1000;
  if (newestFirst) {
    if (idx === 0) return others[0].position + 1000;
    if (idx >= others.length) return others[others.length - 1].position - 1000;
  } else {
    if (idx === 0) return others[0].position - 1000;
    if (idx >= others.length) return others[others.length - 1].position + 1000;
  }
  return (others[idx - 1].position + others[idx].position) / 2;
}

export default function KanbanColumn({
  status, color, tasks, newestFirst = false, allStatuses, tagOptions, statusOptions, collaborators, pageSize,
  onCreateTask, onUpdateTask, onDeleteTask, onDrop,
  onRename, onMoveLeft, onMoveRight, onRemove,
}: Props) {
  const [dragOver, setDragOver] = useState(false);
  const [editingTask, setEditingTask] = useState<Task | null>(null);
  const [creating, setCreating] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [displayCount, setDisplayCount] = useState(pageSize);
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  const dropIndexRef = useRef<number | null>(null);
  const draggingFromHere = useRef(false);
  const draggedIndex = useRef<number | null>(null);

  // Column menu state
  const [showMenu, setShowMenu] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // Inline rename state
  const [isRenaming, setIsRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState(status);
  const renameInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setDisplayCount(pageSize);
  }, [pageSize]);

  // Close menu on outside click
  useEffect(() => {
    if (!showMenu) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setShowMenu(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [showMenu]);

  const visibleTasks = tasks.slice(0, displayCount);
  const hiddenCount = tasks.length - displayCount;
  const loadMoreCount = Math.min(pageSize, hiddenCount);

  const startRename = () => {
    setRenameValue(status);
    setIsRenaming(true);
    setShowMenu(false);
    setTimeout(() => renameInputRef.current?.select(), 0);
  };

  const commitRename = () => {
    const trimmed = renameValue.trim();
    if (trimmed && trimmed !== status && !allStatuses.includes(trimmed)) {
      onRename(trimmed);
    }
    setIsRenaming(false);
  };

  const cancelRename = () => {
    setRenameValue(status);
    setIsRenaming(false);
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (!draggingFromHere.current) {
      setDragOver(true);
    }
  };

  const handleDragLeave = (e: React.DragEvent) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node)) {
      setDragOver(false);
      setDropIndex(null);
      dropIndexRef.current = null;
    }
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const taskId = e.dataTransfer.getData('taskId');
    if (!taskId) return;

    const isWithinLane = draggingFromHere.current;
    draggingFromHere.current = false;
    draggedIndex.current = null;
    const idx = dropIndexRef.current ?? visibleTasks.length;
    setDropIndex(null);
    dropIndexRef.current = null;

    if (isWithinLane) {
      const newPosition = calculatePosition(tasks, taskId, idx, newestFirst);
      await onUpdateTask(taskId, { position: newPosition });
    } else {
      await onDrop(taskId, status);
    }
  };

  const handleCardDragStart = (e: React.DragEvent, taskId: string, index: number) => {
    e.dataTransfer.setData('taskId', taskId);
    e.dataTransfer.effectAllowed = 'move';
    draggingFromHere.current = true;
    draggedIndex.current = index;
  };

  const handleCardDragEnd = () => {
    draggingFromHere.current = false;
    draggedIndex.current = null;
    setDropIndex(null);
    dropIndexRef.current = null;
  };

  const handleCardDragOver = (e: React.DragEvent, index: number) => {
    if (!draggingFromHere.current) return;
    e.preventDefault();
    e.stopPropagation();

    const dragIdx = draggedIndex.current;
    if (dragIdx !== null && index === dragIdx) return;

    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const isTopHalf = e.clientY < rect.top + rect.height / 2;
    let newDropIndex = isTopHalf ? index : index + 1;

    if (dragIdx !== null && (newDropIndex === dragIdx || newDropIndex === dragIdx + 1)) {
      if (index < dragIdx) {
        newDropIndex = index;
      } else {
        newDropIndex = index + 1;
      }
    }

    setDropIndex(newDropIndex);
    dropIndexRef.current = newDropIndex;
  };

  const handleRemove = () => {
    setShowMenu(false);
    if (!onRemove) return;
    const taskCount = tasks.length;
    if (taskCount > 0) {
      const first = allStatuses.find((s) => s !== status) ?? 'Unknown';
      if (!window.confirm(
        `Delete "${status}" column? ${taskCount} task(s) will be moved to "${first}".`
      )) return;
    }
    onRemove();
  };

  return (
    <>
      <div
        className={`column${dragOver ? ' drag-over' : ''}${collapsed ? ' collapsed' : ''}`}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        <div className="column-header">
          <span className="column-dot" style={{ background: color }} />

          {isRenaming && !collapsed ? (
            <input
              ref={renameInputRef}
              className="column-title-input"
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              onBlur={commitRename}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitRename();
                if (e.key === 'Escape') cancelRename();
              }}
              autoFocus
            />
          ) : (
            <span
              className="column-title"
              onDoubleClick={() => !collapsed && startRename()}
              title={collapsed ? `${status} (${tasks.length})` : 'Double-click to rename'}
            >
              {status}
            </span>
          )}

          <span className="column-count">{tasks.length}</span>

          {!collapsed && (
            <div className="column-menu-container" ref={menuRef}>
              <button
                className="column-menu-btn"
                onClick={() => setShowMenu((s) => !s)}
                title="Column options"
              >
                ⋮
              </button>
              {showMenu && (
                <div className="column-menu-dropdown">
                  <button onClick={startRename}>Rename</button>
                  {onMoveLeft && <button onClick={() => { setShowMenu(false); onMoveLeft(); }}>Move Left</button>}
                  {onMoveRight && <button onClick={() => { setShowMenu(false); onMoveRight(); }}>Move Right</button>}
                  {onRemove && <button className="danger" onClick={handleRemove}>Delete Column</button>}
                </div>
              )}
            </div>
          )}

          <button
            className="column-collapse-btn"
            onClick={() => setCollapsed((c) => !c)}
            title={collapsed ? 'Expand column' : 'Collapse column'}
          >
            {collapsed ? '▶' : '▼'}
          </button>
        </div>

        {!collapsed && (
          <>
            <div className="column-body">
              {visibleTasks.map((task, index) => (
                <div
                  key={task.id}
                  onDragOver={(e) => handleCardDragOver(e, index)}
                >
                  {dropIndex === index && <div className="drop-indicator" />}
                  <TaskCard
                    task={task}
                    tagOptions={tagOptions}
                    onClick={() => setEditingTask(task)}
                    onDragStart={(e) => handleCardDragStart(e, task.id, index)}
                    onDragEnd={handleCardDragEnd}
                    onToggleCheckbox={(nextDescription) => onUpdateTask(task.id, { description: nextDescription })}
                  />
                </div>
              ))}
              {dropIndex === visibleTasks.length && <div className="drop-indicator" />}
            </div>

            {hiddenCount > 0 && (
              <button
                className="load-more-btn"
                onClick={() => setDisplayCount((c) => c + pageSize)}
              >
                Load {loadMoreCount} more ({hiddenCount} remaining)
              </button>
            )}

            <button className="add-task-btn" onClick={() => setCreating(true)}>
              + Add a task
            </button>
          </>
        )}
      </div>

      {creating && (
        <TaskModal
          task={null}
          initialStatus={status}
          tagOptions={tagOptions}
          statusOptions={statusOptions}
          collaborators={collaborators}
          onSave={onCreateTask}
          onClose={() => setCreating(false)}
        />
      )}

      {editingTask && (
        <TaskModal
          task={editingTask}
          tagOptions={tagOptions}
          statusOptions={statusOptions}
          collaborators={collaborators}
          onSave={(updates) => onUpdateTask(editingTask.id, updates)}
          onDelete={() => onDeleteTask(editingTask.id)}
          onClose={() => setEditingTask(null)}
        />
      )}
    </>
  );
}
