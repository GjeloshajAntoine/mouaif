'use strict';

const { randomUUID } = require('node:crypto');
const { Groups } = require('./subagent-groups.js');
const PARENT_TOOLS = Object.freeze(['subagent_messages', 'subagent_status', 'subagent_stop', 'subagent_send', 'subagent_group_create', 'subagent_group_update']);
const SIBLING_TOOLS = Object.freeze(['subagent_publish', 'subagent_read', 'subagent_group_status', 'subagent_decision', 'subagent_conflict']);
const TOOL_NAMES = Object.freeze([...PARENT_TOOLS, ...SIBLING_TOOLS]);
const FAMILY_NAMES = Object.freeze(['subagent', ...TOOL_NAMES]);
// Root-tree budgets when settings omit subagentLimits. Depth 3 lets a child
// and a grandchild delegate by default (root → child → grandchild → leaf);
// the leaf level stops advertising launch/control tools. Settings may lower
// it to 1 for non-recursive delegation or raise it without a maximum.
const DEFAULT_LIMITS = Object.freeze({ maxDepth: 3, maxRuns: 32 });
// Accepted integer range of each limit. The Scope constructor and the
// settings registry (src/content/registry.js, checked on write) both read
// this table, as does resolveLimits() below.
const LIMIT_RANGES = Object.freeze({
  maxDepth: Object.freeze({ min: 1 }),
  maxRuns: Object.freeze({ min: 1 })
});
const validLimit = (name, value) => Number.isInteger(value) && value >= LIMIT_RANGES[name].min;

