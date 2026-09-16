'use strict';

// Streaming core for the AI client.
//
// Owns the multi-turn tool loop (streamChat), the single tool-call
// runner (runSingleToolCall), and the byte-stream helpers shared with
// the provider parsers (readSSE / parseSSEFrame / readNDJSON).
// Provider definitions, request builders and event parsers live in
// src/ai-endpoints.js; the public facade is src/ai.js.

const { endpointFor, requireApiKey, BUILDERS, PARSERS, parseMiniMaxTextToolCalls } = require('./ai-endpoints.js');
const { projectModelRecord } = require('./util.js');
const toolFeedback = require('./toolFeedback.js');
const usageMetrics = require('./usage.js');

// ---- Streaming core ----------------------------------------------------

// Walks an SSE byte stream and yields {eventName, data} pairs.
// `stream` is a ReadableStream<Uint8Array> from fetch().
async function* readSSE(stream) {
  const decoder = new TextDecoder('utf-8');
  let buf = '';
  // SSE frames are separated by a blank line. The spec allows LF, CRLF,
  // and bare CR as line endings, and all three occur in the wild: Azure
  // OpenAI, Ollama's OpenAI-compatible mode, and many gateways emit CRLF,
  // and an old-style proxy can emit CR-only. Splitting on `\n\n` alone
  // would glue such frames into one giant frame with literal `\r` inside
  // the JSON, so every chunk would fail JSON.parse and stream as
  // `passthrough` (no visible text). The separator pattern below matches
  // all three (CRLF first, so it is never read as two CR/LF breaks), and
  // each frame's line endings are normalized to LF so parseSSEFrame's
  // `\n`-based field splitting sees a clean frame.
  const FRAME_SEP = /(?:\r\n|\r|\n){2}/;
  for await (const chunk of stream) {
    buf += decoder.decode(chunk, { stream: true });
    let idx;
    while ((idx = buf.search(FRAME_SEP)) !== -1) {
      const frame = buf.slice(0, idx).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
      // Consume the separator (2 or 4 chars: "\n\n" / "\r\n\r\n" / "\r\r")
      // — a plain slice by fixed length would leave a stray "\r" behind.
      const sep = buf.slice(idx, idx + 4).match(FRAME_SEP)[0];
      buf = buf.slice(idx + sep.length);
      const ev = parseSSEFrame(frame);
      if (ev) yield ev;
    }
  }
  // Tail without trailing blank line.
  if (buf.trim()) {
    const ev = parseSSEFrame(buf);
    if (ev) yield ev;
  }
}

function parseSSEFrame(frame) {
  let eventName = 'message';
  const dataLines = [];
  for (const line of frame.split('\n')) {
    if (!line) continue;
    if (line.startsWith(':')) continue; // comment / heartbeat
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const field = line.slice(0, colon);
    let value = line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') eventName = value;
    else if (field === 'data') dataLines.push(value);
  }
  // No data lines -> comment-only / heartbeat / empty frame; skip.
  if (!dataLines.length) return null;
  return { eventName, data: dataLines.join('\n') };
}

// Walks an NDJSON byte stream and yields one parsed object per line.
async function* readNDJSON(stream) {
  const decoder = new TextDecoder('utf-8');
  let buf = '';
  for await (const chunk of stream) {
    buf += decoder.decode(chunk, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      try { yield JSON.parse(line); }
      catch { /* ignore malformed line, upstream is responsible */ }
    }
  }
  if (buf.trim()) {
    try { yield JSON.parse(buf); } catch { /* ignore */ }
  }
}

// ---- Single tool-call runner ---------------------------------------------
// Executes one tool call through the full native pipeline — circuit
// breaker, authorization gate, dispatch — emitting tool_call/tool_result
// events and appending the `tool` message to `cx.convo` (when provided).
// Shared by the streamChat tool loop and by POST /api/tools/subagent
// (direct @agent dispatch from the composer).
//
// cx = {
//   opts, onEvent, convo,               // streamChat closure (convo optional)
//   toolSpecs, promptProfilesMod, discoveredToolNames,
//   modelContentForTool,                // (name, exec) -> string
//   dispatchTool, firstStringArgument, toolResultImageParts, // helpers
//   getLastToolCallKey/setLastToolCallKey,
//   getRepeatedToolCallCount/setRepeatedToolCallCount, REPEATED_TOOL_CALL_LIMIT
// }
async function runSingleToolCall(c, cx) {
  const { opts, onEvent, convo, toolSpecs, promptProfilesMod, discoveredToolNames, modelContentForTool } = cx;
  const dispatchTool = cx.dispatchTool;
  const firstStringArgument = cx.firstStringArgument;
  const toolResultImageParts = cx.toolResultImageParts;
  let args = {};
  if (c.arguments) {
    try { args = JSON.parse(c.arguments); }
    catch { args = { __raw: c.arguments }; }
  }
  let exec;
  let callEmitted = false;
  // Captured when the authorization gate resolves a prompt for an
  // `ask_user` call. The runner reads it to fold the user's
  // structured answer into the `tool` message it returns.
  let callOptsAnswerPayload = null;
  // Captured when the authorization gate resolves a prompt for a
  // `subagent` call whose card carried a user-picked model. The
  // payload is { modelOverride: { providerId, modelId } }; the
  // subagent dispatcher resolves it to a hydrated model so the
  // delegated run executes on the chosen model for this call only.
  let callOptsModelOverride = null;
  // Captured from the same authorization payload: a per-run thinking
  // level the user picked on the approval card (this call only).
  let callOptsThinkingLevel = null;
  const pushToolMessage = (name, content) => {
    if (convo) convo.push({ role: 'tool', tool_call_id: c.id || undefined, name, content });
  };
  // Identical-call circuit breaker. A model retrying the exact same
  // call with the exact same arguments (typically after a tool
  // error) never converges — enforce that the returned result is
  // identical, so nothing was learned from the retry. Refuse it
  // with an explanatory tool error so the model is forced to vary
  // the command or answer in plain text. Counts per consecutive
  // identical call; any different call resets the streak.
  const callKey = c.name + '\n' + (c.arguments || '');
  if (callKey === cx.getLastToolCallKey()) {
    cx.setRepeatedToolCallCount(cx.getRepeatedToolCallCount() + 1);
  } else {
    cx.setLastToolCallKey(callKey);
    cx.setRepeatedToolCallCount(0);
  }
  const loopLimit = typeof cx.REPEATED_TOOL_CALL_LIMIT === 'number' ? cx.REPEATED_TOOL_CALL_LIMIT : 3;
  if (cx.getRepeatedToolCallCount() >= loopLimit) {
    const r = {
      error: {
        code: 'ELOOP',
        message: 'You have called ' + c.name + ' with identical arguments ' + (cx.getRepeatedToolCallCount() + 1) + ' times in a row with identical results. The call was refused. Do not retry it — change the command/arguments or answer the user in plain text instead.'
      }
    };
    exec = { ok: false, content: JSON.stringify(r), result: r };
    onEvent('tool_call', { id: c.id || null, name: c.name, args });
    callEmitted = true;
    onEvent('tool_result', { id: c.id || null, name: c.name, ok: false, result: exec.result });
    pushToolMessage(c.name, modelContentForTool(c.name, exec));
    return exec;
  }
  try {
    // list_features is a read-only metadata tool that bypasses
    // the authorization gate — it only returns feature state.
    if (c.name === 'list_features') {
      let af;
      try { af = require('./agentFeatures.js'); }
      catch (e) {
        exec = { ok: false, content: JSON.stringify({ error: { code: 'EMODULE', message: 'agentFeatures module unavailable: ' + (e.message || e) } }), result: { error: { code: 'EMODULE' } } };
      }
      if (!exec) {
        exec = await af.dispatchListFeatures(args, Object.assign({}, opts, { callId: c.id || null }));
      }
      onEvent('tool_call', { id: c.id || null, name: c.name, args });
      callEmitted = true;
    } else if (c.name === 'activate_skill') {
      // Activation is a read-only lookup constrained to the enum of enabled,
      // project-contained skills, so it does not require a separate approval.
      onEvent('tool_call', { id: c.id || null, name: c.name, args });
      callEmitted = true;
      exec = await dispatchTool(c.name, args, Object.assign({}, opts, { callId: c.id || null }));
    } else if (c.name === 'report_progress') {
      // report_progress is a read-only UI/update tool. It honors
      // the project `off` visibility gate, but does not show an
      // interactive authorization prompt because progress updates
      // do not read or modify project resources.
      try {
        const authGate = require('./tools/authorization.js');
        const cfg = authGate.effectiveConfig(opts && opts.projectDir, c.name, opts && opts.chatId);
        if (cfg && cfg.mode === 'off') {
          exec = { ok: false, content: JSON.stringify({ ok: false, code: 'ETOOL_DISABLED', reason: 'tool is disabled' }), result: { ok: false, code: 'ETOOL_DISABLED', reason: 'tool is disabled' } };
        }
      } catch { /* unreadable authorization state: keep compatibility path */ }
      // Emit the running card before dispatch so the subsequent
      // progress_update can attach to the same call id.
      onEvent('tool_call', { id: c.id || null, name: c.name, args });
      callEmitted = true;
      if (!exec) exec = await dispatchTool(c.name, args, Object.assign({}, opts, { callId: c.id || null }));
    } else if (promptProfilesMod && c.name === promptProfilesMod.DISCOVER_TOOL_NAME) {
      const requested = args && (args.toolName || args.name || args.tool);
      const spec = (toolSpecs || []).find(s => s && s.function && s.function.name === requested);
      if (!spec) {
        exec = {
          ok: false,
          content: JSON.stringify({ error: { code: 'EUNKNOWN_TOOL', message: 'Unknown tool: ' + requested } }),
          result: { error: { code: 'EUNKNOWN_TOOL', message: 'Unknown tool: ' + requested } }
        };
      } else {
        if (discoveredToolNames) discoveredToolNames.add(requested);
        const fn = spec.function || {};
        exec = {
          ok: true,
          content: JSON.stringify({ name: fn.name, description: fn.description, parameters: fn.parameters }),
          result: { name: fn.name, description: fn.description, parameters: fn.parameters }
        };
      }
      onEvent('tool_call', { id: c.id || null, name: c.name, args });
      callEmitted = true;
    } else {
      const authGate = require('./tools/authorization.js');
      // The summary shown on the "Authorization required" card and
      // matched against the file-tool allowlist needs the right
      // argument per tool family. For shell it's the command; for
      // the file tools it's the path (with the optional query /
      // content as a hint, when relevant).
      let summary;
      if (c.name === 'shell') summary = (args && args.cmd) || '';
      else if (c.name === 'subagent') summary = (args && args.task) || '';
      else if (c.name === 'image_gen') summary = (args && args.prompt) || '';
      else if (c.name === 'webpreview') {
        // Show the URL the model wants to open so the user can tell
        // at a glance which site it'll preview — beats the generic
        // first-arg fallback because every webpreview call has a
        // `url` argument anyway.
        summary = (args && args.url) || '';
      }
      else if (c.name === 'read_file' || c.name === 'list_files' || c.name === 'search_files' || c.name === 'write_file' || c.name === 'edit_file') {
        summary = (args && (args.path || args.file)) || (args && args.query) || '';
      } else if (String(c.name).startsWith('mcp__')) {
        // MCP allowlists (shared or per-server/per-tool) match
        // against "<composedName> <firstStringArg>" so a pattern
        // can pin either the tool itself (^mcp__fs__read_file$)
        // or the resource it touches (^mcp__fs__read_file src/).
        const first = firstStringArgument(args);
        summary = first ? (c.name + ' ' + first) : c.name;
      } else {
        summary = firstStringArgument(args);
      }
      const authResult = await authGate.authorize({
        projectDir: opts && opts.projectDir,
        chatId: opts && opts.chatId,
        tool: c.name,
        callId: c.id,
        cmd: args && args.cmd,
        path: args && args.path,
        query: args && args.query,
        summary,
        timeoutMs: args && args.timeoutMs,
        args
      });
      // The gate returns the timeout it resolved against the project's
      // `defaultTimeoutMs` / `maxTimeoutMs`. That value — never the raw
      // model-supplied one — is what the runner must use and what the
      // approval card must show: the model cannot raise its own ceiling
      // by asking for a longer timeout.
      const clampedTimeoutMs = Number.isFinite(authResult && authResult.timeoutMs)
        ? authResult.timeoutMs
        : (args && args.timeoutMs);

      // `ask_user` rides a separate UI card (question + options +
      // free-form "extra" textbox). The same authorization gate is
      // reused so the audit log, session grants, and `off` /
      // `allow-always` semantics work the same as for the other
      // tools. The dedicated `ask_user_required` event carries the
      // validated question payload so the chat UI can render the
      // right component without parsing `args` itself.
      let askUserPayload = null;
      if (c.name === 'ask_user') {
        try {
          const askMod = require('./tools/ask.js');
          askUserPayload = askMod.validateArgs(args);
        } catch (e) {
          // The model fed us a bad question (too many options,
          // duplicate value, missing label, ...). Surface the
          // validation error directly as a tool_result so the
          // model can self-correct on the next turn; do NOT block
          // the gate on a user prompt, because the bug is on the
          // model side, not the user side.
          const r = { error: { code: e.code || 'EBADINPUT', message: e.message } };
          exec = { ok: false, content: JSON.stringify(r), result: r };
          onEvent('tool_call', { id: c.id || null, name: c.name, args });
          callEmitted = true;
          onEvent('tool_result', { id: c.id || null, name: c.name, ok: false, result: exec.result });
          pushToolMessage(c.name, modelContentForTool(c.name, exec));
          return exec;
        }
      }

      if (authResult.decision === 'prompt') {
        if (c.name === 'ask_user' && askUserPayload) {
          onEvent('ask_user_required', {
            chatId: opts && opts.chatId,
            callId: c.id,
            tool: c.name,
            question: askUserPayload.question,
            options: askUserPayload.options,
            multiSelect: askUserPayload.multiSelect,
            presets: askUserPayload.presets,
            projectDir: opts && opts.projectDir
          });
        } else {
          onEvent('authorization_required', {
            chatId: opts && opts.chatId,
            callId: c.id,
            tool: c.name,
            cmd: args && args.cmd,
            path: args && args.path,
            query: args && args.query,
            summary,
            timeoutMs: clampedTimeoutMs,
            projectDir: opts && opts.projectDir
          });
        }
        // Capture the resolved value (allow, payload, ...) so the
        // `ask_user` runner can read the user's structured answer.
        // For every other tool the payload is undefined and the
        // runner ignores it.
        const authDecision = await authResult.wait;
        if (authDecision && authDecision.payload) {
          if (c.name === 'ask_user') {
            callOptsAnswerPayload = authDecision.payload;
          } else if (c.name === 'subagent') {
            if (authDecision.payload.modelOverride) {
              // The authorization card let the user pick a model for
              // this delegated run. Hand it to the subagent dispatcher,
              // which resolves it to a hydrated model and runs the
              // nested call on it (per-call override, never persisted).
              callOptsModelOverride = authDecision.payload.modelOverride;
            }
            if (typeof authDecision.payload.thinkingLevel === 'string') {
              // Per-run thinking level chosen on the same card.
              callOptsThinkingLevel = authDecision.payload.thinkingLevel;
            }
          }
        }
      }
      // Only announce a running tool after authorization has completed.
      // Previously the UI showed "tool call — running" while the server
      // was actually blocked waiting for an authorization decision. If the
      // authorization card was missed or the page reloaded, the transcript
      // appeared permanently stuck on a tool call with no messages.
      onEvent('tool_call', { id: c.id || null, name: c.name, args });
      callEmitted = true;
      exec = await dispatchTool(c.name, args, Object.assign({}, opts, { callId: c.id || null, toolTimeoutMs: clampedTimeoutMs, answerPayload: callOptsAnswerPayload, modelOverride: callOptsModelOverride, thinkingLevel: callOptsThinkingLevel }));
    }
  } catch (e) {
    // Denied/disabled/error calls still need a call card immediately
    // before their result so persisted history remains a valid pair.
    if (!callEmitted) onEvent('tool_call', { id: c.id || null, name: c.name, args });
    if (e.code === 'EDENIED') {
      // For `ask_user` we want the runner to produce a
      // `cancelled: true` result so the model can decide what to
      // do next (fall back to a free-form chat, stop, ask a
      // different question, ...). For every other tool a deny
      // stays a plain EDENIED stub.
      if (c.name === 'ask_user') {
        exec = await dispatchTool('ask_user', args, Object.assign({}, opts, { callId: c.id || null, answerPayload: { cancelled: true } }));
      } else {
        exec = { ok: false, content: JSON.stringify({ ok: false, code: 'EDENIED', reason: 'user denied' }), result: { ok: false, code: 'EDENIED', reason: 'user denied' } };
      }
    } else if (e.code === 'ETOOL_DISABLED') {
      exec = { ok: false, content: JSON.stringify({ ok: false, code: 'ETOOL_DISABLED', reason: 'tool is disabled' }), result: { ok: false, code: 'ETOOL_DISABLED', reason: 'tool is disabled' } };
    } else {
      exec = { ok: false, content: JSON.stringify({ ok: false, error: e.message }), result: { ok: false, error: e.message } };
    }
  }

  onEvent('tool_result', { id: c.id || null, name: c.name, ok: exec.ok, result: exec.result });

  pushToolMessage(c.name, modelContentForTool(c.name, exec));
  // webpreview screenshots are rendered for the user in the preview dock. The
  // model only receives the compact JSON result and can call the tool again to
  // reload the page; it does not receive or inspect the image bytes.
  const imageParts = c.name === 'webpreview' ? [] : toolResultImageParts(exec && exec.result);
  return { exec, imageParts };
}

