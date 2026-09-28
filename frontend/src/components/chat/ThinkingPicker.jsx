// mouaif web — Thinking-level picker (chat header)
//
// The chat's per-model reasoning-effort control. It is a POPOVER, not a
// native <select>: on a phone a native select's popup renders in flow and
// covers the transcript directly beneath it (the same reason the dictation
// model picker uses the sheet variant — see DictationPage.jsx). It follows
// the chat head's existing popover idiom: a compact trigger that reveals an
// anchored panel on desktop and a fixed visual-viewport sheet at phone
// widths, exactly like ModelPickerField's `chat`/`sheet` variants.
//
// This component is deliberately declarative. The control used to be a bare
// <select> plus a hidden input that `syncThinkingSelect()` rebuilt by hand
// outside Preact's render cycle — so a background model-catalog fetch could
// (and did) reset `hidden` on the input and make the custom field vanish
// under the user's finger. Nothing outside a render writes the DOM here:
// visibility is derived from the selected value every time.
//
// Values:
//   ''            — "No thinking" (sent as no reasoning field at all)
//   '__custom__'  — the free-form indicator; the committed value is the
//                   text in the field, stored on the chat like any other
//   'low'|'high'… — a provider-reported level, or the generic presets

import { h } from 'preact';
import { useState, useRef, useEffect, useCallback } from 'preact/hooks';
import { thinkingOptionsFor, thinkingLabelFor } from './thinking.js';

// The sentinel the option list uses for the "type your own" row. Declared
// in one place so thinking.js and this component cannot disagree.
const THINKING_CUSTOM = '__custom__';

