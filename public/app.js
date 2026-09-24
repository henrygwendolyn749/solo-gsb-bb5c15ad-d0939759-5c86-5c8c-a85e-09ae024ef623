'use strict';

/* 家谱关系核对 —— 原生前端逻辑 */

const state = {
  version: 1,
  maxMembers: 30,
  members: [],
  edges: [], // { parentId, childId }
};

/* 批量录入草稿：drafts 为 [{ key, parentId, childId }]；
   batchCheck 保存最近一次预检结果（含家谱版本），草稿变动后置空。 */
let draftSeq = 0;
const drafts = [];
let batchCheck = null; // { version, valid, total, invalidCount, results } | null

// 记住下拉框的选择，数据刷新后尽量保持
const selection = {
  edgeParent: '',
  edgeChild: '',
  queryA: '',
  queryB: '',
};

let queryStale = false; // 关系被修改后，查询结果标记为过期

const $ = (id) => document.getElementById(id);

/** 安全创建 DOM 元素，避免 innerHTML 注入 */
function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (value !== null && value !== undefined) {
      node.setAttribute(key, value);
    }
  }
  for (const child of [].concat(children)) {
    if (child === null || child === undefined) continue;
    node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

const nameOf = (id) => {
  const m = state.members.find((x) => x.id === id);
  return m ? m.name : '（已删除）';
};

/* ---------------- 网络请求 ---------------- */

async function api(url, options = {}) {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  let body = null;
  try {
    body = await res.json();
  } catch (_) {
    /* 非 JSON 响应 */
  }
  if (!res.ok) {
    const err = new Error((body && body.error) || `请求失败（${res.status}）`);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

async function refresh() {
  const data = await api('/api/state');
  state.version = data.version;
  state.maxMembers = data.maxMembers;
  state.members = data.members;
  state.edges = data.edges;
  reconcileSelection();
  render();
}

function applyStateAndRender(data) {
  state.version = data.version;
  state.maxMembers = data.maxMembers;
  state.members = data.members;
  state.edges = data.edges;
  reconcileSelection();
  invalidateBatchCheckWithHint('家谱数据已变化，批量草稿需重新预检。');
  render();
}

function reconcileSelection() {
  const ids = new Set(state.members.map((m) => m.id));
  for (const key of Object.keys(selection)) {
    if (!ids.has(selection[key])) selection[key] = '';
  }
}

/* ---------------- Toast ---------------- */

let toastTimer = null;
function toast(message, isError = false) {
  const box = $('toast');
  box.textContent = message;
  box.className = isError ? 'toast error' : 'toast';
  box.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { box.hidden = true; }, 3200);
}

/* ---------------- 渲染 ---------------- */

function render() {
  renderMembers();
  renderEdges();
  renderSelects();
  renderStaleBanner();
  renderBatch();
}

function renderMembers() {
  $('member-count').textContent = `${state.members.length}/${state.maxMembers}`;
  const list = $('member-list');
  list.replaceChildren();

  if (state.members.length === 0) {
    list.appendChild(el('li', { class: 'empty-hint', text: '尚未添加成员，请先在上方录入。' }));
    return;
  }

  // 父母计数，便于展示
  const parentCount = new Map();
  const childCount = new Map();
  for (const e of state.edges) {
    parentCount.set(e.parentId, (parentCount.get(e.parentId) || 0) + 1);
    childCount.set(e.childId, (childCount.get(e.childId) || 0) + 1);
  }

  for (const m of state.members) {
    const li = el('li');
    li.appendChild(el('span', { class: 'name', text: m.name }));
    li.appendChild(
      el('span', {
        class: 'sub',
        text: `子女 ${parentCount.get(m.id) || 0} · 父母 ${childCount.get(m.id) || 0}`,
      })
    );
    li.appendChild(el('button', {
      class: 'danger-link',
      text: '重命名',
      onClick: () => startRename(li, m),
    }));
    li.appendChild(el('button', {
      class: 'danger-link',
      text: '删除',
      onClick: () => removeMember(m),
    }));
    list.appendChild(li);
  }
}

function startRename(li, member) {
  li.classList.add('renaming');
  li.replaceChildren();
  const input = el('input', {
    type: 'text',
    value: member.name,
    maxlength: '50',
  });
  const saveBtn = el('button', { type: 'button', text: '保存' });
  const cancelBtn = el('button', { type: 'button', text: '取消', class: 'danger-link' });

  const doSave = async () => {
    const name = input.value.trim();
    if (!name) { toast('姓名不能为空', true); return; }
    try {
      const data = await api(`/api/members/${encodeURIComponent(member.id)}`, {
        method: 'PATCH',
        body: JSON.stringify({ name }),
      });
      applyStateAndRender(data);
      markStale();
      toast('已重命名');
    } catch (err) {
      toast(err.message, true);
    }
  };

  saveBtn.addEventListener('click', doSave);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); doSave(); }
  });
  cancelBtn.addEventListener('click', () => render());
  li.append(input, saveBtn, cancelBtn);
  input.focus();
  input.select();
}

