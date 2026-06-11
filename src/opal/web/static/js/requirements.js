// Shared requirements UI behavior: tree collapse/expand, ghost-row inline
// creation, and the lint underline editor. Used by the tree page and the
// dossier. Depends on escapeHtml/formatApiError from layouts/base.html.

function getReqHeaders() {
    const headers = { 'Content-Type': 'application/json' };
    return headers;
}

// ============ Subtree collapse (state in localStorage) ============
const REQ_COLLAPSE_KEY = 'opal_req_tree_collapsed';

function reqCollapsedSet() {
    try { return new Set(JSON.parse(localStorage.getItem(REQ_COLLAPSE_KEY) || '[]')); }
    catch (e) { return new Set(); }
}

function saveReqCollapsed(set) {
    localStorage.setItem(REQ_COLLAPSE_KEY, JSON.stringify([...set]));
}

function setSubtree(id, collapsed) {
    const container = document.getElementById('children-' + id);
    const row = document.getElementById('req-row-' + id);
    if (!container) return;
    container.classList.toggle('collapsed', collapsed);
    const chevron = row && row.querySelector('.tree-chevron');
    if (chevron && !chevron.classList.contains('tree-chevron-leaf')) {
        chevron.textContent = collapsed ? '▸' : '▾';
    }
}

function toggleSubtree(id, event) {
    if (event) event.stopPropagation();
    const set = reqCollapsedSet();
    const collapsed = !set.has(id);
    if (collapsed) set.add(id); else set.delete(id);
    saveReqCollapsed(set);
    setSubtree(id, collapsed);
}

function applyStoredCollapse() {
    reqCollapsedSet().forEach(id => setSubtree(id, true));
}

// ============ Row expand (full statement in place) ============
function toggleRowExpand(id) {
    const el = document.getElementById('req-expand-' + id);
    if (el) el.style.display = el.style.display === 'none' ? 'block' : 'none';
}

// ============ Ghost rows (inline create) ============
function openGhost(linkEl) {
    const ghost = linkEl.closest('.tree-ghost');
    linkEl.style.display = 'none';
    const editor = ghost.querySelector('.tree-ghost-editor');
    editor.style.display = 'flex';
    editor.querySelector('.tree-ghost-title').focus();
}

function closeGhost(editor) {
    editor.style.display = 'none';
    editor.querySelector('.tree-ghost-title').value = '';
    editor.querySelector('.tree-ghost-statement').value = '';
    const ghost = editor.closest('.tree-ghost');
    ghost.querySelector('.tree-ghost-link').style.display = '';
    ghost.classList.remove('force');
}

function ghostKeydown(event, input) {
    if (event.key === 'Escape') {
        event.preventDefault();
        closeGhost(input.closest('.tree-ghost-editor'));
    } else if (event.key === 'Enter') {
        event.preventDefault();
        createFromGhost(input.closest('.tree-ghost-editor'));
    }
    event.stopPropagation();
}

async function createFromGhost(editor) {
    const title = editor.querySelector('.tree-ghost-title').value.trim();
    const statement = editor.querySelector('.tree-ghost-statement').value.trim();
    if (!title || !statement) return;
    const body = {
        title: title,
        statement: statement,
        parent_id: editor.dataset.parentId ? parseInt(editor.dataset.parentId) : null,
        category: editor.dataset.category || null,
    };
    try {
        const r = await fetch('/api/requirements', {
            method: 'POST', headers: getReqHeaders(), body: JSON.stringify(body),
        });
        if (!r.ok) {
            const err = await r.json();
            alert(formatApiError(err.detail, 'Failed to create requirement'));
            return;
        }
        const req = await r.json();
        insertCreatedRow(editor, req);
        // Fresh ghost: clear fields, keep editing so decomposition flows.
        editor.querySelector('.tree-ghost-title').value = '';
        editor.querySelector('.tree-ghost-statement').value = '';
        editor.querySelector('.tree-ghost-title').focus();
    } catch (e) { alert('Network error: ' + e.message); }
}