export function ThinkingPicker(props) {
  const {
    value,
    onChange,
    descriptor,
    disabled = false,
    ariaLabel = 'Thinking level'
  } = props;

  const [open, setOpen] = useState(false);
  // customIntent — the user tapped "Custom…" in this session. UI-only:
  // the sentinel is never written to the chat, because it is not a value
  // the provider understands (see effectiveThinkingLevel in thinking.js).
  const [customIntent, setCustomIntent] = useState(false);
  const [draft, setDraft] = useState('');
  const rootRef = useRef(null);
  const popRef = useRef(null);
  const triggerRef = useRef(null);
  const customRef = useRef(null);
  // draftRef mirrors `draft` for the commit paths. A handler closure captures
  // the render-time state value, so clearing `draft` in choose() would still
  // leave the blur handler — which fires on the NEXT tick, after close()
  // refocuses the trigger — reading the stale text and PATCHing it over the
  // row the user actually picked. The ref is cleared synchronously instead.
  const draftRef = useRef('');
  const backdropPressRef = useRef(false);

  const current = typeof value === 'string' ? value : '';
  // Rebuilt whenever the provider's descriptor changes, so a live catalog
  // arriving mid-session swaps the option list without any DOM surgery.
  const options = thinkingOptionsFor(descriptor);
  // A stored value outside the reported set is a free-form entry (a token
  // budget, or a level the model no longer reports): show the field so the
  // user can see and edit it.
  const isCustomCurrent = current !== '' && !options.some((o) => o.value === current);
  const customOpen = open && (customIntent || isCustomCurrent);

  const close = useCallback(() => {
    setOpen(false);
    // Drop the in-session "Custom…" intent: reopening should show the
    // stored value, not a half-finished entry.
    setCustomIntent(false);
    if (triggerRef.current) triggerRef.current.focus({ preventScroll: true });
  }, []);

  // Fixed sheets dismiss via Escape and the backdrop, mirroring
  // ModelPickerField (Escape via onKeyDown as well, because a focused text
  // field can swallow the native cancel event).
  useEffect(() => {
    if (!open) return;
    const onKey = (ev) => { if (ev.key === 'Escape') close(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, close]);

  // Keep the sheet inside the visual viewport while a keyboard is open, and
  // promote it to the top layer so no clipping/transformed ancestor can cut
  // it off. Same two variables ModelPickerField publishes.
  useEffect(() => {
    if (!open || !popRef.current) return;
    const pop = popRef.current;
    const vv = window.visualViewport;
    let frame = 0;
    const sync = () => {
      const height = vv && vv.height ? vv.height : window.innerHeight;
      const top = vv ? Math.max(0, vv.offsetTop) : 0;
      pop.style.setProperty('--model-picker-viewport-height', height + 'px');
      pop.style.setProperty('--model-picker-viewport-top', top + 'px');
      const anchor = triggerRef.current && triggerRef.current.getBoundingClientRect();
      if (anchor) {
        const bottom = Math.min(Math.max(top, anchor.bottom + 4), top + height - Math.min(280, height));
        pop.style.setProperty('--model-picker-anchor-top', bottom + 'px');
        pop.style.setProperty('--model-picker-anchor-left', anchor.left + 'px');
        pop.style.setProperty('--model-picker-available-height', Math.max(0, top + height - bottom) + 'px');
      }
    };
    const schedule = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(sync); };
    if (vv) { vv.addEventListener('resize', sync); vv.addEventListener('scroll', sync); }
    window.addEventListener('resize', sync);
    window.addEventListener('orientationchange', sync);
    pop.addEventListener('focusin', schedule);
    pop.addEventListener('focusout', schedule);
    sync();
    if (!pop.open) pop.showModal();
    return () => {
      if (pop.open) pop.close();
      cancelAnimationFrame(frame);
      if (vv) { vv.removeEventListener('resize', sync); vv.removeEventListener('scroll', sync); }
      window.removeEventListener('resize', sync);
      window.removeEventListener('orientationchange', sync);
      pop.removeEventListener('focusin', schedule);
      pop.removeEventListener('focusout', schedule);
      ['--model-picker-viewport-height', '--model-picker-viewport-top',
        '--model-picker-anchor-top', '--model-picker-anchor-left',
        '--model-picker-available-height'].forEach((v) => pop.style.removeProperty(v));
    };
  }, [open]);

  // Seed the free-form draft from the stored value each time the field is
  // revealed, so a stored number is editable rather than blank.
  useEffect(() => {
    if (!customOpen) return;
    const seed = isCustomCurrent ? current : '';
    draftRef.current = seed;
    setDraft(seed);
    if (customRef.current) customRef.current.focus({ preventScroll: true });
  }, [customOpen, isCustomCurrent, current]);

  function choose(next) {
    if (next !== THINKING_CUSTOM) {
      // Clear the draft synchronously (state AND ref) BEFORE close(). close()
      // refocuses the trigger, which blurs the input on the next tick — and a
      // blur commits whatever the field holds, so a stale draft would PATCH
      // after this choice and win the race.
      draftRef.current = '';
      setDraft('');
      setCustomIntent(false);
      setOpen(false);
      if (onChange) onChange(next);
      return;
    }
    // "Custom…" keeps the panel open and reveals the input. It writes NO
    // value: the sentinel is not something the provider understands, so
    // persisting it would send '__custom__' as reasoning_effort. The
    // committed value is whatever the field holds when it is blurred or
    // Enter is pressed.
    setCustomIntent(true);
  }

  function commitDraft(ev) {
    // Blur commits a typed value but never hides the field — moving focus
    // (tapping the composer, the keyboard opening, the picker closing) is
    // not a dismissal.
    //
    // Exception: a blur caused by tapping ANOTHER row in this popover is
    // navigation, not a commit. Committing here would PATCH the draft and
    // the row's own choose() would PATCH again, and the two writes race —
    // the stale one can land last and win. Let the click decide.
    const to = ev && ev.relatedTarget;
    if (to && popRef.current && popRef.current.contains(to)) return;
    const v = (draftRef.current || '').trim();
    if (!v) return;
    if (onChange) onChange(v);
  }

  function commitDraftOnEnter(ev) {
    if (ev.key !== 'Enter') return;
    ev.preventDefault();
    // Enter is the explicit commit, including an empty field — which
    // resets to "No thinking" rather than leaving reasoning_effort empty.
    const v = (draftRef.current || '').trim();
    draftRef.current = '';
    setCustomIntent(false);
    if (onChange) onChange(v);
    close();
  }

  function onDraftInput(ev) {
    const v = ev.currentTarget.value;
    draftRef.current = v;
    setDraft(v);
  }

  const triggerLabel = isCustomCurrent
    ? current
    : (customIntent ? (draft.trim() || 'Custom…') : thinkingLabelFor(options, current));

  return h('div', { class: 'thinking-picker', ref: rootRef },
    h('button', {
      ref: triggerRef,
      type: 'button',
      class: 'input thinking-picker__trigger' + (current === '' && !isCustomCurrent ? ' is-empty' : ''),
      disabled: !!disabled,
      'aria-label': ariaLabel,
      'aria-haspopup': 'dialog',
      'aria-expanded': String(open),
      onClick: () => setOpen(!open)
    },
      h('span', { class: 'thinking-picker__label' }, triggerLabel),
      h('span', { class: 'thinking-picker__caret', 'aria-hidden': 'true' }, '▾')
    ),
    open ? h('dialog', {
      class: 'thinking-picker__pop',
      role: 'dialog',
      'aria-modal': 'true',
      'aria-label': ariaLabel,
      ref: popRef,
      onCancel: (ev) => { ev.preventDefault(); close(); },
      onKeyDown: (ev) => {
        if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); close(); }
      },
      // Dismiss only gestures that start AND end outside the panel, so a
      // text-selection drag off the field is not read as a tap.
      onPointerDown: (ev) => {
        const r = ev.currentTarget.getBoundingClientRect();
        backdropPressRef.current = ev.target === ev.currentTarget
          && (ev.clientX < r.left || ev.clientX > r.right || ev.clientY < r.top || ev.clientY > r.bottom);
      },
      onPointerCancel: () => { backdropPressRef.current = false; },
      onClick: (ev) => {
        const startedOutside = backdropPressRef.current;
        backdropPressRef.current = false;
        if (!startedOutside || ev.target !== ev.currentTarget) return;
        const r = ev.currentTarget.getBoundingClientRect();
        if (ev.clientX < r.left || ev.clientX > r.right || ev.clientY < r.top || ev.clientY > r.bottom) close();
      }
    },
      h('div', { class: 'thinking-picker__head' },
        h('span', { class: 'thinking-picker__title' }, 'Thinking level'),
        h('button', {
          type: 'button',
          class: 'thinking-picker__close',
          'aria-label': 'Close',
          title: 'Close',
          onClick: close
        }, '×')
      ),
      h('ul', { class: 'thinking-picker__list', role: 'listbox', 'aria-label': ariaLabel },
        options.map((o) => {
          const on = o.value === THINKING_CUSTOM
            ? customOpen
            : (current === o.value && !isCustomCurrent);          return h('li', { key: o.value, class: 'thinking-picker__row' },
            h('button', {
              type: 'button',
              class: 'thinking-picker__opt' + (on ? ' is-on' : ''),
              role: 'option',
              'aria-selected': String(on),
              onClick: () => choose(o.value)
            },
              h('span', { class: 'thinking-picker__check', 'aria-hidden': 'true' }, on ? '✓' : ''),
              h('span', { class: 'thinking-picker__opt-label' }, o.label)
            )
          );
        })
      ),
      customOpen ? h('div', { class: 'thinking-picker__custom' },
        h('label', { class: 'thinking-picker__custom-label', for: 'thinkingCustomInput' }, 'Custom value'),
        h('input', {
          ref: customRef,
          id: 'thinkingCustomInput',
          class: 'input thinking-picker__custom-input',
          type: 'text',
          value: draft,
          placeholder: 'e.g. 4096, minimal, xhigh',
          'aria-label': 'Custom thinking level',
          onInput: (ev) => onDraftInput(ev),
          onBlur: (ev) => commitDraft(ev),
          onKeyDown: commitDraftOnEnter
        }),
        h('p', { class: 'thinking-picker__hint' },
          'A number is a token budget for Anthropic and Gemini; OpenAI-shaped providers take it as reasoning_effort.')
      ) : null
    ) : null
  );
}