function renderEdges() {
  const list = $('edge-list');
  list.replaceChildren();

  if (state.edges.length === 0) {
    list.appendChild(el('li', {
      class: 'empty-hint',
      text: '尚未建立关系。选择父母与子女后点击「建立关系」。',
    }));
    return;
  }

  // 排序：先按子女姓名，再按父母姓名，便于查看
  const sorted = [...state.edges].sort((a, b) => {
    const ca = nameOf(a.childId), cb = nameOf(b.childId);
    if (ca !== cb) return ca.localeCompare(cb, 'zh');
    return nameOf(a.parentId).localeCompare(nameOf(b.parentId), 'zh');
  });

  for (const e of sorted) {
    const li = el('li');
    li.appendChild(el('span', { class: 'edge-text' }, [
      el('span', { class: 'p-name', text: nameOf(e.parentId) }),
      document.createTextNode(' → '),
      el('span', { class: 'c-name', text: nameOf(e.childId) }),
    ]));
    li.appendChild(el('button', {
      class: 'danger-link',
      text: '删除',
      onClick: () => removeEdge(e),
    }));
    list.appendChild(li);
  }
}

function renderSelects() {
  fillSelect($('edge-parent'), selection.edgeParent, '选择父母');
  fillSelect($('edge-child'), selection.edgeChild, '选择子女');
  fillSelect($('query-a'), selection.queryA, '选择成员甲');
  fillSelect($('query-b'), selection.queryB, '选择成员乙');
}

function fillSelect(select, selectedId, placeholder) {
  const current = selectedId || select.value;
  select.replaceChildren();
  if (state.members.length === 0) {
    select.appendChild(el('option', { value: '', text: `（请先添加成员）` }));
    select.disabled = true;
    return;
  }
  select.disabled = false;
  select.appendChild(el('option', { value: '', text: `（${placeholder}）` }));
  for (const m of state.members) {
    const attrs = { value: m.id, text: m.name };
    if (m.id === current) attrs.selected = 'selected';
    select.appendChild(el('option', attrs));
  }
  if (!current) select.value = '';
}

function renderStaleBanner() {
  const box = $('query-result');
  const existing = box.querySelector('.stale-banner');
  if (queryStale && box.dataset.hasResult === '1') {
    if (!existing) {
      box.prepend(el('p', {
        class: 'stale-banner',
        text: '⚠️ 关系在上次查询后发生过修改，以下结果可能已过期，请重新查询。',
      }));
    }
  } else if (existing) {
    existing.remove();
  }
}

function markStale() {
  queryStale = true;
  renderStaleBanner();
}

/* ---------------- 事件处理 ---------------- */

$('member-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = $('member-name');
  const name = input.value.trim();
  if (!name) { toast('姓名不能为空', true); return; }
  try {
    const data = await api('/api/members', {
      method: 'POST',
      body: JSON.stringify({ name }),
    });
    applyStateAndRender(data);
    input.value = '';
    input.focus();
    toast('成员已添加');
  } catch (err) {
    toast(err.message, true);
  }
});

async function removeMember(member) {
  if (!confirm(`确定删除成员「${member.name}」？\n与之相关的全部父母/子女关系将一并删除。`)) return;
  try {
    const data = await api(`/api/members/${encodeURIComponent(member.id)}`, { method: 'DELETE' });
    applyStateAndRender(data);
    markStale();
    toast('成员已删除');
  } catch (err) {
    toast(err.message, true);
  }
}

