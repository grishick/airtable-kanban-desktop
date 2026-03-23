import type { Task, TaskStatus, TagOption, Collaborator } from '../types';
import { STATUSES } from '../types';
import KanbanColumn from './KanbanColumn';

interface Props {
  tasks: Task[];
  tagOptions: TagOption[];
  collaborators: Collaborator[];
  pageSize: number;
  onCreateTask: (data: Partial<Task>) => Promise<void>;
  onUpdateTask: (id: string, updates: Partial<Task>) => Promise<void>;
  onDeleteTask: (id: string) => Promise<void>;
}

export default function KanbanBoard({ tasks, tagOptions, collaborators, pageSize, onCreateTask, onUpdateTask, onDeleteTask }: Props) {
  const handleDrop = async (taskId: string, newStatus: TaskStatus) => {
    const task = tasks.find((t) => t.id === taskId);
    if (!task || task.status === newStatus) return;

    // Find the max position in the target column and place after it
    const maxPos = tasks
      .filter((t) => t.status === newStatus)
      .reduce((m, t) => Math.max(m, t.position), 0);

    await onUpdateTask(taskId, { status: newStatus, position: maxPos + 1000 });
  };

  const tasksByStatus = (status: TaskStatus) =>
    tasks
      .filter((t) => t.status === status)
      .sort((a, b) => a.position - b.position);

  return (
    <div className="board-container">
      <div className="board">
        {STATUSES.map((status) => (
          <KanbanColumn
            key={status}
            status={status}
            tasks={tasksByStatus(status)}
            tagOptions={tagOptions}
            collaborators={collaborators}
            pageSize={pageSize}
            onCreateTask={(data) => onCreateTask({ ...data, status })}
            onUpdateTask={onUpdateTask}
            onDeleteTask={onDeleteTask}
            onDrop={handleDrop}
          />
        ))}
      </div>
    </div>
  );
}
