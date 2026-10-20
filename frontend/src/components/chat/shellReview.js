// mouaif web — shell review display helpers
//
// The reviewer lives on the server (src/shellReview.js): a second model reads
// one proposed command and answers in plain text with a SAFE / CAUTION /
// DANGER verdict. Nothing in this module decides anything — it only reads the
// configured choice and renders a verdict block, so every surface that shows a
// review (the approval card, the shell card, the review sheet) looks the same.
//
// Display-only, by design: the block never carries a button that runs the
// command, and it is never what grants an approval. The normal authorization
// gate still owns "may this run?".

// Review modes, mirroring REVIEW_MODES in src/shellReview.js. The settings
// select is built from this list, so the two surfaces cannot drift.
export const SHELL_REVIEW_MODES = Object.freeze([
  { value: 'off', label: 'Off — never ask another model' },
  { value: 'ask', label: 'On demand — only from the Review command button' },
  { value: 'always', label: 'Always — review every shell command before approval' }
]);

// shellReviewFromResolved(resolved) -> { mode, providerId, modelId, prompt, configured }
//
// `resolved` is the merged settings object (`/api/settings/resolved`). Anything
// unreadable reads as `off`, the safe direction: no request is made and no
// review UI is offered. `configured` is what a surface checks before showing a
// review control — a mode without a model cannot review, and silently falling
// back to the chat's model would spend a budget the user did not choose.
export function shellReviewFromResolved(resolved) {
  const raw = resolved && typeof resolved.shellReview === 'object' && resolved.shellReview
    ? resolved.shellReview
    : {};
  const mode = SHELL_REVIEW_MODES.some((m) => m.value === raw.mode) ? raw.mode : 'off';
  const providerId = typeof raw.providerId === 'string' ? raw.providerId.trim() : '';
  const modelId = typeof raw.modelId === 'string' ? raw.modelId.trim() : '';
  return {
    mode,
    providerId,
    modelId,
    prompt: typeof raw.prompt === 'string' ? raw.prompt : '',
    configured: mode !== 'off' && !!providerId && !!modelId
  };
}

// verdictMeta(verdict) -> { label, tone }
//
// The reviewer is asked to end with one verdict word. `tone` is a data
// attribute the CSS colours on; an answer without a recognised verdict keeps
// the neutral tone and still renders in full.
export function verdictMeta(verdict) {
  const v = String(verdict || '').toUpperCase();
  if (v === 'DANGER') return { label: 'Danger', tone: 'danger' };
  if (v === 'CAUTION') return { label: 'Caution', tone: 'caution' };
  if (v === 'SAFE') return { label: 'Safe', tone: 'safe' };
  return { label: 'Review', tone: 'plain' };
}

// reviewModelLabel(review) -> 'provider · model'
function reviewModelLabel(review) {
  const model = (review && review.model) || {};
  return [model.provider, model.id].filter(Boolean).join(' · ');
}

// buildReviewBlock(review) -> HTMLElement | null
//
// The one renderer for a review verdict. Returned detached so a caller can
// put it wherever the card renders and update it in place later.
//
//   review.text      — the reviewer's answer (already capped server-side)
//   review.verdict   — SAFE / CAUTION / DANGER, when it said one
//   review.model     — { provider, id } of the reviewer
//   review.error     — set when the review could not be produced
export function buildReviewBlock(review) {
  if (!review || typeof review !== 'object') return null;
  const block = document.createElement('div');
  block.className = 'tool-card__review';
  const meta = verdictMeta(review.verdict);
  block.dataset.tone = meta.tone;
  const head = document.createElement('div');
  head.className = 'tool-card__review-head';
  const title = document.createElement('span');
  title.className = 'tool-card__review-title';
  title.textContent = 'Second opinion';
  head.appendChild(title);
  const pill = document.createElement('span');
  pill.className = 'tool-card__review-verdict';
  pill.textContent = meta.label;
  head.appendChild(pill);
  const model = reviewModelLabel(review);
  if (model) {
    const who = document.createElement('span');
    who.className = 'tool-card__review-model';
    who.textContent = model;
    who.title = 'The model that reviewed this command';
    head.appendChild(who);
  }
  block.appendChild(head);
  const body = document.createElement('pre');
  body.className = 'tool-card__review-text';
  // A failed review says why in the same block: the user asked for a second
  // opinion and a silent card would read as "this command is fine".
  body.textContent = review.ok === false
    ? 'No review: ' + (review.error || review.code || 'the reviewing model could not answer')
    : String(review.text || '');
  if (body.textContent) block.appendChild(body);
  if (review.ok !== false && review.cost && review.cost.known && Number(review.cost.total) > 0) {
    const cost = document.createElement('div');
    cost.className = 'tool-card__review-cost';
    cost.textContent = 'review cost ' + Number(review.cost.total).toFixed(4) + ' ' + (review.cost.currency || 'USD');
    block.appendChild(cost);
  }
  return block;
}

// applyReviewToCard(card, review) -> boolean
//
// Attach (or replace) the review block on an existing card. The review can
// land after the card mounted — that is the normal order, because the request
// is fired before the approval prompt renders — so this is an in-place update,
// never a second card. Returns false when there is nothing to update.
export function applyReviewToCard(card, review) {
  if (!card || !review) return false;
  const block = buildReviewBlock(review);
  if (!block) return false;
  const existing = card.querySelector('.tool-card__review');
  if (existing) existing.replaceWith(block);
  else {
    // A review on a shell card goes above the output: it is about the command,
    // not about what the command printed.
    const body = card.querySelector('.tool-card__body');
    if (body) body.insertBefore(block, body.firstChild);
    else card.appendChild(block);
  }
  card.dataset.reviewed = review.verdict ? String(review.verdict).toLowerCase() : 'plain';
  return true;
}
