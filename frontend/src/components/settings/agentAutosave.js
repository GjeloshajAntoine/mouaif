// Merge debounced field edits and serialize PATCHes, including renames.
// The editor owns rendering/navigation; this queue only owns persistence.
export function createAgentAutosave({ name, save, onStatus, onSaved, delay = 350 }) {
  let currentName = name;
  let pending = {};
  let timer = null;
  let running = null;
  let failed = false;
  function clearTimer() {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  }
  async function drain() {
    while (Object.keys(pending).length) {
      clearTimer();
      const patch = pending;
      pending = {};
      onStatus({ text: 'saving…', kind: 'busy' });
      let agent;
      try {
        agent = await save(currentName, patch);
      } catch (error) {
        // Newer edits win over the failed snapshot when retrying.
        pending = { ...patch, ...pending };
        clearTimer();
        failed = true;
        onStatus({ text: error.message || 'Could not save', kind: 'error' });
        return false;
      }
      currentName = agent.name;
      if (!Object.keys(pending).length) {
        onSaved(agent);
        onStatus({ text: 'saved', kind: 'success' });
      }
    }
    return true;
  }
  function flush() {
    clearTimer();
    if (running) return running;
    failed = false;
    running = drain().finally(() => { running = null; });
    return running;
  }
  function enqueue(patch, immediate = false) {
    pending = { ...pending, ...patch };
    failed = false;
    clearTimer();
    onStatus({ text: 'unsaved changes', kind: 'busy' });
    if (immediate) return flush();
    timer = setTimeout(flush, delay);
  }
  return { enqueue, flush, get name() { return currentName; }, get failed() { return failed; } };
}
