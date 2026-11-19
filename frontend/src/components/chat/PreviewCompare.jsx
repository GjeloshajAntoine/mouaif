// mouaif web — before/after view in the web preview viewer
//
// Shows two screenshots of the same URL stacked; the "before" is clipped to
// the left of a draggable divider, so a design change after a prompt can be
// seen in place. The divider is a native range input (works with touch,
// mouse and the keyboard). When more than two captures exist, chips pick
// which earlier one is the "before".
import { h } from 'preact';
import { useEffect, useState } from 'preact/hooks';

export function PreviewCompare({ captures, current }) {
  const earlier = captures.filter((c) => c !== current && c.thumbnail !== current.thumbnail);
  const [beforeIndex, setBeforeIndex] = useState(earlier.length - 1);
  const [split, setSplit] = useState(50);
  // A new capture arriving moves "before" to the one just replaced.
  useEffect(() => { setBeforeIndex(earlier.length - 1); }, [current && current.thumbnail]);
  const before = earlier[Math.min(Math.max(beforeIndex, 0), earlier.length - 1)];
  if (!before) return null;
  return h('div', { class: 'wp-cmp' },
    earlier.length > 1
      ? h('div', { class: 'wp-cmp__picks', role: 'group', 'aria-label': 'Compare with' },
          earlier.map((c, i) => h('button', {
            key: c.capturedAt || i,
            type: 'button',
            class: 'wp-cmp__pick' + (c === before ? ' wp-cmp__pick--on' : ''),
            'aria-pressed': String(c === before),
            onClick: () => setBeforeIndex(i)
          }, label(c, i, earlier.length)))
        )
      : null,
    h('div', { class: 'wp-cmp__stage' },
      h('img', { class: 'wp-cmp__img', src: current.thumbnail, alt: 'After', draggable: 'false' }),
      h('img', {
        class: 'wp-cmp__img wp-cmp__img--before',
        src: before.thumbnail,
        alt: 'Before',
        draggable: 'false',
        style: { clipPath: 'inset(0 ' + (100 - split) + '% 0 0)' }
      }),
      h('span', { class: 'wp-cmp__line', style: { left: split + '%' }, 'aria-hidden': 'true' }),
      h('span', { class: 'wp-cmp__tag wp-cmp__tag--before' }, 'Before'),
      h('span', { class: 'wp-cmp__tag wp-cmp__tag--after' }, 'After')
    ),
    h('input', {
      class: 'wp-cmp__range',
      type: 'range',
      min: 0,
      max: 100,
      value: split,
      'aria-label': 'Before / after divider',
      onInput: (e) => setSplit(Number(e.currentTarget.value))
    })
  );
}

function label(capture, index, count) {
  const d = new Date(capture.capturedAt || '');
  if (!isNaN(d.getTime())) {
    try { return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }); } catch { /* fall through */ }
  }
  return '−' + (count - index);
}
