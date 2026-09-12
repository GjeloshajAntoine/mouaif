// mouaif web — Inspector style declaration validation.
//
// The Styles panel writes straight onto the selected element's own style via
// `element.style.setProperty(prop, value)`. That call is the problem: the CSSOM
// **silently discards** a declaration it does not understand. It does not throw,
// it does not warn, and it leaves no trace —
//
//     el.style.setProperty('color', 'notacolor');   // no error, nothing written
//     el.style.setProperty('bogus-prop', '1px');    // no error, nothing written
//
// so the write reported success, the panel optimistically merged the value into
// its own list, the receipt recorded a change, and then the post-write re-read
// came back without the property and the row simply vanished. The user saw a row
// appear and disappear, a "changed" highlight for nothing, and — worst of all —
// an **Undo entry for a change that never happened**.
//
// This module is the answer to "will the CSSOM accept this declaration?" asked
// *before* the write, so an invalid value is reported instead of being swallowed.
//
// Two levels, deliberately:
//
//   1. `validateDeclaration` — a pure check run before the write, so the sheet
//      can put an inline error under the field and leave the page untouched.
//   2. the read-back in `events.js` `setInlineStyleProperty` — a check run
//      *after* the write, because no client-side oracle is authoritative: this
//      owns the browser's real verdict, including the shorthand expansion the
//      `CSS.supports` check cannot predict.
//
// The `supports` predicate is injected rather than imported so the rules below
// are testable in plain Node, where there is no `CSS` object.
//
// This is validation for *convenience and honesty*, not a security boundary: it
// keeps the panel from lying about what it did. Nothing here restricts what a
// user may type — any property and any value the browsers actually accept is
// still writable.

// A custom property (`--brand`) takes any token stream. `CSS.supports('--brand',
// 'anything')` is true for every value, including nonsense, and that is correct:
// the value of a custom property is only meaningful where it is substituted, so
// validating it here would reject valid usage.
export const CUSTOM_PROPERTY_RE = /^--/;

// A CSS property name: an optional vendor prefix, then a lowercase ident.
// Hyphen-separated, never starting with a digit, no spaces.
export const PROPERTY_NAME_RE = /^-[a-z]+-[a-z][a-z0-9]*(-[a-z0-9]+)*$|^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

// normalizeProp — the property name as the CSSOM will see it. Property names are
// case-insensitive ASCII, and `--Custom` and `--custom` are DIFFERENT custom
// properties, so the lowercasing stops at custom properties.
export function normalizeProp(prop) {
  const raw = String(prop == null ? '' : prop).trim();
  if (!raw) return '';
  return CUSTOM_PROPERTY_RE.test(raw) ? raw : raw.toLowerCase();
}

// validateDeclaration — is `prop: value` something the CSSOM will keep?
//
// Returns `{ ok: true, prop, value }` or `{ ok: false, prop, value, error }`,
// where `error` is a sentence the sheet can show verbatim under the field.
//
// `supports` is the injected capability check — `CSS.supports(prop, value)` in
// a browser. When it is not supplied the value is accepted as-is: a missing
// oracle must not block a write the browser might well have accepted.
export function validateDeclaration(prop, value, supports) {
  const name = normalizeProp(prop);
  const raw = String(value == null ? '' : value).trim();

  if (!name) {
    return { ok: false, prop: '', value: raw, error: 'Enter a CSS property name.' };
  }
  // A custom property needs only a name; its value is whatever the user wants.
  if (CUSTOM_PROPERTY_RE.test(name)) {
    return raw
      ? { ok: true, prop: name, value: raw }
      : { ok: false, prop: name, value: '', error: 'A custom property needs a value — use Remove to drop it.' };
  }
  if (!PROPERTY_NAME_RE.test(name)) {
    return {
      ok: false,
      prop: name,
      value: raw,
      error: '“' + name + '” is not a CSS property name. Names are lowercase and hyphenated, like background-color.'
    };
  }
  if (!raw) {
    // An empty value is not a no-op: `setProperty(p, '')` *removes* the
    // declaration, so Apply on a blank field would silently unset the property
    // the user came here to change. Dropping is what Remove is for.
    return { ok: false, prop: name, value: '', error: 'Enter a value — use Remove to drop the property.' };
  }
  if (typeof supports === 'function') {
    let accepted;
    try {
      accepted = supports(name, raw);
    } catch {
      // A malformed value can make the capability check itself throw; that is
      // the same answer as "not supported".
      accepted = false;
    }
    if (!accepted) {
      return {
        ok: false,
        prop: name,
        value: raw,
        error: '“' + raw + '” is not a valid value for ' + name + '.'
      };
    }
  }
  return { ok: true, prop: name, value: raw };
}

// declarationApplied — did a `setProperty` call actually land?
//
// `before` and `after` are the element's `style.cssText` either side of the
// write, and `read` is `style.getPropertyValue(prop)` afterwards. A shorthand
// (`padding: 30px`) is stored by the engine as its longhands, so reading the
// typed name back returns '' even though the write succeeded — which is why the
// cssText comparison is here and not just the read. All three answers are
// needed:
//
//   - read !== ''            the declaration is stored under the typed name
//   - after !== before       the engine stored *something* (a shorthand expanded)
//   - both empty/unchanged   the declaration was discarded — the invalid case
export function declarationApplied(before, after, read) {
  if (String(read == null ? '' : read) !== '') return true;
  return String(before) !== String(after);
}