// ---- OpenAI prompt-cache routing key ----------------------------------
// OpenAI-family endpoints cache prompt prefixes automatically, but they only
// serve a warm cache when consecutive requests of one conversation reach the
// same machine. `prompt_cache_key` is the documented routing hint for that.
//
// The key must be identical for every request of one chat — every tool round
// and every follow-up turn — and different between chats, which makes the
// chat id exactly the right source. A request with no chat (a one-shot
// /api/chat call) returns null, and the builder then omits the field: there
// is no conversation worth keeping warm. The builder decides which providers
// accept the field (see ai-endpoints.js → PROMPT_CACHE_KEY_PROVIDERS).
function promptCacheKeyFor(opts) {
  const chatId = opts && opts.chatId;
  if (!chatId) return null;
  const key = 'mouaif-' + String(chatId);
  // Defensive cap so a hand-set or future id shape can never produce an
  // oversized field. Truncation keeps the prefix, so distinct ids stay
  // distinct.
  return key.length > 64 ? key.slice(0, 64) : key;
}

async function streamChat(opts) {
  const { model, messages, signal, onEvent, onRoundUsage, onRoundCommit, thinkingLevel, maxOutputTokens } = opts || {};
  if (!model || !model.provider) {
    return { ok: false, error: { code: 'EBADMODEL', message: 'Missing model.provider' } };
  }
  if (!Array.isArray(messages) || !messages.length) {
    return { ok: false, error: { code: 'EBADINPUT', message: 'messages must be a non-empty array' } };
  }
  if (typeof onEvent !== 'function') {
    return { ok: false, error: { code: 'EBADINPUT', message: 'onEvent must be a function' } };
  }
  // Pass thinking level and max output tokens down to the request builders
  // so they can inject provider-specific fields (reasoning_effort, thinking
  // budget, max_completion_tokens, max_tokens, etc.).
  if (typeof thinkingLevel === 'string' && thinkingLevel) {
    model.thinkingLevel = thinkingLevel;
  }
  if (typeof maxOutputTokens === 'string' && maxOutputTokens) {
    model.maxOutputTokens = maxOutputTokens;
  }

  let def, build, parse;
  try {
    def = endpointFor(model);
    // requireApiKey is async on the OAuth path (proactive refresh);
    // sync-fast on the API-key path. We always `await` it here.
    await requireApiKey(model, def);
    build = BUILDERS[model.provider];
    parse = PARSERS[model.provider];
  } catch (e) {
    return { ok: false, error: { code: e.code || 'EBADMODEL', message: e.message } };
  }
  if (!build || !parse) {
    return { ok: false, error: { code: 'EUNKNOWN_PROVIDER', message: 'No builder/parser for ' + model.provider } };
  }

  // ---- Tool specs advertised to the model ----------------------------
  // Three sources feed the `tools` field of the outgoing request:
  //   1. The native `shell` tool (src/tools/shell.js), always present.
  //   2. The native `report_progress` tool (src/tools/progress.js), always present.
  //   3. The native `subagent` tool (src/tools/subagent.js), always present.
  //   4. The native `ask_user` tool (src/tools/ask.js), always present.
  //      Lets the model pause and ask the user a structured question
  //      with a list of options (2+, no cap). The user always has a
  //      free-form "extra" textbox alongside their pick, so the answer
  //      is never constrained to the offered options. See
  //      docs/features/ask-user-tool.md.
  //   5. The native file tools (read_file / list_files / search_files /
  //      write_file, src/tools/files.js), always present. Authorization
  //      decides whether a call prompts, runs, or is rejected. These cover
  //      "read this file / find where X is used / patch a small file"
  //      loop without requiring an MCP server.
  //   6. MCP-discovered tools (decision §18), which use the
  //      mcp__<serverSlug>__<toolName> name convention.
  // Tool calling and the multi-turn loop are wired for the OpenAI-
  // compatible tool shape (openai-compatible + github-copilot + openrouter)
  // and for Anthropic's native tool_use shape (buildAnthropicRequest
  // converts the specs and the parser emits tool_call_delta for tool_use
  // blocks). Other providers stream normally and never see a `tools`
  // field, so their happy path is unchanged.
  const toolSpecs = [];
  try { toolSpecs.push(require('./tools/shell.js').SPEC); }
  catch { /* shell tool module unavailable; skip */ }
  try { toolSpecs.push(require('./tools/progress.js').SPEC); }
  catch { /* progress tool module unavailable; skip */ }
  try {
    const sub = require('./tools/subagent.js');
    // Enumerate the project's agent names in the `agent` parameter
    // description so the model knows exactly what it can delegate to.
    let agentNames = [];
    try {
      if (opts && opts.projectDir) agentNames = require('./agents.js').list(opts.projectDir).map((a) => a.name);
    } catch { /* no agents */ }
    toolSpecs.push(sub.buildSpec ? sub.buildSpec(agentNames) : sub.SPEC);
  }
  catch { /* subagent tool module unavailable; skip */ }
  try { toolSpecs.push(require('./tools/ask.js').SPEC); }
  catch { /* ask_user tool module unavailable; skip */ }
  try { toolSpecs.push(require('./agentFeatures.js').LIST_FEATURES_SPEC); }
  catch { /* list_features tool module unavailable; skip */ }
  try { toolSpecs.push(require('./tools/task.js').SPEC); }
catch { /* task tool module unavailable; skip */ }
try { toolSpecs.push(require('./tools/restart.js').SPEC); }
catch { /* restart tool module unavailable; skip */ }
  // Native image generation tool: generate a picture with an image model,
  // save it as a project file, and attach the picture to the tool result
  // (so a subagent's generation is what the main agent receives). Off by
  // default; gated by the `image_gen` authorization mode.
  try {
    const img = require('./tools/image.js');
    let imageModels = [];
    try { if (opts && opts.projectDir) imageModels = img.imageModelRecords(opts.projectDir); }
    catch { /* no image models configured */ }
    toolSpecs.push(img.buildSpec ? img.buildSpec(imageModels) : img.SPEC);
  } catch { /* image tool module unavailable; skip */ }
try {
const skillSpec = require('./agentSkills.js').buildSpec(opts && opts.projectDir, opts && opts.chat);

    if (skillSpec) toolSpecs.push(skillSpec);
  } catch { /* skills unavailable; skip */ }
  try {
    const ft = require('./tools/files.js');
    for (const name of ft.FILE_TOOL_NAMES) toolSpecs.push(ft.SPECS[name]);
  } catch { /* file tools module unavailable; skip */ }
  // Native web-preview tool: opens a URL in the debug Chrome and
  // returns a small JPEG thumbnail. Same CDP bridge as the Inspector
  // tab, gated by the project-level `webpreview` authorization mode.
  try { toolSpecs.push(require('./tools/webpreview.js').SPEC); }
  catch { /* webpreview module unavailable; skip */ }
  try {
    if (opts && opts.projectDir) {
      const mcpMod = require('./mcp.js');
      const specs = mcpMod.listComposedToolSpecs(opts.projectDir);
      if (specs && specs.length) {
        for (const s of specs) {
          toolSpecs.push({
            type: 'function',
            function: { name: s.name, description: s.description, parameters: s.parameters }
          });
        }
      }
    }
  } catch { /* mcp module not loaded or project dir invalid; fall through without MCP tools */ }

  // Tools in `off` authorization mode are dropped from the advertised
  // set: a hidden tool costs zero prompt tokens and the model cannot
  // waste turns calling something that would fail with ETOOL_DISABLED.
  // authorize() still rejects `off` calls at execution time as
  // defense-in-depth (e.g. a hand-crafted REST call or a stale spec
  // name kept in a chat's tool filter). File tools resolve through
  // their `file` family name; MCP tools resolve per tool / per server
  // through the layered .mcp.json authorization block.
  try {
    if (opts && opts.projectDir) {
      const authz = require('./tools/authorization.js');
      const authState = authz.getAuthorization(opts.projectDir, opts && opts.chatId);
      for (const family of ['shell', 'subagent', 'file', 'ask_user', 'report_progress', 'task', 'webpreview', 'restart_app', 'image_gen']) {
        const cfg = authState.tools[family];
        if (cfg && cfg.mode === 'off') {
          const hidden = family === 'file' ? authz.FILE_TOOL_NAMES : new Set([family]);
          for (let i = toolSpecs.length - 1; i >= 0; i--) {
            const spec = toolSpecs[i];
            if (spec && spec.function && hidden.has(spec.function.name)) toolSpecs.splice(i, 1);
          }
        }
      }
      // Per-leaf file overrides: a single file operation can carry its
      // own `off` (e.g. tools.read_file.mode = "off") while the `file`
      // family stays enabled. The family loop above only fires when the
      // family itself is `off`, so resolve each file-tool spec through
      // effectiveConfig to honor the leaf. Without this the leaf was
      // still advertised even though the execution gate rejects it with
      // ETOOL_DISABLED — the model paid tokens for a tool it could never
      // use. A family-level `off` still hides every leaf (the loop above
      // runs first and drops them all).
      for (let i = toolSpecs.length - 1; i >= 0; i--) {
      const spec = toolSpecs[i];
      if (!spec || !spec.function || !authz.FILE_TOOL_NAMES.has(spec.function.name)) continue;
      const cfg = authz.effectiveConfig(opts.projectDir, spec.function.name, opts && opts.chatId);
      if (cfg && cfg.mode === 'off') toolSpecs.splice(i, 1);
      }
      // MCP tools resolve through the layered gate (per-tool →
      // per-server → shared, see authorization.mcpLayeredConfig): an
      // `off` at any level hides exactly the mcp__<slug>__<tool> specs
      // it covers — one server, or one tool — at zero prompt-token
      // cost. Execution still rejects forged calls with ETOOL_DISABLED
      // through authorize().
      for (let i = toolSpecs.length - 1; i >= 0; i--) {
      const spec = toolSpecs[i];
      if (!spec || !spec.function || !String(spec.function.name).startsWith('mcp__')) continue;
      const cfg = authz.effectiveConfig(opts.projectDir, spec.function.name, opts && opts.chatId);
      if (cfg && cfg.mode === 'off') toolSpecs.splice(i, 1);
      }
    }
  } catch { /* authorization state unreadable; keep every tool advertised */ }

  // Per-chat tool filter. opts.enabledTools === null / undefined:
  //   legacy behavior — every collected spec is advertised. An array
  //   (even empty): restrict to those names exactly. Unknown names
  //   are dropped silently so a stale chat (a tool that was renamed
  //   or whose MCP server was stopped) does not fail the request.
  //   The array is captured here once — the chat UI persists the
  //   same set on the chat record, so we don't need to re-read it.
  let visibleToolSpecs = toolSpecs;
  if (opts && Array.isArray(opts.enabledTools)) {
    const allow = new Set(opts.enabledTools.map((n) => String(n)));
    visibleToolSpecs = toolSpecs.filter((s) => s && s.function && allow.has(s.function.name));
  }

  // Shrink the tool declaration according to the active prompt-size
  // profile (decisions §4). For very-small, the list is compact (name +
  // description, no schemas) but FIXED for the whole turn — it must not
  // grow between tool-loop requests, because Anthropic's cached prefix
  // (system + tools) would change and the warm cache would be
  // invalidated on every round. average/extensive send the full specs
  // from the start. `discoveredToolNames` is retained for the
  // discover_tool dispatcher (it decides what the tool returns), but it
  // no longer changes the advertised tool list.
  const discoveredToolNames = new Set();
  let promptProfilesMod = null;
  try { promptProfilesMod = require('./promptProfiles.js'); } catch { /* optional */ }

  // The multi-turn tool loop. `convo` is the working message array; it
  // grows by one assistant (tool-call) message + N tool-result messages
  // each iteration the model asks for tools. The model decides when its
  // task is complete; tool use is not cut off after an arbitrary count.
  const convo = messages.slice();
  const usage = { promptTokens: 0, completionTokens: 0 };
  // Anthropic prompt-cache totals across all tool rounds in this turn.
  // Filled by commitRoundUsage() from the per-round trackers; folded into
  // the final `done` usage block so the server and chat UI can price the
  // cached tokens at the discounted rate.
  const usageCache = { readTokens: 0, creationTokens: 0 };
  const delegatedUsage = { promptTokens: 0, completionTokens: 0, count: 0, costCount: 0 };
  let providerCost = null;
  let delegatedProviderCost = null;
  let completedToolRound = false;
  let emptyPostToolRetries = 0;
  const FINAL_ANSWER_RETRIES = 2;
  // Identical-call circuit breaker state (enforced in runOneCall below).
  // The loop has no fixed turn limit, so a model retrying the exact
  // same failing call (e.g. an interactive command that exits
  // immediately) would otherwise spin forever.
  let lastToolCallKey = null;
  let repeatedToolCallCount = 0;
  const REPEATED_TOOL_CALL_LIMIT = 3;

  function modelContentForTool(name, exec) {
    return toolFeedback.compactToolFeedback({
      name,
      content: exec && exec.content,
      result: exec && exec.result,
      maxBytes: opts && opts.appSettings && opts.appSettings.toolFeedbackMaxBytes,
      toolOutput: opts && opts.toolOutput
    });
  }

  while (true) {
    let effectiveToolSpecs = visibleToolSpecs;
    try {
      effectiveToolSpecs = promptProfilesMod
        ? promptProfilesMod.reduceToolSpecs(visibleToolSpecs, opts && opts.promptSize, { discoveredToolNames })
        : visibleToolSpecs;
    } catch { /* non-fatal; fall back to the per-chat filtered set */ }
    const result = await runUpstreamTurn(convo, effectiveToolSpecs);
    if (!result.ok) return { ok: false, error: result.error, usage };

    const calls = result.toolCalls;
    if (!calls || !calls.length) {
      // Some OpenAI-compatible models end the first follow-up request with
      // `stop` but no content after receiving a tool result. Treat that as
      // an incomplete exchange rather than a successful empty answer. A
      // short system reminder reliably gets the model to summarize the tool
      // output, while the retry cap prevents a silent model from looping.
      if (completedToolRound && !String(result.assistantText || '').trim() && emptyPostToolRetries < FINAL_ANSWER_RETRIES) {
        emptyPostToolRetries++;
        // Anthropic merges every system-role message into the cached
        // system block, so a mid-conversation system reminder would
        // change the cache prefix and invalidate the warm cache for the
        // rest of the chat. Ride it as a user message instead — the
        // alternating user/assistant pattern stays valid and the system
        // block (the cache breakpoint) stays byte-identical.
        convo.push({
          role: model.provider === 'anthropic' ? 'user' : 'system',
          content: 'Your previous response was empty. Return the final user-facing answer now. Do not call a tool and do not return an empty response.'
        });
        continue;
      }
      if (completedToolRound && !String(result.assistantText || '').trim()) {
        onEvent('message', {
          delta: 'Tool execution finished, but the model did not provide a final response. Review the tool results above before retrying.'
        });
      }
      // No tool calls this turn -> the assistant is done. Emit the
      // final `done` with the accumulated usage and return. Parent
      // prompt tokens stay last-round-wins, but delegated subagent
      // requests are separate upstream calls and must be added so the
      // chat's total usage/cost matches what providers billed.
      const finalUsage = usageWithDelegated();
      const finalProviderCost = totalProviderCost();
      const finalDelegatedCost = delegatedCostTotal();
      const finalTotalCost = totalRunCost();
      onEvent('done', { usage: finalUsage, providerCost: finalProviderCost, delegatedCost: finalDelegatedCost });
      return { ok: true, usage: finalUsage, providerCost: finalProviderCost, delegatedCost: finalDelegatedCost, totalCost: finalTotalCost };
    }

    for (const c of calls) {
      if (!c.id) c.id = 'call_' + Math.random().toString(36).slice(2, 12);
    }

    // The model asked for tools. Append the assistant's tool-call
    // message (OpenAI shape) so the follow-up request has the context.
    convo.push({
      role: 'assistant',
      content: result.assistantText || null,
      tool_calls: calls.map(c => ({
        id: c.id || undefined,
        type: 'function',
        function: { name: c.name, arguments: c.arguments || '{}' }
      }))
    });

    // Close the streamed assistant segment before tool cards are emitted.
    // A model may send explanatory text and then request a tool; without an
    // explicit boundary the browser keeps one live bubble above the tool
    // cards and appends the post-tool answer back into that old bubble.
    onEvent('assistant_turn_end', { content: result.assistantText || '', hasToolCalls: true });

    // Execute each call, emit tool_call + tool_result, and append the
    // `tool` result message the upstream needs on the next turn.
    // Image blocks are also attached as native vision message parts after
    // all required tool messages have been added.
    //
    // Parallelism: when every call in this turn is a `subagent`, run them
    // concurrently — subagents are read-mostly nested chats, so the model
    // can fan out independent research/analysis tasks in one turn. Mixed
    // batches (subagent + file/shell/MCP) stay sequential so ordering
    // guarantees hold for tools with side effects. The authorization
    // session is keyed by callId and the UI routes nested events by
    // parentCallId, so concurrent subagents prompt and render correctly.
    const runParallel = calls.length > 1 && calls.every((c) => c.name === 'subagent');
    const postToolImageMessages = [];
    // Single-call runner shared with POST /api/tools/subagent (direct
    // @agent dispatch from the composer). Closure state: convo (tool
    // messages), call-key circuit breaker, delegated-usage counters,
    // and the discoveredToolNames set for the very-small profile.
    const runOneCall = async (c) => {
      const out = await runSingleToolCall(c, {
        opts,
        onEvent,
        convo,
        toolSpecs,
        visibleToolSpecs,
        promptProfilesMod,
        discoveredToolNames,
        modelContentForTool,
        dispatchTool,
        firstStringArgument,
        toolResultImageParts,
        getLastToolCallKey: () => lastToolCallKey,
        setLastToolCallKey: (k) => { lastToolCallKey = k; },
        getRepeatedToolCallCount: () => repeatedToolCallCount,
        setRepeatedToolCallCount: (n) => { repeatedToolCallCount = n; },
        REPEATED_TOOL_CALL_LIMIT
      });
      const imageParts = out && out.imageParts;
      if (imageParts && imageParts.length) {
        postToolImageMessages.push({
          role: 'user',
          content: [
            { type: 'text', text: 'Image result from tool `' + c.name + '`:' },
            ...imageParts
          ]
        });
      }
      return out.exec;
    };
    if (runParallel) {
      // Concurrent subagent fan-out. `convo` and `postToolImageMessages`
      // are appended from each async worker; ordering of the tool
      // messages in the follow-up request doesn't carry semantics (each
      // is matched by tool_call_id), so completion order is fine.
      await Promise.all(calls.map((c) => runOneCall(c)));
    } else {
      for (const c of calls) await runOneCall(c);
    }
    if (postToolImageMessages.length) convo.push(...postToolImageMessages);
    completedToolRound = true;
    emptyPostToolRetries = 0;
    // Loop: request again with the tool results in context.
  }

  // ---- One upstream request (stream + accumulate) --------------------
  // Performs a single request/response against the provider, streaming
  // `message` deltas through onEvent as they arrive. Returns
  //   { ok: true, assistantText, toolCalls: [{ id, name, arguments }] }
  // or { ok: false, error }. `done` is NOT emitted here — the caller
  // decides when the whole exchange is finished.
  async function runUpstreamTurn(convoMessages, specs) {
  const req = build(model, convoMessages, true, specs, { promptCacheKey: promptCacheKeyFor(opts) });
  const supportsOpenAITools = model.provider === 'openai-compatible'
    || model.provider === 'openrouter'
    || model.provider === 'github-copilot';
  if (supportsOpenAITools && specs && specs.length) {
    const builderBody = req.body;
    if (builderBody && typeof builderBody === 'object') {
      builderBody.tools = specs;
    }
  }
  // Anthropic streams a tool_use block's arguments as input_json_delta
  // frames across multiple SSE events. The parser generator is re-created
  // for every frame, so the tool_use accumulator lives here — one map per
  // upstream turn, shared by every parser call of that turn. Other
  // providers pass the accumulator-less parser through untouched.
  const anthropicToolAcc = model.provider === 'anthropic' ? new Map() : null;
  const parseTurn = (eventName, data) => anthropicToolAcc
    ? parse(eventName, data, anthropicToolAcc)
    : parse(eventName, data);
  // Idle watchdog on the upstream request. The provider can accept the
  // socket and then go silent (dead gateway, stalled network, overloaded
  // model): without a deadline the server waits forever, the chat shows
  // "streaming…" permanently, and the running marker wedges the chat
  // (every retry gets 409 EALREADY_RUNNING). The timer resets on every
  // streamed byte, so a slow-but-chatty model never trips it — only a
  // genuinely silent one does. UPSTREAM_IDLE_MS covers the quiet gap
  // before the first token too (models can "think" for a long time
  // before emitting anything).
  const UPSTREAM_IDLE_MS = 180000; // 3 min of total silence = stuck
  const upstreamCtl = new AbortController();
  let idleTimer = null;
  const resetIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      try { upstreamCtl.abort(new Error('provider idle timeout')); } catch { /* already settled */ }
    }, UPSTREAM_IDLE_MS);
  };
  resetIdle();
  const stopIdle = () => { if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; } };
  // An outer signal (client disconnect) aborts the same request.
  let outerAbort = null;
  if (signal) {
    outerAbort = () => { try { upstreamCtl.abort(signal.reason || new Error('client disconnected')); } catch { /* already settled */ } };
    if (signal.aborted) outerAbort();
    else signal.addEventListener('abort', outerAbort, { once: true });
  }
  const upstream = await fetch(req.url, {
    method: 'POST',
    headers: req.headers,
    body: JSON.stringify(req.body),
    signal: upstreamCtl.signal
  }).catch((e) => {
    return { __networkError: e };
  });

  if (upstream && upstream.__networkError) {
    stopIdle();
    if (signal && outerAbort) signal.removeEventListener('abort', outerAbort);
    const e = upstream.__networkError;
    if (e && e.name === 'AbortError') {
      const idle = upstreamCtl.signal.reason && upstreamCtl.signal.reason.message === 'provider idle timeout';
      const clientGone = signal && signal.aborted;
      if (clientGone) return { ok: false, error: { code: 'EABORTED', message: 'aborted' } };
      if (idle) return { ok: false, error: { code: 'ETIMEOUT', message: 'Provider sent nothing for 3 minutes — the request was cancelled. Try again.' } };
      return { ok: false, error: { code: 'EABORTED', message: 'aborted' } };
    }
    return { ok: false, error: { code: 'ENETWORK', message: e.message || 'network error' } };
  }
  if (!upstream.ok) {
    stopIdle();
    if (signal && outerAbort) signal.removeEventListener('abort', outerAbort);
    let detail = '';
    try { detail = await upstream.text(); } catch { /* ignore */ }
    return {
      ok: false,
      error: {
        code: 'EUPSTREAM',
        message: 'Upstream ' + upstream.status + ' ' + upstream.statusText,
        detail: detail.slice(0, 2000)
      }
    };
  }

  // Stream -> normalize -> onEvent. Assistant text and any tool-call
  // deltas are accumulated locally; the caller (the tool loop) decides
  // what to do with them. `done` is NOT emitted here.
  let sawError = null;
  let assistantText = '';
  let reasoningText = '';
  // OpenAI tool-call accumulator. Deltas arrive split across frames;
  // we assemble by `index`. The accumulator lives only for the
  // duration of one turn.
  const toolAcc = new Map(); // index -> { id, name, arguments }
  // Per-round usage trackers. OpenAI-shaped providers report usage once
  // on the final chunk (with stream_options.include_usage), but some
  // compatible gateways stamp a running total on every chunk. Summing
  // those would double-count, so the round's LAST non-zero report is
  // committed once by commitRoundUsage() when the stream ends. Across
  // tool rounds, completion tokens and cost are genuinely new and do sum.
  let roundPromptTokens = null;
  let roundCompletionTokens = null;
  // Anthropic prompt-cache metrics. `cache_read_input_tokens` are tokens
  // served from the provider's prompt cache (billed at ~10% of the input
  // rate); `cache_creation_input_tokens` are the tokens written into the
  // cache on this request (billed at 1.25× the input rate). They flow from
  // message_start (parseAnthropicSSE → usage_input) into the per-round
  // trackers so per-segment cost and the final turn cost can price them
  // correctly instead of charging everything at the full input rate.
  let roundCacheReadTokens = null;
  let roundCacheCreationTokens = null;
  let roundProviderCost = null;
  let roundProviderCostInput = null;
  let roundProviderCostOutput = null;
  let roundUsageCommitted = false;
  const stream = upstream.body;
  const isNDJSON = def.streamFormat === 'ndjson';
  try {
    if (isNDJSON) {
      for await (const obj of readNDJSON(stream)) {
        resetIdle(); // any upstream byte proves the provider is alive
        for (const ev of parseTurn('', JSON.stringify(obj))) {
          apply(ev);
        }
      }
    } else {
      for await (const ev of readSSE(stream)) {
        resetIdle(); // any upstream byte proves the provider is alive
        for (const out of parseTurn(ev.eventName, ev.data)) {
          apply(out);
        }
      }
    }
  } catch (e) {
    stopIdle();
    if (signal && outerAbort) signal.removeEventListener('abort', outerAbort);
    if (e && e.name === 'AbortError') {
      const idle = upstreamCtl.signal.reason && upstreamCtl.signal.reason.message === 'provider idle timeout';
      const clientGone = signal && signal.aborted;
      if (!clientGone && idle) {
        onEvent('error', { code: 'ETIMEOUT', message: 'Provider went silent mid-stream — the request was cancelled. Try again.' });
        return { ok: false, error: { code: 'ETIMEOUT', message: 'Provider went silent mid-stream — the request was cancelled. Try again.' } };
      }
      if (!clientGone) onEvent('error', { code: 'EABORTED', message: 'aborted' });
      return { ok: false, error: { code: 'EABORTED', message: 'aborted' } };
    }
    onEvent('error', { code: 'EUPSTREAM', message: e.message || 'stream error' });
    return { ok: false, error: { code: 'EUPSTREAM', message: e.message || 'stream error' } };
  }
  stopIdle();
  if (signal && outerAbort) signal.removeEventListener('abort', outerAbort);

  // Commit the round's usage exactly once. Providers that stamp usage
  // on every chunk (not just the final one) would otherwise have their
  // running totals summed into the turn aggregate (double-count). The
  // last non-zero report of the round wins — see apply()'s `done`.
  commitRoundUsage();

  if (sawError) return { ok: false, error: sawError };

  // Collapse the accumulator into an ordered list of tool calls.
  const toolCalls = [];
  for (const tc of toolAcc.values()) {
    if (tc.name) toolCalls.push({ id: tc.id, name: tc.name, arguments: tc.arguments });
  }
  // MiniMax/OpenRouter compatibility: if no native OpenAI tool call was
  // emitted, recover calls serialized into assistant text. OpenRouter text is
  // buffered for one turn so private sentinels never flash in the browser.
  if (!toolCalls.length && model.provider === 'openrouter') {
    const compat = parseMiniMaxTextToolCalls(assistantText);
    if (compat.calls.length) {
      assistantText = compat.text;
      toolCalls.push(...compat.calls);
    }
  }
  if (model.provider === 'openrouter') {
    // Reasoning already streamed live as it arrived (see apply()).
    // Only the assistant text is buffered for MiniMax tool-call
    // compatibility; replaying it here would duplicate every thinking
    // delta the client already rendered.
    if (assistantText) onEvent('message', { delta: assistantText });
  }
  return { ok: true, assistantText, toolCalls };

  function apply(ev) {
    if (ev.name === 'message') {
      if (ev.data && typeof ev.data.delta === 'string') assistantText += ev.data.delta;
      // OpenRouter is buffered until the turn completes because MiniMax may
      // serialize a tool call across several ordinary content deltas.
      if (model.provider !== 'openrouter') onEvent('message', ev.data);
    }
    else if (ev.name === 'reasoning') {
      if (ev.data && typeof ev.data.delta === 'string') reasoningText += ev.data.delta;
      // Reasoning deltas stream live for every provider, OpenRouter
      // included. Unlike `content`, reasoning text never carries a
      // MiniMax-style serialized tool call, so there is no compat
      // reason to buffer it — streaming keeps the client's
      // "Thinking…" block filling in real time instead of popping
      // in as one burst at turn end.
      onEvent('reasoning', ev.data);
    }
    else if (ev.name === 'done') {
      // Record the round's usage into per-round trackers; committed once
      // by commitRoundUsage() when the stream ends. Do NOT emit `done`
      // here — the outer tool loop owns the single final `done` after
      // the whole exchange (all tool round-trips) has completed.
      //
      // promptTokens: the last report wins. Every round-trip re-sends the
      // full conversation, so summing would double-count the context on
      // tool-heavy turns (N rounds × full convo). The final round's
      // prompt is the accurate footprint.
      // completionTokens / providerCost: summed ACROSS rounds (each
      // round's output is genuinely new) but last-wins WITHIN a round,
      // so a provider that stamps running totals on intermediate chunks
      // is not double-counted.
      if (ev.data && ev.data.usage) {
        const p = Number(ev.data.usage.promptTokens);
        const c = Number(ev.data.usage.completionTokens);
        // Only overwrite when the provider actually reported a count;
        // a 0/absent value must not clobber a real number.
        if (isFinite(p) && p > 0) roundPromptTokens = p;
        if (isFinite(c) && c > 0) roundCompletionTokens = c;
        // Surface the round's prompt footprint so the chat UI can
        // refresh its context-usage line mid-exchange (tool rounds).
        // Anthropic already streams usage_input/usage_output; this
        // covers OpenAI-shaped providers that only report on `done`.
        if (isFinite(p) && p > 0) onEvent('usage_input', { promptTokens: p });
      }
      const cost = ev.data && ev.data.providerCost;
      if (typeof cost === 'number' && isFinite(cost) && cost >= 0) {
        roundProviderCost = cost;
        // firstFiniteNumberOrNull leaves absent fields null; keep "no
        // breakdown reported" distinct from a genuine $0 so the split
        // doesn't masquerade as known.
        const norm = (v) => (typeof v === 'number' && isFinite(v) && v > 0) ? v : null;
        roundProviderCostInput = norm(ev.data && ev.data.providerCostInput);
        roundProviderCostOutput = norm(ev.data && ev.data.providerCostOutput);
      }
    } else if (ev.name === 'usage_input') {
      const p = Number(ev.data && ev.data.promptTokens);
      // Anthropic reports this once at message_start; last wins so the
      // final round's prompt (the full conversation footprint) prevails.
      if (isFinite(p) && p > 0) roundPromptTokens = p;
      // Cache metrics ride the same message_start frame. The last non-zero
      // report wins (mirrors the prompt-token rule); a 0/absent value must
      // not clobber a real number already recorded this round.
      const cr = Number(ev.data && ev.data.cacheReadTokens);
      const cc = Number(ev.data && ev.data.cacheCreationTokens);
      if (isFinite(cr) && cr > 0) roundCacheReadTokens = cr;
      if (isFinite(cc) && cc > 0) roundCacheCreationTokens = cc;
      onEvent('usage_input', ev.data);
    } else if (ev.name === 'usage_output') {
      const c = Number(ev.data && ev.data.completionTokens);
      if (isFinite(c) && c > 0) roundCompletionTokens = c;
      onEvent('usage_output', ev.data);
      // Anthropic does not put usage on its `done` frame; the output
      // count arrives on `message_delta` and the input count on
      // `message_start`. Emit the round snapshot here so per-round cost
      // reaches intermediate segments for Anthropic too. Anthropic's
      // deltas are cumulative, so fire per delta — the server keeps the
      // last (richest) value. The trackers are intentionally NOT
      // committed here; the end-of-stream commitRoundUsage() folds the
      // final values into the turn aggregate exactly once.
      if (typeof onRoundUsage === 'function') {
        try {
          if ((roundPromptTokens || 0) > 0 || (roundCompletionTokens || 0) > 0) {
            onRoundUsage({
              promptTokens: roundPromptTokens || 0,
              completionTokens: roundCompletionTokens || 0,
              cacheReadTokens: roundCacheReadTokens || 0,
              cacheCreationTokens: roundCacheCreationTokens || 0,
              providerCost: null,
              providerCostInput: null,
              providerCostOutput: null
            });
            // The round has a snapshot; commitRoundUsage() must not
            // emit a duplicate when it folds the aggregates.
            roundUsageCommitted = true;
          }
        } catch { /* listener errors must not abort the stream */ }
      }
    } else if (ev.name === 'finish') {
      // The tool-call finish reason is handled by the outer loop
      // (it emits tool_call / tool_result). Pass through only the
      // non-tool finish reasons so the UI can show them.
      if (!(ev.data && ev.data.reason === 'tool_calls')) {
        onEvent('finish', ev.data);
      }
    } else if (ev.name === 'tool_call_delta') {
      // OpenAI streams tool calls as a list of deltas. Accumulate
      // by `index`. The first delta carries the `id`; subsequent
      // deltas fill in `function.name` (sometimes) and
      // `function.arguments` (a JSON string we concatenate).
      const d = ev.data;
      const idx = (typeof d.index === 'number') ? d.index : 0;
      let cur = toolAcc.get(idx);
      if (!cur) { cur = { id: null, name: '', arguments: '' }; toolAcc.set(idx, cur); }
      if (d.id) cur.id = d.id;
      if (d.function) {
        if (typeof d.function.name === 'string' && d.function.name) cur.name = d.function.name;
        if (typeof d.function.arguments === 'string') cur.arguments += d.function.arguments;
      }
    } else if (ev.name === 'error') {
      sawError = { code: ev.data.code || 'EUPSTREAM', message: ev.data.message || 'upstream error' };
      onEvent('error', ev.data);
    } else if (ev.name === 'passthrough') {
      onEvent('passthrough', ev.data);
    }
  }

  // Fold the round's latest usage report into the turn aggregate. The
  // trackers are consumed, so each report is added exactly once: a
  // provider that stamps usage on every chunk overwrites the pending
  // value (last-wins) instead of accumulating it. Anthropic commits per
  // `usage_output` delta; the end-of-stream call is then a no-op and the
  // real commit for providers that report on `done` (OpenAI-shaped,
  // Ollama). The per-round snapshot for segment costing is emitted once
  // per round, carrying the most recent numbers.
  function commitRoundUsage() {
    const promptTokens = roundPromptTokens || 0;
    const completionTokens = roundCompletionTokens || 0;
    const hasUsage = promptTokens > 0 || completionTokens > 0;
    const hasCost = typeof roundProviderCost === 'number' && isFinite(roundProviderCost) && roundProviderCost >= 0;
    if (!hasUsage && !hasCost) return;
    if (promptTokens > 0) usage.promptTokens = promptTokens;
    if (completionTokens > 0) usage.completionTokens = (usage.completionTokens || 0) + completionTokens;
    if (roundCacheReadTokens) usageCache.readTokens += roundCacheReadTokens;
    if (roundCacheCreationTokens) usageCache.creationTokens += roundCacheCreationTokens;
    if (hasCost) providerCost = (providerCost || 0) + roundProviderCost;
    if (!roundUsageCommitted && hasUsage && typeof onRoundUsage === 'function') {
      try {
        onRoundUsage({
          promptTokens,
          completionTokens,
          cacheReadTokens: roundCacheReadTokens || 0,
          cacheCreationTokens: roundCacheCreationTokens || 0,
          providerCost: hasCost ? roundProviderCost : null,
          providerCostInput: roundProviderCostInput,
          providerCostOutput: roundProviderCostOutput
        });
      } catch { /* listener errors must not abort the stream */ }
    }
    if (typeof onRoundCommit === 'function') {
    // Fires exactly once per round — when the round's upstream stream has
    // ended — with the round's final token/cost snapshot. Unlike
    // onRoundUsage (a snapshot stream that providers reporting usage per
    // delta fire several times per round), this is a per-round boundary:
    // the subagent dispatcher bills each nested round the moment it
    // finishes so the parent chat's running total grows while the
    // delegated run is still working.
    try {
      onRoundCommit({
      promptTokens,
      completionTokens,
      cacheReadTokens: roundCacheReadTokens || 0,
      cacheCreationTokens: roundCacheCreationTokens || 0,
      providerCost: hasCost ? roundProviderCost : null,
      providerCostInput: roundProviderCostInput,
      providerCostOutput: roundProviderCostOutput
      });
    } catch { /* listener errors must not abort the stream */ }
    }
    roundUsageCommitted = true;
    roundPromptTokens = null;
    roundCompletionTokens = null;
    roundCacheReadTokens = null;
    roundCacheCreationTokens = null;
    roundProviderCost = null;
    roundProviderCostInput = null;
    roundProviderCostOutput = null;
  }
  } // end runUpstreamTurn

  function usageWithDelegated(includeDelegated = true) {
    const u = {
      promptTokens: (usage.promptTokens || 0) + (includeDelegated ? (delegatedUsage.promptTokens || 0) : 0),
      completionTokens: (usage.completionTokens || 0) + (includeDelegated ? (delegatedUsage.completionTokens || 0) : 0)
    };
    // Cache totals are Anthropic-only and carry no delegated counterpart
    // (subagents may run on a different provider), so include them only
    // when the parent turn actually reported some.
    if (usageCache.readTokens || usageCache.creationTokens) {
      u.cacheReadTokens = usageCache.readTokens;
      u.cacheCreationTokens = usageCache.creationTokens;
    }
    return u;
  }

  function parentProviderCost() {
    return (typeof providerCost === 'number' && isFinite(providerCost) && providerCost >= 0) ? providerCost : null;
  }
  function delegatedCostTotal() {
    if (!delegatedUsage.count) return 0;
    return delegatedUsage.costCount === delegatedUsage.count ? delegatedProviderCost : null;
  }
  function totalProviderCost() {
    const parent = parentProviderCost();
    const delegated = delegatedCostTotal();
    // Keep this legacy aggregate for callers that consume providerCost. New
    // callers can use delegatedCost/totalCost to avoid pricing nested tokens
    // with the parent model when only one side has provider-reported billing.
    if (parent == null || delegated == null) return null;
    return parent + delegated;
  }
  function parentCostTotal() {
    const exact = parentProviderCost();
    if (exact != null) return exact;
    try {
      const app = opts && opts.appSettings ? opts.appSettings : require('./settings.js').getApp();
      const estimate = usageMetrics.computeCost({ model, usage: usageWithDelegated(false), app });
      return estimate && estimate.known ? estimate.total : null;
    } catch { return null; }
  }
  function totalRunCost() {
    const parent = parentCostTotal();
    const delegated = delegatedCostTotal();
    return parent == null || delegated == null ? null : parent + delegated;
  }
  function delegatedCostForResult(result) {
    // An explicit null/undefined means "unknown", not $0: Number(null) is
    // 0, so the old form counted a subagent whose cost could not be
    // determined as an exact zero and silently dragged the run's known-cost
    // guard into "known", understating the total.
    const total = result && result.totalCost != null ? Number(result.totalCost) : NaN;
    if (isFinite(total) && total >= 0) return total;
    const exact = result && result.providerCost != null ? Number(result.providerCost) : NaN;
    if (isFinite(exact) && exact >= 0) return exact;
    if (!result || !result.model || !result.usage) return null;
    try {
      const app = opts && opts.appSettings ? opts.appSettings : require('./settings.js').getApp();
      const estimate = usageMetrics.computeCost({ model: result.model, usage: result.usage, app });
      return estimate && estimate.known ? estimate.total : null;
    } catch { return null; }
  }
  // reportDelegatedUsage(report)
  //
  // A nested subagent is one or more *separate* billed upstream calls, so
  // its tokens and cost ride on top of the parent turn. Reports arrive as
  // deltas and are folded in as they land:
  //
  //   - every nested round that finishes reports its own increment (see the
  //     `subagent` branch of dispatchTool), so the chat's live "Total" pill
  //     grows while the delegated run is still working instead of jumping
  //     when the whole run returns;
  //   - the completion report (report.complete) commits the run's `count` —
  //     and `costCount` when the run's cost is known — and adds only the
  //     cost the round reports did not already cover. Only a run that
  //     actually returned is counted; a delegated run that failed mid-way
  //     keeps the cost its finished rounds already reported (those tokens
  //     were really billed and are already on screen) without entering the
  //     counts, mirroring the pre-existing rule that a failed subagent is
  //     not a priced unit.
  //
  // `delegatedCostTotal()` requires one known-cost report per counted run,
  // so the counters are only touched on completion: a run in flight must
  // not make the aggregate look "known" while rounds are still unbilled.
  function reportDelegatedUsage(report) {
    if (!report) return;
    const promptTokens = Number(report.promptTokens);
    const completionTokens = Number(report.completionTokens);
    if (isFinite(promptTokens) && promptTokens > 0) delegatedUsage.promptTokens += promptTokens;
    if (isFinite(completionTokens) && completionTokens > 0) delegatedUsage.completionTokens += completionTokens;
    const cost = (typeof report.cost === 'number' && isFinite(report.cost) && report.cost > 0) ? report.cost : null;
    if (cost != null) {
      delegatedProviderCost = (delegatedProviderCost || 0) + cost;
      // Surface the increment to the SSE stream so the chat's "Total"
      // pill updates immediately. The wire shape matches the persisted
      // `cost` block on assistant messages
      // ({ known, total, input, output, currency }) so the client can
      // drop it into the live running total with no extra plumbing. The
      // final `done` event folds the same number into the parent
      // remainder; the client clears the running delta at that point so
      // nothing is double-counted.
      onEvent('usage_update', {
        cost: {
          known: true,
          total: cost,
          input: 0,
          output: 0,
          currency: 'USD'
        },
        source: 'subagent',
        modelId: report.modelId
      });
    }
    if (report.complete && report.ok) {
      delegatedUsage.count++;
      if (report.costKnown) delegatedUsage.costCount++;
    }
  }

  function toolResultImageParts(result) {
    if (!result || !Array.isArray(result.content)) return [];
    const out = [];
    for (const block of result.content) {
      if (!block || typeof block !== 'object') continue;
      // MCP tools return images two ways: a top-level `image` content block
      // ({ type:'image', data, mimeType }) or an embedded `resource` block
      // ({ type:'resource', resource:{ blob, mimeType } }) — screenshot,
      // chart, and diagram servers commonly use the resource shape. Accept
      // both so those images actually reach the model instead of being
      // silently dropped.
      let data = null;
      let mimeType = null;
      if (block.type === 'image') {
        data = block.data || block.base64;
        mimeType = block.mimeType || block.mime_type || block.mediaType || block.media_type || 'image/png';
      } else if (block.type === 'resource' && block.resource && typeof block.resource === 'object') {
        const res = block.resource;
        const resMime = res.mimeType || res.mime_type || res.mediaType || res.media_type || '';
        // Only forward binary resources that are actually images; text
        // resources ride along in the stringified tool result instead.
        const blob = res.blob || res.data || res.base64;
        if (typeof blob === 'string' && blob && /^image\//i.test(resMime)) {
          data = blob;
          mimeType = resMime;
        }
      }
      if (typeof data === 'string' && data) {
        const url = data.startsWith('data:') ? data : ('data:' + mimeType + ';base64,' + data);
        out.push({ type: 'image_url', image_url: { url } });
      }
    }
    return out;
  }

  function firstStringArgument(value) {
    if (!value || typeof value !== 'object') return '';
    for (const item of Object.values(value)) {
      if (typeof item === 'string') return item;
    }
    return '';
  }

  // ---- Tool dispatcher -----------------------------------------------
  // Routes one tool call to its runner and returns
  //   { ok, content, result } where `content` is the string fed back
  //   to the model as the `tool` message, and `result` is the richer
  //   object surfaced to the chat UI in the tool_result SSE event.
  async function dispatchTool(name, args, callOpts) {
    // Native shell tool.
    if (name === 'shell') {
      let out;
      try {
        const shell = require('./tools/shell.js');
        const parentOnEvent = callOpts && callOpts.onEvent;
        const callId = callOpts && callOpts.callId;
        out = await shell.runShell({
          projectDir: callOpts.projectDir,
          cmd: args && args.cmd,
          shell: args && args.shell,
          // Clamped by the authorization gate against the project's
          // maxTimeoutMs. Falls back to the model's request only when the
          // gate returned no value (it always does, so this is defensive).
          timeoutMs: (callOpts && callOpts.toolTimeoutMs != null) ? callOpts.toolTimeoutMs : (args && args.timeoutMs),
          // Stream decoded output chunks to the chat UI while the
          // command is still running so the tool card shows a live
          // preview instead of a silent spinner.
          onOutput: typeof parentOnEvent === 'function'
            ? (stream, delta) => {
              try {
                parentOnEvent('shell_output', { id: callId || null, stream, delta });
                // Inside a subagent run, re-emit under the nested event
                // name so the chunk lands in the parent subagent card
                // instead of a standalone transcript card.
                if (callOpts && callOpts.nestedSubagent) {
                  parentOnEvent('subagent_event', {
                    parentCallId: callOpts.callId || null,
                    kind: 'shell_output',
                    data: { id: callId || null, stream, delta }
                  });
                }
              } catch { /* best-effort */ }
            }
            : null
        });
      } catch (e) {
        out = { ok: false, error: e.message || String(e), code: 'ESHELL' };
      }
      // The first tool message line tells the model which software and
      // which shell ran the command (the spec description says the same
      // thing up front; the per-call line survives prompt compaction).
      const identity = (out && out.identity) || 'mouaif shell';
      return { ok: !!out.ok, content: '# ' + identity + '\n' + JSON.stringify(out), result: out };
    }

    if (name === 'activate_skill') {
      try {
        return require('./agentSkills.js').activate(callOpts && callOpts.projectDir, opts && opts.chat, args && args.name);
      } catch (e) {
        return { ok: false, content: JSON.stringify({ error: e.message, code: e.code || 'ENO_SKILL' }), result: { error: e.message, code: e.code || 'ENO_SKILL' } };
      }
    }

    // Native task tool. Manages structured tasks with subtasks, progress
    // tracking, and completion. Tasks are in-memory per chat (do not
    // survive a server restart).
    if (name === 'task') {
      try {
        const taskMod = require('./tools/task.js');
        const validated = taskMod.validateArgs(args);
        const out = taskMod.dispatchTask(callOpts && callOpts.chatId, validated);
        // Surface task progress changes as a progress_update event so the
        // frontend progress card and the per-chat updatable status push
        // notification show the current task title and count — the same
        // notification slot the report_progress tool uses. Creation is
        // skipped: a fresh task
        // always starts at 0%, which would be a noise notification.
        if (out && out.ok && out.result && out.result.task
          && (out.result.action === 'progress_updated' || out.result.action === 'completed')
          && callOpts && typeof callOpts.onEvent === 'function') {
          const t = out.result.task;
          const completed = out.result.action === 'completed';
          callOpts.onEvent('progress_update', {
            callId: (callOpts && callOpts.callId) || null,
            kind: 'task',
            title: t.title || 'Task',
            current: typeof t.current === 'number' ? t.current : 0,
            total: typeof t.total === 'number' ? t.total : 100,
            status: completed ? 'completed' : 'running',
            message: completed
              ? 'Task complete'
              : ((typeof t.current === 'number' && typeof t.total === 'number')
                  ? t.current + ' of ' + t.total
                  : '')
          });
        }
        return out;
      } catch (e) {
        const r = { error: { code: e.code || 'ETASK', message: e.message || String(e) } };
        return { ok: false, content: JSON.stringify(r), result: r };
      }
    }

    // Native app restart tool. Authorization is handled by the shared gate;
// this dispatcher schedules the graceful relaunch after its result has had
// time to flush through the current chat stream.
if (name === 'restart_app') {
try {
return require('./tools/restart.js').runRestart(args, {
lifecycle: callOpts && callOpts.lifecycle
});
} catch (e) {
const r = { error: { code: e.code || 'ERESTART', message: e.message || String(e) } };
return { ok: false, content: JSON.stringify(r), result: r };
}
}
// Native subagent tool. It delegates to the same model with the same
// project tool surface, including MCP. The nested call intentionally omits

    // only `subagent` itself to avoid unbounded recursive delegation loops.
    // Authorization uses the parent chat id so the existing chat popup/card is
    // reused for any nested tool or MCP call that needs approval.
    if (name === 'subagent') {
      const task = args && typeof args.task === 'string' ? args.task.trim() : '';
      const context = args && typeof args.context === 'string' ? args.context.trim() : '';
      const agentName = args && typeof args.agent === 'string' ? args.agent.trim() : '';
      if (!task) {
        const r = { error: { code: 'EBADINPUT', message: 'task is required' } };
        return { ok: false, content: JSON.stringify(r), result: r };
      }
      // Resolve the requested agent persona (if any). Agents are
      // named subagent personas from .mouaif.json — an unknown name is
      // a hard, typed error so the model can retry with a valid one
      // instead of silently delegating to a generic subagent.
      let agentTools = null;
      let nestedModel = model; // default: inherit the chat's model
      // Default: inherit the chat's thinking level (null → inherit). An
      // explicit per-run override (authorization card) wins; otherwise an
      // agent's thinkingLevel applies. Empty string = "No thinking".
      let nestedThinkingLevel = null;
      const nestedMessages = [];
      // Per-call model override chosen on the authorization card.
      // { providerId, modelId } — the user explicitly picked a model
      // while approving this call, so it wins over the agent's pin
      // and the chat's model. Resolved to a hydrated model below.
      const chosenModel = (callOpts && callOpts.modelOverride && typeof callOpts.modelOverride === 'object')
        ? callOpts.modelOverride
        : null;
      if (chosenModel && (!chosenModel.providerId || !chosenModel.modelId)) {
        const r = { error: { code: 'EBADINPUT', message: 'Model override must set providerId and modelId' } };
        return { ok: false, content: JSON.stringify(r), result: r };
      }
      if (agentName) {
        if (!callOpts || !callOpts.projectDir) {
          const r = { error: { code: 'EUNKNOWN_AGENT', message: 'No project context to resolve agent "' + agentName + '"', available: [] } };
          return { ok: false, content: JSON.stringify(r), result: r };
        }
        let agent = null;
        let available = [];
        let agentMod = null;
        try {
          agentMod = require('./agents.js');
          const all = agentMod.list(callOpts.projectDir);
          available = all.map((a) => a.name);
          agent = all.find((a) => a.name === agentName) || null;
        } catch { /* fall through to typed error */ }
        if (!agent) {
          const r = { error: { code: 'EUNKNOWN_AGENT', message: 'Unknown agent "' + agentName + '"', available } };
          return { ok: false, content: JSON.stringify(r), result: r };
        }
        // Optional per-agent model pin. When set, the nested call runs
        // on that project model (hydrated with its provider connection)
        // instead of inheriting the chat's model. Unknown model ids
        // fail loudly — never a silent fallback.
        if (agent.modelId) {
          try {
            const rec = agentMod.resolveModel(callOpts.projectDir, agent);
            const settingsMod = require('./settings.js');
            const app = settingsMod.getApp();
            const providers = Array.isArray(app.providers) ? app.providers : [];
            const connection = providers.find((p) => p && p.id === rec.provider) || null;
            if (!connection) {
              const r = { error: { code: 'EPROVIDER_NOT_FOUND', message: 'No provider connection for "' + rec.provider + '"' } };
              return { ok: false, content: JSON.stringify(r), result: r };
            }
            nestedModel = Object.assign({}, connection, projectModelRecord(rec), {
              provider: rec.provider,
              auth: connection.auth || 'apikey'
            });
          } catch (e) {
            const r = { error: { code: e.code || 'EUNKNOWN_MODEL', message: e.message || String(e) } };
            return { ok: false, content: JSON.stringify(r), result: r };
          }
        }
        nestedMessages.push({ role: 'system', content: [{ type: 'text', text: agent.content, cache_control: { type: 'ephemeral' } }] });
        agentTools = Array.isArray(agent.tools) && agent.tools.length ? agent.tools : null;
        // Per-agent thinking level (optional). Applies only when no
        // explicit per-run override was chosen on the approval card.
        if (typeof agent.thinkingLevel === 'string' && agent.thinkingLevel.trim()) {
          nestedThinkingLevel = agent.thinkingLevel;
        }
      } else {
        nestedMessages.push({
          role: 'system',
          content: [{ type: 'text', text: 'You are a focused subagent. Answer only the delegated task. Be concise. You may use the available project tools and MCP tools when they help; authorization prompts are handled by the parent chat.', cache_control: { type: 'ephemeral' } }]
        });
      }
      // Authorization-time model override. The user picked a model on
      // the approval card for THIS delegated run, so it wins over both
      // the chat's model and an agent's pin. Resolve it the same way
      // the chat model is resolved: prefer the project model record,
      // then fall back to a live-catalog entry for the provider, and
      // hydrate either with the app-level provider connection. The
      // project record may only contribute identity/selection metadata
      // — committed project JSON must never redirect a credentialed
      // provider connection candidate (mirrors resolveModel in
      // server-shared.js).
      if (chosenModel) {
        try {
          const settingsMod = require('./settings.js');
          const resolved = settingsMod.getResolved(callOpts && callOpts.projectDir || null);
          const models = Array.isArray(resolved.models) ? resolved.models : [];
          let rec = models.find((x) => x && x.id === chosenModel.modelId && x.provider === chosenModel.providerId) || null;
          if (!rec) {
            // Live-catalog models (OpenRouter & co.) are resolved by
            // provider id; the URL/credential come from the connection.
            rec = { id: chosenModel.modelId, provider: chosenModel.providerId };
          }
          const safe = projectModelRecord(rec);
          const app = settingsMod.getApp();
          const providers = Array.isArray(app.providers) ? app.providers : [];
          const connection = providers.find((p) => p && p.id === rec.provider) || null;
          if (!connection) {
          const r = { error: { code: 'EPROVIDER_NOT_FOUND', message: 'No provider connection for "' + rec.provider + '"' } };
          return { ok: false, content: JSON.stringify(r), result: r };
          }
          nestedModel = Object.assign({}, connection, safe, {
          provider: rec.provider,
          auth: connection.auth || 'apikey'
          });
        } catch (e) {
          const r = { error: { code: e.code || 'EUNKNOWN_MODEL', message: e.message || String(e) } };
          return { ok: false, content: JSON.stringify(r), result: r };
        }
      }
      nestedMessages.push({
        role: 'user',
        content: context ? ('Task:\n' + task + '\n\nContext:\n' + context) : task
      });
      // Per-run thinking level from the authorization card wins over an
      // agent's pin. An empty string clears both so the nested call uses
      // the provider default (the user explicitly chose "No thinking").
      if (callOpts && typeof callOpts.thinkingLevel === 'string') {
        nestedThinkingLevel = callOpts.thinkingLevel;
      }
      // Apply the resolved level directly onto the nested model. `streamChat`
      // only assigns a truthy `thinkingLevel` opt, so an explicit "" (clear)
      // must delete the inherited value rather than ride through it.
      if (nestedThinkingLevel !== null) {
        if (nestedThinkingLevel === '') delete nestedModel.thinkingLevel;
        else nestedModel.thinkingLevel = nestedThinkingLevel;
      }
      // ---- live delegated billing ---------------------------------------
      // A delegated run is several separate billed upstream calls. Billing
      // it only when the whole run returns leaves the chat's live "Total"
      // frozen for the entire subagent — which, with tool-using subagents,
      // can be a long time. So every nested round reports its own increment
      // the moment it finishes, and the completion below only adds what the
      // round reports did not cover.
      //
      // `mirror` reproduces the nested run's own usage aggregation (see
      // commitRoundUsage: prompt tokens are last-round-wins because every
      // round re-sends the conversation, while completion, cache and
      // provider-reported cost accumulate), so `nestedCostSoFar()` is
      // exactly the cost the nested run reports when it returns.
      // `forwarded` tracks what has already been handed to the parent, so
      // the deltas can never bill a round twice.
      const nestedModelRef = nestedModel && nestedModel.id
        ? { id: nestedModel.id, pricing: nestedModel.pricing }
        : null;
      const mirror = {
        lastPromptTokens: 0,
        completionTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        providerCost: null
      };
      const forwarded = { promptTokens: 0, completionTokens: 0, cost: 0 };
      let runCostKnown = false;

      // Cost of the nested run as reported so far, resolved the same way
      // the completion path resolves it: provider-reported cost when a
      // round carried one, otherwise an estimate priced with the nested
      // model. Null while pricing is unknown.
      function nestedCostSoFar() {
        const usageSoFar = {
          promptTokens: mirror.lastPromptTokens,
          completionTokens: mirror.completionTokens
        };
        if (mirror.cacheReadTokens) usageSoFar.cacheReadTokens = mirror.cacheReadTokens;
        if (mirror.cacheCreationTokens) usageSoFar.cacheCreationTokens = mirror.cacheCreationTokens;
        return delegatedCostForResult({
          ok: true,
          model: nestedModelRef,
          providerCost: mirror.providerCost,
          usage: usageSoFar
        });
      }

      // One nested round finished (streamChat's onRoundCommit): mirror its
      // usage and forward the increments to the parent's delegated totals,
      // which also updates the chat UI's running total.
      function forwardNestedRound(round) {
        if (!round) return;
        const promptTokens = Number(round.promptTokens);
        const completionTokens = Number(round.completionTokens);
        if (isFinite(promptTokens) && promptTokens > 0) mirror.lastPromptTokens = promptTokens;
        if (isFinite(completionTokens) && completionTokens > 0) mirror.completionTokens += completionTokens;
        mirror.cacheReadTokens += Number(round.cacheReadTokens) || 0;
        mirror.cacheCreationTokens += Number(round.cacheCreationTokens) || 0;
        // `providerCost: null` means "no provider-reported cost", NOT $0 —
        // Number(null) is 0, which would look like a real (free) price and
        // shadow the estimate for every round.
        const roundCost = round.providerCost == null ? NaN : Number(round.providerCost);
        if (isFinite(roundCost) && roundCost >= 0) mirror.providerCost = (mirror.providerCost || 0) + roundCost;
        const promptDelta = Math.max(0, mirror.lastPromptTokens - forwarded.promptTokens);
        const completionDelta = isFinite(completionTokens) && completionTokens > 0 ? completionTokens : 0;
        const costSoFar = nestedCostSoFar();
        if (costSoFar != null) runCostKnown = true;
        const costDelta = costSoFar == null ? 0 : Math.max(0, costSoFar - forwarded.cost);
        forwarded.promptTokens += promptDelta;
        forwarded.completionTokens += completionDelta;
        if (costSoFar != null && costSoFar > forwarded.cost) forwarded.cost = costSoFar;
        reportDelegatedUsage({
          promptTokens: promptDelta,
          completionTokens: completionDelta,
          cost: costDelta,
          modelId: nestedModelRef ? nestedModelRef.id : undefined
        });
      }

      const nestedEvents = [];
      const parentEnabled = callOpts && Array.isArray(callOpts.enabledTools) ? callOpts.enabledTools : null;
      let nestedEnabled = parentEnabled
        ? parentEnabled.filter((toolName) => toolName !== 'subagent')
        : visibleToolSpecs
            .map((spec) => spec && spec.function && spec.function.name)
            .filter((toolName) => toolName && toolName !== 'subagent');
      // An agent's tool allowlist restricts the nested call's surface.
      // Agent tool entries can be exact tool names (e.g. "shell") or MCP
      // server slugs (e.g. "mcp__fs") which should allow every tool from
      // that server (mcp__fs__read_file, mcp__fs__write_file, ...).
      if (agentTools) {
        const allow = new Set(agentTools);
        nestedEnabled = nestedEnabled.filter((toolName) => {
          if (allow.has(toolName)) return true;
          // Prefix match for MCP server slugs: "mcp__fs" allows
          // "mcp__fs__read_file", "mcp__fs__write_file", etc.
          for (const prefix of allow) {
            if (prefix.startsWith('mcp__') && toolName.startsWith(prefix + '__')) return true;
          }
          return false;
        });
      }
      const nested = await streamChat({
        model: nestedModel,
        messages: nestedMessages,
        signal,
        projectDir: callOpts && callOpts.projectDir,
        chatId: callOpts && callOpts.chatId,
appSettings: callOpts && callOpts.appSettings,
lifecycle: callOpts && callOpts.lifecycle,
promptSize: callOpts && callOpts.promptSize,

        toolOutput: callOpts && callOpts.toolOutput,
        enabledTools: nestedEnabled,
        // Per-round billing for the live delegated cost (see above).
        onRoundCommit: forwardNestedRound,
        // Marker the shell dispatcher reads to re-emit live output
        // chunks as subagent_event so they render inside this card.
        nestedSubagent: true,
        onEvent: (eventName, data) => {
          nestedEvents.push({ name: eventName, data });
          if (typeof onEvent !== 'function') return;
          // Authorization (and ask_user) still ride the normal event
          // so the parent chat popup/card handles the nested
          // approval. The `parentTool` tag tells the chat UI to
          // route the card into the subagent's live container.
          if (eventName === 'authorization_required' || eventName === 'ask_user_required') {
            onEvent(eventName, Object.assign({}, data, { parentTool: 'subagent' }));
            return;
          }
          // Forward nested progress to the parent as-is. `report_progress`
          // and `task` progress updates from a subagent must still reach
          // the parent's push layer (sendChatPush 'progress' + the per-chat
          // updatable notification) and the transcript progress card.
          // `progress_update` never gets persisted by the parent, so it is
          // safe to reuse the event name directly (no transcript corruption,
          // unlike tool_call / tool_result / message below).
          if (eventName === 'progress_update') {
            onEvent('progress_update', data);
            return;
          }
          // Forward nested progress under a distinct event name. The
          // parent's SSE layer persists every `tool_call` / `tool_result`
          // / `message` it sees, so reusing those names would corrupt
          // the transcript with the subagent's internal turns.
          if (eventName === 'tool_call' || eventName === 'tool_result' || eventName === 'message') {
            onEvent('subagent_event', {
              parentCallId: (callOpts && callOpts.callId) || null,
              kind: eventName,
              data
            });
          }
        }
      });
      let text = '';
      const nestedToolEvents = [];
      for (const ev of nestedEvents) {
        if (ev.name === 'message' && ev.data && typeof ev.data.delta === 'string') text += ev.data.delta;
        else if (ev.name === 'tool_call' || ev.name === 'tool_result' || ev.name === 'authorization_required') nestedToolEvents.push(ev);
      }
      // Rebuild a faithful nested transcript for the UI. The plain
      // `chat` (system+user+final assistant) hides every tool turn,
      // which made the subagent preview look like no tools ran. We fold
      // streamed tool_call / tool_result events back into OpenAI-shaped
      // messages so the chat card can render them.
      const chat = nestedMessages.slice();
      {
        let pendingCalls = [];
        const flushCalls = () => {
          if (!pendingCalls.length) return;
          chat.push({
            role: 'assistant',
            content: null,
            tool_calls: pendingCalls.map((c) => ({
              id: c.id || undefined,
              type: 'function',
              function: { name: c.name, arguments: typeof c.args === 'string' ? c.args : JSON.stringify(c.args || {}) }
            }))
          });
          pendingCalls = [];
        };
        for (const ev of nestedToolEvents) {
          const d = ev.data || {};
          if (ev.name === 'tool_call') {
            pendingCalls.push({ id: d.id, name: d.name, args: d.args });
          } else if (ev.name === 'tool_result') {
            flushCalls();
            chat.push({
              role: 'tool',
              tool_call_id: d.id || undefined,
              name: d.name,
              content: typeof d.result === 'string' ? d.result : JSON.stringify(d.result)
            });
          }
        }
        flushCalls();
      }
      chat.push({ role: 'assistant', content: text });
      const r = nested && nested.ok
      ? { ok: true, text, chat, toolEvents: nestedToolEvents, usage: nested.usage || null, providerCost: nested.providerCost ?? null, totalCost: nested.totalCost ?? null, model: nestedModelRef }
      : { ok: false, text, chat, toolEvents: nestedToolEvents, error: nested && nested.error ? nested.error : { code: 'ESUBAGENT', message: 'subagent failed' } };
      // Record WHICH agent ran, when one was named. The name is not derivable
      // from the nested transcript (an agent's system message is its
      // instructions, not its name), and only the delegated call knows it, so
      // it has to ride the result payload or the chat card cannot say which
      // agent answered. Omitted entirely for a generic delegation.
      if (agentName) r.agent = agentName;
      // Commit the run. The round reports above already billed every nested
      // round, so this only adds what they missed — a run whose rounds
      // never reported usage, or a cost estimate that only became
      // resolvable from the full result — and marks the run as counted so
      // delegatedCostTotal() can be known again.
      const finalCost = delegatedCostForResult(r);
      if (finalCost != null) {
        runCostKnown = true;
        if (finalCost > forwarded.cost) {
          reportDelegatedUsage({
            cost: finalCost - forwarded.cost,
            modelId: nestedModelRef ? nestedModelRef.id : undefined
          });
          forwarded.cost = finalCost;
        }
      }
      reportDelegatedUsage({ complete: true, ok: !!(nested && nested.ok), costKnown: runCostKnown });
      return { ok: !!(nested && nested.ok), content: JSON.stringify(r), result: r };
    }

    // Native ask_user tool. The runner is a thin shim: it folds the
    // user's structured answer (carried on callOpts.answerPayload, set
    // by the authorization gate above) into a { ok, content, result }
    // triple the AI client returns to the model. The actual user
    // interaction rides the `ask_user_required` SSE event; the chat
    // UI is the only thing that ever sees the question payload.
    if (name === 'ask_user') {
      let askMod;
      try { askMod = require('./tools/ask.js'); }
      catch (e) {
        const r = { error: { code: 'EMODULE', message: 'ask_user tool module unavailable: ' + (e.message || e) } };
        return { ok: false, content: JSON.stringify(r), result: r };
      }
      let validated;
      try { validated = askMod.validateArgs(args); }
      catch (e) {
        const r = { error: { code: e.code || 'EBADINPUT', message: e.message } };
        return { ok: false, content: JSON.stringify(r), result: r };
      }
      // The deny path passes { cancelled: true } explicitly. Any other
      // missing payload means the gate resolved without prompting — a
      // bug, not a user dismissal — so surface it as an internal error
      // the model can report instead of a silent "cancelled".
      const payload = (callOpts && callOpts.answerPayload);
      if (!payload) {
        const r = { error: { code: 'ENOANSWER', message: 'ask_user resolved without a user answer; the question was not shown or the session was stale. Ask the user again.' } };
        return { ok: false, content: JSON.stringify(r), result: r };
      }
      const choice = payload && Array.isArray(payload.choice) ? payload.choice.slice() : (payload && typeof payload.choice === 'string' ? payload.choice : '');
      const extra = askMod.clampExtra(payload && typeof payload.extra === 'string' ? payload.extra : '');
      const out = askMod.buildResult({
        choice,
        extra,
        options: validated.options,
        multiSelect: validated.multiSelect,
        cancelled: !!(payload && payload.cancelled)
      });
      return { ok: out.ok, content: out.content, result: out.result };
    }

    // Native list_features tool — returns the full structured feature
    // state for the current project and chat. Not gated by authorization:
    // it is read-only metadata, does not execute commands or modify files.
    if (name === 'list_features') {
      let af;
      try { af = require('./agentFeatures.js'); }
      catch (e) {
        const r = { error: { code: 'EMODULE', message: 'agentFeatures module unavailable: ' + (e.message || e) } };
        return { ok: false, content: JSON.stringify(r), result: r };
      }
      return await af.dispatchListFeatures(args, {
        projectDir: callOpts && callOpts.projectDir,
        chatId: callOpts && callOpts.chatId,
        chat: callOpts && callOpts.chat
      });
    }

    // Native report_progress tool — validates args, emits a
    // progress_update SSE event so the frontend can show a live
    // progress bar, and returns the structured data to the model.
    if (name === 'report_progress') {
      let progMod;
      try { progMod = require('./tools/progress.js'); }
      catch (e) {
        const r = { error: { code: 'EMODULE', message: 'report_progress tool module unavailable: ' + (e.message || e) } };
        return { ok: false, content: JSON.stringify(r), result: r };
      }
      let validated;
      try { validated = progMod.validateArgs(args); }
      catch (e) {
        const r = { error: { code: e.code || 'EBADINPUT', message: e.message } };
        return { ok: false, content: JSON.stringify(r), result: r };
      }
      // Emit progress_update SSE event for the frontend.
      if (callOpts && callOpts.onEvent && typeof callOpts.onEvent === 'function') {
        callOpts.onEvent('progress_update', {
          callId: (callOpts && callOpts.callId) || null,
          title: validated.title,
          current: validated.current,
          total: validated.total,
          status: validated.status,
          message: validated.message || ''
        });
      }
      return progMod.buildResult(validated);
    }

    // Native file tools: read_file, list_files, search_files, write_file,
    // edit_file (compatibility alias for a full-file write).
    // Gated by callOpts.fileToolsEnabled (matches the spec-collection
    // branch above). Dispatched in one shot — all four share the same
    // path-safety, size-cap, and authorization story, so a single
    // dispatch helper keeps the call site readable.
    if (name === 'read_file' || name === 'list_files' || name === 'search_files' || name === 'write_file' || name === 'edit_file') {
      let ft;
      try { ft = require('./tools/files.js'); }
      catch (e) {
        const r = { error: { code: 'EMODULE', message: 'file tools module unavailable: ' + (e.message || e) } };
        return { ok: false, content: JSON.stringify(r), result: r };
      }
      return await ft.runFileTool(name, {
      projectDir: callOpts && callOpts.projectDir,
      args,
      settings: callOpts && callOpts.appSettings,
      toolOutput: callOpts && callOpts.toolOutput
      });
    }

    // Native web-preview tool: opens a URL in the debug Chrome and
    // returns a small JPEG screenshot of what is on the page. The
    // chat UI renders it as a thumbnail card; tapping the card
    // opens a full-screen modal with a close button. Authorize is
    // handled by the dispatch gate above (it treats `webpreview` as
    // a native family like the others), so the runner does not see
    // a denial again — it just runs.
    if (name === 'webpreview') {
      let wp;
      try { wp = require('./tools/webpreview.js'); }
      catch (e) {
        const r = { error: { code: 'EMODULE', message: 'webpreview tool module unavailable: ' + (e.message || e) } };
        return { ok: false, content: JSON.stringify(r), result: r };
      }
      try {
const out = await wp.runWebpreview({
url: args && args.url,
viewport: args && args.viewport,
signal: callOpts && callOpts.signal
});
return out;
} catch (e) {
const r = { error: { code: 'EWEBPREVIEW', message: e.message || String(e) } };
return { ok: false, content: JSON.stringify(r), result: r };
}
    }

    // Native image generation tool. Generates one or more pictures with a
    // project image model, saves each as a file inside the project, and
    // attaches the pixels to the result. A subagent reaches this same
    // branch (it shares the dispatcher), so a delegated run's generated
    // image is a real file plus a real image part in the tool result the
    // main agent receives.
    if (name === 'image_gen') {
    let img;
    try { img = require('./tools/image.js'); }
    catch (e) {
      const r = { error: { code: 'EMODULE', message: 'image tool module unavailable: ' + (e.message || e) } };
      return { ok: false, content: JSON.stringify(r), result: r };
    }
    const out = await img.runImageTool({
      projectDir: callOpts && callOpts.projectDir,
      args,
      settings: opts && opts.appSettings,
      appSettings: callOpts && callOpts.appSettings,
      signal: callOpts && callOpts.signal
    });
    return out;
    }

    // MCP tools (mcp__<serverSlug>__<toolName>).
    if (callOpts && callOpts.projectDir) {
      let mcpMod;
      try { mcpMod = require('./mcp.js'); }
      catch (e) {
        const r = { error: { code: 'EMODULE', message: 'MCP module unavailable: ' + (e.message || e) } };
        return { ok: false, content: JSON.stringify(r), result: r };
      }
      const parsed = mcpMod.parseServerSlugAndToolName(name);
if (parsed) {
let error = null;
let out;
try {
out = await mcpMod.callTool(callOpts.projectDir, parsed.serverSlug, parsed.toolName, args);
} catch (e) {
error = {
code: (e && e.code) || 'EMCP_RPC',
message: (e && e.message) || String(e)
};
if (e && e.serverSlug) error.serverSlug = e.serverSlug;
if (e && e.toolName) error.toolName = e.toolName;
      out = { ok: false, content: [{ type: 'text', text: 'MCP error: ' + (error.message || error.code) }], isError: true };
    }
    // MCP servers may report an error as a normal result with isError=true.
    // Give that path the same typed envelope as a thrown transport/RPC error.
    if (!out.ok && !error) {
      const text = Array.isArray(out.content)
        ? out.content.find((block) => block && block.type === 'text' && block.text)
        : null;
      error = {
        code: 'EMCP_RPC',
        message: (text && text.text) || 'MCP tool failed',
        serverSlug: parsed.serverSlug,
        toolName: parsed.toolName
      };
    }
    const result = {
      content: out.content,
      isError: !!out.isError,
      serverSlug: parsed.serverSlug,
      toolName: parsed.toolName
    };
    if (error) result.error = error;
return { ok: !!out.ok, content: JSON.stringify(result), result };
}
    }

    // Unknown tool.
    const r = { error: { code: 'EUNKNOWN_TOOL', message: 'Unknown tool: ' + name } };
    return { ok: false, content: JSON.stringify(r), result: r };
  }
} // end streamChat

module.exports = {
  streamChat,
  runSingleToolCall,
  // byte-stream helpers, re-exported for tests through src/ai.js
  parseSSEFrame,
  readSSE,
  readNDJSON,
  // OpenAI prompt-cache routing key derivation, exported for tests
  promptCacheKeyFor
};

