import { useState } from 'react';
import type { Task, TagOption, StatusOption, Collaborator } from '../types';
import KanbanColumn from './KanbanColumn';

interface Props {
  tasks: Task[];
  tagOptions: TagOption[];
  statusOptions: StatusOption[];
  collaborators: Collaborator[];
  pageSize: number;
  onCreateTask: (data: Partial<Task>) => Promise<void>;
  onUpdateTask: (id: string, updates: Partial<Task>) => Promise<void>;
  onDeleteTask: (id: string) => Promise<void>;
  onAddStatus: (name: string) => Promise<void>;
  onRenameStatus: (oldName: string, newName: string) => Promise<void>;
  onReorderStatuses: (orderedNames: string[]) => Promise<void>;
  onRemoveStatus: (name: string) => Promise<void>;
}

export default function KanbanBoard({
  tasks, tagOptions, statusOptions, collaborators, pageSize,
  onCreateTask, onUpdateTask, onDeleteTask,
  onAddStatus, onRenameStatus, onReorderStatuses, onRemoveStatus,
}: Props) {
  const [addingColumn, setAddingColumn] = useState(false);
  const [newColumnName, setNewColumnName] = useState('');

  const statuses = statusOptions.map((o) => o.name);
  const colorMap = new Map(statusOptions.map((o) => [o.name, o.color ?? '#97a0af']));

  const handleDrop = async (taskId: string, newStatus: string) => {
    const task = tasks.find((t) => t.id === taskId);
    if (!task || task.status === newStatus) return;

    const maxPos = tasks
      .filter((t) => t.status === newStatus)
      .reduce((m, t) => Math.max(m, t.position), 0);

    await onUpdateTask(taskId, { status: newStatus, position: maxPos + 1000 });
  };

  const tasksByStatus = (status: string) =>
    tasks
      .filter((t) => t.status === status)
      .sort((a, b) => a.position - b.position);

  const handleMoveLeft = (index: number) => {
    if (index <= 0) return;
    const reordered = [...statuses];
    [reordered[index - 1], reordered[index]] = [reordered[index], reordered[index - 1]];
    onReorderStatuses(reordered);
  };

  const handleMoveRight = (index: number) => {
    if (index >= statuses.length - 1) return;
    const reordered = [...statuses];
    [reordered[index], reordered[index + 1]] = [reordered[index + 1], reordered[index]];
    onReorderStatuses(reordered);
  };

  const handleAddColumn = () => {
    const name = newColumnName.trim();
    if (!name) return;
    if (statuses.includes(name)) return;
    onAddStatus(name);
    setNewColumnName('');
    setAddingColumn(false);
  };

  return (
    <div className="board-container">
      <div className="board">
        {statuses.map((status, index) => (
          <KanbanColumn
            key={status}
            status={status}
            color={colorMap.get(status) ?? '#97a0af'}
            tasks={tasksByStatus(status)}
            allStatuses={statuses}
            tagOptions={tagOptions}
            collaborators={collaborators}
            statusOptions={statusOptions}
            pageSize={pageSize}
            onCreateTask={(data) => onCreateTask({ ...data, status })}
            onUpdateTask={onUpdateTask}
            onDeleteTask={onDeleteTask}
            onDrop={handleDrop}
            onRename={(newName) => onRenameStatus(status, newName)}
            onMoveLeft={index > 0 ? () => handleMoveLeft(index) : null}
            onMoveRight={index < statuses.length - 1 ? () => handleMoveRight(index) : null}
            onRemove={statuses.length > 1 ? () => onRemoveStatus(status) : null}
          />
        ))}

        {/* Add column button */}
        <div className="add-column">
          {addingColumn ? (
            <div className="add-column-form">
              <input
                className="add-column-input"
                value={newColumnName}
                onChange={(e) => setNewColumnName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleAddColumn();
                  if (e.key === 'Escape') { setAddingColumn(false); setNewColumnName(''); }
                }}
                placeholder="Column name…"
                autoFocus
              />
              <div className="add-column-actions">
                <button className="btn btn-primary btn-sm" onClick={handleAddColumn}>Add</button>
                <button className="btn btn-secondary btn-sm" onClick={() => { setAddingColumn(false); setNewColumnName(''); }}>Cancel</button>
              </div>
            </div>
          ) : (
            <button className="add-column-btn" onClick={() => setAddingColumn(true)} title="Add column">
              +
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
