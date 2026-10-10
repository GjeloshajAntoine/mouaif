'use strict';

const { randomUUID } = require('node:crypto');
const PARENT_TOOLS = Object.freeze(['subagent_messages', 'subagent_status', 'subagent_stop']);
const SIBLING_TOOLS = Object.freeze(['subagent_publish', 'subagent_read']);
const TOOL_NAMES = Object.freeze([...PARENT_TOOLS, ...SIBLING_TOOLS]);
const FAMILY_NAMES = Object.freeze(['subagent', ...TOOL_NAMES]);
const error = (code, message) => Object.assign(new Error(message), { code });
const spec = (name, description, properties, required = []) => ({ type: 'function', function: {
  name, description, parameters: { type: 'object', properties, required, additionalProperties: false }
} });
const callId = { type: 'string', description: 'Background callId returned by subagent, in this parent turn only.' };
const SPECS = [
  spec('subagent_status', 'Parent only: list this turn’s delegated runs, or inspect one handle. Finished rows include a bounded final answer.', { callId, waitMs: { type: 'integer', minimum: 0, maximum: 30000, description: 'With callId, wait up to this long for settlement before returning status; default 0. Avoid tight polling.' } }),
  spec('subagent_messages', 'Parent only: read bounded public answer/progress lines (no reasoning/tool payloads). Optionally queue a steering message for the child’s next model round; not an immediate interrupt.', {
    callId, since: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 50 },
    message: { type: 'string', maxLength: 4096 }
  }, ['callId']),
  spec('subagent_stop', 'Parent only: cancel one child, including its pending approvals, without cancelling siblings. Idempotent; cancellation is cooperative.', { callId }, ['callId']),
  spec('subagent_publish', 'Publish a bounded named handoff in this turn only. Names are immutable; siblings can read summaries and project-relative file references. No arbitrary file contents/snippets.', {
    name: { type: 'string', maxLength: 80 }, summary: { type: 'string', maxLength: 8192 },
    files: { type: 'array', maxItems: 20, items: { type: 'string', maxLength: 512 } }
  }, ['name', 'summary']),
  spec('subagent_read', 'Read a named sibling handoff (metadata only). Use ordinary authorized read_file for contents and redaction; the handoff never bypasses File tools.', {
    name: { type: 'string', maxLength: 80 }
  }, ['name'])
];

