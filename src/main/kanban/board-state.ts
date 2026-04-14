// board-state.ts — Standalone kanban board state module for Electron app
// Immutable pattern: all mutations return a new BoardState

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TaskStatus = "backlog" | "in_progress" | "review" | "done";

export interface TaskCard {
  id: string;
  title: string;
  prompt: string;
  agentId: string | null;
  status: TaskStatus;
  worktreePath?: string;
  worktreeBranch?: string;
  createdAt: number;
  updatedAt: number;
}

export interface Dependency {
  from: string; // task id
  to: string;   // task id — "from" depends on "to" being done
}

export interface BoardState {
  columns: Record<TaskStatus, TaskCard[]>;
  dependencies: Dependency[];
}

// ---------------------------------------------------------------------------
// Board factory
// ---------------------------------------------------------------------------

export function createEmptyBoard(): BoardState {
  return {
    columns: {
      backlog: [],
      in_progress: [],
      review: [],
      done: [],
    },
    dependencies: [],
  };
}

// ---------------------------------------------------------------------------
// Task ID generation
// ---------------------------------------------------------------------------

const TASK_ID_LENGTH = 5;

export function generateTaskId(): string {
  const raw = crypto.randomUUID().replaceAll("-", "");
  return raw.slice(0, TASK_ID_LENGTH);
}

function uniqueTaskId(board: BoardState): string {
  const existing = new Set<string>();
  for (const cards of Object.values(board.columns)) {
    for (const card of cards) {
      existing.add(card.id);
    }
  }
  for (let attempt = 0; attempt < 16; attempt++) {
    const candidate = generateTaskId();
    if (!existing.has(candidate)) {
      return candidate;
    }
  }
  // Fallback: timestamp-based
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`.slice(
    0,
    TASK_ID_LENGTH,
  );
}

// ---------------------------------------------------------------------------
// Mutations — all return a new BoardState
// ---------------------------------------------------------------------------

export interface AddTaskInput {
  title: string;
  prompt: string;
  agentId?: string | null;
  status?: TaskStatus;
  worktreePath?: string;
  worktreeBranch?: string;
}

export function addTask(board: BoardState, input: AddTaskInput): BoardState {
  const now = Date.now();
  const status: TaskStatus = input.status ?? "backlog";
  const task: TaskCard = {
    id: uniqueTaskId(board),
    title: input.title,
    prompt: input.prompt,
    agentId: input.agentId ?? null,
    status,
    ...(input.worktreePath ? { worktreePath: input.worktreePath } : {}),
    ...(input.worktreeBranch ? { worktreeBranch: input.worktreeBranch } : {}),
    createdAt: now,
    updatedAt: now,
  };

  return {
    ...board,
    columns: {
      ...board.columns,
      [status]: [...board.columns[status], task],
    },
  };
}

export function moveTask(
  board: BoardState,
  taskId: string,
  toStatus: TaskStatus,
): BoardState {
  // Find the task across all columns
  let found: TaskCard | null = null;
  let fromStatus: TaskStatus | null = null;

  for (const [status, cards] of Object.entries(board.columns) as [TaskStatus, TaskCard[]][]) {
    const card = cards.find((c) => c.id === taskId);
    if (card) {
      found = card;
      fromStatus = status;
      break;
    }
  }

  if (!found || !fromStatus || fromStatus === toStatus) {
    return board;
  }

  const now = Date.now();
  const movedTask: TaskCard = { ...found, status: toStatus, updatedAt: now };

  return {
    ...board,
    columns: {
      ...board.columns,
      [fromStatus]: board.columns[fromStatus].filter((c) => c.id !== taskId),
      [toStatus]: [...board.columns[toStatus], movedTask],
    },
  };
}

export function updateTask(
  board: BoardState,
  taskId: string,
  updates: Partial<Pick<TaskCard, "title" | "prompt" | "agentId" | "worktreePath" | "worktreeBranch">>,
): BoardState {
  const now = Date.now();
  let updated = false;

  const columns = { ...board.columns } as Record<TaskStatus, TaskCard[]>;

  for (const status of Object.keys(columns) as TaskStatus[]) {
    const idx = columns[status].findIndex((c) => c.id === taskId);
    if (idx === -1) continue;

    const card = columns[status][idx];
    columns[status] = columns[status].map((c, i) =>
      i === idx ? { ...card, ...updates, updatedAt: now } : c,
    );
    updated = true;
    break;
  }

  if (!updated) return board;

  return { ...board, columns };
}

export function deleteTask(board: BoardState, taskId: string): BoardState {
  let found = false;
  const columns = { ...board.columns } as Record<TaskStatus, TaskCard[]>;

  for (const status of Object.keys(columns) as TaskStatus[]) {
    const before = columns[status].length;
    columns[status] = columns[status].filter((c) => c.id !== taskId);
    if (columns[status].length < before) {
      found = true;
      break;
    }
  }

  if (!found) return board;

  // Remove any dependencies that reference the deleted task
  const dependencies = board.dependencies.filter(
    (d) => d.from !== taskId && d.to !== taskId,
  );

  return { ...board, columns, dependencies };
}

// ---------------------------------------------------------------------------
// Dependency mutations
// ---------------------------------------------------------------------------

export function addDependency(
  board: BoardState,
  from: string,
  to: string,
): BoardState {
  if (from === to) return board;

  // Check both tasks exist
  const allIds = new Set<string>();
  for (const cards of Object.values(board.columns)) {
    for (const card of cards) {
      allIds.add(card.id);
    }
  }
  if (!allIds.has(from) || !allIds.has(to)) return board;

  // Check for duplicate
  const exists = board.dependencies.some(
    (d) => d.from === from && d.to === to,
  );
  if (exists) return board;

  return {
    ...board,
    dependencies: [...board.dependencies, { from, to }],
  };
}

export function removeDependency(
  board: BoardState,
  from: string,
  to: string,
): BoardState {
  const filtered = board.dependencies.filter(
    (d) => !(d.from === from && d.to === to),
  );
  if (filtered.length === board.dependencies.length) return board;

  return { ...board, dependencies: filtered };
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/** Returns backlog tasks whose upstream dependencies are all in the 'done' column. */
export function getReadyTasks(board: BoardState): TaskCard[] {
  const doneIds = new Set(board.columns.done.map((c) => c.id));

  return board.columns.backlog.filter((task) => {
    // Collect all "to" task ids that this task depends on
    const upstreamIds = board.dependencies
      .filter((d) => d.from === task.id)
      .map((d) => d.to);

    // A task with no dependencies is ready
    if (upstreamIds.length === 0) return true;

    // All upstream tasks must be done
    return upstreamIds.every((id) => doneIds.has(id));
  });
}
