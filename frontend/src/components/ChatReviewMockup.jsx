import { h } from 'preact';
import { useState } from 'preact/hooks';
import '../chat-review-mockup.css';

const DIRECTIONS = [
  { id: 'calm', label: 'Calm utility', category: 'Minimal / product-led', note: 'Quiet hierarchy', accent: '#8eb7ff' },
  { id: 'glass', label: 'Glass workspace', category: 'Glassmorphism', note: 'Layered + luminous', accent: '#72e7d0' },
  { id: 'editorial', label: 'Editorial focus', category: 'Warm / magazine', note: 'Human + crafted', accent: '#f28d69' },
  { id: 'command', label: 'Command deck', category: 'Terminal / power-user', note: 'Dense + precise', accent: '#b6f36a' }
];

const INITIAL_MESSAGES = [
  { id: 'u1', kind: 'user', text: 'Can you make the onboarding feel calmer without hiding the important steps?' },
  { id: 'a1', kind: 'assistant', text: 'Yes. I would keep the three-step structure, then give each step more breathing room and make progress visible without turning it into a loud dashboard.', meta: 'Sonnet · 1.8s' },
  { id: 'tool1', kind: 'tool', title: 'Inspecting onboarding flow', status: 'Complete', detail: '12 screens · 3 routes · 0 blocking issues', open: false },
  { id: 'a2', kind: 'assistant', text: 'The strongest direction is Calm utility: one clear action per screen, a soft progress rail, and secondary actions moved into the overflow menu.', meta: 'Sonnet · 2.4s', card: true }
];

const QUICK_PROMPTS = ['Show the visual hierarchy', 'Compare mobile spacing', 'Draft a calmer empty state'];

function TrendIcon({ id }) {
  const symbols = { calm: '○', glass: '◈', editorial: '✦', command: '⌘' };
  return h('span', { class: 'chat-review__trend-icon', 'aria-hidden': 'true' }, symbols[id]);
}

function ToolCard({ message, onToggle }) {
  return h('div', { class: 'chat-review__tool' },
    h('button', { type: 'button', class: 'chat-review__tool-head', 'aria-expanded': message.open, onClick: onToggle },
      h('span', { class: 'chat-review__tool-status' }, '✓'),
      h('span', { class: 'chat-review__tool-title' }, message.title),
      h('span', { class: 'chat-review__tool-state' }, message.open ? 'Hide' : message.status),
      h('span', { class: 'chat-review__chevron', 'aria-hidden': 'true' }, message.open ? '⌃' : '⌄')
    ),
    message.open ? h('div', { class: 'chat-review__tool-detail' }, message.detail) : null
  );
}

function AssistantMessage({ message }) {
  return h('div', { class: 'chat-review__message chat-review__message--assistant' },
    h('span', { class: 'chat-review__avatar', 'aria-hidden': 'true' }, 'm'),
    h('div', { class: 'chat-review__message-body' },
      h('div', { class: 'chat-review__message-label' }, 'mouaif · assistant'),
      h('p', null, message.text),
      message.card ? h('div', { class: 'chat-review__insight' },
        h('span', { class: 'chat-review__insight-kicker' }, 'Recommendation'),
        h('strong', null, 'Make progress feel earned, not measured.'),
        h('span', null, 'Use one accent for state, not decoration.')
      ) : null,
      message.meta ? h('small', { class: 'chat-review__meta' }, message.meta) : null
    )
  );
}

