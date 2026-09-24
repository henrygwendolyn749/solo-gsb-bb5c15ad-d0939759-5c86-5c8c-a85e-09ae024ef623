'use strict';

/**
 * 家谱图核心逻辑（纯函数，不依赖 Node API，便于测试）。
 *
 * 关系模型：每条边 parent -> child（父母 → 子女）。
 * parentsOf[child] = [parentA, parentB]，每名子女至多两位父母。
 * 每个连通结构必须是有向无环图（DAG），即沿父母链向上永远不会回到自身。
 */

const MAX_PARENTS_PER_CHILD = 2;
const MAX_MEMBERS = 30;
const MAX_BATCH_EDGES = 100;

/** 创建一个空的家谱状态对象 */
function createState(maxMembers = MAX_MEMBERS) {
  return {
    maxMembers,
    members: [], // [{ id, name }]
    parentsOf: {}, // memberId -> [parentId, ...]
  };
}

function getMember(state, id) {
  return state.members.find((m) => m.id === id) || null;
}

function hasMember(state, id) {
  return state.members.some((m) => m.id === id);
}

/** 边的去重键：id 为 UUID，"=>" 不会出现在其中，可安全分隔 */
function edgeKey(parentId, childId) {
  return `${parentId}=>${childId}`;
}

/**
 * 判断从 from 出发沿“父母链”向上是否能到达 to（含 from === to）。
 * parentsOf 是一个父母邻接表（结构上为 DAG 时不会死循环），用栈式 DFS。
 * 可传入临时构造的父母表（批量合并判定时使用）。
 */
function isReachableUpIn(parentsOf, from, to) {
  if (from === to) return true;
  const stack = [...(parentsOf[from] || [])];
  const seen = new Set();
  while (stack.length) {
    const cur = stack.pop();
    if (cur === to) return true;
    if (seen.has(cur)) continue;
    seen.add(cur);
    for (const p of parentsOf[cur] || []) stack.push(p);
  }
  return false;
}

/** 判断从 from 出发沿 state 的“父母链”向上是否能到达 to（含 from === to）。 */
function isReachableUp(state, from, to) {
  return isReachableUpIn(state.parentsOf, from, to);
}

/**
 * 批量校验一组待添加的 parent -> child 边（草稿）。
 *
 * 判定基准是「当前关系与整批草稿的合并结果」这一静态集合，与草稿顺序无关：
 * 先构造合并后的父母表（按集合去重），再对每条草稿独立判定，
 * 因此重排草稿不会改变任何一条的判定，也不会改变整批 valid 结论。
 * 任一条无效则 valid=false，调用方不得写入任何一条。
 *
 * 逐条累计错误（同一条可能命中多个）：
 *  - 成员不存在 / 自指（基础项，不参与后续结构判定）
 *  - 与已有关系重复 / 批内重复
 *  - 合并后该子女父母数超过上限
 *  - 合并后加入该边会形成祖先环路
 *
 * 返回：
 *   { valid, results: [{ index, parentId, childId, errors: string[] }] }
 */
function validateEdgeBatch(state, rawEdges) {
  const results = [];
  const seenKeys = new Set(); // 批内规范化后的边 key（首次出现去重）

  const entries = (Array.isArray(rawEdges) ? rawEdges : []).slice(0, MAX_BATCH_EDGES);

  for (const raw of entries) {
    const parentId = raw && typeof raw.parentId === 'string' ? raw.parentId.trim() : '';
    const childId = raw && typeof raw.childId === 'string' ? raw.childId.trim() : '';
    const result = { index: results.length, parentId, childId, errors: [] };

    if (!parentId || !childId) result.errors.push('父母与子女均为必选项');
    if (parentId && !hasMember(state, parentId)) result.errors.push('父母成员不存在');
    if (childId && !hasMember(state, childId)) result.errors.push('子女成员不存在');
    if (parentId && childId && parentId === childId) {
      result.errors.push('拒绝自指关系：不能成为自己的父母');
    }

    if (
      parentId &&
      childId &&
      parentId !== childId &&
      hasMember(state, parentId) &&
      hasMember(state, childId)
    ) {
      const key = edgeKey(parentId, childId);
      result.key = key;
      if (seenKeys.has(key)) {
        result.errors.push('拒绝批内重复：该父母→子女关系在本批草稿中出现多次');
      } else {
        seenKeys.add(key);
        result.firstInBatch = true;
      }
      if ((state.parentsOf[childId] || []).includes(parentId)) {
        result.errors.push('拒绝重复边：该父母→子女关系已存在');
        result.alreadyExists = true;
      }
    }

    results.push(result);
  }

  // 构造「当前关系 + 整批草稿（去重）」的合并父母表。
  // 与已有关系重复的边不重复加入；批内重复仅计一次。
  const merged = {};
  for (const childId of Object.keys(state.parentsOf)) {
    merged[childId] = [...state.parentsOf[childId]];
  }
  for (const r of results) {
    if (!r.key || r.alreadyExists) continue;
    const [parentId, childId] = r.key.split('=>');
    if (!(childId in merged)) merged[childId] = [];
    if (!merged[childId].includes(parentId)) merged[childId].push(parentId);
  }

  // 结构性判定（父母上限、祖先环路）只归于「真正新增的唯一边」：
  // 与已有重复或批内第 2+ 次出现的草稿不改变合并图，其错误仅为重复本身。
  for (const r of results) {
    if (!r.key || !r.firstInBatch || r.alreadyExists) continue;
    const [parentId, childId] = r.key.split('=>');

    if (merged[childId].length > MAX_PARENTS_PER_CHILD) {
      r.errors.push(
        `每名子女至多 ${MAX_PARENTS_PER_CHILD} 位父母：合并后该子女将有 ${merged[childId].length} 位父母`,
      );
    }

    // 环路判定：在合并图中临时拿掉“本边”后，
    // 若 parent 沿父母链仍可到达 child，加入本边即成环。
    const parentsOf = {
      ...merged,
      [childId]: merged[childId].filter((p) => p !== parentId),
    };
    if (isReachableUpIn(parentsOf, parentId, childId)) {
      r.errors.push('拒绝祖先环路：加入后将形成循环祖先关系');
    }
  }

  return { valid: results.length > 0 && results.every((r) => r.errors.length === 0), results };
}

