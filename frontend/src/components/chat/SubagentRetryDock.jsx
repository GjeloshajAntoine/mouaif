// mouaif web — subagent retry dock
//
// A bar in the bottom stack, above the composer, shown when a subagent in the
// latest turn failed. The failure and its Retry already sit on the subagent
// card (renderSubagentChat), but a card can be folded or scrolled away; the
// user should not have to open it to learn that delegated work failed.
//
// The dock reads the transcript DOM rather than state.messages: the card is
// the one place that knows a delegation settled as failed and with which task,
// and it is drawn the same way for a live run and for a saved chat, so older
// failures get the bar too. "Latest turn" means after the last top-level user
// message; sending the retry adds a user message, which clears the bar.
import { h } from 'preact';
import { useEffect, useState } from 'preact/hooks';

// ownError(card) -> the card's own failure line (not a nested card's).
function ownError(card) {
  return [...card.querySelectorAll('.tool-card__subagent-error')].find((el) => el.closest('.tool-card') === card
    && el.querySelector('.tool-card__subagent-retry')) || null;
}

// failedSubagentCards(root) -> the top-level subagent cards after the last
// top-level user message whose settled body carries a Retry.
function failedSubagentCards(root) {
  if (!root) return [];
  const topLevel = (el) => !(el.parentElement && el.parentElement.closest('.tool-card'));
  const users = [...root.querySelectorAll('.chat-msg--user')].filter(topLevel);
  const lastUser = users[users.length - 1] || null;
  return [...root.querySelectorAll('.tool-card--subagent')].filter((card) => topLevel(card)
    && (!lastUser || (lastUser.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING))
    && ownError(card));
}

function snapshot(root) {
  return failedSubagentCards(root).map((card) => {
    const err = ownError(card);
    const text = err.querySelector('span');
    const btn = err.querySelector('.tool-card__subagent-retry');
    return { id: card.dataset.toolId || '', message: text ? text.textContent.replace(/^⚠\s*/, '') : '', prompt: btn.dataset.prompt || '' };
  });
}

export function SubagentRetryDock({ transcriptRef, onJumpToToolCard }) {
  const [failed, setFailed] = useState([]);

  useEffect(() => {
    const root = transcriptRef && transcriptRef.current;
    if (!root || typeof MutationObserver !== 'function') return undefined;
    let frame = 0;
    const scan = () => {
      frame = 0;
      const next = snapshot(root);
      setFailed((prev) => (prev.length === next.length && prev.every((p, i) => p.id === next[i].id && p.message === next[i].message && p.prompt === next[i].prompt) ? prev : next));
    };
    const queue = () => { if (!frame) frame = requestAnimationFrame(scan); };
    const obs = new MutationObserver(queue);
    obs.observe(root, { childList: true, subtree: true });
    scan();
    return () => { obs.disconnect(); if (frame) cancelAnimationFrame(frame); };
  }, [transcriptRef]);

  if (!failed.length) return null;
  // One follow-up re-runs every failed subagent of the turn, built from the
  // same per-card prompt the card's own Retry sends.
  const retry = () => {
    const prompts = failed.map((f) => f.prompt).filter(Boolean);
    const root = transcriptRef.current;
    if (!prompts.length || !root) return;
    const content = prompts.length === 1 ? prompts[0]
      : 'Several subagent calls failed. Run each of them again with the subagent tool.\n\n' + prompts.map((p, i) => '--- Subagent ' + (i + 1) + ' ---\n' + p).join('\n\n');
    root.dispatchEvent(new CustomEvent('mouaif:subagent-retry', { bubbles: true, detail: { content } }));
  };
  const first = failed[0];
  const label = failed.length === 1 ? 'Subagent failed' : failed.length + ' subagents failed';
  return h('div', { class: 'subagent-retry-dock', role: 'alert' },
    h('span', { class: 'subagent-retry-dock__text' },
      h('strong', null, '⚠ ' + label),
      first.message ? ': ' + first.message : ''),
    onJumpToToolCard && first.id
      ? h('button', { class: 'btn btn--small', type: 'button', onClick: () => onJumpToToolCard(first.id) }, 'Show')
      : null,
    h('button', { class: 'btn btn--small', type: 'button', onClick: retry }, failed.length > 1 ? 'Retry all' : 'Retry'));
}
