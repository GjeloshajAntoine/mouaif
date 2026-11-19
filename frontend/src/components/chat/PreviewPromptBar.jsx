// mouaif web — prompt bar inside the web preview viewer
//
// Lets the user ask for a design change while looking at the page: the text
// is sent as a normal chat message (through the composer, so commands,
// drafts and the transcript behave as usual) and the viewer stays open.
// While the agent works the bar says so; with auto-refresh on, the preview
// reloads (Live) or re-captures (Screenshot) when the reply finishes.
import { h } from 'preact';
import { useRef, useState } from 'preact/hooks';

export function PreviewPromptBar({ working, onPrompt, url }) {
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const [sending, setSending] = useState(false);
  const inputRef = useRef(null);
  function resize(el) {
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 96) + 'px';
  }
  async function submit(e) {
    if (e) e.preventDefault();
    const value = text.trim();
    if (!value || working || sending) return;
    setSending(true);
    setError('');
    let reason = '';
    try { reason = await onPrompt(value); } catch (err) { reason = (err && err.message) || 'Not sent.'; }
    setSending(false);
    // Not sent: keep the text so nothing is lost, and say why.
    if (reason) { setError(reason); return; }
    setText('');
    if (inputRef.current) { inputRef.current.value = ''; resize(inputRef.current); }
  }
  return h('form', { class: 'wp-prompt', onSubmit: submit },
    error ? h('div', { class: 'wp-prompt__error', role: 'alert' }, error) : null,
    h('textarea', {
      ref: inputRef,
      class: 'wp-prompt__input',
      rows: 1,
      value: text,
      placeholder: working ? 'Agent is working…' : 'Ask for a change to this page',
      'aria-label': 'Prompt about ' + (url || 'this page'),
      enterKeyHint: 'send',
      onInput: (e) => { setText(e.currentTarget.value); setError(''); resize(e.currentTarget); },
      onKeyDown: (e) => {
        if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) submit(e);
      }
    }),
    working
      ? h('span', { class: 'wp-prompt__working', role: 'status' }, h('span', { class: 'wp-prompt__dot', 'aria-hidden': 'true' }), 'Working')
      : null,
    h('button', {
      class: 'wp-prompt__send',
      type: 'submit',
      disabled: working || sending || !text.trim(),
      'aria-label': 'Send prompt'
    },
      h('svg', { viewBox: '0 0 24 24', width: 16, height: 16, 'aria-hidden': 'true' },
        h('path', { d: 'M5 12h14 M13 6l6 6-6 6', fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' })
      )
    )
  );
}