// resolveLimits(stored) -> { limits, invalid }
//
// The limits a root turn runs with, from a stored `subagentLimits` value that
// may have been edited by hand. A missing field takes its default; a field
// that is not an integer in range also takes its default and is listed in
// `invalid` ({ name, value, fallback }) so the caller can warn. Never throws:
// a bad project file must not fail turns that never delegate.
function resolveLimits(stored) {
  const source = stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : {};
  const limits = {};
  const invalid = [];
  if (stored != null && source !== stored) invalid.push({ name: 'subagentLimits', value: stored, fallback: { ...DEFAULT_LIMITS } });
  for (const name of Object.keys(DEFAULT_LIMITS)) {
    const value = source[name];
    if (value === undefined || value === null) limits[name] = DEFAULT_LIMITS[name];
    else if (validLimit(name, value)) limits[name] = value;
    else {
      limits[name] = DEFAULT_LIMITS[name];
      invalid.push({ name, value, fallback: DEFAULT_LIMITS[name] });
    }
  }
  return { limits, invalid };
}
const error = (code, message) => Object.assign(new Error(message), { code });
const spec = (name, description, properties, required = []) => ({ type: 'function', function: {
  name, description, parameters: { type: 'object', properties, required, additionalProperties: false }
} });
const callId = { type: 'string', description: 'callId returned by a subagent call you made with background: true.' };
const keyDesc = '1–80 letters, digits, dots, underscores, or hyphens ([A-Za-z0-9_.-]).';
const SPECS = [
  spec('subagent_status', 'For subagents you started with background: true this turn: their current state, returned at once (it never waits). subagent_status, subagent_messages, subagent_group_status and subagent_read share a budget of 256 calls per turn, so do not poll in a tight loop.', {
    callId: { ...callId, description: 'Optional; omit to list all your subagents, the shared budgets, and any escalated conflicts.' }
  }),
  spec('subagent_messages', 'For a subagent you started with background: true this turn: read the lines it has written so far, and whether your subagent_send messages reached it. Returns at once.', {
    callId,
    since: { type: 'integer', minimum: 0, description: 'Cursor from a previous nextCursor (default 0).' },
    limit: { type: 'integer', minimum: 1, maximum: 50, description: 'Maximum lines to return (1–50, default 20).' }
  }, ['callId']),
  spec('subagent_send', 'For a subagent you started with background: true this turn: send it guidance. The message is added to its context before its next model call; it does not interrupt the current one. The receipt says queued, delivered or undelivered (the subagent had already finished).', {
    callId, message: { type: 'string', minLength: 1, maxLength: 4096, description: 'Guidance text (1–4096 chars).' }
  }, ['callId', 'message']),
  spec('subagent_group_create', 'Plan a team of background subagents before starting them: a shared objective and the members, each with a role, the files it owns and the members it depends on. Then start each member with subagent (groupId, memberId, background: true); a member starts only once its dependencies succeeded. Members can propose shared decisions (subagent_decision) for you to approve, and escalate conflicts (subagent_conflict) for you to settle, both with subagent_group_update. Workspace and file ownership are notes for the members: they grant no permissions and create no checkout.', {
    name: { type: 'string', maxLength: 80, description: 'Unique group name: ' + keyDesc },
    objective: { type: 'string', maxLength: 4096, description: 'Shared group objective (1–4096 chars).' },
    members: { type: 'array', minItems: 1, maxItems: 32, items: { type: 'object', additionalProperties: false, required: ['memberId', 'role', 'workspace'], properties: {
      memberId: { type: 'string', maxLength: 80, description: 'Unique member identifier: ' + keyDesc },
      role: { type: 'string', maxLength: 512, description: 'What this member does, in a sentence.' },
      workspace: { type: 'string', maxLength: 1024, description: 'Advisory workspace or branch name (metadata only).' },
      owns: { type: 'array', maxItems: 20, items: { type: 'string', maxLength: 512 }, description: 'Advisory relative file paths (no leading /, \\, or ..).' },
      dependsOn: { type: 'array', maxItems: 32, items: { type: 'string', maxLength: 80 }, description: 'Upstream memberId list in this group.' }
    } } }
  }, ['name', 'objective', 'members']),
  spec('subagent_group_status', 'A group\u2019s state, returned at once: each member\u2019s progress, published handoffs, proposed and approved decisions, and conflicts. The agent that created groups sees all of them; a group member sees only its own group.', {
    groupId: { type: 'string', description: 'Optional groupId; omit to list local-parent groups or inspect your own assigned group.' }
  }),
  spec('subagent_group_update', 'For a group you created: approve or reject a member\u2019s proposed decision (an approved one becomes a contract the members see), settle an escalated conflict, or cancel the group. It records the outcome only: it never merges, rolls back or edits files.', {
    groupId: { type: 'string', description: 'groupId returned by subagent_group_create.' },
    action: { type: 'string', enum: ['approve', 'reject', 'arbitrate', 'cancel'], description: 'approve or reject a decision, arbitrate a conflict, or cancel the group.' },
    name: { type: 'string', maxLength: 80, description: 'Proposal or conflict name (required for approve, reject, and arbitrate).' },
    contract: { type: 'string', maxLength: 4096, description: 'The approved contract text, the rejection reason, or the conflict resolution (required for approve, reject, and arbitrate).' }
  }, ['groupId', 'action']),
  spec('subagent_decision', 'Propose a decision the whole group should follow, such as an interface or a file layout. It binds no one until the agent that created the group approves it as a contract. A name cannot be reused.', {
    groupId: { type: 'string', description: 'Target groupId (optional when called by an assigned group member).' },
    name: { type: 'string', maxLength: 80, description: 'Immutable proposal name: ' + keyDesc },
    proposal: { type: 'string', maxLength: 4096, description: 'The proposed decision (max 4096 chars).' }
  }, ['name', 'proposal']),
  spec('subagent_conflict', 'Escalate a conflict between group members (two members need the same file, or a contract does not work) to the agent that created the group, which settles it with subagent_group_update. Changes no files.', {
    groupId: { type: 'string', description: 'Target groupId (optional when called by an assigned group member).' },
    name: { type: 'string', maxLength: 80, description: 'Conflict name: ' + keyDesc },
    summary: { type: 'string', maxLength: 4096, description: 'What conflicts and why (max 4096 chars).' },
    members: { type: 'array', minItems: 1, maxItems: 32, items: { type: 'string', maxLength: 80 }, description: '1–32 declared memberIds involved in the conflict.' }
  }, ['name', 'summary', 'members']),
  spec('subagent_stop', 'For a subagent you started with background: true this turn: cancel it, with its own subagents and pending approvals; your other subagents keep running. Safe to call twice; the subagent stops at its next step.', { callId }, ['callId']),
  spec('subagent_publish', 'Leave a named handoff for the agent that started you and for sibling subagents: a summary plus project-relative file paths, not file contents. It lasts for the current turn; a name cannot be reused. Members of another group cannot read it.', {
    name: { type: 'string', maxLength: 80, description: 'Immutable artifact name: ' + keyDesc },
    summary: { type: 'string', maxLength: 8192, description: 'What you found or did (max 8192 chars).' },
    files: { type: 'array', maxItems: 20, items: { type: 'string', maxLength: 512 }, description: 'Optional project-relative paths (no leading /, \\, or ..).' }
  }, ['name', 'summary']),
  spec('subagent_read', 'Read a handoff published with subagent_publish by a sibling or by one of your subagents: its summary and file paths. Read the files themselves with read_file, under the normal permissions.', {
    name: { type: 'string', maxLength: 80, description: 'Handoff name; omit to list every handoff you can read.' }
  })
];

