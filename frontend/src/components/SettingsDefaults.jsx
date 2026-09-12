// mouaif web — SettingsDefaultsView
//
// Renders Settings → App defaults → Chat defaults. Four settings:
//
//   - Default prompt style     (very-small / average / extensive)
//   - Enter inserts a newline  (boolean switch)
//   - Auto-retry failed sends  (boolean switch)
//   - Glass orb file button    (boolean switch)
//
// All four auto-save on change via the shared `saveApp` helper, matching
// the rest of the app (Settings → Project toggles, Settings → Agents, etc.).
// No Save button: the previous version required a manual commit, which was
// inconsistent and an extra tap for the user.
//
// Layout follows the standard row-card pattern used by SettingsHome and
// SettingsProject: a `.group` with a title and a `.group__list` of
// `.settings-project__item` cards. The first row is a select-in-a-card
// (mirrors SettingsProject's "Prompt style" row); the rest are
// switch-in-a-card rows with title / note / per-row status.
import { h, Fragment } from 'preact';
import { useState, useEffect, useRef } from 'preact/hooks';
import { loadApp, saveApp } from '../api.js';
import { fileOrbFromApp } from './chat/fileOrb.js';

const PROMPT_SIZE_OPTIONS = [
  { value: 'very-small', label: 'Very small — tool names only, no schemas' },
  { value: 'average',    label: 'Average — full tools, recommended' },
  { value: 'extensive',  label: 'Extensive — full tools + best-practice guidance' }
];

// Localised human label for the prompt-size value, used by the live-region
// status line and the SettingsHome detail text.
function promptSizeLabel(v) {
  const opt = PROMPT_SIZE_OPTIONS.find(o => o.value === v);
  return opt ? opt.label.split(' — ')[0].toLowerCase() : (v || 'average');
}

