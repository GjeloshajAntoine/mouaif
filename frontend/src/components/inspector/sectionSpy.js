// sectionSpy — which Styles section currently owns the top of the panel.
//
// The Styles panel is one ~3 300 px scroller on a phone holding four named
// sections (Controls, Declared, Rules, Computed). The section rail above it is
// the only index of that length, and until now it was a *jump list only*: four
// identical chips that could move the scroller but never said where the user
// already was. So the question the rail exists to answer — "which part of this
// element am I looking at?" — had to be answered by scrolling up to read a
// heading, or by remembering the chip that was tapped some screens ago.
//
// This module is the missing half: given the sections' content offsets and
// where the panel is scrolled to, it returns the id of the section occupying
// the top of the visible region. The panel turns that into the rail's active
// state, which is what makes the rail read as navigation rather than as a row
// of buttons.
//
// Pure (plain data in, id out) so `scripts/test-inspector-section-spy.js` can
// cover the boundary rules without a browser or a Preact render — the same
// shape computedFilter.js and stylesOrder.js use for the panel's other pure
// decisions.

// SECTIONS — the rail's destinations, in scroll order. One source of truth:
// the panel renders its chips from this list and the spy returns these ids, so
// a chip can never name a section the spy cannot report.
export const SECTIONS = [
  { id: 'controls', label: 'Controls' },
  { id: 'declared', label: 'Declared' },
  { id: 'rules', label: 'Rules' },
  { id: 'computed', label: 'Computed' }
];

export const SECTION_IDS = SECTIONS.map((s) => s.id);

// SECTION_SLOP — the tolerance, in px, around the reading line.
//
// It is not a cosmetic fade: `scrollToSection` deliberately lands a heading a
// few px *below* the pinned chrome (flush against it reads as clipped), so the
// spy's line has to reach a little further than the chrome's edge or a jump would
// immediately report the section *above* the one it just scrolled to. Measured
// against the fixture, a slop equal to the jump's 4 px inset left the two exactly
// equal, and the strips' fractional heights (a rail measuring 52.98 px, not 53)
// then resolved the comparison to "not yet" — tapping "Rules" lit "Declared".
//
// The value is therefore the jump inset plus a couple of px of sub-pixel slack.
// It only widens the window by that much: a heading has still arrived at the top
// of the visible region, which is the moment its section becomes the one being
// read.
export const SECTION_SLOP = 8;

// activeSection — the id of the last section whose top is at or above the
// reading line. `boxes` are the sections in scroll order, each with the content
// offset of its heading (`top`, in the scroller's own coordinate space, so it
// does not move when the panel scrolls — see the panel's measureSections). The
// reading line is `viewportTop`, which the caller passes as
// `scrollTop + pinned chrome height`: the heading a user sees first is the one
// just below the sticky strips, not the one at the scroller's raw top.
//
// A section is current once its heading is within `SECTION_SLOP` of the
// reading line — the heading has arrived at the top of the visible region. The
// slop is small on purpose and matched to the jump's own inset, so a jump always
// resolves to the chip that was tapped (see SECTION_SLOP).
//
// Nothing above the first section matches (the panel is scrolled up into the
// Element tree or the preview), so the first section is the answer — the rail
// is never blank, which is what makes it a position indicator as well as a
// jump list.
//
// `atEnd` is the caller telling the spy the panel is at (or within a row of)
// the bottom. The final section is then reported regardless of its heading
// offset: a short last section (a handful of computed rows, or "no inline
// styles yet" on Declared) can sit entirely inside the last screenful, so its
// heading never crosses the reading line and the rail would keep pointing at
// the section above the one the user is looking at.
export function activeSection(boxes, viewportTop, options) {
  const opts = options || {};
  const list = Array.isArray(boxes)
    ? boxes.filter((b) => b && typeof b.id === 'string' && typeof b.top === 'number' && isFinite(b.top))
    : [];
  if (!list.length) return '';
  if (opts.atEnd) return list[list.length - 1].id;
  const slop = typeof opts.slop === 'number' && isFinite(opts.slop) ? opts.slop : SECTION_SLOP;
  // A heading counts once it is within `slop` of the reading line — i.e. it has
  // arrived at the top of the visible region. A *larger* slop therefore flips
  // earlier, which is what a caller tuning for a sticky-strip overshoot wants.
  const line = (typeof viewportTop === 'number' && isFinite(viewportTop) ? viewportTop : 0) + slop;
  let active = list[0].id;
  for (const box of list) {
    if (box.top <= line) active = box.id;
    else break;
  }
  return active;
}

// isAtEnd — the "there is no more list below" test, kept next to the spy so the
// panel's scroll handler passes one consistent notion of the bottom (a row of
// slack, because the last row is usually partly visible).
export function isAtEnd(scrollTop, clientHeight, scrollHeight, slack) {
  const room = (scrollHeight || 0) - (clientHeight || 0);
  if (!isFinite(room) || room <= 0) return true;
  const gap = typeof slack === 'number' && isFinite(slack) ? slack : 72;
  return (scrollTop || 0) >= room - gap;
}