function syncSelectionFromForm() {
  selection.edgeParent = $('edge-parent').value;
  selection.edgeChild = $('edge-child').value;
  selection.queryA = $('query-a').value;
  selection.queryB = $('query-b').value;
}

$('edge-parent').addEventListener('change', syncSelectionFromForm);
$('edge-child').addEventListener('change', syncSelectionFromForm);
$('query-a').addEventListener('change', syncSelectionFromForm);
$('query-b').addEventListener('change', syncSelectionFromForm);

$('edge-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  syncSelectionFromForm();
  const parentId = $('edge-parent').value;
  const childId = $('edge-child').value;
  if (!parentId || !childId) { toast('请选择父母与子女', true); return; }
  if (parentId === childId) { toast('拒绝自指关系：不能成为自己的父母', true); return; }
  try {
    const data = await api('/api/edges', {
      method: 'POST',
      body: JSON.stringify({ parentId, childId }),
    });
    applyStateAndRender(data);
    markStale();
    toast('关系已建立');
  } catch (err) {
    toast(err.message, true);
  }
});

async function removeEdge(edge) {
  if (!confirm(`确定删除关系「${nameOf(edge.parentId)} → ${nameOf(edge.childId)}」？`)) return;
  try {
    const data = await api('/api/edges', {
      method: 'DELETE',
      body: JSON.stringify({ parentId: edge.parentId, childId: edge.childId }),
    });
    applyStateAndRender(data);
    markStale();
    toast('关系已删除');
  } catch (err) {
    toast(err.message, true);
  }
}

/* ---------------- 批量关系录入 ---------------- */

/** 草稿内容变动（增删、清空）后，上次预检立即失效 */
function invalidateBatchCheck() {
  batchCheck = null;
}

/** 家谱数据被刷新（任何增删改）后，预检作废并提示重新预检 */
function invalidateBatchCheckWithHint(reason) {
  batchCheck = null;
  const status = $('batch-status');
  if (status && reason) status.dataset.hint = reason;
}

function draftErrorByIndex() {
  const map = new Map();
  if (batchCheck) {
    for (const r of batchCheck.results) {
      if (r.errors && r.errors.length) map.set(r.index, r.errors);
    }
  }
  return map;
}

function renderBatch() {
  const list = $('draft-list');
  list.replaceChildren();

  if (drafts.length === 0) {
    list.appendChild(el('li', {
      class: 'empty-hint',
      text: '草稿为空：选择父母与子女后点击「加入草稿」。',
    }));
  } else {
    const errorsByIndex = draftErrorByIndex();
    drafts.forEach((d, index) => {
      const li = el('li', { class: errorsByIndex.has(index) ? 'draft-item invalid' : 'draft-item' });
      li.appendChild(el('span', { class: 'edge-text' }, [
        el('span', { class: 'p-name', text: nameOf(d.parentId) }),
        document.createTextNode(' → '),
        el('span', { class: 'c-name', text: nameOf(d.childId) }),
      ]));
      li.appendChild(el('button', {
        class: 'danger-link',
        text: '移除',
        onClick: () => removeDraft(index),
      }));
      const errors = errorsByIndex.get(index);
      if (errors) {
        for (const msg of errors) {
          li.appendChild(el('div', { class: 'draft-error', text: `✗ ${msg}` }));
        }
      }
      list.appendChild(li);
    });
  }

  renderBatchStatus();
}