// One instance per parent invocation; never a process-global chat scratchpad.
class Scope {
  constructor(projectDir, chatId, signal, limits = {}, parentScope = null, owner = null) {
    this.parentScope = parentScope;
    this.owner = owner;
    this.root = parentScope?.root || this;
    if (!parentScope) {
      this.allRuns = new Map(); this.scopes = new Set(); this.escalations = []; this.publicationCount = 0;
      this.limits = {};
      for (const name of Object.keys(DEFAULT_LIMITS)) {
        const value = limits[name] ?? DEFAULT_LIMITS[name];
        if (!validLimit(name, value)) throw error('EBADINPUT', name + ' must be a whole number of at least ' + LIMIT_RANGES[name].min);
        this.limits[name] = value;
      }
    }
    this.root.scopes.add(this);
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
    if (this.owner && !this.parentScope.accepts(this.owner)) throw error('EABORTED', 'local parent is no longer active');
    const depth = (this.owner?.depth || 0) + 1;
    // Depth cap: the deepest level a run below this parent may reach. The
    // root's comes from subagentLimits.maxDepth; an agent with maxNesting
    // sets its own (depth + maxNesting) for its subtree, never deeper than an
    // ancestor agent's explicit cap or the total (subagentLimits.maxDepth).
    const parentCap = this.owner ? this.owner.depthCap : this.root.limits.maxDepth;
    if (depth > parentCap) throw error('EDEPTH', this.owner ? 'this subagent cannot start subagents (nesting limit reached)' : 'root delegation depth budget exhausted');
    if (this.root.allRuns.size >= this.root.limits.maxRuns) throw error('ETOOL_CAP', 'root total-run budget exhausted');
    // An ancestor agent's own maxRuns bounds every run started below it.
    for (let r = this.owner; r; r = r.scope.owner) {
      if (r.runsCap !== undefined && r.subRuns >= r.runsCap) throw error('ETOOL_CAP', 'run budget of agent ' + (r.agent || 'default') + ' exhausted');
    }
    if (this.root.allRuns.has(id)) throw error('EBADINPUT', 'duplicate rooted callId');
    if (this.runs.has(id)) throw error('EBADINPUT', 'duplicate delegation callId');
    const pair = this.groups.validateLaunch(meta);
    const row = { callId: id, author: randomUUID().replace(/-/g, '').slice(0, 12), agent: agent || null, state: 'running', startedAt: Date.now(),
      controller: new AbortController(), lines: [], cursor: 0, inbox: [], receipts: [], published: [], workspace: meta.workspace || this.projectDir };
      row.depth = depth; row.parentCallId = this.owner?.callId || null;
      const parentExplicit = this.owner ? this.owner.explicitCap : null;
      const own = meta.agentLimits || {};
      row.runsCap = Number.isInteger(own.maxRuns) ? own.maxRuns : undefined; row.subRuns = 0;
      for (let r = this.owner; r; r = r.scope.owner) r.subRuns++;
      if (Number.isInteger(own.maxNesting)) {
        row.depthCap = Math.min(depth + own.maxNesting, parentExplicit ?? Infinity, this.root.limits.maxDepth);
        row.explicitCap = row.depthCap;
      } else {
        row.depthCap = parentCap;
        row.explicitCap = parentExplicit;
      }
      row.rootId = this.root.rootId || (this.root.rootId = randomUUID());
      row.scope = this; this.root.allRuns.set(id, row);
      row.complete = complete;
      row.onEnd = meta.onEnd || null;
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
    }).then(async (exec) => {
    if (row.childScope) await row.childScope.finish();
    if (row.finalized) return row.exec;
    // A finished run waits for its subagent.end hooks, so what they add arrives
    // with the result and its state stays "running" until then. A cancelled one
    // does not wait: its turn is ending. Shutdown may finalize the row meanwhile.
    const stateNow = this.settledState(row, exec);
    const ending = this.fireEnd(row, exec, stateNow);
    const end = stateNow === 'cancelled' ? null : await ending;
    if (row.finalized) return row.exec;
    row.finalized = true;
    row.exec = exec;
      row.finishedAt = Date.now();
      row.state = this.settledState(row, exec);
      this.groups.settle(row, row.state);
      this.undelivered(row);
      row.modelId = exec.result?.model?.id || row.modelId || null;
      exec.result = Object.assign({}, exec.result, { rootId: row.rootId, parentCallId: row.parentCallId, depth: row.depth, callId: id, state: row.state, groupId: row.groupId || null, memberId: row.memberId || null, published: row.published.slice() });
      exec.content = JSON.stringify(exec.result);
      if (end) exec.subagentEnd = end;
      complete(exec);
      return exec;
    });
    return row;
  }
  settledState(row, exec) {
    const member = row.groupId && this.groups.member(row.groupId, row.memberId).member;
    return member?.state === 'blocked' ? 'blocked' : row.controller.signal.aborted ? 'cancelled' : exec.ok ? 'completed' : 'failed';
  }
  // Tell subagent.end hooks, once per run. Never rejects.
  fireEnd(row, exec, state) {
    if (!row.onEnd || row.endFired) return Promise.resolve(null);
    row.endFired = true;
    return Promise.resolve().then(() => row.onEnd(row, exec, state)).catch(() => null);
  }
  get(id) {
    const row = this.runs.get(id);
    if (!row) {
    let ancestor = this.owner;
    while (ancestor) {
      if (ancestor.callId === id) throw error('EDEADLOCK', 'self/ancestor handles cannot be controlled or waited on');
      ancestor = ancestor.scope.owner;
    }
    throw error('EUNKNOWN_CALL', 'unknown callId in this local parent scope');
    }
    return row;
  }
  stop(row) {
    const alreadyFinished = ['completed', 'failed', 'cancelled', 'blocked'].includes(row.state);
    if (!alreadyFinished) { row.state = 'stopping'; row.controller.abort(); this.groups.settle(row, 'cancelled'); this.undelivered(row); }
    if (row.childScope) row.childScope.abort();
    return { callId: row.callId, state: row.state, alreadyFinished };
  }
  validateControl(name, args, author) {
    if (this.closed || this.root.closed || this.signal?.aborted) throw error('EABORTED', 'scope ended');
    if (author && author !== this.owner?.author) throw error('EPARENT_ONLY', 'only the local parent controls children');
    if (['subagent_stop', 'subagent_messages', 'subagent_send'].includes(name) || name === 'subagent_status' && args.callId) this.get(args.callId);
    if (name === 'subagent_group_update' && !this.groups.rows.has(args.groupId)) {
      const escalation = this.root.escalations.find((e) => e.groupId === args.groupId && e.name === args.name && this.isAncestorOf(e.scope));
      if (args.action !== 'arbitrate' || !escalation) throw error('EPARENT_ONLY', 'group is outside the local parent scope');
    }
  }
  isAncestorOf(scope) {
    for (let s = scope; s; s = s.parentScope) if (s === this) return true;
    return false;
  }
  listEscalations() {
    return this.root.escalations.filter((e) => this.isAncestorOf(e.scope)).map((e) => ({ groupId: e.groupId, name: e.name, summary: e.summary, sourceCallId: e.sourceCallId, state: e.store.rows.get(e.groupId)?.conflicts.get(e.name)?.state || 'expired' }));
  }
  child(row) {
    if (!this.accepts(row)) throw error('EABORTED', 'local parent is no longer active');
    return row.childScope || (row.childScope = new Scope(this.projectDir, this.chatId, row.controller.signal, {}, this, row));
  }
  // acquire(signal) -> release(). Subagent model requests are not limited in
  // number: this only refuses a request whose run or scope already ended.
  async acquire(signal) {
    if (signal?.aborted || this.closed || this.root.closed) throw error('EABORTED', 'run cancelled before provider dispatch');
    return () => {};
  }
  event(row, kind, data) {
    if (!this.accepts(row)) return;
    // Never copy reasoning, tools, shell output, pixels or file bodies into
    // the polling channel. As with ordinary model answers, prose is not a
    // security boundary for model-repeated secrets.
    const text = kind === 'message' ? data?.delta : kind === 'progress_update' ? data?.message || data?.title : null;
    if (typeof text !== 'string' || !text) return;
    if (kind === 'message') {
      const parts = text.split('\n');
      for (let i = 0; i < parts.length; i++) {
        const chunk = parts[i];
        const prev = row.lines.at(-1);
        if (i === 0 && prev && prev.kind === 'message' && !prev.newline && prev.text.length < 2048) {
          prev.text = (prev.text + chunk).slice(0, 2048);
          prev.cursor = ++row.cursor;
          if (parts.length > 1) prev.newline = true;
        } else if (chunk || i < parts.length - 1) {
          row.lines.push({ cursor: ++row.cursor, kind, text: chunk.slice(0, 2048), ...(i < parts.length - 1 ? { newline: true } : {}) });
          if (row.lines.length > 128) row.lines.shift();
        }
      }
      return;
    }
    row.lines.push({ cursor: ++row.cursor, kind, text: text.slice(0, 2048) });
    if (row.lines.length > 128) row.lines.shift();
  }
  drain(author) {
    const row = [...this.runs.values()].find((r) => r.author === author);
    if (!row || !this.accepts(row)) return [];
    return row.inbox.splice(0).map((receipt) => { receipt.state = 'delivered'; return receipt.message; });
  }
  accepts(row) { return !this.closed && !this.root.closed && !this.signal?.aborted && !row.finalized && !row.controller.signal.aborted; }
  undelivered(row) {
    for (const receipt of row.inbox.splice(0)) receipt.state = 'undelivered';
  }
  status(row) {
    return { callId: row.callId, agent: row.agent, modelId: row.modelId || null, state: row.groupId && this.groups.member(row.groupId, row.memberId).member.state === 'blocked' ? 'blocked' : row.state,
      rootId: row.rootId, parentCallId: row.parentCallId, depth: row.depth,
      groupId: row.groupId || null, memberId: row.memberId || null, workspace: row.workspace,
      startedAt: row.startedAt, elapsedMs: (row.finishedAt || Date.now()) - row.startedAt,
      lastLine: row.lines.at(-1)?.text || '', published: row.published.slice(),
      ...(row.exec ? { ok: row.exec.ok, text: String(row.exec.result?.text || '').slice(0, 16384), error: row.exec.result?.error } : {}),
      ...(row.exec?.subagentEnd?.context ? { hookContext: row.exec.subagentEnd.context } : {}) };
  }
  dispatch(name, args, author, workspace) {
    if (this.closed || this.signal?.aborted) throw error('EABORTED', 'parent turn has ended');
    const localParent = !!this.owner && author === this.owner.author;
    const child = localParent ? this.owner : author && [...this.runs.values()].find((r) => r.author === author);
    if (author && (!child || !(localParent ? this.parentScope.accepts(child) : this.accepts(child)))) throw error('EABORTED', 'child is no longer active');
    if (PARENT_TOOLS.includes(name) && author && !localParent) throw error('EPARENT_ONLY', 'only the local parent can control its children');
    const toolSpec = SPECS.find((s) => s.function.name === name)?.function.parameters;
    if (!toolSpec || !args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).some((k) => !Object.hasOwn(toolSpec.properties, k)) || toolSpec.required.some((k) => args[k] === undefined)) throw error('EBADINPUT', 'invalid tool arguments');
    if (['subagent_status', 'subagent_messages', 'subagent_group_status', 'subagent_read'].includes(name) && ++this.root.observations > 256) throw error('EPOLL_LIMIT', 'observation budget exhausted; stop polling this turn');
    if (name.startsWith('subagent_group') || ['subagent_decision', 'subagent_conflict'].includes(name)) {
      if (name === 'subagent_group_create') {
      if ([...this.root.scopes].reduce((n, s) => n + s.groups.rows.size, 0) >= 8) throw error('ETOOL_CAP', 'root group budget exhausted');
      return this.groups.create(args);
      }
      const inherited = child?.groupId && (!args.groupId || args.groupId === child.groupId);
      const store = inherited ? child.scope.groups : this.groups;
      if (child && !localParent && !inherited) throw error('EPARENT_ONLY', 'children can access only their own group');
      const targetGroupId = args.groupId || (inherited ? child.groupId : undefined);
      if (name === 'subagent_group_status') {
      if (targetGroupId) return store.status(store.get(targetGroupId));
      return { groups: [...this.groups.rows.values()].map((g) => this.groups.status(g)), escalations: this.listEscalations() };
      }
      if (name === 'subagent_decision') return store.propose({ ...args, groupId: targetGroupId }, child);
      if (name === 'subagent_conflict') {
      if (this.root.escalations.length >= 64) throw error('ETOOL_CAP', 'root conflict escalation budget exhausted');
      const conflict = store.conflict({ ...args, groupId: targetGroupId }, child);
      this.root.escalations.push({ groupId: targetGroupId, name: conflict.name, summary: conflict.summary, sourceCallId: child?.callId || this.owner?.callId || null, store, scope: inherited ? child.scope : this });
      return conflict;
      }
      if (name === 'subagent_group_update' && !this.groups.rows.has(args.groupId)) {
      const escalation = this.root.escalations.find((e) => e.groupId === args.groupId && e.name === args.name && this.isAncestorOf(e.scope));
      if (args.action !== 'arbitrate' || !escalation) throw error('EPARENT_ONLY', 'only the owning parent controls group contracts; ancestors arbitrate escalated conflicts');
      const result = escalation.store.update(args);
      return { groupId: result.groupId, conflict: result.conflicts.find((c) => c.name === args.name) };
      }
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
    if (name === 'subagent_status') return args.callId ? this.status(this.get(args.callId)) : { runs: [...this.runs.values()].map((r) => this.status(r)), limits: { ...this.root.limits }, escalations: this.listEscalations() };
    if (name === 'subagent_stop') return this.stop(this.get(args.callId));
    if (name === 'subagent_messages') {
    const row = this.get(args.callId);
    const since = args.since ?? 0;
    const limit = args.limit ?? 20;
    if (!Number.isInteger(since) || since < 0 || !Number.isInteger(limit) || limit < 1 || limit > 50) throw error('EBADINPUT', 'invalid cursor or limit');
    const lines = row.lines.filter((line) => line.cursor > since).slice(0, limit).map(({ cursor, kind, text }) => ({ cursor, kind, text }));
    return { callId: row.callId, state: row.state, lines, nextCursor: lines.at(-1)?.cursor ?? since,
      truncated: since < (row.lines[0]?.cursor || 1) - 1, deliveries: row.receipts.map(({ messageId, state }) => ({ messageId, state })) };
    }
    const bus = localParent ? this.parentScope : this;
    const accessible = (item) => !child || !item.groupId || item.groupId === child.groupId;
    const readable = localParent ? [...this.publications.values(), ...bus.publications.values()].filter((item) => this.publications.get(item.name) === item || accessible(item)) : [...bus.publications.values()].filter(accessible);
    if (name === 'subagent_read' && args.name === undefined) return { artifacts: readable.map((item) => ({ ...item, files: item.files.slice() })) };
    const key = args.name;
    if (typeof key !== 'string' || !/^[a-zA-Z0-9_.-]{1,80}$/.test(key)) throw error('EBADINPUT', 'name must be 1–80 letters, digits, dots, underscores or hyphens');
    if (name === 'subagent_read') {
      const item = readable.find((item) => item.name === key);
      if (!item) throw error('EUNKNOWN_PUBLICATION', 'handoff not published in this scope');
      return { ...item, files: item.files.slice() };
    }
    if (name !== 'subagent_publish') throw error('EUNKNOWN_TOOL', 'unknown orchestration tool');
    if (bus.publications.has(key)) throw error('EEXISTS', 'handoff names are immutable; choose a new name');
    if (this.root.publicationCount >= 64) throw error('ETOOL_CAP', 'handoff store is full');
    if (typeof args.summary !== 'string' || !args.summary.trim() || args.summary.length > 8192) throw error('EBADINPUT', 'summary must contain 1–8192 characters');
    const files = args.files ?? [];
    if (!Array.isArray(files) || files.length > 20 || files.some((file) => typeof file !== 'string' || !file || file.length > 512 || file.startsWith('/') || file.includes('\\') || file.split('/').includes('..'))) throw error('EBADINPUT', 'files must be bounded project-relative references');
    const row = localParent ? this.owner : child;
    if (author && !row) throw error('EUNKNOWN_CALL', 'unknown publisher');
    if (row && workspace) {
      row.workspace = workspace;
      if (row.groupId) row.scope.groups.member(row.groupId, row.memberId).member.actualWorkspace = workspace;
    }
    const item = { name: key, summary: args.summary, files: files.slice(), author: row ? row.callId : 'parent', groupId: row?.groupId || null, memberId: row?.memberId || null, workspace: row?.workspace || this.projectDir };
    if (row?.groupId) row.scope.groups.get(row.groupId).artifacts.push(key);
    this.root.publicationCount++;
    bus.publications.set(key, item);
    if (row) row.published.push(key);
    return { ...item, files: item.files.slice() };
  }
  async finish() {
    if (this.closing) return this.closing;
    this.closed = true;
    this.abort();
    const children = [...this.runs.values()].filter((r) => r.childScope).map((r) => r.childScope.finish());
    this.groups.close();
    let timer;
    this.closing = Promise.race([
    Promise.allSettled([...children, ...[...this.runs.values()].map((r) => r.promise)]),
    new Promise((resolve) => { timer = setTimeout(resolve, 1000); })
    ]).then(() => {
    clearTimeout(timer);
    for (const row of (this.parentScope ? this.runs : this.allRuns).values()) if (!row.finalized) {
      row.finalized = true; row.state = 'cancelled'; this.undelivered(row);
      const result = { callId: row.callId, rootId: row.rootId, parentCallId: row.parentCallId, depth: row.depth, state: 'cancelled', groupId: row.groupId || null, memberId: row.memberId || null, published: row.published.slice(), error: { code: 'ESHUTDOWN_TIMEOUT', message: 'child did not settle within shutdown budget' } };
      row.exec = { ok: false, result, content: JSON.stringify(result) };
      this.fireEnd(row, row.exec, 'cancelled');
      row.complete(row.exec);
    }
    if (this.signal) this.signal.removeEventListener('abort', this.abort);
    this.publications.clear();
    this.runs.clear();
    // Retain escalated conflict metadata until root settlement, never run handles.
    if (!this.parentScope) {
    for (const scope of this.scopes) scope.groups.rows.clear();
    this.allRuns.clear(); this.escalations.length = 0;
    }
    if (!this.parentScope) this.root.scopes.clear();
    });
    return this.closing;
  }
}

module.exports = { Scope, SPECS, DEFAULT_LIMITS, LIMIT_RANGES, resolveLimits, TOOL_NAMES, FAMILY_NAMES, PARENT_TOOLS, SIBLING_TOOLS };