/**
 * 校验并尝试添加一条 parent -> child 边。
 * 返回 { error: string } 或 { error: null }。
 * 不修改 state（由调用方在校验通过后写入）。
 */
function validateEdge(state, parentId, childId) {
  if (!hasMember(state, parentId)) return { error: '父母成员不存在' };
  if (!hasMember(state, childId)) return { error: '子女成员不存在' };

  if (parentId === childId) {
    return { error: '拒绝自指关系：不能成为自己的父母' };
  }

  const parents = state.parentsOf[childId] || [];
  if (parents.includes(parentId)) {
    return { error: '拒绝重复边：该父母→子女关系已存在' };
  }
  if (parents.length >= MAX_PARENTS_PER_CHILD) {
    return {
      error: `每名子女至多 ${MAX_PARENTS_PER_CHILD} 位父母，该成员已有 ${parents.length} 位父母`,
    };
  }

  // 祖先环路检测：若 parent 沿父母链向上能到达 child，
  // 再加 child 成为 parent 的祖先，则 child 会成为自己的祖先。
  if (isReachableUp(state, parentId, childId)) {
    return { error: '拒绝祖先环路：该父母已是此子女的后代，添加后将形成循环祖先关系' };
  }

  return { error: null };
}

/**
 * BFS 沿父母链向上，返回从 start 到其全部祖先（含自身）的“全部最短路径”。
 *
 * 返回 Map: ancestorId -> {
 *   gen: number,                 // 最短代数（向上步数）：自身 0、父母 1、祖父母 2……
 *   paths: Array<Array<id>>,     // 所有长度等于 gen 的路径，方向 start → ... → ancestor
 * }
 *
 * 同代数的不同路径全部保留（例如同时通过父系与母系到达同一祖父母）。
 */
function allShortestPathsUp(state, start) {
  const result = new Map();
  result.set(start, { gen: 0, paths: [[start]] });
  const queue = [start];
  for (let head = 0; head < queue.length; head++) {
    const cur = queue[head];
    const curInfo = result.get(cur);
    for (const p of state.parentsOf[cur] || []) {
      const nextGen = curInfo.gen + 1;
      if (!result.has(p)) {
        // 首次以 BFS 到达 p，nextGen 即最短代数
        result.set(p, {
          gen: nextGen,
          paths: curInfo.paths.map((path) => [...path, p]),
        });
        queue.push(p);
      } else if (result.get(p).gen === nextGen) {
        // 同一最短代数经另一条路径再次到达 → 保留该路径
        const info = result.get(p);
        for (const path of curInfo.paths) info.paths.push([...path, p]);
      }
      // result.get(p).gen < nextGen：更长路径，丢弃
    }
  }
  return result;
}

/**
 * 查询两人的共同祖先。
 * 返回 {
 *   samePerson: boolean,
 *   minTotalGen: number,
 *   ancestors: [{ id, genA, genB, pathsA: [[id]], pathsB: [[id]] }]
 * }
 * minTotalGen 为所有共同祖先中 genA + genB 的最小值；
 * 只返回达到该最小值的全部共同祖先；没有共同祖先时 ancestors 为空。
 */
function findCommonAncestors(state, idA, idB) {
  if (!hasMember(state, idA) || !hasMember(state, idB)) {
    return { error: '成员不存在' };
  }

  if (idA === idB) {
    const self = allShortestPathsUp(state, idA).get(idA);
    return {
      samePerson: true,
      minTotalGen: 0,
      ancestors: [
        {
          id: idA,
          genA: 0,
          genB: 0,
          totalGen: 0,
          pathsA: self.paths,
          pathsB: self.paths,
        },
      ],
    };
  }

  const upA = allShortestPathsUp(state, idA);
  const upB = allShortestPathsUp(state, idB);

  const common = [];
  let minTotalGen = Infinity;
  for (const [ancestorId, infoA] of upA) {
    const infoB = upB.get(ancestorId);
    if (!infoB) continue;
    const totalGen = infoA.gen + infoB.gen;
    if (totalGen < minTotalGen) minTotalGen = totalGen;
    common.push({
      id: ancestorId,
      genA: infoA.gen,
      genB: infoB.gen,
      totalGen,
      pathsA: infoA.paths,
      pathsB: infoB.paths,
    });
  }

  const nearest = common
    .filter((c) => c.totalGen === minTotalGen)
    .sort((a, b) => a.id.localeCompare(b.id));

  return {
    samePerson: false,
    minTotalGen: minTotalGen === Infinity ? null : minTotalGen,
    ancestors: nearest,
  };
}

module.exports = {
  MAX_PARENTS_PER_CHILD,
  MAX_MEMBERS,
  MAX_BATCH_EDGES,
  createState,
  getMember,
  edgeKey,
  isReachableUpIn,
  isReachableUp,
  validateEdge,
  validateEdgeBatch,
  allShortestPathsUp,
  findCommonAncestors,
};
