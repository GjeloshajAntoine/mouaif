// mouaif web — Preview URL prompt modal
//
// Small full-screen overlay that asks the user for a web URL to open in the
// web-preview tool. Opens from the FileToolbar's new "Preview" entry. On
// submit it calls `onSubmit(url)` so the chat view can run the capture (and
// publish the screenshot into the existing preview dock). Tapping the
// backdrop, the close button, or pressing Escape dismisses it without
// capturing.
//
// Same overlay/sheet pattern as the Git modal (.gm__overlay / .gm__sheet) and
// web-preview viewer (.wp__overlay / .wp__sheet): dark backdrop, a sheet that
// fills the viewport on a phone and grows to a compact centered card on
// tablet/desktop.
//
// Props:
//   onSubmit (url: string) => void  — called with the trimmed URL on submit
//   onClose  () => void             — dismiss the prompt
import { h } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';

export function PreviewUrlPrompt({ onSubmit, onClose }) {
  const [url, setUrl] = useState('');
  const [error, setError] = useState('');
  const inputRef = useRef(null);

  useEffect(() => {
    function onKey(e) {
      if (e.key === 'Escape') {
        e.stopPropagation();
        if (onClose) onClose();
      }
    }
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  // Focus the field on mount so the user can type immediately.
  useEffect(() => {
    if (inputRef.current) inputRef.current.focus();
  }, []);

  function onBackdropClick(e) {
    // Only close when the tap lands on the backdrop itself, not on
    // the sheet. Same pattern as the Git and web-preview modals.
    if (e.target === e.currentTarget && onClose) onClose();
  }

  function submit(event) {
    event.preventDefault();
    const trimmed = url.trim();
    // Light validation: accept http(s) URLs. A bare hostname is fine to
    // normalise, but reject anything that is clearly not a web page.
    if (!trimmed) {
      setError('Enter a web URL to preview.');
      return;
    }
    let parsed;
    try {
      parsed = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : 'https://' + trimmed);
    } catch {
      setError('That does not look like a valid web URL.');
      return;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      setError('Only http and https URLs are supported.');
      return;
    }
    if (onSubmit) onSubmit(parsed.href);
  }

  return h('div', {
    class: 'wp__overlay',
    role: 'dialog',
    'aria-modal': 'true',
    'aria-label': 'Preview a web page',
    onClick: onBackdropClick
  },
  h('div', { class: 'wp__sheet wp__prompt-sheet' },
  h('div', { class: 'wp__head' },
  h('div', { class: 'wp__head-text' },
  h('div', { class: 'wp__title' }, 'Preview a web page'),
  h('div', { class: 'wp__title-sub' }, 'Opens in the web-preview viewer')
  ),
  h('div', { class: 'wp__head-actions' },
  h('button', {
    class: 'wp__close',
    type: 'button',
    'aria-label': 'Close',
    title: 'Close',
    onClick: () => onClose && onClose()
  },
  h('svg', { viewBox: '0 0 24 24', width: 18, height: 18, 'aria-hidden': 'true' },
  h('path', { d: 'M6 6 18 18 M18 6 6 18', fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round' })
  )
  )
  )
  ),
  h('form', { class: 'wp__prompt-form', onSubmit: submit },
  h('label', { class: 'label wp__prompt-label', for: 'wp-preview-url' }, 'URL'),
  h('input', {
    ref: inputRef,
    id: 'wp-preview-url',
    class: 'input mono wp__prompt-input',
    type: 'text',
    inputMode: 'url',
    autocomplete: 'off',
    autocapitalize: 'off',
    spellcheck: 'false',
    enterkeyhint: 'go',
    placeholder: 'https://example.com/landing',
    value: url,
    onInput: (e) => {
      setUrl(e.currentTarget.value);
      if (error) setError('');
    },
    'aria-label': 'Web URL to preview'
  }),
  h('button', { class: 'btn btn--primary wp__prompt-submit', type: 'submit' },
  'Preview'),
  error ? h('div', { class: 'wp__prompt-error', role: 'alert' }, error) : null,
  h('p', { class: 'wp__prompt-hint' }, 'A screenshot is captured using the Inspector debug Chrome.')
  )
  )
  );
}
