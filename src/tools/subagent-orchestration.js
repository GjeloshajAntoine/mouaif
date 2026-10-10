'use strict';

const { randomUUID } = require('node:crypto');
const { Groups } = require('./subagent-groups.js');
const PARENT_TOOLS = Object.freeze(['subagent_messages', 'subagent_status', 'subagent_stop', 'subagent_send', 'subagent_group_create', 'subagent_group_update']);
const SIBLING_TOOLS = Object.freeze(['subagent_publish', 'subagent_read', 'subagent_group_status', 'subagent_decision', 'subagent_conflict']);
const TOOL_NAMES = Object.freeze([...PARENT_TOOLS, ...SIBLING_TOOLS]);
const FAMILY_NAMES = Object.freeze(['subagent', ...TOOL_NAMES]);
const error = (code, message) => Object.assign(new Error(message), { code });
const spec = (name, description, properties, required = []) => ({ type: 'function', function: {
  name, description, parameters: { type: 'object', properties, required, additionalProperties: false }
} });
const callId = { type: 'string', description: 'Background callId returned by subagent, in this parent turn only.' };
const SPECS = [
  spec('subagent_status', 'Parent only: immediate status, never waits. Maximum 256 observation calls per turn; do not poll tightly.', { callId }),
  spec('subagent_messages', 'Parent only: read bounded public lines and delivery receipts; no writes or waiting.', {
    callId, since: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 50 }
  }, ['callId']),
  spec('subagent_send', 'Parent only: explicitly queue steering for the next child model round. Receipt is queued, delivered (inserted into context), or undelivered; not an interrupt.', { callId, message: { type: 'string', maxLength: 4096 } }, ['callId', 'message']),
  spec('subagent_group_create', 'Parent only: declare a shared objective and member DAG before launching members. Ownership/workspace are metadata, never permission or checkout effects.', {
    name: { type: 'string', maxLength: 80 }, objective: { type: 'string', maxLength: 4096 },
    members: { type: 'array', minItems: 1, maxItems: 32, items: { type: 'object', additionalProperties: false, required: ['memberId', 'role', 'workspace'], properties: {
      memberId: { type: 'string' }, role: { type: 'string', maxLength: 512 }, workspace: { type: 'string', maxLength: 1024 },
      owns: { type: 'array', maxItems: 20, items: { type: 'string' } }, dependsOn: { type: 'array', maxItems: 32, items: { type: 'string' } }
    } } }
  }, ['name', 'objective', 'members']),
  spec('subagent_group_status', 'Immediate discoverable group/member readiness, artifacts, proposed/approved decisions and conflicts. Parent sees all; children see only their group.', { groupId: { type: 'string' } }),
  spec('subagent_group_update', 'Parent only: approve/reject a proposed contract, arbitrate an escalated conflict, or cancel the group. Never merges, rolls back or obtains consensus.', {
    groupId: { type: 'string' }, action: { type: 'string', enum: ['approve', 'reject', 'arbitrate', 'cancel'] }, name: { type: 'string' }, contract: { type: 'string', maxLength: 4096 }
  }, ['groupId', 'action']),
  spec('subagent_decision', 'Propose a named shared decision. It is not a contract until the parent explicitly approves it.', { groupId: { type: 'string' }, name: { type: 'string' }, proposal: { type: 'string', maxLength: 4096 } }, ['groupId', 'name', 'proposal']),
  spec('subagent_conflict', 'Escalate an ownership/contract conflict for parent arbitration; no child consensus or automatic file effects.', { groupId: { type: 'string' }, name: { type: 'string' }, summary: { type: 'string', maxLength: 4096 }, members: { type: 'array', maxItems: 32, items: { type: 'string' } } }, ['groupId', 'name', 'summary', 'members']),
  spec('subagent_stop', 'Parent only: cancel one child, including its pending approvals, without cancelling siblings. Idempotent; cancellation is cooperative.', { callId }, ['callId']),
  spec('subagent_publish', 'Publish a bounded named handoff in this turn only. Names are immutable; siblings can read summaries and project-relative file references. No arbitrary file contents/snippets.', {
    name: { type: 'string', maxLength: 80 }, summary: { type: 'string', maxLength: 8192 },
    files: { type: 'array', maxItems: 20, items: { type: 'string', maxLength: 512 } }
  }, ['name', 'summary']),
  spec('subagent_read', 'Read a named sibling handoff (metadata only). Use ordinary authorized read_file for contents and redaction; the handoff never bypasses File tools.', {
    name: { type: 'string', maxLength: 80, description: 'Omit to discover all accessible named artifacts.' }
  })
];

