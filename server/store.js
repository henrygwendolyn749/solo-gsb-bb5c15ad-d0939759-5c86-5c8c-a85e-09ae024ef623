'use strict';

/**
 * JSON 文件持久化：启动时读取，每次变更后同步写入（先写临时文件再 rename）。
 *
 * 乐观并发：state.version 为单调递增的整数版本，任何成功的变更都 +1 并落盘。
 * 批量提交必须携带预检时拿到的 expectedVersion，与当前版本不一致则整体拒绝。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {
  createState,
  validateEdge,
  validateEdgeBatch,
  isReachableUp,
  MAX_MEMBERS,
} = require('./familyGraph');

function createStore(filePath) {
  const state = loadState(filePath);

  function persist() {
    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = path.join(dir, `.${path.basename(filePath)}.${process.pid}.tmp`);
    // 统一以 { members, edges } 的边表格式落盘，与 loadState 读取格式保持一致
    const snapshot = {
      version: state.version,
      maxMembers: state.maxMembers,
      members: state.members,
      edges: edgesList(state),
    };
    fs.writeFileSync(tmp, JSON.stringify(snapshot, null, 2), 'utf8');
    fs.renameSync(tmp, filePath);
  }

  /** 应用一次变更并递增版本（每次写操作只调用一次） */
  function commit() {
    state.version += 1;
    persist();
  }

  function list() {
    return {
      version: state.version,
      maxMembers: state.maxMembers,
      members: state.members,
      edges: edgesList(state),
    };
  }

  function addMember(rawName) {
    const name = typeof rawName === 'string' ? rawName.trim().slice(0, 50) : '';
    if (!name) return { error: '姓名不能为空' };
    if (state.members.length >= state.maxMembers) {
      return { error: `成员数量上限为 ${state.maxMembers} 人，无法继续添加` };
    }
    const member = { id: crypto.randomUUID(), name };
    state.members.push(member);
    state.parentsOf[member.id] = [];
    commit();
    return { error: null, member, version: state.version };
  }

  function renameMember(id, rawName) {
    const name = typeof rawName === 'string' ? rawName.trim().slice(0, 50) : '';
    if (!name) return { error: '姓名不能为空' };
    const member = state.members.find((m) => m.id === id);
    if (!member) return { error: '成员不存在' };
    member.name = name;
    commit();
    return { error: null, member, version: state.version };
  }

  /** 删除成员：同时移除以其为父母或子女的全部边（级联） */
  function deleteMember(id) {
    if (!state.members.some((m) => m.id === id)) {
      return { error: '成员不存在' };
    }
    state.members = state.members.filter((m) => m.id !== id);
    delete state.parentsOf[id];
    for (const childId of Object.keys(state.parentsOf)) {
      state.parentsOf[childId] = state.parentsOf[childId].filter((p) => p !== id);
    }
    commit();
    return { error: null, version: state.version };
  }

  function addEdge(parentId, childId) {
    const check = validateEdge(state, parentId, childId);
    if (check.error) return check;
    state.parentsOf[childId].push(parentId);
    commit();
    return { error: null, version: state.version };
  }

  function deleteEdge(parentId, childId) {
    const parents = state.parentsOf[childId];
    if (!parents || !parents.includes(parentId)) {
      return { error: '关系不存在' };
    }
    state.parentsOf[childId] = parents.filter((p) => p !== parentId);
    commit();
    return { error: null, version: state.version };
  }

  /**
   * 原子批量添加关系：
   * 1) expectedVersion 必须等于当前版本，否则拒绝（期间家谱发生过变化）；
   * 2) 以「当前关系 + 整批草稿」合并结果重新校验，任何一条无效则整批拒绝、一条不写；
   * 3) 全部合法时一次写入、一次持久化、版本 +1。
   */
  function addEdgesBatch(edges, expectedVersion) {
    if (!Number.isInteger(expectedVersion) || expectedVersion < 0) {
      return { error: '缺少家谱版本号，请先进行预检' };
    }
    if (expectedVersion !== state.version) {
      return {
        error: '家谱已在预检后发生变化，请重新预检后再提交',
        stale: true,
        currentVersion: state.version,
      };
    }
    if (!Array.isArray(edges) || edges.length === 0) {
      return { error: '请至少添加一条关系草稿' };
    }

    const check = validateEdgeBatch(state, edges);
    if (!check.valid) {
      return { error: '批次中存在不合法关系，未写入任何一条', results: check.results };
    }

    for (const r of check.results) {
      if (!r.firstInBatch || r.alreadyExists) continue;
      const [parentId, childId] = r.key.split('=>');
      state.parentsOf[childId].push(parentId);
    }
    commit();
    return { error: null, version: state.version, added: check.results.length };
  }

  return {
    list,
    addMember,
    renameMember,
    deleteMember,
    addEdge,
    deleteEdge,
    addEdgesBatch,
    getState: () => state,
  };
}

function edgesList(state) {
  const edges = [];
  for (const [childId, parents] of Object.entries(state.parentsOf)) {
    for (const parentId of parents) edges.push({ parentId, childId });
  }
  return edges;
}

function loadState(filePath) {
  if (!fs.existsSync(filePath)) {
    const fresh = createState(MAX_MEMBERS);
    fresh.version = 1; // 空家谱的初始版本
    return fresh;
  }
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    throw new Error(`无法解析数据文件 ${filePath}: ${err.message}`);
  }

  const state = createState(Number.isInteger(raw.maxMembers) ? raw.maxMembers : MAX_MEMBERS);
  // 兼容旧数据文件（无 version 字段）：从 1 开始
  state.version = Number.isInteger(raw.version) && raw.version >= 0 ? raw.version : 1;

  if (Array.isArray(raw.members)) {
    for (const m of raw.members) {
      if (m && typeof m.id === 'string' && typeof m.name === 'string') {
        state.members.push({ id: m.id, name: m.name });
      }
    }
  }
  const ids = new Set(state.members.map((m) => m.id));
  if (Array.isArray(raw.edges)) {
    for (const e of raw.edges) {
      if (e && ids.has(e.parentId) && ids.has(e.childId) && e.parentId !== e.childId) {
        (state.parentsOf[e.childId] ||= []).push(e.parentId);
      }
    }
  } else if (raw.parentsOf && typeof raw.parentsOf === 'object') {
    // 兼容早期版本落盘的 parentsOf 邻接表格式
    for (const [childId, parents] of Object.entries(raw.parentsOf)) {
      if (!ids.has(childId) || !Array.isArray(parents)) continue;
      for (const parentId of parents) {
        if (ids.has(parentId) && parentId !== childId) {
          (state.parentsOf[childId] ||= []).push(parentId);
        }
      }
    }
  }
  for (const m of state.members) {
    const ps = state.parentsOf[m.id] || [];
    state.parentsOf[m.id] = [...new Set(ps)].slice(0, 2);
  }
  // 手工编辑数据文件可能引入环路（正常 API 路径已在写入前拦截）。
  // 按成员出现顺序做拓扑净化：丢弃会让父母链重新回到已处理成员的边，
  // 保证加载后的图一定是 DAG，避免查询时死循环。
  for (const child of state.members) {
    state.parentsOf[child.id] = state.parentsOf[child.id].filter(
      (parentId) => !isReachableUp(state, parentId, child.id),
    );
  }
  return state;
}

module.exports = { createStore };