function renderBatchStatus() {
  const box = $('batch-status');
  box.replaceChildren();
  const submitBtn = $('batch-submit');

  // 数据刷新导致预检失效的提示（草稿已清空则无需提示）
  if (!batchCheck && drafts.length > 0 && box.dataset.hint) {
    box.appendChild(el('p', { class: 'batch-line warn', text: `⚠️ ${box.dataset.hint}` }));
  }

  if (!batchCheck) {
    if (drafts.length > 0 && !box.dataset.hint) {
      box.appendChild(el('p', {
        class: 'batch-line muted',
        text: `已维护 ${drafts.length} 条草稿，尚未预检。`,
      }));
    }
    submitBtn.disabled = true;
    return;
  }

  delete box.dataset.hint;
  if (batchCheck.valid) {
    box.appendChild(el('p', {
      class: 'batch-line ok',
      text: `✓ 预检通过：${batchCheck.total} 条关系全部合法，可以整批提交。（家谱版本 ${batchCheck.version}）`,
    }));
    submitBtn.disabled = false;
  } else {
    box.appendChild(el('p', {
      class: 'batch-line err',
      text: `✗ 预检未通过：${batchCheck.invalidCount}/${batchCheck.total} 条存在错误，整批不可提交，请按下方逐条提示修改。`,
    }));
    submitBtn.disabled = true;
  }
  box.appendChild(el('p', {
    class: 'batch-line muted',
    text: `预检基于家谱版本 ${batchCheck.version}；提交前若家谱被其他操作改动，提交会被拒绝并要求重新预检。`,
  }));
}

function addDraft() {
  syncSelectionFromForm();
  const parentId = $('edge-parent').value;
  const childId = $('edge-child').value;
  if (!parentId || !childId) { toast('请选择父母与子女', true); return; }
  if (parentId === childId) { toast('拒绝自指关系：不能成为自己的父母（预检也会拒绝）', true); return; }
  if (drafts.some((d) => d.parentId === parentId && d.childId === childId)) {
    toast('该关系已在草稿中（批内重复预检会拒绝）', true);
    return;
  }
  if (drafts.length >= 100) { toast('一批最多 100 条草稿', true); return; }
  drafts.push({ key: `d${++draftSeq}`, parentId, childId });
  invalidateBatchCheck();
  renderBatch();
}

function removeDraft(index) {
  drafts.splice(index, 1);
  invalidateBatchCheck();
  renderBatch();
}

async function runPrecheck() {
  if (drafts.length === 0) { toast('请先加入至少一条草稿', true); return; }
  try {
    const payload = drafts.map((d) => ({ parentId: d.parentId, childId: d.childId }));
    batchCheck = await api('/api/edges/batch/precheck', {
      method: 'POST',
      body: JSON.stringify({ edges: payload }),
    });
    renderBatch();
    if (batchCheck.valid) toast(`预检通过（${batchCheck.total} 条），可整批提交`);
    else toast(`预检未通过：${batchCheck.invalidCount} 条错误`, true);
  } catch (err) {
    toast(err.message, true);
  }
}

async function submitBatch() {
  if (!batchCheck || !batchCheck.valid) {
    toast('请先预检且整批合法后再提交', true);
    return;
  }
  const version = batchCheck.version;
  const payload = drafts.map((d) => ({ parentId: d.parentId, childId: d.childId }));
  const expectedAdded = payload.length;
  try {
    const data = await api('/api/edges/batch', {
      method: 'POST',
      body: JSON.stringify({ edges: payload, version }),
    });
    drafts.length = 0;
    batchCheck = null;
    applyStateAndRender(data);
    markStale();
    toast(`已一次写入 ${expectedAdded} 条关系`);
  } catch (err) {
    if (err.status === 409) {
      // 期间家谱发生变化：预检作废，必须重新预检
      batchCheck = null;
      renderBatch();
      toast(`${err.message}（当前版本 ${err.body && err.body.currentVersion}）`, true);
    } else if (err.status === 400 && err.body && Array.isArray(err.body.results)) {
      // 理论上预检通过不会走到；用服务端最新结果覆盖展示，保持单一事实来源
      batchCheck = {
        version,
        valid: false,
        total: err.body.results.length,
        invalidCount: err.body.results.filter((r) => r.errors.length).length,
        results: err.body.results,
      };
      renderBatch();
      toast(err.message, true);
    } else {
      toast(err.message, true);
    }
  }
}

$('draft-add').addEventListener('click', addDraft);
$('batch-precheck').addEventListener('click', runPrecheck);
$('batch-submit').addEventListener('click', submitBatch);
$('draft-clear').addEventListener('click', () => {
  if (drafts.length === 0) return;
  drafts.length = 0;
  invalidateBatchCheck();
  renderBatch();
});

/* ---------------- 共同祖先查询结果渲染 ---------------- */

