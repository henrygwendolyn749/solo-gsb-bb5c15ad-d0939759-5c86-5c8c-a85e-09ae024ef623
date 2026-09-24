'use strict';

const path = require('path');
const express = require('express');
const { createStore } = require('./store');
const { findCommonAncestors, validateEdge, validateEdgeBatch, MAX_BATCH_EDGES } = require('./familyGraph');

const PORT = parseInt(process.env.PORT, 10) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, '..', 'data', 'family.json');

const store = createStore(DATA_FILE);
const app = express();
app.use(express.json({ limit: '64kb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

function sendError(res, status, message) {
  return res.status(status).json({ error: message });
}

/** 统一的输入校验：从请求体取非空字符串字段 */
function requireId(body, field) {
  const value = body && typeof body[field] === 'string' ? body[field].trim() : '';
  return value || null;
}

function normalizeName(raw) {
  if (typeof raw !== 'string') return '';
  return raw.trim().slice(0, 50);
}

/** 获取全部数据：成员 + 关系 */
app.get('/api/state', (req, res) => {
  res.json(store.list());
});

/** 新增成员（最多 30 人） */
app.post('/api/members', (req, res) => {
  const name = normalizeName(req.body && req.body.name);
  if (!name) return sendError(res, 400, '姓名不能为空');
  const result = store.addMember(name);
  if (result.error) return sendError(res, 400, result.error);
  res.status(201).json(store.list());
});

/** 修改成员姓名（支持修改后重新查询） */
app.patch('/api/members/:id', (req, res) => {
  const name = normalizeName(req.body && req.body.name);
  if (!name) return sendError(res, 400, '姓名不能为空');
  const result = store.renameMember(req.params.id, name);
  if (result.error) return sendError(res, 404, result.error);
  res.json(store.list());
});

/** 删除成员（级联删除相关关系） */
app.delete('/api/members/:id', (req, res) => {
  const result = store.deleteMember(req.params.id);
  if (result.error) return sendError(res, 404, result.error);
  res.json(store.list());
});

/**
 * 添加 父母→子女 关系。
 * 服务端拒绝：自指、重复边、超过两位父母、祖先环路。
 */
app.post('/api/edges', (req, res) => {
  const parentId = requireId(req.body, 'parentId');
  const childId = requireId(req.body, 'childId');
  if (!parentId || !childId) return sendError(res, 400, '请选择父母与子女');

  // 双重校验（store.addEdge 内部同样校验，保证单一规则来源）
  const check = validateEdge(store.getState(), parentId, childId);
  if (check.error) return sendError(res, 400, check.error);

  const result = store.addEdge(parentId, childId);
  if (result.error) return sendError(res, 400, result.error);
  res.status(201).json(store.list());
});

/** 删除关系（修改关系 = 删除后重新添加） */
app.delete('/api/edges', (req, res) => {
  const parentId = requireId(req.body, 'parentId');
  const childId = requireId(req.body, 'childId');
  if (!parentId || !childId) return sendError(res, 400, '缺少关系参数');
  const result = store.deleteEdge(parentId, childId);
  if (result.error) return sendError(res, 404, result.error);
  res.json(store.list());
});

/** 规范化一批草稿入参：只接受含字符串 parentId/childId 的对象 */
function normalizeBatchEdges(body) {
  const raw = body && Array.isArray(body.edges) ? body.edges : null;
  if (!raw) return null;
  return raw.slice(0, MAX_BATCH_EDGES).map((e) => ({
    parentId: e && typeof e.parentId === 'string' ? e.parentId.trim() : '',
    childId: e && typeof e.childId === 'string' ? e.childId.trim() : '',
  }));
}

/** 为预检/提交结果补充成员姓名，便于前端直接展示逐条错误 */
function decorateBatchResults(state, results) {
  const byId = new Map(state.members.map((m) => [m.id, m.name]));
  return results.map((r) => ({
    index: r.index,
    parentId: r.parentId,
    childId: r.childId,
    parentName: r.parentId ? byId.get(r.parentId) || '（不存在）' : '',
    childName: r.childId ? byId.get(r.childId) || '（不存在）' : '',
    errors: r.errors,
  }));
}

/**
 * 批量关系预检：不写入。基于「当前关系 + 整批草稿」合并结果校验，
 * 返回家谱版本、整批可否提交与逐条错误。草稿顺序不影响判定。
 */
app.post('/api/edges/batch/precheck', (req, res) => {
  const edges = normalizeBatchEdges(req.body);
  if (!edges) return sendError(res, 400, '请求体需要 edges 数组');
  if (edges.length === 0) return sendError(res, 400, '请至少添加一条关系草稿');

  const state = store.getState();
  const check = validateEdgeBatch(state, edges);
  res.json({
    version: state.version,
    valid: check.valid,
    total: check.results.length,
    invalidCount: check.results.reduce((n, r) => n + (r.errors.length ? 1 : 0), 0),
    results: decorateBatchResults(state, check.results),
  });
});

/**
 * 批量提交：必须携带预检返回的 version。
 * 版本与当前一致且整批合法时一次持久化；版本不符返回 409 提示重新预检；
 * 任一条非法则整批拒绝、不写入任何一条。
 */
app.post('/api/edges/batch', (req, res) => {
  const edges = normalizeBatchEdges(req.body);
  if (!edges) return sendError(res, 400, '请求体需要 edges 数组');
  if (edges.length === 0) return sendError(res, 400, '请至少添加一条关系草稿');

  const expectedVersion = Number.parseInt(req.body && req.body.version, 10);
  const result = store.addEdgesBatch(edges, expectedVersion);
  if (result.error) {
    if (result.stale) {
      return res.status(409).json({
        error: result.error,
        currentVersion: result.currentVersion,
      });
    }
    return res.status(400).json({
      error: result.error,
      results: result.results ? decorateBatchResults(store.getState(), result.results) : undefined,
    });
  }
  res.status(201).json(store.list());
});

/**
 * 查询两人共同祖先：
 * 沿父母链 BFS，找出总代数最少的全部共同祖先，
 * 并返回双方到每个祖先的全部最短亲缘路径（同代数不同路径全部保留）。
 */
app.get('/api/common-ancestors', (req, res) => {
  const { personA, personB } = req.query;
  if (typeof personA !== 'string' || typeof personB !== 'string') {
    return sendError(res, 400, '请选择两位成员');
  }
  const result = findCommonAncestors(store.getState(), personA, personB);
  if (result.error) return sendError(res, 404, result.error);

  const byId = new Map(store.list().members.map((m) => [m.id, m.name]));
  const decoratePath = (p) =>
    p.map((id) => ({ id, name: byId.get(id) || '（已删除）' }));

  res.json({
    samePerson: result.samePerson,
    minTotalGen: result.minTotalGen,
    ancestors: result.ancestors.map((a) => ({
      id: a.id,
      name: byId.get(a.id) || '（已删除）',
      genA: a.genA,
      genB: a.genB,
      totalGen: a.totalGen,
      pathsA: a.pathsA.map(decoratePath),
      pathsB: a.pathsB.map(decoratePath),
    })),
  });
});

/** JSON 解析错误兜底 */
app.use((err, req, res, next) => {
  if (err && err.type === 'entity.parse.failed') {
    return sendError(res, 400, '请求体不是合法的 JSON');
  }
  return next(err);
});

app.listen(PORT, HOST, () => {
  console.log(`家谱关系核对应用已启动: http://localhost:${PORT}`);
  console.log(`数据文件: ${DATA_FILE}`);
});

module.exports = app;
