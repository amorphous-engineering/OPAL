// Risk module UI: scenario lint editors, score trend, disposition panel,
// acceptance signature, linked issues. Depends on lintMarkupHtml from
// requirements.js and escapeHtml/formatApiError from layouts/base.html.
// Pages set `riskId` before use; lint binding works without it (new form).

function getRiskHeaders() {
    return { 'Content-Type': 'application/json' };
}

// ============ Scenario lint (three fields, one round trip) ============

const SCENARIO_LINT_FIELDS = ['condition', 'departure', 'consequence'];

function bindScenarioLint() {
    const editors = {};
    for (const field of SCENARIO_LINT_FIELDS) {
        const textarea = document.getElementById(field + '-text');
        const overlay = document.getElementById(field + '-overlay');
        if (textarea && overlay) editors[field] = { textarea, overlay };
    }
    if (!Object.keys(editors).length) return;

    let timer = null;
    async function refresh() {
        try {
            const body = {};
            for (const field in editors) body[field] = editors[field].textarea.value;
            const r = await fetch('/api/risks/lint', {
                method: 'POST',
                headers: getRiskHeaders(),
                body: JSON.stringify(body),
            });
            if (!r.ok) return;
            const data = await r.json();
            for (const field in editors) {
                const { textarea, overlay } = editors[field];
                overlay.innerHTML = lintMarkupHtml(textarea.value, data.findings[field] || []);
                overlay.scrollTop = textarea.scrollTop;
            }
        } catch (e) { /* lint is advisory; never interrupt typing */ }
    }

    for (const field in editors) {
        const { textarea, overlay } = editors[field];
        textarea.addEventListener('input', () => {
            // Mirror the text immediately so underlines never lag the content...
            overlay.innerHTML = escapeHtml(textarea.value);
            clearTimeout(timer);
            timer = setTimeout(refresh, 400);  // ...then re-lint after the pause.
        });
        textarea.addEventListener('scroll', () => { overlay.scrollTop = textarea.scrollTop; });
        overlay.addEventListener('click', () => textarea.focus());
    }
    refresh();
}

// ============ Detail page: field edits ============

function scoreTrendHtml(risk) {
    let html = `<span class="sev-${risk.severity}">${risk.score}</span>`;
    if (risk.residual_score !== null && risk.residual_score !== undefined) {
        html += ` → <span class="sev-${risk.residual_severity}">${risk.residual_score}</span>`;
    }
    return html;
}

function renderRiskState(risk) {
    const masthead = document.getElementById('statement-masthead');
    if (masthead) {
        if (risk.statement) {
            masthead.textContent = risk.statement;
            masthead.classList.remove('risk-statement-incomplete');
        } else {
            masthead.textContent = 'scenario incomplete — condition · departure · asset · consequence';
            masthead.classList.add('risk-statement-incomplete');
        }
    }
    const trend = document.getElementById('score-trend');
    if (trend) trend.innerHTML = scoreTrendHtml(risk);
}

async function refreshAcceptancePanel() {
    const container = document.getElementById('acceptance-panel');
    if (!container) return;
    try {
        // The rationale textarea saves on blur, which lands here right after
        // the user clicks ACCEPT — re-rendering must not swallow the open
        // confirm dialog mid-signature.
        const confirmEl = document.getElementById('accept-confirm');
        const confirmWasOpen = confirmEl && confirmEl.style.display !== 'none';
        const editing = typeof EDITING !== 'undefined' && EDITING;
        const r = await fetch(`/risks/${riskId}/acceptance-panel${editing ? '?edit=1' : ''}`);
        if (r.ok) container.innerHTML = await r.text();
        if (confirmWasOpen && document.getElementById('accept-confirm')) openAcceptConfirm();
    } catch (e) { /* panel refresh is cosmetic; the next save retries */ }
}

async function updateRisk(field, value) {
    try {
        const data = {};
        data[field] = value;
        const response = await fetch(`/api/risks/${riskId}`, {
            method: 'PATCH',
            headers: getRiskHeaders(),
            body: JSON.stringify(data),
        });
        if (!response.ok) {
            const error = await response.json();
            alert(formatApiError(error.detail, 'Failed to update risk'));
            window.location.reload();
            return;
        }
        const risk = await response.json();
        if (risk.acceptance_invalidated) {
            // The signature stopped covering the scenario — show the whole new state.
            window.location.reload();
            return;
        }
        renderRiskState(risk);
        refreshAcceptancePanel();
    } catch (e) {
        alert('Network error: ' + e.message);
        window.location.reload();
    }
}

