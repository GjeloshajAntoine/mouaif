'use strict';

// Native `task` tool — lets the model define structured tasks with subtasks,
// track progress, and mark items done. Tasks are stored in-memory per chat
// (they are ephemeral and do not survive a server restart). Each task has an
// auto-generated id so the model can reference it across turns.
//
// Public surface:
//   SPEC           — the OpenAI-compatible tool spec advertised to the model.
//   validateArgs   — validate and normalize the incoming arguments.
//   buildResult    — shape the runner result.
//   dispatchTask   — execute a task action and return the result.
//   clearChat      — remove all tasks for a chat (called on chat delete).
//   listChatTasks  — return the task list for a chat (for UI queries).

const crypto = require('node:crypto');

// In-memory store: Map<chatId, Map<taskId, task>>
const taskStore = new Map();

function tasksFor(chatId) {
  if (!chatId || typeof chatId !== 'string') return null;
  if (!taskStore.has(chatId)) taskStore.set(chatId, new Map());
  return taskStore.get(chatId);
}

function nextId() {
  return crypto.randomBytes(4).toString('hex');
}

const MAX_TITLE_CHARS = 200;
const MAX_DESC_CHARS = 2000;
const MAX_SUBTASK_TITLE_CHARS = 200;
const MAX_TASKS_PER_CHAT = 50;

const SPEC = {
  type: 'function',
  function: {
    name: 'task',
    description: 'Create, update, track progress on, and list structured tasks with subtasks. Use this to break down complex work into manageable pieces and show progress to the user. Each task gets an auto-generated ID you reference in later calls.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['create', 'update_progress', 'list', 'complete'],
          description: 'Action to perform: create a new task, update progress on an existing task, list all tasks in the current chat, or mark a task complete.'
        },
        title: {
          type: 'string',
          description: 'Task title (required when action is "create", max 200 chars).'
        },
        description: {
          type: 'string',
          description: 'Optional task description (max 2000 chars).'
        },
        taskId: {
          type: 'string',
          description: 'The task ID returned when the task was created. Required for "update_progress", "complete".'
        },
        current: {
          type: 'number',
          description: 'Current progress count (0-based). Required for "update_progress". Ignored for other actions.'
        },
        total: {
          type: 'number',
          description: 'Total progress count. Required for "update_progress". Ignored for other actions.'
        }
      },
      required: ['action'],
      additionalProperties: false
    }
  }
};

function trimString(value, max) {
  if (typeof value !== 'string') return '';
  const s = value.trim();
  if (s.length <= max) return s;
  return s.slice(0, max);
}

function validateArgs(args) {
  if (!args || typeof args !== 'object') {
    const e = new Error('args is required'); e.code = 'EBADINPUT'; throw e;
  }
  const action = args.action;
  if (action !== 'create' && action !== 'update_progress' && action !== 'list' && action !== 'complete') {
    const e = new Error('action must be "create", "update_progress", "list", or "complete"'); e.code = 'EBADINPUT'; throw e;
  }
  if (action === 'create') {
    const title = trimString(args.title, MAX_TITLE_CHARS);
    if (!title) {
      const e = new Error('title is required when action is "create"'); e.code = 'EBADINPUT'; throw e;
    }
    return {
      action: 'create',
      title,
      description: trimString(args.description, MAX_DESC_CHARS)
    };
  }
  if (action === 'update_progress') {
    const taskId = typeof args.taskId === 'string' && args.taskId.trim() ? args.taskId.trim() : null;
    if (!taskId) {
      const e = new Error('taskId is required when action is "update_progress"'); e.code = 'EBADINPUT'; throw e;
    }
    const current = Number.isFinite(args.current) ? Math.max(0, Math.round(args.current)) : null;
    const total = Number.isFinite(args.total) ? Math.max(1, Math.round(args.total)) : null;
    if (current == null || total == null) {
      const e = new Error('current and total are required when action is "update_progress"'); e.code = 'EBADINPUT'; throw e;
    }
    return { action: 'update_progress', taskId, current, total };
  }
  if (action === 'complete') {
    const taskId = typeof args.taskId === 'string' && args.taskId.trim() ? args.taskId.trim() : null;
    if (!taskId) {
      const e = new Error('taskId is required when action is "complete"'); e.code = 'EBADINPUT'; throw e;
    }
    return { action: 'complete', taskId };
  }
  // list — no extra args
  return { action: 'list' };
}

