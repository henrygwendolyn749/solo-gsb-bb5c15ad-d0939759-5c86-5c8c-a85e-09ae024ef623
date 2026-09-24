'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createState, validateEdgeBatch } = require('../server/familyGraph');

/** 测试辅助：建成员 */
function makeState(names) {
  const state = createState();
  for (const name of names) {
    state.members.push({ id: name, name });
    state.parentsOf[name] = [];
  }
  return state;
}

function put(state, parent, child) {
  state.parentsOf[child].push(parent);
}

/** 取 index -> errors 映射，便于断言 */
function errorsByIndex(check) {
  const map = new Map();
  for (const r of check.results) {
    if (r.errors.length) map.set(r.index, r.errors.join('；'));
  }
  return map;
}

test('批量：全部合法时 valid=true，逐条无错误', () => {
  const state = makeState(['A', 'B', 'C', 'D']);
  put(state, 'A', 'B'); // 已有 A -> B
  const check = validateEdgeBatch(state, [
    { parentId: 'B', childId: 'C' },
    { parentId: 'B', childId: 'D' },
  ]);
  assert.equal(check.valid, true);
  assert.equal(check.results.length, 2);
  assert.deepEqual(check.results.map((r) => r.errors), [[], []]);
});

test('批量：空批次 valid=false', () => {
  const state = makeState(['A']);
  assert.equal(validateEdgeBatch(state, []).valid, false);
  assert.equal(validateEdgeBatch(state, undefined).valid, false);
});

test('批量：成员不存在与自指逐条标出', () => {
  const state = makeState(['A']);
  const check = validateEdgeBatch(state, [
    { parentId: 'A', childId: 'X' }, // 子女不存在
    { parentId: 'X', childId: 'A' }, // 父母不存在
    { parentId: 'A', childId: 'A' }, // 自指
    { parentId: '', childId: '' },   // 缺参
  ]);
  assert.equal(check.valid, false);
  const byIndex = errorsByIndex(check);
  assert.match(byIndex.get(0), /子女成员不存在/);
  assert.match(byIndex.get(1), /父母成员不存在/);
  assert.match(byIndex.get(2), /自指/);
  assert.match(byIndex.get(3), /必选/);
});

test('批量：与已有关系重复 + 批内重复（重复出现的每条都报错）', () => {
  const state = makeState(['P', 'C']);
  put(state, 'P', 'C');
  const check = validateEdgeBatch(state, [
    { parentId: 'P', childId: 'C' }, // 与已有重复
    { parentId: 'C', childId: 'P' }, // 批内仅出现一次，但与已有边反向 → 环路
  ]);
  assert.equal(check.valid, false);
  assert.match(errorsByIndex(check).get(0), /关系已存在/);
  assert.match(errorsByIndex(check).get(1), /祖先环路/);

  const check2 = validateEdgeBatch(makeState(['P', 'C']), [
    { parentId: 'P', childId: 'C' },
    { parentId: 'P', childId: 'C' },
  ]);
  const byIndex2 = errorsByIndex(check2);
  assert.equal(byIndex2.has(0), false); // 首次出现不记批内重复
  assert.match(byIndex2.get(1), /批内重复/);
  assert.equal(check2.valid, false);
});

test('批量：合并后某子女超过两位父母，相关草稿逐条报错', () => {
  const state = makeState(['P1', 'P2', 'P3', 'P4', 'C']);
  put(state, 'P1', 'C'); // 已有 1 位父母
  const check = validateEdgeBatch(state, [
    { parentId: 'P2', childId: 'C' },
    { parentId: 'P3', childId: 'C' }, // 合并后 C 将有 3 位父母
  ]);
  assert.equal(check.valid, false);
  const byIndex = errorsByIndex(check);
  assert.match(byIndex.get(0), /至多 2 位父母/);
  assert.match(byIndex.get(1), /至多 2 位父母/);
});

test('批量：恰好补到两位父母是合法的', () => {
  const state = makeState(['P1', 'P2', 'C']);
  put(state, 'P1', 'C');
  const check = validateEdgeBatch(state, [{ parentId: 'P2', childId: 'C' }]);
  assert.equal(check.valid, true);
});

test('批量：批内边相互成环时逐条标出（顺序无关）', () => {
  // 三条草稿 A->B、B->C、C->A：合并后形成环。
  // 拿掉自身边后：A->B 成环（B->C->A 到 A? 需从 parent 到 child）
  // 边 A->B：parent=A，child=B，去掉 A->B 后 A 不能上溯到 B，合法？
  // 合并父母表：B:[A], C:[B], A:[C]
  //   A->B：parentsOf 中 B 去掉 A 后为空，从 A 上溯 A->C->B，可达 B → 环
  //   B->C：去掉 C 中的 B，从 B 上溯 B->A->C，可达 C → 环
  //   C->A：去掉 A 中的 C，从 C 上溯 C->B->A，可达 A → 环
  const edges = [
    { parentId: 'A', childId: 'B' },
    { parentId: 'B', childId: 'C' },
    { parentId: 'C', childId: 'A' },
  ];
  const state1 = makeState(['A', 'B', 'C']);
  const check1 = validateEdgeBatch(state1, edges);
  assert.equal(check1.valid, false);
  assert.equal(check1.results.filter((r) => /祖先环路/.test(r.errors.join())).length, 3);

  // 颠倒草稿顺序，判定必须完全一致
  const check2 = validateEdgeBatch(makeState(['A', 'B', 'C']), [...edges].reverse());
  const keyOf = (r) => `${r.parentId}->${r.childId}`;
  const norm = (check) =>
    check.results
      .map((r) => [keyOf(r), [...r.errors].sort().join('|')])
      .sort((a, b) => a[0].localeCompare(b[0]));
  assert.deepEqual(norm(check1), norm(check2));
});

test('批量：跨草稿补齐中间世代不成环，合法', () => {
  // 空图一次录入三代：G->P、P->X，顺序无关
  const edges = [
    { parentId: 'P', childId: 'X' },
    { parentId: 'G', childId: 'P' },
  ];
  const check = validateEdgeBatch(makeState(['G', 'P', 'X']), edges);
  assert.equal(check.valid, true);
});

test('批量：草稿顺序重排不改变任何逐条判定与整批结论', () => {
  // 已有 A->B；草稿含合法补边、重复边、超父母数边的混合
  const make = () => {
    const s = makeState(['A', 'B', 'C', 'P1', 'P2', 'P3']);
    put(s, 'A', 'B');
    put(s, 'P1', 'B'); // B 已有 A、P1 两位父母
    return s;
  };
  const edges = [
    { parentId: 'A', childId: 'C' }, // 合法
    { parentId: 'A', childId: 'B' }, // 与已有重复
    { parentId: 'P2', childId: 'B' }, // B 将有 3 位父母
    { parentId: 'B', childId: 'A' }, // 环路
  ];
  const keyOf = (r) => `${r.parentId}->${r.childId}`;
  const summarize = (check) => ({
    valid: check.valid,
    per: new Map(check.results.map((r) => [keyOf(r), [...r.errors].sort()])),
  });
  const a = summarize(validateEdgeBatch(make(), edges));
  const b = summarize(validateEdgeBatch(make(), [...edges].reverse()));
  assert.equal(a.valid, b.valid);
  assert.deepEqual([...a.per.keys()].sort(), [...b.per.keys()].sort());
  for (const [k, v] of a.per) assert.deepEqual(v, b.per.get(k), `边 ${k} 的错误应一致`);
});