// One instance per parent invocation; never a process-global chat scratchpad.
class Scope {
  constructor(projectDir, chatId, signal) {
    this.projectDir = projectDir;
    this.chatId = chatId;
    this.runs = new Map();
    this.publications = new Map();
    this.groups = new Groups();
    this.observations = 0;
    this.closed = false;
    this.signal = signal;
    this.abort = () => { for (const row of this.runs.values()) this.stop(row); };
    if (signal) signal.addEventListener('abort', this.abort, { once: true });
  }
  start(id, agent, execute, complete, meta = {}) {
    if (this.closed || this.signal?.aborted) throw error('EABORTED', 'parent turn has ended');
    if (this.runs.size >= 32) throw error('ETOOL_CAP', 'maximum 32 delegations per parent turn');
    if (this.runs.has(id)) throw error('EBADINPUT', 'duplicate delegation callId');
    const pair = this.groups.validateLaunch(meta);
    const row = { callId: id, author: randomUUID().replace(/-/g, '').slice(0, 12), agent: agent || null, state: 'running', startedAt: Date.now(),
      controller: new AbortController(), lines: [], cursor: 0, inbox: [], receipts: [], published: [], workspace: meta.workspace || this.projectDir };
      row.complete = complete;
      this.groups.bind(pair, row);
      if (pair) row.state = pair.member.state;
      this.runs.set(id, row);
    // Defer dispatch until the receipt is returned; completion owns the single
    // persisted tool_result, while the model gets a background handle immediately.
    row.promise = new Promise((resolve) => setImmediate(resolve)).then(async () => {
    if (!await this.groups.ready(row) || row.controller.signal.aborted || this.closed) {
      const result = { error: { code: 'EDEPENDENCY', message: 'run cancelled or dependency did not complete' } };
      return { ok: false, result };
    }
    row.state = 'running';
    return execute(row);
    }).catch((e) => {
      const result = { error: { code: e.code || 'ESUBAGENT', message: e.message } };
      return { ok: false, result, content: JSON.stringify(result) };
    }).then((exec) => {
    if (row.finalized) return row.exec;
    row.finalized = true;
    row.exec = exec;
      row.finishedAt = Date.now();
      const member = row.groupId && this.groups.member(row.groupId, row.memberId).member;
      row.state = member?.state === 'blocked' ? 'blocked' : row.controller.signal.aborted ? 'cancelled' : exec.ok ? 'completed' : 'failed';
      this.groups.settle(row, row.state);
      this.undelivered(row);
      row.modelId = exec.result?.model?.id || row.modelId || null;
      exec.result = Object.assign({}, exec.result, { callId: id, state: row.state, groupId: row.groupId || null, memberId: row.memberId || null, published: row.published.slice() });
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
    const alreadyFinished = ['completed', 'failed', 'cancelled', 'blocked'].includes(row.state);
    if (!alreadyFinished) { row.state = 'stopping'; row.controller.abort(); this.groups.settle(row, 'cancelled'); this.undelivered(row); }
    return { callId: row.callId, state: row.state, alreadyFinished };
  }
  event(row, kind, data) {
    if (!this.accepts(row)) return;
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
    if (!row || !this.accepts(row)) return [];
    return row.inbox.splice(0).map((receipt) => { receipt.state = 'delivered'; return receipt.message; });
  }
  accepts(row) { return !this.closed && !this.signal?.aborted && !row.finalized && !row.controller.signal.aborted; }
  undelivered(row) {
    for (const receipt of row.inbox.splice(0)) receipt.state = 'undelivered';
  }
  status(row) {
    return { callId: row.callId, agent: row.agent, modelId: row.modelId || null, state: row.groupId && this.groups.member(row.groupId, row.memberId).member.state === 'blocked' ? 'blocked' : row.state,
      groupId: row.groupId || null, memberId: row.memberId || null, workspace: row.workspace,
      startedAt: row.startedAt, elapsedMs: (row.finishedAt || Date.now()) - row.startedAt,
      lastLine: row.lines.at(-1)?.text || '', published: row.published.slice(),
      ...(row.exec ? { ok: row.exec.ok, text: String(row.exec.result?.text || '').slice(0, 16384), error: row.exec.result?.error } : {}) };
  }
  dispatch(name, args, author, workspace) {
    if (this.closed || this.signal?.aborted) throw error('EABORTED', 'parent turn has ended');
    const child = author && [...this.runs.values()].find((r) => r.author === author);
    if (author && (!child || !this.accepts(child))) throw error('EABORTED', 'child is no longer active');
    if (PARENT_TOOLS.includes(name) && author) throw error('EPARENT_ONLY', 'only the delegating parent can control runs');
    const toolSpec = SPECS.find((s) => s.function.name === name)?.function.parameters;
    if (!toolSpec || !args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).some((k) => !Object.hasOwn(toolSpec.properties, k)) || toolSpec.required.some((k) => args[k] === undefined)) throw error('EBADINPUT', 'invalid tool arguments');
    if (['subagent_status', 'subagent_messages', 'subagent_group_status', 'subagent_read'].includes(name) && ++this.observations > 256) throw error('EPOLL_LIMIT', 'observation budget exhausted; stop polling this turn');
    if (name.startsWith('subagent_group') || ['subagent_decision', 'subagent_conflict'].includes(name)) {
      if (child && (!child.groupId || args.groupId && args.groupId !== child.groupId)) throw error('EPARENT_ONLY', 'children can access only their own group');
      if (name === 'subagent_group_create') return this.groups.create(args);
      if (name === 'subagent_group_status') return args.groupId || child ? this.groups.status(this.groups.get(args.groupId || child.groupId)) : { groups: [...this.groups.rows.values()].map((g) => this.groups.status(g)) };
      if (name === 'subagent_decision') return this.groups.propose(args, child);
      if (name === 'subagent_conflict') return this.groups.conflict(args, child);
      if (args.action === 'cancel') {
        const group = this.groups.get(args.groupId);
        for (const m of group.members.values()) {
          if (m.callId) this.stop(this.get(m.callId));
          else if (!['completed', 'failed', 'cancelled', 'blocked'].includes(m.state)) { m.state = 'cancelled'; m.resolve('cancelled'); }
        }
        this.groups.propagate(group); return this.groups.status(group);
      }
      return this.groups.update(args);
    }
    if (name === 'subagent_send') {
      const row = this.get(args.callId);
      if (typeof args.message !== 'string' || !args.message.trim() || args.message.length > 4096) throw error('EBADINPUT', 'message must contain 1–4096 characters');
      if (row.receipts.length >= 64 || row.inbox.length >= 16) throw error('ETOOL_CAP', 'message budget exhausted');
      const receipt = { messageId: randomUUID(), state: this.accepts(row) ? 'queued' : 'undelivered', message: args.message };
      row.receipts.push(receipt); if (receipt.state === 'queued') row.inbox.push(receipt);
      return { callId: row.callId, messageId: receipt.messageId, state: receipt.state };
    }
    if (name === 'subagent_status') return args.callId ? this.status(this.get(args.callId)) : { runs: [...this.runs.values()].map((r) => this.status(r)) };
    if (name === 'subagent_stop') return this.stop(this.get(args.callId));
    if (name === 'subagent_messages') {
      const row = this.get(args.callId);
      const since = args.since ?? 0;
      const limit = args.limit ?? 20;
      if (!Number.isInteger(since) || since < 0 || !Number.isInteger(limit) || limit < 1 || limit > 50) throw error('EBADINPUT', 'invalid cursor or limit');
      const lines = row.lines.filter((line) => line.cursor > since).slice(0, limit);
      return { callId: row.callId, state: row.state, lines, nextCursor: lines.at(-1)?.cursor ?? since,
        truncated: since < (row.lines[0]?.cursor || 1) - 1, deliveries: row.receipts.map(({ messageId, state }) => ({ messageId, state })) };
    }
    const accessible = (item) => !child || !item.groupId || item.groupId === child.groupId;
    if (name === 'subagent_read' && args.name === undefined) return { artifacts: [...this.publications.values()].filter(accessible).map((item) => ({ ...item, files: item.files.slice() })) };
    const key = args.name;
    if (typeof key !== 'string' || !/^[a-zA-Z0-9_.-]{1,80}$/.test(key)) throw error('EBADINPUT', 'name must be 1–80 letters, digits, dots, underscores or hyphens');
    if (name === 'subagent_read') {
      const item = this.publications.get(key);
      if (!item || !accessible(item)) throw error('EUNKNOWN_PUBLICATION', 'handoff not published in this scope');
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
    if (row && workspace) {
      row.workspace = workspace;
      if (row.groupId) this.groups.member(row.groupId, row.memberId).member.actualWorkspace = workspace;
    }
    const item = { name: key, summary: args.summary, files: files.slice(), author: row ? row.callId : 'parent', groupId: row?.groupId || null, memberId: row?.memberId || null, workspace: row?.workspace || this.projectDir };
    if (row?.groupId) this.groups.get(row.groupId).artifacts.push(key);
    this.publications.set(key, item);
    if (row) row.published.push(key);
    return { ...item, files: item.files.slice() };
  }
  async finish() {
    if (this.closing) return this.closing;
    this.closed = true;
    this.abort();
    this.groups.close();
    let timer;
    this.closing = Promise.race([
    Promise.allSettled([...this.runs.values()].map((r) => r.promise)),
    new Promise((resolve) => { timer = setTimeout(resolve, 1000); })
    ]).then(() => {
    clearTimeout(timer);
    for (const row of this.runs.values()) if (!row.finalized) {
      row.finalized = true; row.state = 'cancelled'; this.undelivered(row);
      const result = { callId: row.callId, state: 'cancelled', groupId: row.groupId || null, memberId: row.memberId || null, published: row.published.slice(), error: { code: 'ESHUTDOWN_TIMEOUT', message: 'child did not settle within shutdown budget' } };
      row.exec = { ok: false, result, content: JSON.stringify(result) };
      row.complete(row.exec);
    }
    if (this.signal) this.signal.removeEventListener('abort', this.abort);
    this.publications.clear();
    this.runs.clear();
    this.groups.rows.clear();
    });
    return this.closing;
  }
}

module.exports = { Scope, SPECS, TOOL_NAMES, FAMILY_NAMES, PARENT_TOOLS, SIBLING_TOOLS };