// dispatchTask(chatId, args) -> { ok, content, result }
//
// args must already be validated by validateArgs.
function dispatchTask(chatId, validated) {
  if (!chatId) {
    return { ok: false, content: JSON.stringify({ error: 'chatId is required' }), result: { error: 'chatId is required' } };
  }

  if (validated.action === 'list') {
    const tasks = tasksFor(chatId);
    if (!tasks || !tasks.size) {
      const result = { tasks: [] };
      return { ok: true, content: JSON.stringify(result), result };
    }
    const taskList = [];
    for (const t of tasks.values()) {
      taskList.push(t);
    }
    // Sort by creation order
    taskList.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
    const result = { tasks: taskList };
    return { ok: true, content: JSON.stringify(result), result };
  }

  if (validated.action === 'create') {
    const tasks = tasksFor(chatId);
    if (!tasks) {
      return { ok: false, content: JSON.stringify({ error: 'No chat context' }), result: { error: 'No chat context' } };
    }
    if (tasks.size >= MAX_TASKS_PER_CHAT) {
      return { ok: false, content: JSON.stringify({ error: 'Maximum tasks per chat reached (' + MAX_TASKS_PER_CHAT + ')' }), result: { error: 'Maximum tasks per chat reached' } };
    }
    const id = nextId();
    const task = {
      id,
      title: validated.title,
      description: validated.description || '',
      status: 'in_progress',
      current: 0,
      total: 100,
      createdAt: Date.now()
    };
    tasks.set(id, task);
    const result = { task, action: 'created' };
    return { ok: true, content: JSON.stringify(result), result };
  }

  if (validated.action === 'update_progress') {
    const tasks = tasksFor(chatId);
    if (!tasks || !tasks.has(validated.taskId)) {
      return { ok: false, content: JSON.stringify({ error: 'task not found', taskId: validated.taskId }), result: { error: 'task not found', taskId: validated.taskId } };
    }
    const task = tasks.get(validated.taskId);
    task.current = validated.current;
    task.total = validated.total;
    const result = {
      task: {
        id: task.id,
        title: task.title,
        status: task.status,
        current: task.current,
        total: task.total
      },
      action: 'progress_updated'
    };
    return { ok: true, content: JSON.stringify(result), result };
  }

  if (validated.action === 'complete') {
    const tasks = tasksFor(chatId);
    if (!tasks || !tasks.has(validated.taskId)) {
      return { ok: false, content: JSON.stringify({ error: 'task not found', taskId: validated.taskId }), result: { error: 'task not found', taskId: validated.taskId } };
    }
    const task = tasks.get(validated.taskId);
    task.status = 'completed';
    task.current = task.total;
    const result = {
      task: {
        id: task.id,
        title: task.title,
        status: task.status,
        current: task.current,
        total: task.total
      },
      action: 'completed'
    };
    return { ok: true, content: JSON.stringify(result), result };
  }

  return { ok: false, content: JSON.stringify({ error: 'unknown action' }), result: { error: 'unknown action' } };
}

function clearChat(chatId) {
  taskStore.delete(chatId);
}

function listChatTasks(chatId) {
  const tasks = taskStore.get(chatId);
  if (!tasks) return [];
  return Array.from(tasks.values()).sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
}

module.exports = {
  SPEC,
  validateArgs,
  dispatchTask,
  clearChat,
  listChatTasks,
  MAX_TASKS_PER_CHAT
};