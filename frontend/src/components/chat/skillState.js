// Keep the transcript and Preact popup on the same server-resolved state.
export function skillStateFromResponse(body, chat = {}) {
  const locked = body.projectSkills === false;
  return {
    items: (Array.isArray(body.skills) ? body.skills : []).map((s) => ({
      id: s.id,
      name: s.name,
      description: s.description,
      disabled: !!s.disabled,
      chatDisabled: !!s.chatDisabled
    })),
    enabled: !locked && (typeof body.skillsEnabled === 'boolean' ? body.skillsEnabled : chat.skills !== false),
    projectLocked: locked
  };
}

// Serialize whole-list PATCHes so quick taps cannot restore an older choice.
// Keep the last acknowledged selection for rollback on HTTP/network failures.
export async function saveSkillSelection(patch, previous, state, notify, updateChat, refresh) {
  const { projectDir, chatId } = state.props || {};
  let session = state._skillSaveSession;
  if (!session || session.projectDir !== projectDir || session.chatId !== chatId) {
    session = { projectDir, chatId, pending: 0, tail: Promise.resolve(), persisted: previous };
    state._skillSaveSession = session;
  } else if (!session.pending) {
    // A prior server refresh may have resolved a preset/project override.
    session.persisted = previous;
  }
  const selection = state.skills;
  session.pending++;
  state._skillSavePending = true;
  const active = () => state._skillSaveSession === session
    && (state.props || {}).projectDir === projectDir && (state.props || {}).chatId === chatId;
  const saving = session.tail.then(async () => {
    try {
      if (await updateChat(patch) === false) return false;
      session.persisted = selection;
      return true;
    } catch {
      if (active() && state._onSkillSaveError) state._onSkillSaveError('Could not save skills. Try again.');
      return false;
    }
  });
  session.tail = saving;
  const saved = await saving;
  session.pending--;
  if (!active()) return saved;
  state._skillSavePending = session.pending > 0;
  if (session.pending) return saved;
  if (!saved) {
    state.skills = session.persisted;
    notify();
  }
  if (typeof refresh === 'function') {
    try { await refresh(); }
    catch { /* A refresh failure must not turn a successful PATCH into a failed save. */ }
  }
  return saved;
}
