import { useEffect, useRef, useState } from 'react';
import type { Task, TaskStatus, TagOption, Collaborator } from '../types';
import TaskCard from './TaskCard';
import TaskModal from './TaskModal';

interface Props {
  status: TaskStatus;
  tasks: Task[];
  tagOptions: TagOption[];
  collaborators: Collaborator[];
  pageSize: number;
  onCreateTask: (data: Partial<Task>) => Promise<void>;
  onUpdateTask: (id: string, updates: Partial<Task>) => Promise<void>;
  onDeleteTask: (id: string) => Promise<void>;
  onDrop: (taskId: string, newStatus: TaskStatus) => Promise<void>;
}

const STATUS_COLORS: Record<TaskStatus, string> = {
  'Not Started': 'var(--col-not-started)',
  'In Progress': 'var(--col-in-progress)',
  'Deferred':    'var(--col-deferred)',
  'Waiting':     'var(--col-waiting)',
  'Completed':   'var(--col-completed)',
};

function calculatePosition(tasks: Task[], taskId: string, insertBeforeIndex: number): number {
  const others = tasks.filter((t) => t.id !== taskId);
  const originalIndex = tasks.findIndex((t) => t.id === taskId);
  let idx = insertBeforeIndex;
  if (originalIndex < insertBeforeIndex) idx--;
  idx = Math.max(0, Math.min(idx, others.length));

  if (others.length === 0) return 1000;
  if (idx === 0) return others[0].position - 1000;
  if (idx >= others.length) return others[others.length - 1].position + 1000;
  return (others[idx - 1].position + others[idx].position) / 2;
}

export default function KanbanColumn({
  status,
  tasks,
  tagOptions,
  collaborators,
  pageSize,
  onCreateTask,
  onUpdateTask,
  onDeleteTask,
  onDrop,
}: Props) {
  const [dragOver, setDragOver] = useState(false);
  const [editingTask, setEditingTask] = useState<Task | null>(null);
  const [creating, setCreating] = useState(false);
  const [collapsed, setCollapsed] = useState(status === 'Completed');
  const [displayCount, setDisplayCount] = useState(pageSize);
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  const dropIndexRef = useRef<number | null>(null);
  const draggingFromHere = useRef(false);
  const draggedIndex = useRef<number | null>(null);

  // Reset display count when pageSize setting changes
  useEffect(() => {
    setDisplayCount(pageSize);
  }, [pageSize]);

  const visibleTasks = tasks.slice(0, displayCount);
  const hiddenCount = tasks.length - displayCount;
  const loadMoreCount = Math.min(pageSize, hiddenCount);

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
      const newPosition = calculatePosition(tasks, taskId, idx);
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

  return (
    <>
      <div
        className={`column${dragOver ? ' drag-over' : ''}${collapsed ? ' collapsed' : ''}`}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        <div className="column-header">
          <span
            className="column-dot"
            style={{ background: STATUS_COLORS[status] }}
          />
          <span className="column-title">{status}</span>
          <span className="column-count">{tasks.length}</span>
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
          collaborators={collaborators}
          onSave={onCreateTask}
          onClose={() => setCreating(false)}
        />
      )}

      {editingTask && (
        <TaskModal
          task={editingTask}
          tagOptions={tagOptions}
          collaborators={collaborators}
          onSave={(updates) => onUpdateTask(editingTask.id, updates)}
          onDelete={() => onDeleteTask(editingTask.id)}
          onClose={() => setEditingTask(null)}
        />
      )}
    </>
  );
}
