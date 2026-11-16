// mouaif web — Settings → Project → Tools → Chat tool list.
//
// Its own page (settings/project/tool-view). A segmented mode picker switches
// between the default "All tools" tree and "Simplified view" (your own short
// categories). Below it:
//   - An explicit scope callout & live coverage bar showing how many tools are
//     shown in the simplified list vs. kept in the "All tools" tab, making it
//     unmistakable that unpicked tools stay active for the AI.
//   - One-tap starter templates when starting from scratch.
//   - Category cards with name, tool count badge, removable tool chips, and an
//     inline searchable tool picker.
//   - A collapsible live preview of how the chat's Tools card will render.
// Every change saves immediately.
//
// Props:
//   view      normalized { enabled, categories: [{ name, tools }] }
//   groups    default tree groups (buildToolGroups output) to pick from
//   loading   the tool catalog has not arrived yet
//   status    one-line save status
//   onChange  (nextView) => void — persist the whole value

import { h } from 'preact';
import { useState } from 'preact/hooks';
import { ToolTree } from '../ToolTree.jsx';
import { sectionIcon } from '../settingsProjectUi.js';
import {
  MAX_CATEGORIES,
  MAX_NAME_LENGTH,
  TOOL_VIEW_PRESETS,
  applyToolView,
  isToolViewActive,
  toolViewStats
} from '../../toolView.js';