async function updateAsset(kind, value) {
    if (kind === 'part') {
        await updateRisk('asset_part_id', value ? parseInt(value) : null);
        const text = document.getElementById('asset-text-input');
        if (value && text) text.value = '';
    } else {
        await updateRisk('asset_text', value || null);
        const part = document.getElementById('asset-part-select');
        if (value && part) part.value = '';
    }
}

// ============ Dispositions ============

async function loadDispositionPanel(target) {
    const container = document.getElementById('disposition-panel');
    if (!container) return;
    if (!target) {
        container.innerHTML = '';
        return;
    }
    const r = await fetch(`/risks/${riskId}/disposition-panel?target=${encodeURIComponent(target)}`);
    if (r.ok) container.innerHTML = await r.text();
}

async function applyDisposition(target) {
    const noteInput = document.getElementById('disposition-note');
    const note = noteInput ? noteInput.value.trim() : '';
    const errorDiv = document.getElementById('disposition-error');
    if (noteInput && !note) {
        errorDiv.textContent = 'a note is required';
        errorDiv.style.display = 'block';
        return;
    }
    const response = await fetch(`/api/risks/${riskId}/disposition`, {
        method: 'POST',
        headers: getRiskHeaders(),
        body: JSON.stringify({ disposition: target, note: note || null }),
    });
    if (response.ok) {
        window.location.reload();
    } else {
        const error = await response.json();
        errorDiv.textContent = formatApiError(error.detail, 'Transition refused');
        errorDiv.style.display = 'block';
    }
}

// ============ Acceptance — the signature ============

function openAcceptConfirm() {
    document.getElementById('accept-confirm').style.display = 'flex';
}

async function commitAccept() {
    const response = await fetch(`/api/risks/${riskId}/accept`, {
        method: 'POST',
        headers: getRiskHeaders(),
        body: JSON.stringify({}),
    });
    if (response.ok) {
        window.location.reload();
    } else {
        const error = await response.json();
        alert(formatApiError(error.detail, 'Acceptance refused'));
        refreshAcceptancePanel();
    }
}

// ============ Linked issues ============

async function linkIssue() {
    const issueId = document.getElementById('link-issue-select').value;
    const role = document.getElementById('link-role-select').value;
    if (!issueId) return;
    const response = await fetch(`/api/risks/${riskId}/issues`, {
        method: 'POST',
        headers: getRiskHeaders(),
        body: JSON.stringify({ issue_id: parseInt(issueId), role: role }),
    });
    if (response.ok) window.location.reload();
    else alert(formatApiError((await response.json()).detail, 'Failed to link issue'));
}

async function spawnIssue() {
    const title = document.getElementById('spawn-title-input').value.trim();
    const role = document.getElementById('link-role-select').value;
    if (!title) return;
    const response = await fetch(`/api/risks/${riskId}/issues/spawn`, {
        method: 'POST',
        headers: getRiskHeaders(),
        body: JSON.stringify({ title: title, role: role }),
    });
    if (response.ok) window.location.reload();
    else alert(formatApiError((await response.json()).detail, 'Failed to spawn issue'));
}

async function spawnRealizedIssue() {
    const title = document.getElementById('realized-title-input').value.trim();
    if (!title) return;
    const response = await fetch(`/api/risks/${riskId}/issues/spawn`, {
        method: 'POST',
        headers: getRiskHeaders(),
        body: JSON.stringify({ title: title, role: 'realized' }),
    });
    if (response.ok) window.location.reload();
    else alert(formatApiError((await response.json()).detail, 'Failed to spawn issue'));
}

async function unlinkIssue(issueId) {
    const response = await fetch(`/api/risks/${riskId}/issues/${issueId}`, {
        method: 'DELETE',
        headers: getRiskHeaders(),
    });
    if (response.ok) window.location.reload();
    else alert(formatApiError((await response.json()).detail, 'Failed to unlink issue'));
}

// ============ Register: bulk review stamp ============

async function stampReviewed() {
    // Send the register's current filters, not the rendered rows — the
    // ceremony covers every listed risk, including pages beyond this one.
    const value = (selector) => {
        const el = document.querySelector(selector);
        return el && el.value ? el.value : null;
    };
    const response = await fetch('/api/risks/review-stamp', {
        method: 'POST',
        headers: getRiskHeaders(),
        body: JSON.stringify({
            search: value('#search'),
            disposition: value('[name="disposition"]'),
            severity: value('[name="severity"]'),
        }),
    });
    if (response.ok) window.location.reload();
    else alert(formatApiError((await response.json()).detail, 'Failed to stamp review'));
}