export function SettingsDefaultsView() {
  const [promptSize, setPromptSize] = useState('average');
  const [enterForNewline, setEnterForNewline] = useState(true);
  const [autoRetry, setAutoRetry] = useState(true);
const [fileOrb, setFileOrb] = useState(false);

  // Per-row status messages, mirroring SettingsProject's
  // `promptSizeStatusMsg` / `chatTraceStatusMsg` pattern. Empty string hides
  // the line (`.settings-project__item-status:empty { display: none; }`).
  const [promptSizeMsg, setPromptSizeMsg] = useState('');
  const [enterMsg, setEnterMsg] = useState('');
  const [retryMsg, setRetryMsg] = useState('');
const [fileOrbMsg, setFileOrbMsg] = useState('');

  // Bail flag for late save() responses if the component unmounts mid-save
  // (e.g. user navigates back). Mirrors the same pattern other views use.
  const aliveRef = useRef(true);
  useEffect(() => () => { aliveRef.current = false; }, []);

  // Track in-flight saves per field so a fast toggle flip doesn't race
  // an earlier in-flight request. Latest write wins; older writes' status
  // messages are dropped so the user only sees the most recent outcome.
  const inflight = useRef({ promptSize: 0, enterForNewline: 0, autoRetry: 0, fileOrbButton: 0 });

  useEffect(() => {
    (async () => {
      try {
        const app = await loadApp({ force: true });
        if (!aliveRef.current) return;
        setPromptSize((app.app && app.app.promptSize) || 'average');
        setEnterForNewline(app.app && typeof app.app.enterForNewline === 'boolean' ? app.app.enterForNewline : true);
        setAutoRetry(app.app && typeof app.app.autoRetry === 'boolean' ? app.app.autoRetry : true);
        setFileOrb(fileOrbFromApp(app));
      } catch (e) {
        if (aliveRef.current) setPromptSizeMsg('load failed: ' + e.message);
      }
    })();
  }, []);

  async function saveField(field, patch, setMsg, okMsg) {
    const seq = (inflight.current[field] || 0) + 1;
    inflight.current[field] = seq;
    setMsg('saving…');
    try {
      await saveApp(patch);
      if (!aliveRef.current) return;
      // Only surface the latest result for this field.
      if (inflight.current[field] !== seq) return;
      setMsg(okMsg);
    } catch (e) {
      if (!aliveRef.current) return;
      if (inflight.current[field] !== seq) return;
      setMsg('save failed: ' + e.message);
    }
  }

  function onPromptSizeChange(e) {
    const v = e.currentTarget.value;
    setPromptSize(v);
    saveField('promptSize', { promptSize: v }, setPromptSizeMsg, 'set to ' + promptSizeLabel(v));
  }

  function onEnterChange(e) {
    const v = e.currentTarget.checked;
    setEnterForNewline(v);
    saveField('enterForNewline', { enterForNewline: v }, setEnterMsg, v ? 'Enter now adds a newline' : 'Enter now sends');
  }

  function onAutoRetryChange(e) {
const v = e.currentTarget.checked;
setAutoRetry(v);
saveField('autoRetry', { autoRetry: v }, setRetryMsg, v ? 'auto-retry on' : 'auto-retry off');
}
function onFileOrbChange(e) {
const v = e.currentTarget.checked;
setFileOrb(v);
saveField('fileOrbButton', { fileOrbButton: v }, setFileOrbMsg,
v ? 'the file button is now a glass orb (open a chat to see it)' : 'the file button is back to the flat circle');
}

  return h(Fragment, null,
    h('div', { class: 'view-head' },
      h('a', { href: '#/settings', class: 'view-back', 'aria-label': 'Back to settings' }, '←'),
      h('h2', { class: 'view-title' }, 'App defaults')
    ),
    h('div', { class: 'group' },
      h('div', { class: 'group__title' },
        'Chat defaults',
        h('span', { class: 'group__title-note' }, 'Apply to every project')
      ),
      h('p', { class: 'hint hint--compact' },
        'How much tool schema and instruction text the model receives. Smaller = less context used, faster replies.'),
      h('p', { class: 'hint hint--compact' },
        'A project or a single chat can pick a different style for itself.'),
      h('ul', { class: 'group__list' },
        // ---- Default prompt style: select-in-a-card ---------------------
        h('li', { class: 'settings-project__item' },
          h('div', { class: 'settings-project__item-main' },
            h('label', { class: 'settings-project__item-title', for: 'sd-prompt-size' }, 'Default prompt style'),
            h('div', { class: 'settings-project__item-note' },
              'How much tool schema and instruction text the model receives. ' +
              'Smaller = less context used, faster replies.'),
            h('div', { class: 'settings-project__item-status', 'aria-live': 'polite' }, promptSizeMsg)
          ),
          h('select', {
            class: 'input settings-project__select',
            id: 'sd-prompt-size',
            value: promptSize,
            onChange: onPromptSizeChange
          },
            PROMPT_SIZE_OPTIONS.map(o =>
              h('option', { value: o.value, key: o.value }, o.label)
            )
          )
        ),
        // ---- Enter inserts a newline: switch-in-a-card ------------------
        h('li', { class: 'settings-project__item settings-project__item--col' },
          h('div', { class: 'settings-project__item-row' },
            h('div', { class: 'settings-project__item-main' },
              h('label', { class: 'settings-project__item-title', for: 'sd-enter-newline' },
                'Enter inserts a newline instead of sending'),
              h('div', { class: 'settings-project__item-note' },
                'When on, Enter adds a new line and you send with the send button or Ctrl/Cmd+Enter. ' +
                'Turn it off to send with Enter (Shift+Enter for a new line).'),
              h('div', { class: 'settings-project__item-status', 'aria-live': 'polite' }, enterMsg)
            ),
            h('label', { class: 'switch' },
              h('input', {
                id: 'sd-enter-newline',
                type: 'checkbox',
                role: 'switch',
                'aria-checked': String(enterForNewline),
                checked: enterForNewline,
                onChange: onEnterChange
              }),
              h('span', { class: 'switch__track', 'aria-hidden': 'true' },
                h('span', { class: 'switch__thumb' })
              )
            )
          )
        ),
        // ---- Auto-retry failed sends: switch-in-a-card -------------------
        h('li', { class: 'settings-project__item settings-project__item--col' },
          h('div', { class: 'settings-project__item-row' },
            h('div', { class: 'settings-project__item-main' },
              h('label', { class: 'settings-project__item-title', for: 'sd-auto-retry' },
                'Auto-retry failed sends'),
              h('div', { class: 'settings-project__item-note' },
                'When a message fails before a response starts (network error or HTTP rejection), ' +
                'automatically resend it once. You can still retry any failed message from its inline error card.'),
              h('div', { class: 'settings-project__item-status', 'aria-live': 'polite' }, retryMsg)
            ),
            h('label', { class: 'switch' },
              h('input', {
                id: 'sd-auto-retry',
                type: 'checkbox',
                role: 'switch',
                'aria-checked': String(autoRetry),
                checked: autoRetry,
                onChange: onAutoRetryChange
                }),
                h('span', { class: 'switch__track', 'aria-hidden': 'true' },
                h('span', { class: 'switch__thumb' })
                )
                )
              )
              ),
              // ---- Glass orb file button: switch-in-a-card ---------------
              h('li', { class: 'settings-project__item settings-project__item--col' },
              h('div', { class: 'settings-project__item-row' },
                h('div', { class: 'settings-project__item-main' },
                h('label', { class: 'settings-project__item-title', for: 'sd-file-orb' },
                'Glass orb file button'),
                h('div', { class: 'settings-project__item-note' },
                'Draws the button beside the message box as a shaded glass orb: the file and git ' +
                'counts sit on a 3D folder that tilts slowly, and the sphere picks up a moving ' +
                'highlight. It opens the same Files / Preview / Git / Cli menu either way, and the ' +
                'tap target is unchanged. Off keeps the flat circle that matches the other ' +
                'composer buttons.'),
                h('div', { class: 'settings-project__item-status', 'aria-live': 'polite' }, fileOrbMsg)
                ),
                h('label', { class: 'switch' },
                h('input', {
                id: 'sd-file-orb',
                type: 'checkbox',
                role: 'switch',
                'aria-checked': String(fileOrb),
                checked: fileOrb,
                onChange: onFileOrbChange
                }),
                h('span', { class: 'switch__track', 'aria-hidden': 'true' },
                h('span', { class: 'switch__thumb' })
                )
                )
              )
              )
              ),
              // Trailing hint about chat storage, kept outside the row list so the
      // cards stay clean (matches SettingsProject's "Chats and messages…"
      // placement at the foot of the tools section).
      h('p', { class: 'hint hint--compact' },
        'Chats and messages are stored in the app database. To keep a chat history you can commit, ' +
        'turn on tracing for that chat in project settings — it writes a project-local trace file you can add to source control.')
    )
  );
}
