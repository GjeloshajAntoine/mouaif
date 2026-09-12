// Stand-in for frontend/src/router.js in the dictation UI fixture.
//
// The real module owns the hash → route signal and is imported for its side
// effects, which a fixture that renders two hand-picked views does not want.
// `nav()` keeps the same contract (write the hash) and nothing else.
export function nav(toHash) {
  window.location.hash = '#/' + toHash;
}