// One instance per parent invocation; never a process-global chat scratchpad.
class Scope {
  constructor(projectDir, chatId, signal) {
    this.projectDir = projectDir;
    this.chatId = chatId;
    this.runs = new Map();
    this.publications = new Map();
    this.closed = false;
    this.signal = signal;
    this.abort = () => { for (const row of this.runs.values()) this.stop(row); };
    if (signal) signal.addEventListener('abort', this.abort, { once: true });
  }
  start(id, agent, execute, complete) {
    if (this.closed || this.signal?.aborted) throw error('EABORTED', 'parent turn has ended');
    if (this.runs.size >= 32) throw error('ETOOL_CAP', 'maximum 32 delegations per parent turn');
    if (this.runs.has(id)) throw error('EBADINPUT', 'duplicate delegation callId');
    const row = { callId: id, author: randomUUID().replace(/-/g, '').slice(0, 12), agent: agent || null, state: 'running', startedAt: Date.now(),
      controller: new AbortController(), lines: [], cursor: 0, inbox: [], published: [] };
    this.runs.set(id, row);
    // Defer dispatch until the receipt is returned; completion owns the single
    // persisted tool_result, while the model gets a background handle immediately.
    row.promise = new Promise((resolve) => setImmediate(resolve)).then(() => execute(row)).catch((e) => {
      const result = { error: { code: e.code || 'ESUBAGENT', message: e.message } };
      return { ok: false, result, content: JSON.stringify(result) };
    }).then((exec) => {
      row.exec = exec;
      row.finishedAt = Date.now();
      row.state = row.controller.signal.aborted ? 'cancelled' : exec.ok ? 'completed' : 'failed';
      row.modelId = exec.result?.model?.id || row.modelId || null;
      exec.result = Object.assign({}, exec.result, { callId: id, state: row.state, published: row.published.slice() });
      exec.content = JSON.stringify(exec.result);
      complete(exec);
      return exec;
    });
    return row;
  }
  get(id) {
    const row = this.runs.get(id);
    if (!row) throw error('EUNKNOWN_CALL', 'unknown callId in this parent turn');
    return row;
  }
  stop(row) {
    const alreadyFinished = row.state !== 'running' && row.state !== 'stopping';
    if (!alreadyFinished) { row.state = 'stopping'; row.controller.abort(); }
    return { callId: row.callId, state: row.state, alreadyFinished };
  }
  event(row, kind, data) {
    // Never copy reasoning, tools, shell output, pixels or file bodies into
    // the polling channel. As with ordinary model answers, prose is not a
    // security boundary for model-repeated secrets.
    const text = kind === 'message' ? data?.delta : kind === 'progress_update' ? data?.message || data?.title : null;
    if (typeof text !== 'string' || !text) return;
    row.lines.push({ cursor: ++row.cursor, kind, text: text.slice(0, 2048) });
    if (row.lines.length > 128) row.lines.shift();
  }
  drain(author) {
    const row = [...this.runs.values()].find((r) => r.author === author);
    return row ? row.inbox.splice(0) : [];
  }
  status(row) {
    return { callId: row.callId, agent: row.agent, modelId: row.modelId || null, state: row.state,
      startedAt: row.startedAt, elapsedMs: (row.finishedAt || Date.now()) - row.startedAt,
      lastLine: row.lines.at(-1)?.text || '', published: row.published.slice(),
      ...(row.exec ? { ok: row.exec.ok, text: String(row.exec.result?.text || '').slice(0, 16384), error: row.exec.result?.error } : {}) };
  }
  dispatch(name, args, author) {
    if (this.closed) throw error('EABORTED', 'parent turn has ended');
    if (PARENT_TOOLS.includes(name) && author) throw error('EPARENT_ONLY', 'only the delegating parent can control runs');
    if (name === 'subagent_status') return args.callId ? this.status(this.get(args.callId)) : { runs: [...this.runs.values()].map((r) => this.status(r)) };
    if (name === 'subagent_stop') return this.stop(this.get(args.callId));
    if (name === 'subagent_messages') {
      const row = this.get(args.callId);
      const since = args.since ?? 0;
      const limit = args.limit ?? 20;
      if (!Number.isInteger(since) || since < 0 || !Number.isInteger(limit) || limit < 1 || limit > 50) throw error('EBADINPUT', 'invalid cursor or limit');
      if (args.message !== undefined) {
        if (typeof args.message !== 'string' || !args.message.trim() || args.message.length > 4096) throw error('EBADINPUT', 'message must contain 1–4096 characters');
        if (row.state !== 'running') throw error('EALREADY_FINISHED', 'run is not accepting messages');
        if (row.inbox.length >= 16) throw error('ETOOL_CAP', 'child inbox is full');
        row.inbox.push(args.message);
      }
      const lines = row.lines.filter((line) => line.cursor > since).slice(0, limit);
      return { callId: row.callId, state: row.state, lines, nextCursor: lines.at(-1)?.cursor ?? since,
        truncated: since < (row.lines[0]?.cursor || 1) - 1, queued: args.message !== undefined };
    }
    const key = args.name;
    if (typeof key !== 'string' || !/^[a-zA-Z0-9_.-]{1,80}$/.test(key)) throw error('EBADINPUT', 'name must be 1–80 letters, digits, dots, underscores or hyphens');
    if (name === 'subagent_read') {
      const item = this.publications.get(key);
      if (!item) throw error('EUNKNOWN_PUBLICATION', 'handoff not published in this turn');
      return { ...item, files: item.files.slice() };
    }
    if (name !== 'subagent_publish') throw error('EUNKNOWN_TOOL', 'unknown orchestration tool');
    if (this.publications.has(key)) throw error('EEXISTS', 'handoff names are immutable; choose a new name');
    if (this.publications.size >= 64) throw error('ETOOL_CAP', 'handoff store is full');
    if (typeof args.summary !== 'string' || !args.summary.trim() || args.summary.length > 8192) throw error('EBADINPUT', 'summary must contain 1–8192 characters');
    const files = args.files ?? [];
    if (!Array.isArray(files) || files.length > 20 || files.some((file) => typeof file !== 'string' || !file || file.length > 512 || file.startsWith('/') || file.includes('\\') || file.split('/').includes('..'))) throw error('EBADINPUT', 'files must be bounded project-relative references');
    const row = author && [...this.runs.values()].find((r) => r.author === author);
    if (author && !row) throw error('EUNKNOWN_CALL', 'unknown publisher');
    const item = { name: key, summary: args.summary, files: files.slice(), author: row ? row.callId : 'parent' };
    this.publications.set(key, item);
    if (row) row.published.push(key);
    return { ...item, files: item.files.slice() };
  }
  async finish() {
    if (this.closing) return this.closing;
    this.closed = true;
    this.abort();
    this.closing = Promise.allSettled([...this.runs.values()].map((r) => r.promise)).then(() => {
      if (this.signal) this.signal.removeEventListener('abort', this.abort);
      this.publications.clear();
      this.runs.clear();
    });
    return this.closing;
  }
}

module.exports = { Scope, SPECS, TOOL_NAMES, FAMILY_NAMES, PARENT_TOOLS, SIBLING_TOOLS };
