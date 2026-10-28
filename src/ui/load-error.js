// load-error.js
//
// The "couldn't LOAD your notes" state shared by the List, Compact and Kanban
// views. A failed load must never read as "no notes": this shows the real error
// (name + message via textContent - error text is not trusted markup) and a
// Retry that re-runs the load.

/**
 * @param {{ error: any, onRetry?: () => void }} loadError
 * @param {{ className: string, headingClass?: string, bodyClass?: string }} classes
 *   view-specific classes so each view keeps its own empty-state spacing
 * @returns {HTMLElement}
 */
export function buildLoadErrorState({ error, onRetry }, { className, headingClass, bodyClass }) {
  const el = document.createElement('div');
  el.className = `${className} sc-list-error`;
  el.setAttribute('role', 'alert');
  const h = document.createElement('p');
  if (headingClass) h.className = headingClass;
  h.textContent = 'Couldn’t load your notes';
  const p = document.createElement('p');
  if (bodyClass) p.className = bodyClass;
  p.setAttribute('data-load-error', '');
  p.textContent = `${error?.name || 'Error'}: ${error?.message || String(error)}`;
  const retry = document.createElement('button');
  retry.type = 'button';
  retry.className = 'sc-btn sc-btn--primary sc-load-retry';
  retry.textContent = 'Retry';
  retry.addEventListener('click', () => onRetry?.());
  el.append(h, p, retry);
  return el;
}
