/* OPALkit page helpers — one home for what every page's inline script used
 * to redefine. Loaded by layouts/base.html after htmx.
 *
 * - getHeaders(): JSON headers for fetch() against /api (identity rides in
 *   the session cookie; no request header ever confers identity).
 * - The part-search widget: a .part-search-container holding an
 *   .part-search-input (hx-get="/parts/search" into a .part-search-dropdown),
 *   a hidden input for the chosen id, and a .part-search-selected readout.
 *   components/part_search_results.html renders the rows and calls
 *   selectPart(this); the clear control calls clearPartSelection(prefix).
 */
(function () {
    'use strict';

    window.getHeaders = function () {
        return { 'Content-Type': 'application/json' };
    };

    window.selectPart = function (el) {
        const container = el.closest('.part-search-container') || el.closest('.part-search-dropdown').parentElement;
        const hiddenInput = container.querySelector('input[type="hidden"]');
        const searchInput = container.querySelector('.part-search-input');
        const dropdown = container.querySelector('.part-search-dropdown');
        const selected = container.querySelector('.part-search-selected');
        const partId = el.dataset.partId;
        const partName = el.dataset.partName;
        const partPn = el.dataset.partPn;

        hiddenInput.value = partId;
        selected.querySelector('.part-id').textContent = partId;
        selected.querySelector('.part-name').textContent = partPn ? `${partPn} - ${partName}` : partName;
        selected.style.display = 'flex';
        searchInput.style.display = 'none';
        dropdown.classList.remove('active');
        dropdown.innerHTML = '';
        container.dispatchEvent(new CustomEvent('opal:part-selected', { bubbles: true, detail: { partId, partName, partPn, trackingType: el.dataset.trackingType } }));
    };

    // `prefix` names the widget: its input is #<prefix>-part-search or
    // #<prefix>-search (two conventions in the templates); either resolves.
    window.clearPartSelection = function (prefix) {
        const input = document.getElementById(prefix + '-part-search') || document.getElementById(prefix + '-search');
        if (!input) return;
        const container = input.closest('.part-search-container');
        const hiddenInput = container.querySelector('input[type="hidden"]');
        const searchInput = container.querySelector('.part-search-input');
        const selected = container.querySelector('.part-search-selected');
        hiddenInput.value = '';
        searchInput.value = '';
        searchInput.style.display = 'block';
        selected.style.display = 'none';
        searchInput.focus();
    };

    // Results arrive by HTMX swap: show the dropdown when it has rows.
    // Loaded in <head>: listen on document (htmx events bubble there).
    document.addEventListener('htmx:afterSwap', function (evt) {
        const t = evt.detail && evt.detail.target;
        if (t && t.classList && t.classList.contains('part-search-dropdown')) {
            t.classList.toggle('active', !!t.innerHTML.trim());
        }
    });

    // Clickable rows: a <tr data-href> navigates on click, unless the click
    // landed on something interactive inside it (a link, button, control).
    // Modifier/middle clicks open in a new tab like a link would.
    document.addEventListener('click', function (evt) {
        const row = evt.target.closest('tr[data-href]');
        if (!row || evt.target.closest('a, button, input, select, textarea, label, [role="menuitem"], summary')) return;
        if (window.getSelection && String(window.getSelection())) return;
        const href = row.dataset.href;
        if (evt.metaKey || evt.ctrlKey || evt.button === 1) window.open(href, '_blank');
        else window.location.href = href;
    });
    document.addEventListener('auxclick', function (evt) {
        const row = evt.target.closest('tr[data-href]');
        if (row && evt.button === 1 && !evt.target.closest('a, button')) window.open(row.dataset.href, '_blank');
    });

    // Click outside any widget closes every open dropdown.
    document.addEventListener('click', function (evt) {
        if (!evt.target.closest('.part-search-container')) {
            document.querySelectorAll('.part-search-dropdown.active').forEach((d) => d.classList.remove('active'));
        }
    });
})();
