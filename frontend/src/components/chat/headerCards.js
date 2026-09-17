// mouaif web — Transcript header cards: slot order
//
// The transcript's header block has a fixed order:
//
//   [setup] [system prompt] [tools] [agent files] [skills] [empty state]
//
// and it always sits ABOVE the message rows and any standing overlay card
// (ask_user / authorization). Each card is built and mounted on its own — by
// syncHeaderCards, by refreshSystemPrompt, by a card toggle that swaps its
// node in place — so every mounter used to GUESS its slot from whichever
// sibling happened to be mounted at that moment ("insert after the
// system-prompt row, else before the empty state, else append at the end").
//
// Every anchor those guesses relied on can be legitimately absent:
//
//   * the system-prompt row — renderSystemPromptMessage removes and
//     re-inserts it whenever the resolved prompt is refreshed;
//   * the empty-state block — the first message removes it.
//
// With both anchors gone the card fell through to appendChild(), i.e. BELOW
// the conversation, which is why the prompt/tool toggles sometimes showed up
// in the middle of the transcript, and why the block's order changed from
// pass to pass.
//
// This module makes a card's slot deterministic instead: headerCardIndex()
// names the slot of a mounted card, placeHeaderCard() puts a card in that
// slot in one mutation ("before the first child that is not a header card,
// or that is a header card from a later slot"), and orderHeaderCards() is the
// invariant pass that re-slots whatever is mounted, whatever built it.
//
// Deliberately dependency-free (no imports) so the transcript's file-order
// tests can load it in a vm context the same way they load transcript.js.

export const HEADER_CARD_ORDER = {
  setup: 0,
  sysPrompt: 1,
  tools: 2,
  agentFiles: 3,
  skills: 4,
  empty: 5
};

// The mounted header cards, in the order they are laid out. Used by the
// invariant pass; the individual mounters place themselves by slot index.
export const HEADER_CARD_SELECTORS = [
  '.chat-view__setup',
  '[data-sys-prompt="1"]',
  '[data-tools-card="1"]',
  '[data-agent-files-card="1"]',
  '[data-skills-card="1"]',
  '.chat-view__empty'
];

// hasClass(el, name) -> bool
//
// `className` is read as a string rather than through `classList`, matching
// the transcript module, so the vm-based tests that drive this code with a
// minimal element stub keep working.
function hasClass(el, name) {
  const cls = el && el.className;
  return typeof cls === 'string' && (' ' + cls + ' ').indexOf(' ' + name + ' ') >= 0;
}

// headerCardIndex(el) -> number | -1
//
// The card's slot, or -1 for anything that is not a header card — a message
// row, a tool card, an overlay card, the scroll padding.
export function headerCardIndex(el) {
  if (!el || el.nodeType !== 1) return -1;
  const ds = el.dataset || null;
  if (ds) {
    if (ds.sysPrompt !== undefined) return HEADER_CARD_ORDER.sysPrompt;
    if (ds.toolsCard !== undefined) return HEADER_CARD_ORDER.tools;
    if (ds.agentFilesCard !== undefined) return HEADER_CARD_ORDER.agentFiles;
    if (ds.skillsCard !== undefined) return HEADER_CARD_ORDER.skills;
  }
  if (hasClass(el, 'chat-view__setup')) return HEADER_CARD_ORDER.setup;
  if (hasClass(el, 'chat-view__empty')) return HEADER_CARD_ORDER.empty;
  return -1;
}

// isHeaderCardNode(el) -> bool
//
// True for the header cards. The transcript's reconciler asks this before it
// treats a node as a message row: the system-prompt row carries `.chat-msg`
// too (it is a bubble), and the reconciler used to cull it as an unkeyed row
// and use it as the cursor for the whole row block.
export function isHeaderCardNode(el) {
  return headerCardIndex(el) !== -1;
}

// placeHeaderCard(el, card, index)
//
// Put `card` in the slot `index` of the header block, in a single mutation:
// before the first child that is either not a header card or a header card
// from a later slot. A card already sitting in its slot is left untouched, so
// an unchanged card is never moved (moving a node replays its CSS entry
// animation).
export function placeHeaderCard(el, card, index) {
  if (!el || !card) return;
  let ref = null;
  for (const child of el.children) {
    if (child === card) continue;
    const childIndex = headerCardIndex(child);
    if (childIndex === -1 || childIndex > index) { ref = child; break; }
  }
  // Already in place when the card sits immediately before `ref`. A minimal
  // DOM stub does not reflect `nextSibling`, so normalise it to null rather
  // than risk a no-op move (which would replay the card's entry animation).
  const next = card.nextSibling === undefined ? null : card.nextSibling;
  if (card.parentNode === el && next === ref) return;
  el.insertBefore(card, ref);
}

// orderHeaderCards(refs)
//
// Invariant pass: re-slot every mounted header card, whatever built it. Called
// at the end of syncHeaderCards so the block's order cannot depend on which
// mounter ran last, and after a system-prompt refresh, which is the one path
// that re-inserts a header card on its own.
export function orderHeaderCards(refs) {
  const el = refs && refs.transcript && refs.transcript.current;
  if (!el || typeof el.querySelector !== 'function') return;
  for (const selector of HEADER_CARD_SELECTORS) {
    const node = el.querySelector(selector);
    if (!node || node.parentNode !== el) continue;
    placeHeaderCard(el, node, headerCardIndex(node));
  }
}