export function ToolViewEditor({ view, groups = [], loading = false, status = '', onChange }) {
  // Which category has its tool picker open (one at a time keeps the page short).
  const [openIndex, setOpenIndex] = useState(-1);
  // Filter query inside the open tool picker so finding a tool among 40+ is instant.
  const [pickerQuery, setPickerQuery] = useState('');
  // Preview toggle: show either the simplified categories or the full default tree.
  const [previewAll, setPreviewAll] = useState(false);

  const categories = view.categories;

  // Tool id -> display name & group name, for chips and search.
  const toolLabel = new Map();
  const toolGroupLabel = new Map();
  for (const g of groups) {
    for (const t of (g.tools || [])) {
      toolLabel.set(t.id, t.name || t.id);
      toolGroupLabel.set(t.id, g.name || g.id);
    }
  }

  const save = (patch) => onChange(Object.assign({}, view, patch));
  const setCategory = (index, patch) => save({
    categories: categories.map((c, i) => (i === index ? Object.assign({}, c, patch) : c))
  });

  function setMode(enabled) {
    if (enabled === view.enabled) return;
    save({ enabled });
  }

  function applyPreset(preset) {
    const nextCategories = preset.categories.slice(0, MAX_CATEGORIES).map((c) => ({
      name: c.name,
      tools: c.tools.slice()
    }));
    onChange({ enabled: true, categories: nextCategories });
    setOpenIndex(-1);
    setPickerQuery('');
  }

  function addCategory() {
    save({ categories: categories.concat([{ name: '', tools: [] }]) });
    setOpenIndex(categories.length);
    setPickerQuery('');
  }
  function removeCategory(index) {
    save({ categories: categories.filter((_, i) => i !== index) });
    setOpenIndex(-1);
    setPickerQuery('');
  }
  function moveCategory(index, delta) {
    const to = index + delta;
    if (to < 0 || to >= categories.length) return;
    const next = categories.slice();
    const [item] = next.splice(index, 1);
    next.splice(to, 0, item);
    save({ categories: next });
    if (openIndex === index) setOpenIndex(to);
    else if (openIndex === to) setOpenIndex(index);
  }
  function setTools(index, names, checked) {
    const current = categories[index].tools;
    const next = checked
      ? current.concat(names.filter((n) => !current.includes(n)))
      : current.filter((n) => !names.includes(n));
    setCategory(index, { tools: next });
  }

  function pickerGroups(cat) {
    const picked = new Set(cat.tools);
    const q = pickerQuery.trim().toLowerCase();
    return groups.map((g) => {
      const groupMatch = q && (
        (g.name && g.name.toLowerCase().includes(q)) ||
        (g.description && g.description.toLowerCase().includes(q))
      );
      const allTools = (g.tools || []).map((t) => ({
        id: t.id, name: t.name, description: t.description, title: t.title, checked: picked.has(t.id)
      }));
      const tools = !q || groupMatch
        ? allTools
        : allTools.filter((t) =>
            (t.name && t.name.toLowerCase().includes(q)) ||
            (t.id && t.id.toLowerCase().includes(q)) ||
            (t.description && t.description.toLowerCase().includes(q))
          );
      return {
        id: g.id, name: g.name, description: g.description, title: g.title,
        checked: tools.length > 0 && tools.every((t) => t.checked),
        alwaysExpanded: !!q || tools.length === 1,
        tools
      };
    }).filter((g) => g.tools.length);
  }

  const stats = toolViewStats(groups, view);
  const active = isToolViewActive(view);
  const anyTools = categories.some((c) => c.tools.length);
  const previewGroups = active && !previewAll ? applyToolView(groups, view) : groups;

  function renderCategory(cat, index) {
    const open = openIndex === index;
    const label = cat.name || 'Category ' + (index + 1);
    const filteredGroups = open ? pickerGroups(cat) : [];
    return h('li', { key: index, class: 'tve-cat' + (open ? ' tve-cat--open' : '') },
      h('div', { class: 'tve-cat__head' },
        h('span', { class: 'tve-cat__num', 'aria-hidden': 'true' }, index + 1),
        h('input', {
          class: 'input tve-cat__name',
          type: 'text',
          value: cat.name,
          maxLength: MAX_NAME_LENGTH,
          placeholder: 'Category name (e.g. Read, Run, Web…)',
          'aria-label': 'Name of category ' + (index + 1),
          // Save when the field is left, not on every keystroke.
          onChange: (e) => setCategory(index, { name: e.currentTarget.value.trim() })
        }),
        h('span', {
          class: 'tve-cat__badge' + (cat.tools.length ? ' tve-cat__badge--on' : ''),
          title: cat.tools.length + (cat.tools.length === 1 ? ' tool in this category' : ' tools in this category')
        }, cat.tools.length + (cat.tools.length === 1 ? ' tool' : ' tools')),
        h('div', { class: 'tve-cat__tools', role: 'group', 'aria-label': 'Arrange ' + label },
          h('button', {
            class: 'glyph-btn tve-cat__icon', type: 'button', disabled: index === 0,
            onClick: () => moveCategory(index, -1), 'aria-label': 'Move ' + label + ' up', title: 'Move up'
          }, '↑'),
          h('button', {
            class: 'glyph-btn tve-cat__icon', type: 'button', disabled: index === categories.length - 1,
            onClick: () => moveCategory(index, 1), 'aria-label': 'Move ' + label + ' down', title: 'Move down'
          }, '↓'),
          h('button', {
            class: 'glyph-btn tve-cat__icon tve-cat__icon--danger', type: 'button',
            onClick: () => removeCategory(index), 'aria-label': 'Remove ' + label, title: 'Remove category'
          }, '×')
        )
      ),
      cat.tools.length
        ? h('ul', { class: 'tve-chips', 'aria-label': 'Tools in ' + label },
            cat.tools.map((id) => {
              const grp = toolGroupLabel.get(id);
              const chipName = toolLabel.get(id) || id;
              return h('li', { key: id, class: 'tve-chip' },
                grp ? h('span', { class: 'tve-chip__group' }, grp) : null,
                h('span', { class: 'tve-chip__label', title: id }, chipName),
                h('button', {
                  class: 'tve-chip__x', type: 'button',
                  onClick: () => setTools(index, [id], false),
                  'aria-label': 'Remove ' + chipName + ' from ' + label
                }, '×')
              );
            })
          )
        : h('p', { class: 'tve-cat__empty' }, 'No tools selected yet — pick at least one tool so this category appears in chats.'),
      h('div', { class: 'tve-cat__actions' },
        h('button', {
          class: 'btn ' + (open ? 'btn--primary' : 'btn--ghost') + ' tve-cat__pick', type: 'button',
          'aria-expanded': String(open),
          onClick: () => {
            setOpenIndex(open ? -1 : index);
            setPickerQuery('');
          }
        }, open ? 'Done picking tools' : (cat.tools.length ? 'Edit tools (' + cat.tools.length + ')' : '+ Choose tools')),
        cat.tools.length > 0 && open
          ? h('button', {
              class: 'btn btn--ghost tve-cat__clear', type: 'button',
              onClick: () => setCategory(index, { tools: [] })
            }, 'Clear all')
          : null
      ),
      open
        ? h('div', { class: 'tve-cat__picker' },
            loading
              ? h('div', { class: 'settings-project__item-note' }, 'Loading tools…')
              : [
                  h('div', { key: 'search', class: 'tve-picker-bar' },
                    h('input', {
                      class: 'input tve-picker-bar__input',
                      type: 'search',
                      value: pickerQuery,
                      placeholder: 'Filter tools by name or group…',
                      'aria-label': 'Filter tools for ' + label,
                      onInput: (e) => setPickerQuery(e.currentTarget.value)
                    }),
                    pickerQuery
                      ? h('button', {
                          class: 'glyph-btn tve-picker-bar__clear',
                          type: 'button',
                          'aria-label': 'Clear tool filter',
                          onClick: () => setPickerQuery('')
                        }, '×')
                      : null
                  ),
                  filteredGroups.length
                    ? h(ToolTree, {
                        key: pickerQuery ? 'filtered' : 'all',
                        groups: filteredGroups,
                        collapsedByDefault: !pickerQuery,
                        onToggleGroup: (groupId, checked) => {
                          const group = filteredGroups.find((g) => g.id === groupId) || groups.find((g) => g.id === groupId);
                          if (group) setTools(index, (group.tools || []).map((t) => t.id), checked);
                        },
                        onToggleTool: (groupId, toolId, checked) => setTools(index, [toolId], checked)
                      })
                    : h('div', { class: 'tve-picker-empty' }, 'No tools match “' + pickerQuery + '”.')
                ]
          )
        : null
    );
  }

  return h('div', { class: 'tool-view-editor' },
    // 1. Mode choice + clear explanation of what Simplified mode does (and doesn't do).
    h('div', { class: 'group settings-project__section' },
      h('div', { class: 'group__title settings-project__section-title' },
        sectionIcon('tools'),
        h('span', null, 'Chat tool list mode'),
        h('details', { class: 'settings-project__info' },
          h('summary', { 'aria-label': 'About the chat tool list' }, '?'),
          h('div', { class: 'settings-project__info-body' },
            h('p', null, 'This only changes how the chat’s Tools card and composer popup are organized. A tool you leave out keeps its Off / Ask / Allow permission and can still be called by the AI — it is simply tucked under the “All tools” tab.'),
            h('p', null, 'In any chat, tap the Simplified / All tools toggle in the Tools header to switch views on the fly.')
          )
        )
      ),
      h('ul', { class: 'group__list' },
        h('li', { class: 'settings-project__item settings-project__item--col' },
          h('div', { class: 'tve-mode-seg', role: 'radiogroup', 'aria-label': 'Chat tool list layout' },
            h('button', {
              type: 'button',
              role: 'radio',
              'aria-checked': String(!view.enabled),
              class: 'tve-mode-seg__btn' + (!view.enabled ? ' tve-mode-seg__btn--on' : ''),
              onClick: () => setMode(false)
            },
              h('span', { class: 'tve-mode-seg__title' }, 'All tools (default)'),
              h('span', { class: 'tve-mode-seg__sub' }, 'Built-in groups: Shell, File tools, Chats, MCP servers…')
            ),
            h('button', {
              type: 'button',
              role: 'radio',
              'aria-checked': String(!!view.enabled),
              class: 'tve-mode-seg__btn' + (view.enabled ? ' tve-mode-seg__btn--on' : ''),
              onClick: () => setMode(true)
            },
              h('span', { class: 'tve-mode-seg__title' }, 'Simplified view'),
              h('span', { class: 'tve-mode-seg__sub' }, 'Pin your own short categories up front in chats')
            )
          ),
          // Keep the accessible checkbox for tests & assistive tech that target #sp-tool-view
          h('div', { class: 'settings-project__item-row tve-switch-row' },
            h('div', { class: 'settings-project__item-main' },
              h('label', { class: 'settings-project__item-title', for: 'sp-tool-view' }, 'Use simplified categories in chats'),
              h('div', { class: 'settings-project__item-note' },
                'Display-only filter: unpicked tools remain active and keep their Off / Ask / Allow permission.'),
              status ? h('div', { class: 'settings-project__item-status', 'aria-live': 'polite' }, status) : null
            ),
            h('label', { class: 'switch' },
              h('input', {
                id: 'sp-tool-view',
                type: 'checkbox',
                role: 'switch',
                checked: view.enabled,
                'aria-checked': view.enabled ? 'true' : 'false',
                onChange: (e) => setMode(!!e.currentTarget.checked)
              }),
              h('span', { class: 'switch__track', 'aria-hidden': 'true' }, h('span', { class: 'switch__thumb' }))
            )
          ),
          // Coverage summary bar so the user immediately sees what is shown vs tucked under "All tools".
          view.enabled
            ? h('div', { class: 'tve-summary' + (active ? ' tve-summary--active' : ' tve-summary--pending') },
                h('div', { class: 'tve-summary__stats' },
                  h('span', { class: 'tve-summary__pill tve-summary__pill--primary' },
                    active
                      ? stats.shownTools + ' of ' + (stats.totalTools || stats.shownTools) + ' tools pinned in ' + stats.activeCategories + (stats.activeCategories === 1 ? ' category' : ' categories')
                      : 'No tools pinned yet — chats still show all ' + stats.totalTools + ' tools'
                  ),
                  active && stats.hiddenTools > 0
                    ? h('span', { class: 'tve-summary__pill' },
                        '+' + stats.hiddenTools + ' more stay active under “All tools”'
                      )
                    : null
                ),
                h('p', { class: 'tve-summary__note' },
                  active
                    ? 'Chats open on your Simplified categories. Tap “All (' + stats.totalTools + ')” in the chat Tools header anytime to see every tool.'
                    : 'Pick a starter preset below or add a category and choose at least one tool to activate Simplified view.'
                )
              )
            : null
        )
      )
    ),

    // 2. Starter presets + Custom categories editor when Simplified view is enabled.
    view.enabled ? h('div', { class: 'group settings-project__section' },
      h('div', { class: 'group__title settings-project__section-title tve-head' },
        h('span', null, 'Categories'),
        h('span', { class: 'tve-head__count' }, categories.length + ' / ' + MAX_CATEGORIES)
      ),
      // Quick-start presets bar (always available when empty, or in a compact disclosure when categories exist)
      !anyTools
        ? h('div', { class: 'tve-presets' },
            h('div', { class: 'tve-presets__head' },
              h('span', { class: 'tve-presets__title' }, 'Quick start with a preset'),
              h('span', { class: 'tve-presets__sub' }, 'Populates ready-made categories that you can rename or edit:')
            ),
            h('div', { class: 'tve-presets__grid' },
              TOOL_VIEW_PRESETS.map((preset) =>
                h('button', {
                  key: preset.id,
                  type: 'button',
                  class: 'tve-preset-card',
                  onClick: () => applyPreset(preset)
                },
                  h('span', { class: 'tve-preset-card__label' }, preset.label),
                  h('span', { class: 'tve-preset-card__desc' }, preset.description),
                  h('span', { class: 'tve-preset-card__cats' },
                    preset.categories.map((c) => c.name + ' (' + c.tools.length + ')').join(' · ')
                  )
                )
              )
            )
          )
        : null,
      categories.length && !anyTools
        ? h('p', { class: 'tve-hint' }, 'Chats show every tool until at least one category has a tool.')
        : null,
      categories.length
        ? h('ol', { class: 'tve-list' }, categories.map(renderCategory))
        : h('div', { class: 'tve-empty' },
            h('p', { class: 'tve-empty__title' }, 'No custom categories yet'),
            h('p', { class: 'tve-empty__note' }, 'Tap a preset above for a 1-tap setup, or tap “+ Add category” below to build your own from scratch.')
          ),
      h('div', { class: 'tve-footer-bar' },
        categories.length < MAX_CATEGORIES
          ? h('button', { class: 'btn btn--primary tve-add', type: 'button', onClick: addCategory }, '+ Add category')
          : null,
        anyTools
          ? h('details', { class: 'tve-presets-more' },
              h('summary', { class: 'btn btn--ghost tve-presets-more__btn' }, 'Replace with preset…'),
              h('div', { class: 'tve-presets-more__menu' },
                TOOL_VIEW_PRESETS.map((preset) =>
                  h('button', {
                    key: preset.id,
                    type: 'button',
                    class: 'tve-preset-card tve-preset-card--compact',
                    onClick: (e) => {
                      const details = e.currentTarget.closest('details');
                      if (details) details.open = false;
                      applyPreset(preset);
                    }
                  },
                    h('span', { class: 'tve-preset-card__label' }, preset.label),
                    h('span', { class: 'tve-preset-card__cats' },
                      preset.categories.map((c) => c.name).join(' · ')
                    )
                  )
                )
              )
            )
          : null
      )
    ) : null,

    // 3. Live chat preview so the user sees the exact chat Tools card before leaving Settings.
    view.enabled && active && !loading
      ? h('div', { class: 'group settings-project__section tve-preview-section' },
          h('div', { class: 'group__title settings-project__section-title tve-head' },
            h('span', null, 'Live chat preview'),
            h('div', { class: 'chat-tools-view-seg', role: 'group', 'aria-label': 'Preview tool view' },
              h('button', {
                type: 'button',
                class: 'chat-tools-view-seg__btn' + (!previewAll ? ' is-active' : ''),
                onClick: () => setPreviewAll(false)
              }, 'Simplified (' + stats.shownTools + ')'),
              h('button', {
                type: 'button',
                class: 'chat-tools-view-seg__btn' + (previewAll ? ' is-active' : ''),
                onClick: () => setPreviewAll(true)
              }, 'All (' + stats.totalTools + ')')
            )
          ),
          h('div', { class: 'tve-preview-card' },
            h(ToolTree, {
              key: previewAll ? 'preview-all' : 'preview-simp',
              groups: previewGroups,
              collapsedByDefault: false
            })
          )
        )
      : null
  );
}