function insertCreatedRow(editor, req) {
    const ghost = editor.closest('.tree-ghost');
    const depth = Math.max(0, Math.round((parseInt(ghost.style.paddingLeft || '22') - 22) / 18));
    const row = document.createElement('div');
    row.className = 'tree-row';
    row.id = 'req-row-' + req.id;
    row.tabIndex = -1;
    row.dataset.id = req.id;
    row.dataset.state = req.lifecycle_state;
    row.dataset.level = req.level;
    row.dataset.number = req.req_number;
    row.dataset.category = req.category || '';
    row.dataset.text = (req.req_number + ' ' + req.title + ' ' + req.statement).toLowerCase();
    row.style.paddingLeft = (depth * 18) + 'px';
    row.innerHTML =
        '<span class="tree-chevron tree-chevron-leaf"></span>' +
        '<a class="tree-num mono" href="/requirements/' + req.id + '">' + escapeHtml(req.req_number) + '</a>' +
        '<span class="tree-statement">' + escapeHtml(req.statement) + '</span>' +
        '<span class="tree-meta">' +
        '<span class="status-badge status-draft">DRAFT</span>' +
        '<span class="tree-lvl mono">L' + req.level + '·' + (req.verification_method || '—')[0].toUpperCase() + '</span>' +
        '<span class="tree-age mono">now</span></span>';
    ghost.parentNode.insertBefore(row, ghost);
}

// `c` on a focused leaf forces its (otherwise hidden) ghost open.
function openGhostFor(row) {
    const container = document.getElementById('children-' + row.dataset.id);
    if (!container) return;
    setSubtree(parseInt(row.dataset.id), false);
    const ghost = container.querySelector(':scope > .tree-ghost');
    if (!ghost) return;
    ghost.classList.add('force');
    openGhost(ghost.querySelector('.tree-ghost-link'));
}

// ============ Lint underline editor ============
// Overlay sits above the textarea: transparent text, visible underline
// decorations, pointer-events only on the underlined spans (title tooltips).

function lintMarkupHtml(text, findings) {
    const spanned = findings.filter(f => f.span);
    if (!spanned.length || !text) return escapeHtml(text);
    const marks = new Array(text.length).fill(null);
    spanned.forEach((f, i) => {
        for (let p = Math.max(0, f.span[0]); p < Math.min(f.span[1], text.length); p++) {
            (marks[p] = marks[p] || new Set()).add(i);
        }
    });
    const sameMarks = (a, b) =>
        (!a && !b) || (a && b && a.size === b.size && [...a].every(x => b.has(x)));
    let html = '', runStart = 0;
    for (let pos = 1; pos <= text.length; pos++) {
        if (pos < text.length && sameMarks(marks[pos], marks[runStart])) continue;
        const chunk = escapeHtml(text.slice(runStart, pos));
        const covering = marks[runStart];
        if (covering) {
            const here = [...covering].sort((a, b) => a - b).map(i => spanned[i]);
            const css = here.some(f => f.severity === 'block_baseline') ? 'lint-block' : 'lint-warn';
            const title = escapeHtml(here.map(f => f.rule + ': ' + f.message).join('; '));
            html += '<span class="' + css + '" title="' + title + '">' + chunk + '</span>';
        } else {
            html += chunk;
        }
        runStart = pos;
    }
    return html;
}

function bindLintEditor(textarea, overlay) {
    let timer = null;
    async function refresh() {
        try {
            const r = await fetch('/api/requirements/lint', {
                method: 'POST',
                headers: getReqHeaders(),
                body: JSON.stringify({ statement: textarea.value }),
            });
            if (!r.ok) return;
            const data = await r.json();
            overlay.innerHTML = lintMarkupHtml(textarea.value, data.findings);
            overlay.scrollTop = textarea.scrollTop;
        } catch (e) { /* lint is advisory; never interrupt typing */ }
    }
    textarea.addEventListener('input', () => {
        // Mirror the text immediately so underlines never lag the content...
        overlay.innerHTML = escapeHtml(textarea.value);
        clearTimeout(timer);
        timer = setTimeout(refresh, 400);  // ...then re-lint after the pause.
    });
    textarea.addEventListener('scroll', () => { overlay.scrollTop = textarea.scrollTop; });
    overlay.addEventListener('click', () => textarea.focus());
    refresh();
}
