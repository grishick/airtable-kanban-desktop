import { useEffect, useState } from 'react';
import type { Task, TaskStatus, TagOption } from '../types';
import TaskCard from './TaskCard';
import TaskModal from './TaskModal';

interface Props {
  status: TaskStatus;
  tasks: Task[];
  tagOptions: TagOption[];
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

export default function KanbanColumn({
  status,
  tasks,
  tagOptions,
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
    setDragOver(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node)) {
      setDragOver(false);
    }
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const taskId = e.dataTransfer.getData('taskId');
    if (taskId) await onDrop(taskId, status);
  };

  const handleCardDragStart = (e: React.DragEvent, taskId: string) => {
    e.dataTransfer.setData('taskId', taskId);
    e.dataTransfer.effectAllowed = 'move';
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
              {visibleTasks.map((task) => (
                <TaskCard
                  key={task.id}
                  task={task}
                  tagOptions={tagOptions}
                  onClick={() => setEditingTask(task)}
                  onDragStart={(e) => handleCardDragStart(e, task.id)}
                  onToggleCheckbox={(nextDescription) => onUpdateTask(task.id, { description: nextDescription })}
                />
              ))}
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
          onSave={onCreateTask}
          onClose={() => setCreating(false)}
        />
      )}

      {editingTask && (
        <TaskModal
          task={editingTask}
          tagOptions={tagOptions}
          onSave={(updates) => onUpdateTask(editingTask.id, updates)}
          onDelete={() => onDeleteTask(editingTask.id)}
          onClose={() => setEditingTask(null)}
        />
      )}
    </>
  );
}
