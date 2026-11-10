// mouaif web — the first step of adding a provider: choose how to connect.
import { h, Fragment } from 'preact';
import { PROVIDER_CHOICE_GROUPS } from '../providerChoices.js';

export function SettingsProviderPicker() {
  return h(Fragment, null,
    h('div', { class: 'view-head' },
      h('a', { href: '#/settings/providers', class: 'view-back', 'aria-label': 'Back to providers' }, '←'),
      h('h2', { class: 'view-title' }, 'Add provider')
    ),
    h('section', null,
      PROVIDER_CHOICE_GROUPS.map((group) => h(Fragment, { key: group.title },
        h('h3', { class: 'provider-picker__group' }, group.title),
        h('ul', { class: 'providers__list', 'aria-label': group.title },
          group.choices.map((choice) => h('li', { class: 'provider-row', key: choice.key },
            h('a', { class: 'provider-row__main', href: '#/settings/providers/new/' + encodeURIComponent(choice.key) },
              h('div', { class: 'provider-row__body' },
                h('div', { class: 'provider-row__name' }, choice.label),
                h('div', { class: 'provider-row__meta' }, choice.detail)
              ),
              h('div', { class: 'provider-row__chev' }, '›')
            )
          ))
        )
      ))
    )
  );
}
