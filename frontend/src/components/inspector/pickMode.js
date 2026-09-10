// mouaif web — inspector pick mode
//
// Tap-to-select is armed in the Styles panel and performed on the Preview
// panel's screenshot. Two things go wrong at that distance, and both were
// live in the shipped UI:
//
//   1. no feedback on the surface being tapped — the user cannot tell
//      whether a tap will select an element or click the page;
//   2. pick mode stayed armed after a successful pick, so the *next* tap
//      silently selected another element instead of poking the page, which
//      reads as a broken preview.
//
// (2) is the decision implemented here. It is a pure function so the
// behaviour can be tested without a browser: `pickFromPoint` resolves to
// true when it selected an element, false when nothing was selectable, and
// may reject on a CDP error. Only a real selection disarms.

// settlePick — route the outcome of a pick to the right callback.
//
//   picked   the value returned by the pick handler: a boolean, a promise
//            of one, or undefined when no handler is wired.
//   onPicked called when an element was selected (disarm pick mode).
//   onMiss   called when the tap hit nothing selectable, or the pick threw
//            (stay armed: the user asked to pick and has not picked yet).
//
// Returns the promise it is waiting on, or null for a synchronous outcome,
// so a caller can await it in a test.
export function settlePick(picked, onPicked, onMiss) {
  const miss = () => { if (onMiss) onMiss(); };
  if (picked && typeof picked.then === 'function') {
    return picked.then((ok) => { if (ok) { if (onPicked) onPicked(); } else { miss(); } },
      () => { miss(); });
  }
  if (picked) { if (onPicked) onPicked(); } else { miss(); }
  return null;
}

// pickBannerText — the one line shown over the screenshot while pick mode is
// on. Names the gesture rather than the feature ("Pick", "Select") because
// the user's question here is "what will my tap do?".
export function pickBannerText() {
  return 'Pick: tap an element in the page';
}
