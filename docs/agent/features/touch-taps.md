# Touch taps — implementation notes

> Agent-facing reference for [`docs/features/touch-taps.md`](../../features/touch-taps.md). The human-facing surface lives in that file; the implementation details and source paths live here.

## Implementation notes

- **No runtime component.** This is a stylesheet convention, not code. Every `:hover` rule under [frontend/src](../../../frontend/src) sits inside a `@media (hover: hover)` block next to the rules it covers. Nothing in `src/` or the bundled JS inspects `matchMedia('(hover: …)')`.

- **Why the guard, not a JS fix.** iOS WebKit (Safari and an installed PWA alike) delivers a tap to an element that has a `:hover` style in two steps: the first tap applies the hover state and is consumed, and only a second tap produces the `click`. It is a property of the element with the hover style, so a single unguarded rule makes every similarly styled control feel like it needs two taps. Removing the hover state on touch-only devices removes the step iOS spends the tap on. `:active` rules are deliberately left outside the guard — that is the feedback a touch user should see, and it fires on the press itself. This mirrors the project's own rule in [.github/copilot-instructions.md](../../../.github/copilot-instructions.md) §2 ("Avoid hover-only affordances; everything must work on tap").

- **`(hover: hover)` is the right predicate.** It is false on a touch-only device and true on a device with a real pointer. `any-hover` would be wrong: a hybrid laptop with a touchscreen reports `any-hover: hover`, but `hover: hover` correctly describes the primary pointer the tap is coming from. `(pointer: coarse)` is also wrong — a phone with a Bluetooth mouse is still `hover: hover`.

- **Mixing hover and non-hover selectors.** A rule such as `.mp__options:hover, .mp__options.is-active, .mp__refresh:hover { … }` is split, because `.is-active` is a device-independent state and must stay unguarded while the two `:hover` selectors move into the guard. Both halves keep the original declaration body verbatim.

- **What the sweep must not touch.** `@keyframes`, `@font-face`, and other at-rules are skipped (`scripts`-side transform and any future edit). Only *selector* rules mentioning `:hover` are wrapped. Declaration bodies are copied byte-for-byte — the app's stylesheets use no declaration indentation, so a re-indented body would create a 1000-line diff for a 134-rule change.

- **Regression contract, checked mechanically.** After any edit that adds hover styling, every `:hover` selector in the tree must have a `(hover: hover)` ancestor. A one-liner to verify (expect `0`):

  ```bash
  node -e '
  const fs=require("fs"),path=require("path"),postcss=require("postcss");
  const files=[];(function w(d){for(const e of fs.readdirSync(d,{withFileTypes:true})){const p=path.join(d,e.name);e.isDirectory()?w(p):/\.css$/.test(e.name)&&files.push(p);}})("frontend/src");
  let n=0;
  for(const f of files){const root=postcss.parse(fs.readFileSync(f,"utf8"),{from:f});
   root.walkRules(r=>{if(!r.selectors.some(s=>/:hover/.test(s)))return;
    let p=r.parent,ok=false;while(p){if(p.type==="atrule"&&p.name==="media"&&/hover\s*:\s*hover/.test(p.params)){ok=true;break;}p=p.parent;}
    if(!ok)n++;});}
  console.log(n);
  '
  ```

- **Compiled-bundle check.** `npm run build:web` must leave `(hover:hover)` in the emitted `assets/index-*.css`, with every `:hover` after it inside such a block. The minified sample:

  ```css
  @media (hover:hover){.icon-btn:hover{background:var(--surface-2);color:var(--fg)}}.icon-btn:active{background:var(--surface-3)}
  ```

- **Tests.** No test asserts on hover guards directly; the CSS-reading suites (`scripts/test-inspector-touch-controls.js`, `scripts/test-file-orb.mjs`, `scripts/test-index-first-paint.mjs`, `scripts/test-composer-tools.mjs`, `scripts/test-flush-scroll.mjs`) are the ones that would notice a stylesheet that stopped parsing or lost a rule.
