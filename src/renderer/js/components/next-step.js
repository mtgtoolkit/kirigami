/**
 * "What next" footer shown at the end of every main view (spec §8.1), e.g.
 * `nextStep({ text: '62 cards ready', actionLabel: 'Make PDF', onAction: () => ctx.navigate('pdf') })`.
 *
 * @module components/next-step
 */

import { h, icon, button } from '../core/ui.js';

/**
 * @param {object} options
 * @param {unknown} options.text main sentence (string or node)
 * @param {unknown} [options.detail] optional secondary line
 * @param {string} [options.actionLabel] primary button label (button hidden without `onAction`)
 * @param {() => any} [options.onAction]
 * @param {string} [options.icon] leading icon (default 'check-circle')
 * @param {'success'|'neutral'|'warning'} [options.tone] icon colour (default 'success')
 * @param {boolean} [options.disabled] disable the action
 * @param {{ label: string, onClick: () => any, icon?: string }} [options.secondary] extra ghost button
 * @returns {HTMLElement}
 */
export function nextStep({ text, detail, actionLabel = 'Continue', onAction, icon: iconName = 'check-circle', tone = 'success', disabled = false, secondary } = {}) {
  return h('div', { class: ['next-step', `next-step-${tone}`], role: 'region', attrs: { 'aria-label': 'Next step' } },
    h('span.next-step-icon', icon(iconName, { size: 20 })),
    h('div.next-step-text',
      h('div.next-step-title', text),
      detail && h('div.next-step-detail', detail)),
    h('div.next-step-actions',
      secondary && button({ label: secondary.label, icon: secondary.icon, variant: 'ghost', onClick: secondary.onClick }),
      typeof onAction === 'function' && button({ label: actionLabel, variant: 'primary', size: 'lg', iconRight: 'arrow-right', disabled, onClick: onAction })));
}

export default nextStep;
