'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createStore } = require('../server/store');

function tmpFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'family-tree-'));
  return path.join(dir, 'family.json');
}

test('成员与关系写入后可被新 store 完整恢复（持久化往返）', () => {
  const file = tmpFile();

  const store1 = createStore(file);
  const a = store1.addMember('甲').member;
  const b = store1.addMember('乙').member;
  const c = store1.addMember('丙').member;
  assert.equal(store1.addEdge(a.id, b.id).error, null);
  assert.equal(store1.addEdge(b.id, c.id).error, null);

  // 落盘内容为边表格式
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.ok(Array.isArray(raw.edges));
  assert.equal(raw.edges.length, 2);

  // 模拟进程重启
  const store2 = createStore(file);
  const data = store2.list();
  assert.equal(data.members.length, 3);
  assert.equal(data.edges.length, 2);
  const byId = Object.fromEntries(data.members.map((m) => [m.name, m.id]));
  assert.deepEqual(
    data.edges.map((e) => [e.parentId, e.childId]).sort(),
    [[byId.甲, byId.乙], [byId.乙, byId.丙]].sort(),
  );
});

test('删除成员级联清除相关关系并持久化', () => {
  const file = tmpFile();
  const store = createStore(file);
  const a = store.addMember('A').member;
  const b = store.addMember('B').member;
  store.addEdge(a.id, b.id);

  assert.equal(store.deleteMember(a.id).error, null);
  const reloaded = createStore(file).list();
  assert.equal(reloaded.members.length, 1);
  assert.equal(reloaded.edges.length, 0);
});

test('非法输入与规则拒绝', () => {
  const store = createStore(tmpFile());
  assert.ok(store.addMember('  ').error);
  const a = store.addMember('A').member;
  assert.ok(store.addEdge(a.id, 'missing-id').error);
  assert.equal(store.addEdge(a.id, a.id).error.includes('自指'), true);
});

test('手工编辑出的环路数据文件在加载时被净化为 DAG', () => {  const file = tmpFile();
  // A -> B -> C -> A 为环路；另含一条合法边 C -> D
  const raw = {
    maxMembers: 30,
    members: [{ id: 'A', name: 'A' }, { id: 'B', name: 'B' }, { id: 'C', name: 'C' }, { id: 'D', name: 'D' }],
    edges: [
      { parentId: 'A', childId: 'B' },
      { parentId: 'B', childId: 'C' },
      { parentId: 'C', childId: 'A' }, // 闭环边，应被丢弃
      { parentId: 'C', childId: 'D' },
    ],
  };
  fs.writeFileSync(file, JSON.stringify(raw));
  const store = createStore(file);
  const data = store.list();
  assert.equal(data.members.length, 4);
  // 闭环边 C->A 被移除；其余边保留
  assert.deepEqual(
    data.edges.map((e) => `${e.parentId}->${e.childId}`).sort(),
    ['A->B', 'B->C', 'C->D'],
  );
  // 净化后的图查询不死循环且结果正确：B 是 D 的祖先，最近共同祖先为 B 本人（2+0 代）
  const { findCommonAncestors } = require('../server/familyGraph');
  const r = findCommonAncestors(store.getState(), 'D', 'B');
  assert.equal(r.minTotalGen, 2);
  assert.deepEqual(r.ancestors.map((a) => a.id), ['B']);
  assert.equal(r.ancestors[0].genA, 2);
  assert.equal(r.ancestors[0].genB, 0);
});

test('版本号：初始为 1，每次成功变更递增并落盘', () => {
  const file = tmpFile();
  const store = createStore(file);
  assert.equal(store.list().version, 1);
  const a = store.addMember('A').member;
  assert.equal(store.list().version, 2);
  const b = store.addMember('B').member;
  assert.equal(store.list().version, 3);
  store.addEdge(a.id, b.id);
  assert.equal(store.list().version, 4);
  // 失败的写入不递增版本
  store.addEdge(a.id, a.id);
  assert.equal(store.list().version, 4);

  const reloaded = createStore(file);
  assert.equal(reloaded.list().version, 4);
});

test('批量提交：合法批次一次写入并只递增一个版本', () => {
  const store = createStore(tmpFile());
  const a = store.addMember('A').member;
  const b = store.addMember('B').member;
  const c = store.addMember('C').member;
  const version = store.list().version;

  const result = store.addEdgesBatch(
    [{ parentId: a.id, childId: b.id }, { parentId: b.id, childId: c.id }],
    version,
  );
  assert.equal(result.error, null);
  assert.equal(result.added, 2);
  assert.equal(store.list().version, version + 1);
  assert.equal(store.list().edges.length, 2);
});

test('批量提交：任一条无效则整批拒绝、一条不写、版本不变', () => {
  const store = createStore(tmpFile());
  const a = store.addMember('A').member;
  const b = store.addMember('B').member;
  const version = store.list().version;

  const result = store.addEdgesBatch(
    [
      { parentId: a.id, childId: b.id }, // 合法
      { parentId: b.id, childId: a.id }, // 成环，非法
    ],
    version,
  );
  assert.ok(result.error);
  assert.ok(result.results.some((r) => r.errors.length > 0));
  assert.equal(store.list().edges.length, 0);
  assert.equal(store.list().version, version);
});

test('批量提交：版本不符（期间家谱变化）整体拒绝并返回 stale', () => {
  const store = createStore(tmpFile());
  const a = store.addMember('A').member;
  const b = store.addMember('B').member;
  const versionAtPrecheck = store.list().version;

  // 预检之后、提交之前，家谱发生了另一次变更
  const c = store.addMember('C').member;
  assert.notEqual(store.list().version, versionAtPrecheck);

  const result = store.addEdgesBatch(
    [{ parentId: a.id, childId: b.id }],
    versionAtPrecheck,
  );
  assert.ok(result.stale);
  assert.equal(result.currentVersion, store.list().version);
  // 陈旧版本的提交不得写入
  assert.equal(store.list().edges.length, 0);
  // 成员 C 的加入仍然保留
  assert.ok(store.list().members.some((m) => m.id === c.id));

  // 用最新版本重新提交则成功
  const retry = store.addEdgesBatch(
    [{ parentId: a.id, childId: b.id }],
    store.list().version,
  );
  assert.equal(retry.error, null);
  assert.equal(store.list().edges.length, 1);
});

test('批量提交：缺版本号或空批次被拒绝', () => {
  const store = createStore(tmpFile());
  const a = store.addMember('A').member;
  const b = store.addMember('B').member;
  assert.ok(store.addEdgesBatch([{ parentId: a.id, childId: b.id }], undefined).error);
  assert.ok(store.addEdgesBatch([], store.list().version).error);
  assert.equal(store.list().edges.length, 0);
});
