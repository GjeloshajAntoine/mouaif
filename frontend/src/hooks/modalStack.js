// Modal stack — which sheet owns the keyboard right now.
//
// The app has several full-screen sheets that can be open at the same time
// (the Git modal and its commit-confirm sheet, the Inspector's full-screen
// preview over its panel, the file editor over a chat). Each of them used to
// register its own document-level `keydown` listener for Escape, so with two
// sheets open a single Escape ran both handlers — and the *outer* sheet's
// listener, registered first, ran first, so Escape closed the sheet the user
// was not looking at.
//
// The stack fixes that: every open sheet pushes a token, and only the token on
// top of the stack answers Escape or traps Tab. Closing the top sheet hands
// the keyboard back to the one below it.
//
// Pure and DOM-free on purpose — scripts/test-modal-hook.js drives it
// directly. `useModal` in ./useModal.js is the DOM wiring.

const stack = [];

// openModal(token) — make `token` the sheet that owns the keyboard.
export function openModal(token) {
  closeModal(token);
  stack.push(token);
  return token;
}

// closeModal(token) — remove a token (idempotent), returning true when it was
// the top of the stack, i.e. when the keyboard is now handed back.
export function closeModal(token) {
  const at = stack.indexOf(token);
  if (at === -1) return false;
  stack.splice(at, 1);
  return at === stack.length;
}

// isTopModal(token) — true when this token owns the keyboard. Everything not
// on top ignores Escape and leaves Tab alone.
export function isTopModal(token) {
  return stack.length > 0 && stack[stack.length - 1] === token;
}

// modalDepth() — how many sheets are open. Exported for tests and for the
// rare case that has to know whether it is nested.
export function modalDepth() {
  return stack.length;
}

// resetModalStack() — test seam: drop every token.
export function resetModalStack() {
  stack.length = 0;
}
