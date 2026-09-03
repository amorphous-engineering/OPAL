/**
 * OPAL Execution Document — the multiplayer document.
 *
 * One server-rendered document; this file keeps it live:
 * - 5s state poll (the primary channel — SSE accelerates it but MCP-driven
 *   mutations only surface through the poll)
 * - in-place row/presence updates (spatial stability: rows swap, the
 *   document never reflows)
 * - focus is local: arrows/j/k/click move the highlight and the docked bar
 *   and broadcast nothing. Presence is the CLAIM: an explicit button that
 *   marks the step a user is working on (one per user, released by
 *   pressing again or by completing the step). Reading never moves it.
 * - issue capture, evidence attach, lightbox, docked bar
 */

/* global formatApiError, renderMarkdown, htmx */

(function () {
    'use strict';

    const cfg = window.OPAL_EXEC || {};
    const instanceId = cfg.instanceId;
    if (!instanceId) return;

    const POLL_MS = 5000;
    const storageKey = `opal_execdoc_${instanceId}`;

    let lastState = null;
    let pollTimer = null;
    const appliedRowSigs = {};

    // ---------- helpers ----------

    function getHeaders() {
        return { 'Content-Type': 'application/json' };
    }

    function uploadHeaders() {
        // FormData bodies need fetch to set its own multipart boundary.
        return {};
    }

    function apiUrl(path) {
        return `/api/procedure-instances/${instanceId}${path}`;
    }

    function pageUrl(path) {
        return `/executions/${instanceId}${path}`;
    }

    function toast(html, opts) {
        // Basecoat toaster (layouts/base.html). Its title is inserted as
        // markup, so server error details that echo user input are escaped
        // here; opts.html is reserved for trusted, server-generated markup.
        const toaster = document.getElementById('toaster');
        if (!toaster || typeof toaster.toast !== 'function') return;
        const title = (opts && opts.html) ? html : escapeHtml(html);
        toaster.toast({
            category: opts && opts.error ? 'error' : 'info',
            title: title,
            duration: opts && opts.sticky ? 8000 : 3500,
        });
    }

    function toastError(detail, fallback) {
        toast(formatApiError(detail, fallback), { error: true });
    }

    // ---------- persisted expand/collapse ----------

    function loadToggles() {
        try { return JSON.parse(localStorage.getItem(storageKey) || '{}'); }
        catch (_) { return {}; }
    }

    function saveToggle(key, value) {
        const t = loadToggles();
        t[key] = value;
        localStorage.setItem(storageKey, JSON.stringify(t));
    }

    function applyStoredToggles() {
        const t = loadToggles();
        for (const [key, expanded] of Object.entries(t)) {
            if (key.startsWith('op_')) {
                const card = document.getElementById(key.replace('op_', 'op-'));
                if (card) setOpExpanded(card, expanded, false);
            } else if (key.startsWith('step_')) {
                const row = document.getElementById(key.replace('step_', 'step-'));
                if (row) {
                    const body = row.querySelector('.doc-step-body');
                    if (body) body.hidden = !expanded;
                }
            }
        }
    }

    // OP cards are native <details> in a Basecoat accordion. Programmatic
    // opens (restore, focus-follow, jump) must not be persisted as a user
    // choice. The toggle event is dispatched asynchronously, so the mute is
    // a per-card flag that the handler itself consumes.
    function setOpExpanded(card, expanded, persist) {
        if (card.open === expanded) return;
        if (!persist) card._muteToggle = true;
        card.open = expanded;
        if (persist) saveToggle(`op_${card.dataset.opOrder}`, expanded);
    }

    window.onOpToggle = function (card) {
        if (card._muteToggle) { card._muteToggle = false; return; }
        saveToggle(`op_${card.dataset.opOrder}`, card.open);
    };

    window.toggleStepBody = function (order) {
        const row = document.getElementById(`step-${order}`);
        if (!row) return;
        const body = row.querySelector('.doc-step-body');
        if (!body) return;
        body.hidden = !body.hidden;
        saveToggle(`step_${order}`, !body.hidden);
    };

    // ---------- partial refreshers ----------

    async function refreshStepRow(order) {
        try {
            const resp = await fetch(pageUrl(`/step-row/${order}`));
            if (!resp.ok) return;
            const html = await resp.text();
            const row = document.getElementById(`step-${order}`);
            if (!row) return;
            const wasOpen = !!row.querySelector('.doc-step-body:not([hidden])');
            const tpl = document.createElement('template');
            tpl.innerHTML = html.trim();
            const fresh = tpl.content.firstElementChild;
            if (!fresh) return;
            if (wasOpen) {
                const body = fresh.querySelector('.doc-step-body');
                if (body) body.hidden = false;
            }
            row.replaceWith(fresh);
            if (focusedOrder !== null && parseInt(fresh.dataset.order) === focusedOrder) {
                fresh.classList.add('is-focused');
            }
            if (myClaimOrder !== null && parseInt(fresh.dataset.order) === myClaimOrder) {
                fresh.classList.add('is-claimed');
            }
            if (typeof renderMarkdown === 'function') renderMarkdown();
            loadStepKitAvailability();
        } catch (e) { console.error('execdoc: row refresh failed', e); }
    }

    // The docked bar is the control surface for the focused step; it is on
    // unless a stored preference says otherwise.
    function dockbarVisible() {
        return localStorage.getItem('opal_dockbar') !== '0';
    }

    function applyDockbarPref() {
        document.body.classList.toggle('dockbar-off', !dockbarVisible());
        const toggle = document.getElementById('dockbar-toggle');
        if (toggle) toggle.checked = dockbarVisible();
    }

    window.toggleDockbar = function () {
        localStorage.setItem('opal_dockbar', dockbarVisible() ? '0' : '1');
        applyDockbarPref();
        if (dockbarVisible()) refreshDockbar();
    };

    function positionDockbar() {
        const bar = document.getElementById('dockbar');
        if (!bar) return;
        const doc = document.getElementById('exec-doc');
        if (doc) {
            // Align the bar with the document column, not the viewport.
            const rect = doc.getBoundingClientRect();
            bar.style.left = `${rect.left}px`;
            bar.style.width = `${rect.width}px`;
            bar.style.transform = 'none';
        } else {
            bar.style.left = '';
            bar.style.width = '';
            bar.style.transform = '';
        }
    }
    window.addEventListener('resize', positionDockbar);

    async function refreshDockbar(opts = {}) {
        if (!dockbarVisible() && !opts.force) return;
        try {
            const url = pageUrl('/dockbar') + (focusedOrder !== null ? `?step=${focusedOrder}` : '');
            const resp = await fetch(url);
            if (!resp.ok) return;
            const html = await resp.text();
            const node = document.getElementById('dockbar');
            if (!node) return;
            const tpl = document.createElement('template');
            tpl.innerHTML = html.trim();
            const fresh = tpl.content.firstElementChild;
            if (fresh) node.replaceWith(fresh);
            document.body.classList.toggle(
                'has-dockbar',
                !!document.querySelector('#dockbar .dockbar')
            );
            positionDockbar();
        } catch (e) { console.error('execdoc: dockbar refresh failed', e); }
    }

    async function refreshRail() {
        const rail = document.getElementById('exec-rail-content');
        if (!rail) return;
        try {
            const resp = await fetch(pageUrl('/rail'));
            if (!resp.ok) return;
            const html = await resp.text();
            const tpl = document.createElement('template');
            tpl.innerHTML = html.trim();
            const fresh = tpl.content.firstElementChild;
            if (fresh) rail.replaceWith(fresh);
        } catch (e) { console.error('execdoc: rail refresh failed', e); }
    }

    // ---------- state poll ----------

    function stepSignature(s) {
        // Cursors are NOT part of the row signature: presence chips update
        // in place (renderPresence) — a colleague's cursor move must never
        // re-render a row someone is typing into.
        return JSON.stringify([
            s.status,
            s.holds.map((h) => h.issue_number + h.disposition_state),
            s.attachments,
            // Count + latest timestamp: a note appended remotely (MCP, another
            // operator) re-renders the row's note trail on the next poll.
            s.notes.length,
            s.notes.length ? s.notes[s.notes.length - 1].created_at : null,
        ]);
    }

    // A row is busy while its control surface holds focus or unsaved input —
    // swapping it would destroy the operator's half-entered data.
    function rowBusy(order) {
        const row = document.getElementById(`step-${order}`);
        if (!row) return false;
        const active = document.activeElement;
        if (active && row.contains(active)
            && ['INPUT', 'TEXTAREA', 'SELECT'].includes(active.tagName)) return true;
        return Array.from(row.querySelectorAll('input, textarea')).some((f) => {
            if (f.type === 'checkbox') return f.checked !== f.defaultChecked;
            if (f.type === 'hidden') return false;
            return f.value !== f.defaultValue;
        });
    }

    // The bar refetches only when the focused step's commitment state moves —
    // never on presence/evidence churn (half-entered field values survive).
    function barSignature(s) {
        return JSON.stringify([s.status, s.holds.map((h) => h.issue_number + h.disposition_state)]);
    }

    function applyState(state) {
        const prev = lastState;
        lastState = state;

        // Header progress.
        const progress = document.querySelector('[data-progress]');
        if (progress) {
            progress.textContent = `${state.instance.progress.done}/${state.instance.progress.total}`;
        }
        const fill = document.querySelector('[data-progress-fill]');
        if (fill && state.instance.progress.total) {
            const pct = (state.instance.progress.done / state.instance.progress.total) * 100;
            fill.style.width = `${pct}%`;
            const bar = document.querySelector('[data-progressbar]');
            if (bar) bar.setAttribute('aria-valuenow', String(Math.round(pct)));
        }

        renderPresence(state);

        // Step diffs → swap changed rows in place. appliedRowSigs tracks what
        // each DOM row currently reflects: a swap skipped while the operator
        // types retries on the next poll instead of being lost.
        if (prev) {
            for (const s of state.steps) {
                if (!document.getElementById(`step-${s.order}`)) continue;
                const sig = stepSignature(s);
                if (appliedRowSigs[s.order] === undefined) { appliedRowSigs[s.order] = sig; continue; }
                if (appliedRowSigs[s.order] !== sig && !rowBusy(s.order)) {
                    appliedRowSigs[s.order] = sig;
                    refreshStepRow(s.order);
                }
            }
            // OP progress counters.
            updateOpProgress(state);
            // Rail refresh when holds or evidence change.
            const holdsSig = JSON.stringify(state.holds);
            const attachSig = JSON.stringify(state.steps.map((s) => s.attachments));
            const prevHoldsSig = JSON.stringify(prev.holds);
            const prevAttachSig = JSON.stringify(prev.steps.map((s) => s.attachments));
            if (holdsSig !== prevHoldsSig || attachSig !== prevAttachSig) refreshRail();

            // The focused step's commitment state moved remotely → refetch bar.
            if (focusedOrder !== null) {
                const prevFocused = prev.steps.find((s) => s.order === focusedOrder);
                const liveFocused = state.steps.find((s) => s.order === focusedOrder);
                if (prevFocused && liveFocused
                    && barSignature(prevFocused) !== barSignature(liveFocused)) {
                    refreshDockbar();
                }
            }
        } else {
            state.steps.forEach((s) => { appliedRowSigs[s.order] = stepSignature(s); });
            updateOpProgress(state);
        }
    }

    function activeHolds(s) {
        return (s.holds || []).filter((h) => h.disposition_state === 'undispositioned');
    }

    function updateOpProgress(state) {
        const leavesByParent = {};
        const holdsByParent = {};
        for (const s of state.steps) {
            if (s.parent_order === null || s.parent_order === undefined) continue;
            const bucket = leavesByParent[s.parent_order] || (leavesByParent[s.parent_order] = { done: 0, total: 0 });
            bucket.total += 1;
            if (['completed', 'signed_off', 'skipped'].includes(s.status)) bucket.done += 1;
            const hb = holdsByParent[s.parent_order] || (holdsByParent[s.parent_order] = []);
            hb.push(...activeHolds(s));
        }
        for (const s of state.steps) {
            if (s.level !== 0) continue;
            const card = document.getElementById(`op-${s.order}`);
            if (!card) continue;
            const el = card.querySelector('[data-op-progress]');
            if (!el) continue;
            const bucket = leavesByParent[s.order] || { done: ['completed', 'signed_off', 'skipped'].includes(s.status) ? 1 : 0, total: 1 };
            const done = ['completed', 'signed_off', 'skipped'].includes(s.status);
            el.textContent = `${bucket.done}/${bucket.total}`;
            el.classList.toggle('is-done', done);
            const mini = document.querySelector(`[data-minimap-op="${s.order}"] [data-minimap-prog]`);
            if (mini) {
                mini.textContent = `${bucket.done}/${bucket.total}`;
                mini.classList.toggle('is-done', done);
            }
            // HELD BY blockline: own + child holds, both kinds ('raised'
            // containment and 'bound' resolve-by — a bound child hold gates
            // the OP's completion), deduped; hidden when the last disposition
            // is signed. Same derivation as op_holds_by_order server-side (F4).
            const holdEl = card.querySelector('[data-op-holds]');
            if (holdEl) {
                const seen = new Set();
                const holds = activeHolds(s).concat(holdsByParent[s.order] || [])
                    .filter((h) => !seen.has(h.issue_id) && seen.add(h.issue_id));
                if (holds.length) {
                    holdEl.innerHTML = 'HELD BY ' + holds.map((h) =>
                        `<a href="/issues/${h.issue_id}" onclick="event.stopPropagation()">${h.issue_number}</a>`
                    ).join(' · ');
                    holdEl.hidden = false;
                } else {
                    holdEl.hidden = true;
                    holdEl.innerHTML = '';
                }
            }
        }
    }

    function minutesSince(iso) {
        if (!iso) return 0;
        return Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
    }

    function rosterRow(r, myId) {
        const row = document.createElement('div');
        row.className = 'roster-row mono'
            + (r.stale ? ' is-stale' : '')
            + (r.user_id === myId ? ' is-self' : '');
        let label = r.name || r.initials || '?';
        if (r.step_number) label += ` @${r.step_number}`;
        row.textContent = label;
        if (r.step_order !== null && r.step_order !== undefined) {
            row.onclick = () => jumpToStep(r.step_order);
        }
        return row;
    }

    function renderPresence(state) {
        const myId = window.OPAL_USER_ID;
        const roster = state.roster;
        const me = roster.find((r) => r.user_id === myId);
        myClaimOrder = me && me.step_order !== null && me.step_order !== undefined ? me.step_order : null;
        syncClaimButtons();

        const railRoster = document.querySelector('[data-rail-roster]');
        if (railRoster) {
            railRoster.innerHTML = '';
            if (!roster.length) {
                const empty = document.createElement('div');
                empty.className = 'empty-line mono';
                empty.textContent = 'Online — none';
                railRoster.appendChild(empty);
            } else {
                for (const r of roster) railRoster.appendChild(rosterRow(r, myId));
            }
        }

        // Per-step cursor chips in the right gutter.
        for (const s of state.steps) {
            const row = document.getElementById(`step-${s.order}`);
            if (!row) continue;
            const slot = row.querySelector('[data-cursors]');
            if (!slot) continue;
            slot.innerHTML = '';
            for (const c of s.cursors) {
                const chip = document.createElement('span');
                chip.className = 'badge cursor-chip'
                    + (c.user_id === myId ? ' is-self' : '')
                    + (c.stale ? ' is-stale' : '');
                chip.dataset.variant = c.user_id === myId ? 'primary' : 'outline';
                chip.textContent = c.initials || '?';
                chip.title = c.name || '';
                slot.appendChild(chip);
            }
        }
    }

    async function pollState() {
        try {
            const resp = await fetch(apiUrl('/state'));
            if (!resp.ok) return;
            applyState(await resp.json());
        } catch (e) { /* transient network errors: next tick retries */ }
    }

    function pollNow() {
        pollState();
    }

    function startPolling() {
        if (pollTimer) clearInterval(pollTimer);
        pollTimer = setInterval(pollState, POLL_MS);
        pollState();
    }

    // ---------- jump-follow ----------

    window.jumpToStep = function (order) {
        const row = document.getElementById(`step-${order}`) || document.getElementById(`op-${order}`);
        if (!row) return;
        const card = row.closest('.op-card');
        if (card && !card.open) setOpExpanded(card, true, false);
        row.scrollIntoView({ behavior: 'smooth', block: 'center' });
        row.classList.add('pulse');
        setTimeout(() => row.classList.remove('pulse'), 1600);
    };

    window.toggleRail = function () {
        const layout = document.getElementById('exec-doc-layout');
        if (layout) layout.classList.toggle('rail-open');
    };

    window.railFocusStep = function (order) {
        const group = document.getElementById(`rail-step-${order}`);
        if (group) {
            group.scrollIntoView({ behavior: 'smooth', block: 'center' });
            group.classList.add('pulse');
            setTimeout(() => group.classList.remove('pulse'), 1600);
        }
    };

    // ---------- focus (presence) ----------

    let focusedOrder = null;

    function focusableRows() {
        return Array.from(document.querySelectorAll('#exec-doc .doc-step[data-order]'));
    }

    // ---------- claim (presence) ----------

    let myClaimOrder = cfg.myCursorOrder !== null && cfg.myCursorOrder !== undefined
        ? cfg.myCursorOrder : null;

    function syncClaimButtons() {
        // The accent rail marks the claimed row; focus only carries the docked bar.
        document.querySelectorAll('#exec-doc .doc-step.is-claimed').forEach((row) => {
            if (parseInt(row.dataset.order) !== myClaimOrder) row.classList.remove('is-claimed');
        });
        if (myClaimOrder !== null) {
            const row = document.getElementById(`step-${myClaimOrder}`);
            if (row) row.classList.add('is-claimed');
        }
        document.querySelectorAll('[data-claim]').forEach((btn) => {
            const mine = parseInt(btn.dataset.claim) === myClaimOrder;
            btn.dataset.variant = mine ? 'primary' : 'outline';
            btn.setAttribute('aria-pressed', mine ? 'true' : 'false');
            btn.textContent = mine ? 'CLAIMED' : 'CLAIM';
            btn.title = mine ? 'Release this step' : 'Mark this step as where you are working';
        });
    }

    async function postClaim(order) {
        try {
            const resp = await fetch(apiUrl('/focus'), {
                method: 'POST', headers: getHeaders(),
                body: JSON.stringify({ step_number: order }),
            });
            if (resp.ok) { myClaimOrder = order; syncClaimButtons(); pollNow(); }
            else { const err = await resp.json().catch(() => ({})); toastError(err.detail, 'Could not claim step'); }
        } catch (e) { toastError(null, 'Network error'); }
    }

    async function releaseClaim() {
        try {
            const resp = await fetch(apiUrl('/focus'), { method: 'DELETE', headers: getHeaders() });
            if (resp.ok) { myClaimOrder = null; syncClaimButtons(); pollNow(); }
            else toastError(null, 'Could not release claim');
        } catch (e) { toastError(null, 'Network error'); }
    }

    window.toggleClaim = function (order) {
        if (myClaimOrder === order) releaseClaim();
        else postClaim(order);
    };

    function setFocus(order, opts = {}) {
        const row = document.getElementById(`step-${order}`);
        if (!row) return;
        if (focusedOrder !== null && focusedOrder !== order) {
            const prevRow = document.getElementById(`step-${focusedOrder}`);
            if (prevRow) prevRow.classList.remove('is-focused');
        }
        const moved = focusedOrder !== order;
        focusedOrder = order;
        row.classList.add('is-focused');
        const card = row.closest('.op-card');
        if (card && !card.open) setOpExpanded(card, true, false);
        if (opts.scroll) row.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        if (moved || opts.force) refreshDockbar();
    }

    window.onStepRowClick = function (order) {
        setFocus(order);
        toggleStepBody(order);
    };

    document.addEventListener('keydown', (e) => {
        if (e.target && (['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName) || e.target.isContentEditable)) return;
        if (document.querySelector('dialog[open]')) return;
        if (e.key === 'Enter' && focusedOrder !== null) {
            e.preventDefault();
            toggleStepBody(focusedOrder);
            return;
        }
        const down = e.key === 'j' || e.key === 'ArrowDown';
        const up = e.key === 'k' || e.key === 'ArrowUp';
        if (!down && !up) return;
        e.preventDefault();
        const rows = focusableRows();
        if (!rows.length) return;
        let idx = rows.findIndex((r) => parseInt(r.dataset.order) === focusedOrder);
        if (idx === -1) idx = down ? -1 : rows.length;
        idx = Math.min(rows.length - 1, Math.max(0, idx + (down ? 1 : -1)));
        setFocus(parseInt(rows[idx].dataset.order), { scroll: true });
    });

    // ---------- step actions ----------

    function collectCaptureData(container) {
        if (!container) return { data: null, errors: [] };
        const fields = container.querySelectorAll('[data-capture-field]');
        if (!fields.length) return { data: null, errors: [] };
        const data = {};
        const errors = [];
        fields.forEach((f) => {
            const name = f.dataset.captureField;
            if (f.type === 'checkbox') data[name] = f.checked;
            else if (f.type === 'number') data[name] = f.value ? parseFloat(f.value) : null;
            else if (f.dataset.captureFieldType === 'photo') {
                let ids = [];
                try { ids = JSON.parse(f.value || '[]'); } catch (_) { ids = []; }
                if (!Array.isArray(ids)) ids = ids ? [ids] : [];
                data[name] = ids.length ? ids : null;
            } else data[name] = f.value || null;
        });
        fields.forEach((f) => {
            const name = f.dataset.captureField;
            const val = data[name];
            if (f.hasAttribute('required')
                && (val === null || val === '' || val === undefined
                    || (Array.isArray(val) && val.length === 0))) {
                const label = f.closest('.bar-field')?.querySelector('.bar-field-label');
                errors.push((label ? label.textContent.replace(/\s*\*\s*$/, '').trim() : name) + ' is required');
            }
            if (f.type === 'number' && val !== null && val !== undefined && val !== '') {
                const num = parseFloat(val);
                if (f.hasAttribute('min') && num < parseFloat(f.min)) errors.push(`${name}: ${num} below minimum ${f.min}`);
                if (f.hasAttribute('max') && num > parseFloat(f.max)) errors.push(`${name}: ${num} above maximum ${f.max}`);
            }
        });
        return { data, errors };
    }

    window.completeStep = async function (order, btn) {
        const body = {};
        let container = btn ? btn.closest('.doc-step-body, .dockbar') : null;
        if (!container) {
            const bar = document.getElementById('dockbar');
            if (bar && bar.dataset.barOrder === String(order)) container = bar.querySelector('.dockbar');
        }
        if (container) {
            const { data, errors } = collectCaptureData(container);
            if (errors.length) {
                toastError(errors, 'Cannot complete');
                return;
            }
            if (data) body.data_captured = data;
        }
        try {
            const resp = await fetch(apiUrl(`/steps/${order}/complete`), {
                method: 'POST', headers: getHeaders(), body: JSON.stringify(body),
            });
            if (resp.ok) {
                if (myClaimOrder === parseInt(order)) releaseClaim();
                await refreshDockbar({ force: true });
                await refreshStepRow(order);
                pollNow();
            } else {
                const err = await resp.json();
                toastError(err.detail, 'Failed to complete step');
            }
        } catch (e) { toastError(null, 'Network error'); }
    };

    window.signoffStep = async function (order) {
        try {
            const resp = await fetch(apiUrl(`/steps/${order}/signoff`), { method: 'POST', headers: getHeaders() });
            if (resp.ok) {
                if (myClaimOrder === parseInt(order)) releaseClaim();
                await refreshDockbar();
                await refreshStepRow(order);
                pollNow();
            } else {
                const err = await resp.json();
                toastError(err.detail, 'Failed to sign off step');
            }
        } catch (e) { toastError(null, 'Network error'); }
    };

    // Append-only: posts one timestamped note and clears the input. Empty
    // input is a no-op (blur fires on every focus change).
    window.addStepNote = async function (order, input) {
        const body = input.value.trim();
        if (!body) return;
        try {
            const resp = await fetch(apiUrl(`/steps/${order}/notes`), {
                method: 'POST', headers: getHeaders(),
                body: JSON.stringify({ body }),
            });
            if (!resp.ok) {
                const err = await resp.json().catch(() => ({}));
                toastError(err.detail, 'Failed to add note');
                return;
            }
            input.value = '';
            input.defaultValue = '';
            await refreshStepRow(order);
            pollNow();
        } catch (e) { toastError(null, 'Network error'); }
    };

    window.abortExecution = async function () {
        const wo = cfg.workOrder || 'this work order';
        if (!confirm(`Abort ${wo}? In-progress work stops, the work order closes as ABORTED, and it cannot be resumed.`)) return;
        try {
            const resp = await fetch(apiUrl(''), {
                method: 'PATCH', headers: getHeaders(), body: JSON.stringify({ status: 'aborted' }),
            });
            if (resp.ok) window.location.reload();
            else {
                const err = await resp.json();
                toastError(err.detail, 'Failed to abort execution');
            }
        } catch (e) { toastError(null, 'Network error'); }
    };

    async function ensureJoined() {
        // Opening the document is presence — no JOIN ceremony.
        try { await fetch(apiUrl('/join'), { method: 'POST', headers: getHeaders() }); }
        catch (e) { /* presence is best-effort */ }
    }

    window.addEventListener('pagehide', () => {
        navigator.sendBeacon(apiUrl('/leave'));
    });

    // ---------- issue capture ----------

    window.showIssueModal = function (order, label) {
        document.getElementById('anomaly-step').value = order;
        document.getElementById('anomaly-step-label').textContent = label;
        document.getElementById('anomaly-form').reset();
        document.getElementById('anomaly-step').value = order;
        // RESOLVE BY default = the raised step; name its consequence.
        const boundaryDefault = document.querySelector('#anomaly-boundary option[value=""]');
        if (boundaryDefault) boundaryDefault.textContent = `this step — holds ${label} COMPLETE`;
        document.getElementById('anomaly-error').hidden = true;
        document.getElementById('anomaly-modal').showModal();
        document.getElementById('anomaly-title').focus();
    };

    window.hideAnomalyModal = function () {
        document.getElementById('anomaly-modal').close();
    };
    window.showAnomalyModal = window.showIssueModal;

    window.submitAnomaly = async function (event) {
        event.preventDefault();
        const errorDiv = document.getElementById('anomaly-error');
        errorDiv.hidden = true;
        const order = document.getElementById('anomaly-step').value;
        const boundary = document.getElementById('anomaly-boundary').value;
        const payload = {
            title: document.getElementById('anomaly-title').value,
            priority: document.getElementById('anomaly-priority').value,
            should_be: document.getElementById('anomaly-should-be').value || null,
            actual: document.getElementById('anomaly-is').value || null,
            containment: document.getElementById('anomaly-containment').value,
            containment_step_number: boundary ? parseInt(boundary) : null,
        };
        try {
            const resp = await fetch(apiUrl(`/steps/${order}/nc`), {
                method: 'POST', headers: getHeaders(), body: JSON.stringify(payload),
            });
            if (!resp.ok) {
                const err = await resp.json();
                errorDiv.textContent = formatApiError(err.detail, 'Failed to raise issue');
                errorDiv.hidden = false;
                return;
            }
            const issue = await resp.json();

            // Evidence at discovery: photos link to the issue AND the step.
            const files = document.getElementById('anomaly-photos').files;
            const row = document.getElementById(`step-${order}`);
            const seId = row ? row.dataset.seId : '';
            for (const file of files) {
                const fd = new FormData();
                fd.append('file', file);
                fd.append('issue_id', issue.id);
                if (seId) fd.append('step_execution_id', seId);
                fd.append('kind', 'capture');
                await fetch('/api/attachments/upload', { method: 'POST', headers: uploadHeaders(), body: fd });
            }

            const assign = document.getElementById('anomaly-assign').value;
            if (assign) {
                await fetch(`/api/issues/${issue.id}`, {
                    method: 'PATCH', headers: getHeaders(),
                    body: JSON.stringify({ assigned_to_id: parseInt(assign) }),
                });
            }

            hideAnomalyModal();
            toast(`<a href="/issues/${issue.id}">${issue.issue_number}</a> →`, { sticky: true, html: true });
            await refreshStepRow(parseInt(order));
            refreshRail();
            pollNow();
        } catch (e) {
            errorDiv.textContent = 'Network error: ' + e.message;
            errorDiv.hidden = false;
        }
    };

    // ---------- skip ----------

    window.showSkipModal = function (order, title) {
        document.getElementById('skip-step').value = order;
        document.getElementById('skip-step-title').textContent = title;
        document.getElementById('skip-error').hidden = true;
        document.getElementById('skip-modal').showModal();
    };

    window.hideSkipModal = function () {
        document.getElementById('skip-modal').close();
        document.getElementById('skip-form').reset();
    };

    window.submitSkip = async function (event) {
        event.preventDefault();
        const errorDiv = document.getElementById('skip-error');
        errorDiv.hidden = true;
        const order = document.getElementById('skip-step').value;
        try {
            const resp = await fetch(apiUrl(`/steps/${order}/skip`), {
                method: 'POST', headers: getHeaders(),
                body: JSON.stringify({ reason: document.getElementById('skip-reason').value || null }),
            });
            if (resp.ok) {
                hideSkipModal();
                await refreshStepRow(parseInt(order));
                pollNow();
            } else {
                const err = await resp.json();
                errorDiv.textContent = formatApiError(err.detail, 'Failed to skip step');
                errorDiv.hidden = false;
            }
        } catch (e) {
            errorDiv.textContent = 'Network error: ' + e.message;
            errorDiv.hidden = false;
        }
    };

    // ---------- attach (execution captures) ----------

    window.showAttachModal = function (seId, label) {
        document.getElementById('attach-se-id').value = seId || '';
        document.getElementById('attach-step-label').textContent = label ? `to ${label}` : '';
        document.getElementById('attach-closeout-row').hidden = !!seId;
        document.getElementById('attach-error').hidden = true;
        document.getElementById('attach-form').reset();
        document.getElementById('attach-se-id').value = seId || '';
        document.getElementById('attach-modal').showModal();
    };

    window.hideAttachModal = function () {
        document.getElementById('attach-modal').close();
    };

    window.submitAttach = async function (event) {
        event.preventDefault();
        const errorDiv = document.getElementById('attach-error');
        errorDiv.hidden = true;
        const seId = document.getElementById('attach-se-id').value;
        const files = document.getElementById('attach-file').files;
        const note = document.getElementById('attach-note').value.trim();
        const closeout = document.getElementById('attach-closeout').checked;
        if (!files.length) return;
        try {
            for (const file of files) {
                const fd = new FormData();
                fd.append('file', file);
                if (seId) fd.append('step_execution_id', seId);
                else fd.append('procedure_instance_id', instanceId);
                fd.append('kind', !seId && closeout ? 'closeout' : 'capture');
                if (note) fd.append('note', note);
                const resp = await fetch('/api/attachments/upload', {
                    method: 'POST', headers: uploadHeaders(), body: fd,
                });
                if (!resp.ok) {
                    const err = await resp.json().catch(() => ({}));
                    errorDiv.textContent = formatApiError(err.detail, 'Upload failed');
                    errorDiv.hidden = false;
                    return;
                }
            }
            hideAttachModal();
            refreshRail();
            pollNow();
        } catch (e) {
            errorDiv.textContent = 'Network error: ' + e.message;
            errorDiv.hidden = false;
        }
    };

    // ---------- docked-bar photo capture fields ----------

    function renderStepPhotoGallery(container, ids, fieldName) {
        const gallery = container.querySelector('.step-photo-gallery');
        if (!gallery) return;
        gallery.innerHTML = '';
        for (const id of ids) {
            const item = document.createElement('div');
            item.className = 'step-photo-item';
            item.dataset.attachmentId = String(id);
            const img = document.createElement('img');
            img.className = 'step-photo-thumb';
            img.alt = fieldName;
            img.src = `/api/attachments/${id}/download`;
            img.onclick = () => openLightbox(img.src, fieldName);
            item.appendChild(img);
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'btn';
            btn.dataset.variant = 'outline';
            btn.dataset.size = 'xs';
            btn.textContent = 'REMOVE';
            btn.onclick = function () { removeStepPhoto(btn); };
            item.appendChild(btn);
            gallery.appendChild(item);
        }
        const hidden = container.querySelector('input[type="hidden"][data-capture-field]');
        if (hidden) hidden.value = JSON.stringify(ids);
    }

    window.uploadStepPhotos = async function (input) {
        if (!input.files.length) return;
        const container = input.closest('.step-photo-capture');
        if (!container) return;
        const seId = container.dataset.stepExecutionId;
        const fieldName = container.dataset.fieldName;
        const isMultiple = container.dataset.multiple === 'true';
        const hidden = container.querySelector('input[type="hidden"][data-capture-field]');
        let existing = [];
        try { existing = JSON.parse(hidden.value || '[]'); } catch (_) { existing = []; }
        if (!Array.isArray(existing)) existing = existing ? [existing] : [];

        const newIds = [];
        for (const file of input.files) {
            if (!file.type.startsWith('image/')) continue;
            const fd = new FormData();
            fd.append('file', file);
            fd.append('step_execution_id', seId);
            fd.append('kind', 'capture');
            try {
                const r = await fetch('/api/attachments/upload', {
                    method: 'POST', headers: uploadHeaders(), body: fd,
                });
                if (!r.ok) {
                    const err = await r.json().catch(() => ({}));
                    toastError(err.detail, 'Photo upload failed');
                    continue;
                }
                const data = await r.json();
                newIds.push(data.id);
            } catch (e) { toastError(null, 'Network error'); }
        }
        const updated = isMultiple ? [...existing, ...newIds] : newIds.slice(-1);
        renderStepPhotoGallery(container, updated, fieldName);
        input.value = '';
        pollNow();
    };

    window.removeStepPhoto = function (buttonOrItem) {
        const item = buttonOrItem.closest('.step-photo-item');
        if (!item) return;
        const container = item.closest('.step-photo-capture');
        const removeId = parseInt(item.dataset.attachmentId);
        const hidden = container.querySelector('input[type="hidden"][data-capture-field]');
        let existing = [];
        try { existing = JSON.parse(hidden.value || '[]'); } catch (_) { existing = []; }
        if (!Array.isArray(existing)) existing = existing ? [existing] : [];
        renderStepPhotoGallery(container, existing.filter((id) => id !== removeId), container.dataset.fieldName);
    };

    // ---------- redline (ad-hoc op) ----------

    window.showRedlineModal = function (hostOrder, hostNumberStr, issueIds, issueNumbers) {
        document.getElementById('redline-host-order').value = hostOrder;
        document.getElementById('redline-host-label').textContent = 'on OP ' + hostNumberStr;
        const sel = document.getElementById('redline-issue-id');
        sel.innerHTML = '';
        (issueIds || []).forEach((id, i) => {
            const opt = document.createElement('option');
            opt.value = id;
            opt.textContent = (issueNumbers && issueNumbers[i]) || 'NC';
            sel.appendChild(opt);
        });
        document.getElementById('redline-title').value = '';
        document.getElementById('redline-steps').innerHTML = '';
        addRedlineStep();
        document.getElementById('redline-error').hidden = true;
        document.getElementById('redline-modal').showModal();
    };

    window.hideRedlineModal = function () {
        document.getElementById('redline-modal').close();
    };

    window.addRedlineStep = function () {
        const container = document.getElementById('redline-steps');
        const idx = container.children.length + 1;
        const row = document.createElement('div');
        row.className = 'redline-step-row';
        row.innerHTML = `
            <div class="redline-step-head">
                <span class="mono text-muted">${idx}.</span>
                <input type="text" class="input redline-step-title" placeholder="Step title" required maxlength="255">
                <label class="bar-check"><input type="checkbox" class="redline-step-signoff"> <span class="mono">SIGN-OFF</span></label>
                <button type="button" class="btn" data-variant="outline" data-size="xs" onclick="removeRedlineStep(this)">REMOVE</button>
            </div>
            <textarea class="textarea redline-step-instructions" rows="2" placeholder="Instructions (optional, markdown)"></textarea>
        `;
        container.appendChild(row);
    };

    window.removeRedlineStep = function (btn) {
        const row = btn.closest('.redline-step-row');
        const container = row.parentElement;
        if (container.children.length <= 1) return;
        row.remove();
        Array.from(container.children).forEach((r, i) => {
            const label = r.querySelector('.mono');
            if (label) label.textContent = (i + 1) + '.';
        });
    };

    window.submitRedline = async function (event) {
        event.preventDefault();
        const errorDiv = document.getElementById('redline-error');
        errorDiv.hidden = true;
        const issueId = parseInt(document.getElementById('redline-issue-id').value);
        const title = document.getElementById('redline-title').value.trim();
        const steps = Array.from(document.querySelectorAll('#redline-steps .redline-step-row')).map((r) => ({
            title: r.querySelector('.redline-step-title').value.trim(),
            instructions: r.querySelector('.redline-step-instructions').value || null,
            requires_signoff: r.querySelector('.redline-step-signoff').checked,
        }));
        if (!issueId || !title || steps.length === 0 || steps.some((s) => !s.title)) {
            errorDiv.textContent = 'NC, title, and at least one sub-step (with a title) are required.';
            errorDiv.hidden = false;
            return;
        }
        try {
            const r = await fetch(apiUrl('/ad-hoc-ops'), {
                method: 'POST', headers: getHeaders(),
                body: JSON.stringify({ issue_id: issueId, title, steps }),
            });
            if (r.ok) window.location.reload(); // a new OP card enters the document
            else {
                const err = await r.json();
                errorDiv.textContent = formatApiError(err.detail, 'Failed to create redline');
                errorDiv.hidden = false;
            }
        } catch (e) {
            errorDiv.textContent = 'Network error: ' + e.message;
            errorDiv.hidden = false;
        }
    };

    // ---------- lightbox ----------

    window.openLightbox = function (src, caption) {
        const box = document.getElementById('lightbox');
        if (!box) return;
        document.getElementById('lightbox-img').src = src;
        document.getElementById('lightbox-caption').textContent = caption || '';
        box.hidden = false;
    };

    window.closeLightbox = function () {
        const box = document.getElementById('lightbox');
        if (box) box.hidden = true;
    };

    // ---------- kit availability (KITTING tab + step kits) ----------

    // The one home for the consume-from option label: the physical-item
    // identity first, then where it sits and how much it is.
    // "OPAL-00164 · STORE-A2 · 5 EA · LOT-2026-03" (lot only when present).
    function invSourceLabel(opalNumber, location, quantity, uom, lotNumber) {
        const parts = [];
        if (opalNumber) parts.push(opalNumber);
        parts.push(location);
        parts.push(`${Number(quantity)} ${(uom || 'EA').toUpperCase()}`);
        if (lotNumber) parts.push(lotNumber);
        return parts.join(' · ');
    }

    async function loadKitAvailability() {
        if (!document.getElementById('kit-table')) return;
        try {
            const resp = await fetch(apiUrl('/kit-availability'), { headers: getHeaders() });
            if (resp.ok) populateKitTable((await resp.json()).items);
        } catch (e) { console.error('execdoc: kit availability failed', e); }
    }

    function populateKitTable(items) {
        for (const item of items) {
            const row = document.querySelector(`tr[data-part-id="${item.part_id}"]`);
            if (!row) continue;
            const availCell = row.querySelector('.availability-cell');
            if (!availCell) continue;
            availCell.textContent = item.quantity_available.toFixed(4);
            if (!item.is_available) availCell.classList.add('text-red');
            const select = row.querySelector('.inv-select');
            if (!select) continue;
            select.innerHTML = '<option value="">Select source...</option>';
            for (const loc of item.available_locations) {
                const opt = document.createElement('option');
                opt.value = loc.inventory_record_id;
                opt.textContent = invSourceLabel(
                    loc.opal_number, loc.location, loc.quantity, item.uom, loc.lot_number);
                select.appendChild(opt);
            }
            const required = parseFloat(row.dataset.required);
            for (const loc of item.available_locations) {
                if (loc.quantity >= required) { select.value = loc.inventory_record_id; break; }
            }
        }
    }

    window.consumeParts = async function () {
        const errorDiv = document.getElementById('consume-error');
        errorDiv.style.display = 'none';
        const items = [];
        const rows = document.querySelectorAll('#kit-table tbody tr');
        for (const row of rows) {
            const select = row.querySelector('.inv-select');
            const qtyInput = row.querySelector('.qty-input');
            if (!select.value) { errorDiv.textContent = 'Please select a location for all parts'; errorDiv.style.display = 'block'; return; }
            const qty = parseFloat(qtyInput.value);
            if (qty <= 0) continue;
            items.push({ inventory_record_id: parseInt(select.value), quantity: qty });
        }
        if (items.length === 0) { errorDiv.textContent = 'No parts to consume'; errorDiv.style.display = 'block'; return; }
        try {
            const resp = await fetch(apiUrl('/consume'), {
                method: 'POST', headers: getHeaders(), body: JSON.stringify({ items }),
            });
            if (resp.ok) window.location.reload();
            else { const err = await resp.json(); errorDiv.textContent = formatApiError(err.detail, 'Failed to consume parts'); errorDiv.style.display = 'block'; }
        } catch (e) { errorDiv.textContent = 'Network error: ' + e.message; errorDiv.style.display = 'block'; }
    };

    window.produceOutput = async function () {
        const errorDiv = document.getElementById('produce-error');
        errorDiv.style.display = 'none';
        const items = [];
        const rows = document.querySelectorAll('#output-table tbody tr');
        for (const row of rows) {
            const partId = row.dataset.partId;
            const qty = parseFloat(row.querySelector(`input[name="out_${partId}_qty"]`).value);
            const loc = row.querySelector(`input[name="out_${partId}_loc"]`).value.trim();
            if (qty > 0) {
                if (!loc) { errorDiv.textContent = 'Please enter a location for all output items'; errorDiv.style.display = 'block'; return; }
                items.push({
                    part_id: parseInt(partId), quantity: qty, location: loc,
                    lot_number: row.querySelector(`input[name="out_${partId}_lot"]`).value.trim() || null,
                    serial_number: row.querySelector(`input[name="out_${partId}_serial"]`).value.trim() || null,
                });
            }
        }
        if (items.length === 0) { errorDiv.textContent = 'No output items to record'; errorDiv.style.display = 'block'; return; }
        try {
            const resp = await fetch(apiUrl('/produce'), {
                method: 'POST', headers: getHeaders(), body: JSON.stringify({ items }),
            });
            if (resp.ok) window.location.reload();
            else { const err = await resp.json(); errorDiv.textContent = formatApiError(err.detail, 'Failed to record output'); errorDiv.style.display = 'block'; }
        } catch (e) { errorDiv.textContent = 'Network error: ' + e.message; errorDiv.style.display = 'block'; }
    };

    window.finalizeProduction = async function () {
        const locationInput = document.getElementById('finalize-location');
        const errorDiv = document.getElementById('finalize-error');
        if (errorDiv) errorDiv.style.display = 'none';
        const location = locationInput ? locationInput.value.trim() : '';
        if (!location) { if (errorDiv) { errorDiv.textContent = 'Please enter a storage location'; errorDiv.style.display = 'block'; } return; }
        if (!confirm('Finalize production? This will set output quantities and record assembly genealogy.')) return;
        try {
            const resp = await fetch(apiUrl('/finalize'), {
                method: 'POST', headers: getHeaders(), body: JSON.stringify({ location }),
            });
            if (resp.ok) window.location.reload();
            else {
                const err = await resp.json();
                const msg = formatApiError(err.detail, 'Failed to finalize production');
                if (errorDiv) { errorDiv.textContent = msg; errorDiv.style.display = 'block'; } else toastError(null, msg);
            }
        } catch (e) { if (errorDiv) { errorDiv.textContent = 'Network error: ' + e.message; errorDiv.style.display = 'block'; } }
    };

    async function loadStepKitAvailability() {
        const tables = document.querySelectorAll('[data-step-kit]');
        if (!tables.length) return;
        const partIds = new Set();
        tables.forEach((t) => t.querySelectorAll('tbody tr[data-part-id]').forEach((r) => partIds.add(r.dataset.partId)));
        const inventoryByPart = {};
        await Promise.all([...partIds].map(async (pid) => {
            try {
                const resp = await fetch(`/api/inventory?part_id=${pid}&page_size=100`, { headers: getHeaders() });
                if (resp.ok) inventoryByPart[pid] = await resp.json();
            } catch (e) { console.error('execdoc: inventory load failed', pid, e); }
        }));
        document.querySelectorAll('.sk-inv-select').forEach((select) => {
            const pid = select.dataset.partId;
            const records = inventoryByPart[pid];
            select.innerHTML = '<option value="">Select...</option>';
            if (!records) return;
            const items = records.items || records;
            for (const rec of items) {
                if (parseFloat(rec.quantity) <= 0) continue;
                const opt = document.createElement('option');
                opt.value = rec.id;
                opt.textContent = invSourceLabel(
                    rec.opal_number, rec.location, rec.quantity, rec.part_uom, rec.lot_number);
                select.appendChild(opt);
            }
            const row = select.closest('tr');
            const required = parseFloat(row?.dataset.required || 0);
            for (const rec of items) {
                if (parseFloat(rec.quantity) >= required) { select.value = rec.id; break; }
            }
        });
    }
    window.loadStepKitAvailability = loadStepKitAvailability;

    window.consumeStepParts = async function (order) {
        const table = document.querySelector(`[data-step-kit="${order}"]`);
        if (!table) return;
        const items = [];
        for (const row of table.querySelectorAll('tbody tr')) {
            const select = row.querySelector('.sk-inv-select');
            const qtyInput = row.querySelector('.sk-qty-input');
            if (!select || !select.value) { toastError(null, 'Select a source location for all parts'); return; }
            const qty = parseFloat(qtyInput.value);
            if (qty <= 0) continue;
            const typeBadge = row.querySelector('.status');
            const usageType = typeBadge && typeBadge.textContent.trim().toLowerCase() === 'tooling' ? 'tooling' : 'consume';
            items.push({ inventory_record_id: parseInt(select.value), quantity: qty, usage_type: usageType });
        }
        if (items.length === 0) { toastError(null, 'No parts to consume'); return; }
        try {
            const resp = await fetch(apiUrl(`/steps/${order}/consume`), {
                method: 'POST', headers: getHeaders(), body: JSON.stringify({ items }),
            });
            if (resp.ok) refreshStepRow(order);
            else { const err = await resp.json(); toastError(err.detail, 'Failed to consume step parts'); }
        } catch (e) { toastError(null, 'Network error'); }
    };

    // ---------- wiring ----------

    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            window.hideAnomalyModal();
            window.hideSkipModal();
            window.hideAttachModal();
            window.hideRedlineModal();
            window.closeLightbox();
        }
    });

    function setFooterOffset() {
        const footer = document.querySelector('.footer');
        document.documentElement.style.setProperty(
            '--opal-footer-h', footer ? `${footer.offsetHeight}px` : '0px'
        );
    }
    window.addEventListener('resize', setFooterOffset);

    function initExecDoc() {
        setFooterOffset();
        applyDockbarPref();
        positionDockbar();
        applyStoredToggles();
        loadKitAvailability();
        loadStepKitAvailability();
        document.body.classList.toggle(
            'has-dockbar',
            !!document.querySelector('#dockbar .dockbar')
        );
        if (lastState) renderPresence(lastState);

        // Place the cursor: the server already resolved my cursor or the
        // first actionable row into the bar — adopt it locally.
        const bar = document.getElementById('dockbar');
        const initial = cfg.myCursorOrder !== null && cfg.myCursorOrder !== undefined
            ? cfg.myCursorOrder
            : (bar && bar.dataset.barOrder ? parseInt(bar.dataset.barOrder) : null);
        if (initial !== null && focusedOrder === null) {
            const row = document.getElementById(`step-${initial}`);
            if (row) {
                focusedOrder = initial;
                row.classList.add('is-focused');
            }
        }
        syncClaimButtons();

        // A HOLDING link (holds.py exec_href) lands here with ?op=N — jump to
        // that step, expanding its collapsed OP card. jumpToStep is idempotent.
        const opParam = new URLSearchParams(window.location.search).get('op');
        if (opParam !== null && opParam !== '') {
            const opOrder = parseInt(opParam, 10);
            if (!Number.isNaN(opOrder)) jumpToStep(opOrder);
        }
    }

    document.addEventListener('DOMContentLoaded', () => {
        initExecDoc();
        ensureJoined();
        startPolling();

        // SSE accelerates the poll; the poll remains the source of truth.
        if (window.opalEvents) {
            ['cursor_moved', 'step_completed', 'user_joined', 'user_left', 'issue_dispositioned'].forEach((type) => {
                window.opalEvents.on(type, (data) => {
                    if (data && data.instance_id === instanceId) pollNow();
                });
            });
            window.opalEvents.on('instance_completed', (data) => {
                if (data && data.instance_id === instanceId) {
                    toast('Work order complete');
                    setTimeout(() => window.location.reload(), 1500);
                }
            });
        }
    });

    document.body.addEventListener('htmx:afterSwap', (e) => {
        if (e.target && e.target.classList && e.target.classList.contains('exec-tab-content')) {
            initExecDoc();
        }
    });
})();