export function ChatReviewMockupView() {
  const [direction, setDirection] = useState('calm');
  const [messages, setMessages] = useState(INITIAL_MESSAGES);
  const [draft, setDraft] = useState('');
  const [notice, setNotice] = useState('');
  const selected = DIRECTIONS.find((item) => item.id === direction) || DIRECTIONS[0];

  const selectDirection = (id) => {
    setDirection(id);
    const item = DIRECTIONS.find((candidate) => candidate.id === id);
    setNotice(`${item.label} applied to the preview`);
  };

  const sendMessage = (event) => {
    event.preventDefault();
    const text = draft.trim();
    if (!text) return;
    setMessages((current) => [...current,
      { id: `u-${Date.now()}`, kind: 'user', text },
      { id: `a-${Date.now() + 1}`, kind: 'assistant', text: 'I added that to the review. The useful constraint is clarity first: keep the primary action obvious, then let the visual language do the atmosphere.', meta: 'Preview response · just now' }
    ]);
    setDraft('');
    setNotice('Preview response added');
  };

  const toggleTool = (id) => {
    setMessages((current) => current.map((message) => message.id === id ? { ...message, open: !message.open } : message));
  };

  return h('main', { class: 'chat-review', 'data-direction': direction },
    h('header', { class: 'chat-review__topbar' },
      h('a', { class: 'chat-review__back', href: '#/projects', 'aria-label': 'Back to chats' }, '←'),
      h('div', { class: 'chat-review__brand' },
        h('span', { class: 'chat-review__brand-mark', 'aria-hidden': 'true' }, 'm'),
        h('div', null, h('strong', null, 'Chat UI review'), h('span', null, 'synthetic conversation · safe preview'))
      ),
      h('button', { type: 'button', class: 'chat-review__more', 'aria-label': 'Preview options', onClick: () => setNotice('Preview only — no project state changes') }, '•••')
    ),
    h('section', { class: 'chat-review__intro' },
      h('div', { class: 'chat-review__eyebrow' }, 'Design directions · 2025–26 patterns'),
      h('h1', null, 'Find the right feeling for the conversation.'),
      h('p', null, 'A mobile-first chat study using familiar category trends: calm utility, glass layers, editorial warmth, and command-line focus.'),
      h('div', { class: 'chat-review__directions', role: 'tablist', 'aria-label': 'Chat design directions' }, DIRECTIONS.map((item) =>
        h('button', { type: 'button', role: 'tab', 'aria-selected': direction === item.id, class: `chat-review__direction ${direction === item.id ? 'is-selected' : ''}`, onClick: () => selectDirection(item.id) },
          h(TrendIcon, { id: item.id }),
          h('span', null, h('strong', null, item.label), h('small', null, item.category))
        )
      ))
    ),
    h('section', { class: 'chat-review__frame', 'aria-label': 'Interactive chat preview' },
      h('div', { class: 'chat-review__chat-head' },
        h('div', { class: 'chat-review__chat-title' },
          h('span', { class: 'chat-review__status-dot', 'aria-hidden': 'true' }),
          h('div', null, h('strong', null, 'Onboarding refresh'), h('span', null, `${selected.label} · ready`))
        ),
        h('div', { class: 'chat-review__head-actions' },
          h('span', { class: 'chat-review__model' }, 'Claude 3.7'),
          h('button', { type: 'button', class: 'chat-review__icon-button', 'aria-label': 'Chat options', onClick: () => setNotice('Chat actions would open here') }, '⋯')
        )
      ),
      h('div', { class: 'chat-review__transcript', 'aria-live': 'polite' },
        h('div', { class: 'chat-review__date-divider' }, h('span', null, 'Today · 10:42 AM')),
        messages.map((message) => message.kind === 'tool'
          ? h(ToolCard, { key: message.id, message, onToggle: () => toggleTool(message.id) })
          : message.kind === 'user'
            ? h('div', { key: message.id, class: 'chat-review__message chat-review__message--user' }, h('p', null, message.text))
            : h(AssistantMessage, { key: message.id, message })
        )
      ),
      h('div', { class: 'chat-review__quick-prompts', 'aria-label': 'Example prompts' }, QUICK_PROMPTS.map((prompt) =>
        h('button', { type: 'button', onClick: () => setDraft(prompt) }, prompt)
      )),
      h('form', { class: 'chat-review__composer', onSubmit: sendMessage },
        h('button', { type: 'button', class: 'chat-review__attach', 'aria-label': 'Add context', onClick: () => setNotice('File and image tools would open here') }, '+'),
        h('input', { value: draft, onInput: (event) => setDraft(event.currentTarget.value), placeholder: 'Ask about this direction…', 'aria-label': 'Message', type: 'text' }),
        h('button', { type: 'submit', class: 'chat-review__send', 'aria-label': 'Send message', disabled: !draft.trim() }, '↑')
      )
    ),
    h('div', { class: 'chat-review__footer' },
      h('span', null, h('i', { style: { background: selected.accent } }), selected.note),
      h('span', null, 'Tap a direction or send a prompt to explore'),
      notice ? h('span', { class: 'chat-review__notice', role: 'status' }, notice) : null
    )
  );
}