function renderPathLine(path) {
  // path: [{id,name}, ...] 从查询人向上到祖先
  const gen = path.length - 1;
  const frag = document.createDocumentFragment();
  path.forEach((node, idx) => {
    if (idx > 0) frag.appendChild(el('span', { class: 'path-arrow', text: '↑' }));
    frag.appendChild(document.createTextNode(node.name));
  });
  return el('div', { class: 'path-line' }, [
    el('span', { class: 'gen-tag', text: `${gen} 代` }),
    frag,
  ]);
}

function renderAncestorBlock(ancestor, labelA, labelB) {
  const block = el('div', { class: 'ancestor-block' });
  block.appendChild(el('h3', { text: `共同祖先：${ancestor.name}` }));
  block.appendChild(el('p', { class: 'ancestor-meta' }, [
    document.createTextNode(
      `${labelA}到该祖先 ${ancestor.genA} 代，${labelB}到该祖先 ${ancestor.genB} 代，`
    ),
    el('strong', { text: `合计 ${ancestor.totalGen} 代` }),
    document.createTextNode(
      `；${labelA}侧最短路径 ${ancestor.pathsA.length} 条，${labelB}侧 ${ancestor.pathsB.length} 条（同代数不同路径均保留）。`
    ),
  ]));

  const paths = el('div', { class: 'paths' });

  const colA = el('div', { class: 'path-col' }, [
    el('h4', { text: `${labelA} 向上到「${ancestor.name}」` }),
  ]);
  ancestor.pathsA.forEach((p) => colA.appendChild(renderPathLine(p)));

  const colB = el('div', { class: 'path-col' }, [
    el('h4', { text: `${labelB} 向上到「${ancestor.name}」` }),
  ]);
  ancestor.pathsB.forEach((p) => colB.appendChild(renderPathLine(p)));

  paths.append(colA, colB);
  block.appendChild(paths);
  return block;
}

function renderQueryResult(data, nameA, nameB) {
  const box = $('query-result');
  box.replaceChildren();
  box.dataset.hasResult = '1';

  if (data.samePerson) {
    const a = data.ancestors[0];
    box.appendChild(el('div', { class: 'summary' }, [
      el('div', {}, [el('strong', { text: `两位成员是同一人：「${a.name}」` })]),
      el('div', { text: '其本人即为最近共同祖先，沿父母链向上的总代数为 0 代。' }),
    ]));
    box.appendChild(renderAncestorBlock(a, nameA, nameB));
    return;
  }

  if (data.ancestors.length === 0) {
    box.appendChild(el('div', { class: 'summary no-match' }, [
      el('strong', { text: `「${nameA}」与「${nameB}」没有共同祖先。` }),
      el('div', {
        text: '沿双方父母链向上均找不到同一位成员。若确有亲缘关系，请检查是否漏录了中间世代的父母→子女关系。',
      }),
    ]));
    return;
  }

  box.appendChild(el('div', { class: 'summary' }, [
    el('div', {}, [
      document.createTextNode('「'),
      el('strong', { text: nameA }),
      document.createTextNode('」与「'),
      el('strong', { text: nameB }),
      document.createTextNode('」的 '),
      el('strong', { text: `最少总代数为 ${data.minTotalGen} 代` }),
      document.createTextNode('。'),
    ]),
    el('div', {
      text: `达到该最小值的最近共同祖先共 ${data.ancestors.length} 位（全部列出），双方到各祖先的全部最短亲缘路径如下：`,
    }),
  ]));

  for (const ancestor of data.ancestors) {
    box.appendChild(renderAncestorBlock(ancestor, `「${nameA}」`, `「${nameB}」`));
  }
}

$('query-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  syncSelectionFromForm();
  const personA = $('query-a').value;
  const personB = $('query-b').value;
  if (!personA || !personB) { toast('请选择两位成员', true); return; }

  const nameA = nameOf(personA);
  const nameB = nameOf(personB);

  try {
    const params = new URLSearchParams({ personA, personB });
    const data = await api(`/api/common-ancestors?${params.toString()}`);
    queryStale = false;
    renderQueryResult(data, nameA, nameB);
  } catch (err) {
    toast(err.message, true);
  }
});

/* ---------------- 启动 ---------------- */

refresh().catch((err) => toast(`初始化失败：${err.message}`, true));
