'use strict';
// 罗德岛棋局 · 回归测试（jsdom 集成冒烟）
// 忠实加载 game.html，验证：页面在真实 DOM 中干净启动（零脚本错误）、
// __RH 调试钩子注入、引擎核心端到端可用
//   computeBonds / applyBonds / generateEnemyTeam / makeCombatUnit / simulateBattleGrid。
// 运行：tools/run_tests.bat（已设置 jsdom 的 NODE_PATH）；或手动
//   NODE_PATH=C:\Users\wxk29\.workbuddy\binaries\node\workspace\node_modules node _playtest_jsdom.js
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');
const data = require('./data.json');

const errors = [];
const vc = new VirtualConsole();
vc.on('jsdomError', e => errors.push('jsdomError: ' + (e.detail ? (e.detail.stack || e.detail) : e.message)));

const file = path.resolve(__dirname, 'game.html');
let pass = 0, fail = 0, ran = false;
const ok = (n, c, extra) => {
  if (c) { pass++; console.log('  PASS ' + n + (extra ? '  (' + extra + ')' : '')); }
  else { fail++; console.log('  FAIL ' + n + (extra ? '  (' + extra + ')' : '')); }
};

JSDOM.fromFile(file, {
  runScripts: 'dangerously',
  resources: 'usable',
  pretendToBeVisual: true,
  virtualConsole: vc,
}).then(dom => {
  const { window } = dom;
  window.addEventListener('load', () => run(dom));
  // 兜底：极端情况下 load 事件被 jsdom 吞掉，800ms 后强制跑一次
  setTimeout(() => { if (!ran) run(dom); }, 800);
}).catch(e => { console.log('  FAIL JSDOM 加载失败: ' + e.stack); process.exit(1); });

async function run(dom) {
  if (ran) return; ran = true;
  const { window } = dom;
  const RH = window.__RH;
  ok('window.__RH 已注入（页面启动无致命错误）', !!RH);
  if (!RH) { finish(); return; }
  ok('__RH 含核心函数', ['computeBonds', 'applyBonds', 'generateEnemyTeam', 'simulateBattleGrid', 'makeCombatUnit']
    .every(k => typeof RH[k] === 'function'));

  const ops = data.operators;
  ok('data.json 加载 136 干员', Array.isArray(ops) && ops.length === 136, 'got ' + ops.length);

  // computeBonds（同阵营确保羁绊激活）
  const allies = ops.filter(o => (o.bonds && o.bonds['阵营']) === '罗德岛').slice(0, 6);
  const bonds = RH.computeBonds(allies);
  ok('computeBonds 返回结构', bonds && bonds.mult && bonds.sig && bonds.special);

  // applyBonds + 战斗单位构建
  const units = allies.map(o => RH.makeCombatUnit(o, 1, 'ally', bonds.mult[o.name], bonds.sig[o.name], bonds.special[o.name]));
  try { RH.applyBonds(units, 'ally'); ok('applyBonds 生效', true); }
  catch (e) { fail++; console.log('  FAIL applyBonds: ' + e.message); }

  // generateEnemyTeam
  let et;
  try { et = RH.generateEnemyTeam(5, 1, false, 'normal', 2); ok('generateEnemyTeam OK', Array.isArray(et) && et.length > 0, 'n=' + et.length); }
  catch (e) { fail++; console.log('  FAIL generateEnemyTeam: ' + e.message); }
  if (!et || !et.length) et = allies.slice(0, 5).map(o => ({ op: o, star: 1, buff: 1 })); // 兜底（理论上不会走到）

  const enemyU = et.map(e => RH.makeCombatUnit(e.op, e.star, 'enemy',
    { atk: e.buff, hp: e.buff, def: 1, aspd: 1, crit: 0, magicAmp: 1, healAmp: 1, spInit: 0, spRegen: 1 }, {}, null));

  // simulateBattleGrid（端到端战斗；需传入双方网格站位）
  const allyPos = units.map((u, i) => ({ x: 0, y: i }));
  const enemyPos = enemyU.map((u, i) => ({ x: 2, y: i }));
  try {
    const res = RH.simulateBattleGrid(units, enemyU, allyPos, enemyPos);
    ok('simulateBattleGrid 返回结果', res && res.winner && Array.isArray(res.frames) && res.frames.length > 0,
      'winner=' + (res && res.winner) + ' frames=' + (res && res.frames.length));
  } catch (e) { fail++; console.log('  FAIL simulateBattleGrid: ' + e.message); }

  // —— v2.1 召唤物架构不变量（防止 applyBonds 吞掉 isSummon / 等级成长）——
  try {
    const wolf = RH.makeCombatSummon('wolf', 3, 'ally', 'a0');
    ok('makeCombatSummon 返回 isSummon 标识', !!wolf && wolf.isSummon === true && wolf.summonType === 'wolf');
    ok('makeCombatSummon 等级成长生效（Lv.3 atk > 基础130）', !!wolf && wolf.atk > 130, 'atk=' + (wolf && wolf.atk));
    const regOp = ops.find(o => (o.bonds || {}).阵营 === '罗德岛') || ops[0];
    // 常规干员须先经 applyBonds 转为完整 CombatUnit（与真实 onFight 流程一致），否则模拟会缺字段
    const regUnit = RH.applyBonds([{ op: regOp, star: 1 }], 'ally')[0];
    const placed = RH.placeAdjacentSummons(
      [regUnit],
      [{ x: 3, y: 1 }],
      [{ unit: wolf, summonerPos: { x: 3, y: 1 } }]
    );
    ok('placeAdjacentSummons 并入召唤物且相邻站位', placed.allyList.length === 2 &&
      placed.allyPos[1] && Math.max(Math.abs(placed.allyPos[1].x - 3), Math.abs(placed.allyPos[1].y - 1)) === 1,
      'pos=' + JSON.stringify(placed.allyPos[1]));
    // 关键：召唤物对象未被 applyBonds 重建（引用相等）→ 证明 v2.1 绕过羁绊重建，isSummon 保真
    ok('召唤物未被 applyBonds 重建（引用保真）', placed.allyList[1] === wolf);
    const simRes = RH.simulateBattleGrid(
      placed.allyList,
      [RH.makeCombatUnit(regOp, 1, 'enemy', { atk: 1, hp: 1, def: 1, aspd: 1, crit: 0, magicAmp: 1, healAmp: 1, spInit: 0, spRegen: 1 }, {}, null)],
      placed.allyPos,
      [{ x: 4, y: 1 }]
    );
    ok('simulateBattleGrid 含召唤物时正常产出帧', !!simRes && Array.isArray(simRes.frames) && simRes.frames.length > 0,
      'winner=' + (simRes && simRes.winner) + ' frames=' + (simRes && simRes.frames.length));
  } catch (e) { fail++; console.log('  FAIL 召唤物不变量: ' + e.message); }

  // —— 攻击范围（v2.4：职业基础 + 子职业细分 + 统一 rangeOf）——
  // 断言：makeCombatUnit 依子职业优先给 range，且为有限整数（杜绝 cheb<=undefined 永不攻击）
  try {
    const probe = [
      ['神射手', 5], ['重射手', 4], ['速射手', 3], ['炮手', 3], ['攻城手', 3],
      ['中坚术师', 3], ['秘术师', 4], ['扩散术师', 2],
      ['术战者', 2], ['战术家', 2], ['要塞', 2], ['炼金师', 2],
      ['尖兵', 1], ['铁卫', 1], ['召唤师', 1], ['处决者', 1]
    ];
    let allOk = true; const detail = [];
    probe.forEach(([sc, expect]) => {
      const op = ops.find(o => o.subclass === sc);
      if (!op) { allOk = false; detail.push(sc + '=缺失'); return; }
      const u = RH.makeCombatUnit(op, 1, 'ally');
      const got = (typeof u.range === 'number' && isFinite(u.range)) ? u.range : ('undef:' + u.range);
      if (u.range !== expect) { allOk = false; detail.push(sc + '=' + got + '(期望' + expect + ')'); }
    });
    ok('子职业射程细分生效（神射手5/重射手4/术战者2/尖兵1…）', allOk, detail.join(' '));
    // 职业级回落：未列子类的干员走 CLASS_RANGE 职业档
    const fallbackOp = ops.find(o => o.subclass === '领主');
    if (fallbackOp) {
      const u = RH.makeCombatUnit(fallbackOp, 1, 'ally');
      ok('射程解析有限整数（杜绝 cheb<=undefined）', typeof u.range === 'number' && isFinite(u.range) && u.range >= 1, 'range=' + u.range);
    }
  } catch (e) { fail++; console.log('  FAIL 攻击范围: ' + e.message); }

  // —— autoPositions 行优先分布（防单位全堆前列单列、底行被裁切）——
  // 6 个单位 → 应铺在前两行（y=0,1），不应堆到 y=5 底行。
  try {
    const G = RH.G;
    const dummyOp = ops[0];
    const mk = (x, y) => Object.assign(RH.makeCombatUnit(dummyOp, 1, 'ally'), { x, y, uid: 't' + x + y });
    const ys = [];
    for (let i = 0; i < 6; i++) ys.push(RH.autoPositions([dummyOp, dummyOp, dummyOp, dummyOp, dummyOp, dummyOp], 'enemy')[i].y);
    ok('autoPositions 行优先：6 单位铺前两行（max y ≤ 1）', Math.max.apply(null, ys) <= 1, 'ys=' + ys.join(','));
  } catch (e) { fail++; console.log('  FAIL 行优先分布: ' + e.message); }

  // —— 8×6 部署区 & 战斗演出完整性（防"敌人看不到"复发）——
  // 根因曾有二：(1) showBattle 渲染源缺 uid → 单位不渲染；(2) 战斗网格只按 92vw 不按视口高约束 → 底部行被裁切。
  // 断言：部署区 48 格 / 右半 24 enemy-zone / 敌方预览芯片 24；战斗演出渲染全部敌人（含 y=4~5 底部行）。
  try {
    const G = RH.G;
    const d = window.document;
    const low = ops.filter(o => o.stats && o.stats.cost <= 3);
    const hi = ops.filter(o => o.stats && o.stats.cost >= 2);
    [0, 1, 2, 3, 8, 9].forEach((slot, i) => { G.board[slot] = { op: low[i % low.length], star: 1, uid: 'u' + i }; });
    G.currentEnemy = hi.slice(0, 24).map((o, i) => ({ op: o, star: (i % 3 === 0 ? 2 : 1), buff: null }));
    G.bench = []; G.gold = 99; G.level = 6;
    RH.renderAll();
    ok('部署区渲染 48 格（左 24 部署 / 右 24 敌方底格）',
      d.querySelectorAll('#board .board-cell').length === 48 &&
      d.querySelectorAll('#board .board-cell.enemy-zone').length === 24,
      'cells=' + d.querySelectorAll('#board .board-cell').length +
      ' enemy-zone=' + d.querySelectorAll('#board .board-cell.enemy-zone').length);
    ok('敌方站位预览芯片 24 个且位于右半',
      d.querySelectorAll('#enemyOverlay .eo-chip').length === 24,
      'chips=' + d.querySelectorAll('#enemyOverlay .eo-chip').length);
    RH.onFight();
    const bfEnemy = d.querySelectorAll('#bfGrid .bf-unit.enemy');
    const bfAlly = d.querySelectorAll('#bfGrid .bf-unit.ally');
    ok('战斗演出渲染全部 6 我方 + 24 敌方（无缺漏）',
      bfAlly.length === 6 && bfEnemy.length === 24,
      'ally=' + bfAlly.length + ' enemy=' + bfEnemy.length);
    const bottom = Array.from(bfEnemy).filter(el => {
      const m = /translate\([^,]+,(\d+(?:\.\d+)?)px\)/.exec(el.style.transform);
      return m && parseFloat(m[1]) > 250;
    });
    ok('战斗演出底部行（y>=4）敌人已渲染 ≥8', bottom.length >= 8, 'bottom=' + bottom.length);
    if (G.frameTimer) { clearInterval(G.frameTimer); G.frameTimer = null; }
  } catch (e) { fail++; console.log('  FAIL 8×6 战斗完整性: ' + e.message); }

  // —— 攻击范围适配（8×6 战场下的射程可达性）——
  // 射程为 Chebyshev 距离：需证明横向最远（狙击 x3→x7=4）与贴脸（近战 x3→x4=1）在 8×6 场地上确实能命中。
  try {
    const sniperOp = ops.find(o => o.class === '狙击' && o.stats);
    const meleeOp = ops.find(o => (o.class === '近卫' || o.class === '先锋' || o.class === '重装') && o.stats);
    if (!sniperOp || !meleeOp) { throw new Error('缺少狙击/近战模板'); }
    const mk = (op, x, y) => {
      const u = RH.makeCombatUnit(op, 1, 'ally');
      u.x = x; u.y = y; u.uid = 'u'; return u;
    };
    const mkE = (op, x, y) => {
      const u = RH.makeCombatUnit(op, 1, 'enemy');
      u.x = x; u.y = y; u.uid = 'e'; return u;
    };
    const sim1 = RH.simulateBattleGrid(
      [mk(sniperOp, 3, 5)],
      [mkE(meleeOp, 7, 5)],
      [{ x: 3, y: 5 }], [{ x: 7, y: 5 }]);
    const sniperHit = sim1.frames.some(fr => fr.enemy && fr.enemy.some(e => e.hp < e.max));
    ok('狙击（射程4）横跨全场可达（x3→x7 命中）', !!sniperHit, 'range=' + RH.makeCombatUnit(sniperOp, 1, 'ally').range);
    const sim2 = RH.simulateBattleGrid(
      [mk(meleeOp, 3, 5)],
      [mkE(sniperOp, 4, 5)],
      [{ x: 3, y: 5 }], [{ x: 4, y: 5 }]);
    const meleeHit = sim2.frames.some(fr => fr.enemy && fr.enemy.some(e => e.hp < e.max));
    ok('近战（射程1）贴脸可达（x3→x4 命中）', !!meleeHit, 'range=' + RH.makeCombatUnit(meleeOp, 1, 'ally').range);
  } catch (e) { fail++; console.log('  FAIL 攻击范围适配: ' + e.message); }

  // —— v2 装备系统不变量 ——
  try {
    const pool = RH.EQUIP_POOL, byId = RH.EQUIP_BY_ID;
    ok('装备池结构完整（每条含 id/name/cost/type，铭刻含 countAsFaction）',
      Array.isArray(pool) && pool.length >= 10 &&
      pool.every(e => e.id && e.name && typeof e.cost === 'number' && e.type &&
        (e.type !== 'engraving' || e.countAsFaction)) &&
      pool.every(e => byId[e.id] === e),
      'pool=' + pool.length);
    const testOp = ops.find(o => o.class === '近卫' && o.stats) || ops[0];
    const base = RH.makeCombatUnit(testOp, 1, 'ally');
    const attrU = RH.makeCombatUnit(testOp, 1, 'ally', 1, { attr: {}, kw: {} }, null, null, [byId['e_blade']]);
    ok('装备·属性装注入生效（制式单刃 atk +15%）', attrU.atk > base.atk, 'base=' + base.atk + ' with=' + attrU.atk);
    const mechU = RH.makeCombatUnit(testOp, 1, 'ally', 1, { attr: {}, kw: {} }, null, null, [byId['e_thorn']]);
    ok('装备·机制装注入生效（荆棘护甲 counter kw）',
      Array.isArray(mechU.equipKw) && mechU.equipKw.indexOf('counter') >= 0 && mechU.counter >= 0.15,
      'kw=' + (mechU.equipKw || []) + ' counter=' + (mechU.counter || 0));
    // 无装备 uid 安全返回空（Node 单测 / 未穿戴场景）
    ok('equipFor 未穿戴时返回空数组（安全）', Array.isArray(RH.equipFor('__none__')) && RH.equipFor('__none__').length === 0, 'ok');
    // 购买入背包 + 扣费
    if (typeof G !== 'undefined') {
      const g0 = G.gold; G.gold = 99;
      const bag0 = (G.equipState && G.equipState.bag || []).length;
      RH.buyEquip('e_blade');
      const bag1 = (G.equipState && G.equipState.bag || []).length;
      ok('buyEquip 入背包并扣费', bag1 === bag0 + 1 && G.gold === 99 - byId['e_blade'].cost, 'bag+' + (bag1 - bag0) + ' gold=' + G.gold);
    }
  } catch (e) { fail++; console.log('  FAIL v2 装备系统: ' + e.message); }

  // —— v2.3 部署格轻量卡（方案A+C：立绘优先，标签/装备 hover 显示，详情条收编信息）——
  try {
    const d = window.document;
    const boardCards = d.querySelectorAll('#board .ucard');
    const boardLite = d.querySelectorAll('#board .ucard.board-lite');
    ok('部署格卡带 board-lite（立绘优先轻量卡）',
      boardCards.length > 0 && boardLite.length === boardCards.length,
      'lite=' + boardLite.length + '/' + boardCards.length);
    ok('选中详情条含装备区（#ubEquip）', !!d.querySelector('#ubEquip'));
    ok('备战席卡不带 board-lite（保持完整信息卡）',
      d.querySelectorAll('#bench .ucard.board-lite').length === 0);
  } catch (e) { fail++; console.log('  FAIL 轻量卡: ' + e.message); }

  // —— v2.4 升星：棋盘作主体 + 回主体原位 + 备战席兜底 ——
  try {
    const G = RH.G;
    const op = ops.find(o => o.stats && o.stats.cost <= 2) || ops[0];
    // 场景1：棋盘主体（board[3] 1星 + 备战席 2 张同名 1 星 → 合成）
    G.board = { 3: { uid: 'mb1', op, star: 1 } };
    G.bench = [{ uid: 'mb2', op, star: 1 }, { uid: 'mb3', op, star: 1 }];
    G._combineFx = [];
    RH.tryCombine();
    ok('升星·棋盘作主体并回原位（board[3]→2星，备战席清空）',
      !!(G.board[3] && G.board[3].star === 2 && G.bench.length === 0),
      'board3=' + (G.board[3] && G.board[3].star) + ' bench=' + G.bench.length);
    // 场景2：主体在备战席 → 结果留备战席（不放棋盘）
    G.board = {}; G.bench = [
      { uid: 'sb1', op, star: 1 }, { uid: 'sb2', op, star: 1 }, { uid: 'sb3', op, star: 1 }
    ];
    RH.tryCombine();
    ok('升星·主体在备战席则留备战席（board 空，bench 1张2星）',
      Object.keys(G.board).length === 0 && G.bench.length === 1 && G.bench[0].star === 2,
      'board=' + Object.keys(G.board).length + ' bench=' + G.bench.length + ' star=' + (G.bench[0] && G.bench[0].star));
  } catch (e) { fail++; console.log('  FAIL 升星逻辑: ' + e.message); }

  // —— 旧存档防御（v2.3.1 修复）：nodeIdx 越界的旧存档不得中断启动 / 不得留空 overlay ——
  try {
    const htmlSrc = fs.readFileSync(file, 'utf8');
    // 内联脚本（避免 jsdom url 模式下 http 加载外部资源），带 url 让 localStorage 可用
    const inlined = htmlSrc.replace(/<script src="([^"?]+)(\?[^"]*)?"[^>]*><\/script>/g, (m, src) => {
      const f = path.join(__dirname, src);
      return fs.existsSync(f) ? '<script>' + fs.readFileSync(f, 'utf8') + '<\/script>' : m;
    });
    const errs2 = [];
    const vc2 = new VirtualConsole();
    vc2.on('jsdomError', e => errs2.push((e.detail && e.detail.stack) || e.message));
    const dom2 = new JSDOM(inlined, {
      url: 'http://localhost/game.html',
      runScripts: 'dangerously',
      pretendToBeVisual: true,
      storageQuota: 5 * 1024 * 1024,
      virtualConsole: vc2,
      beforeParse(w) {
        // 模拟旧版本存档：nodeIdx=99 超出当前 27 节点图
        w.localStorage.setItem('rh_chess_save', JSON.stringify({
          v: 1, ts: Date.now(), nodeIdx: 99, gold: 15, level: 3, exp: 10,
          hp: 84, maxHp: 100, winStreak: 0, lossStreak: 0, env: 'gold', phase: 'arena',
          bench: [], board: {}, shop: [null, null, null, null, null],
          currentEnemy: [], selected: null, result: null,
        }));
      },
    });
    await new Promise(res => setTimeout(res, 600));
    const d2 = dom2.window.document;
    ok('越界旧存档不再崩溃（零 jsdomError）', errs2.length === 0, errs2.length ? errs2[0].slice(0, 80) : 'clean');
    // 越界存档应被清档降级 → 进入难度选择 → 投资环境卡片正常渲染
    const startHidden2 = d2.getElementById('startScreen').classList.contains('hidden');
    ok('越界旧存档自动清档降级（不显示开始屏）', !!startHidden2, 'startHidden=' + startHidden2);
    d2.querySelectorAll('#diffChoices .diff-card')[0].click();
    await new Promise(res => setTimeout(res, 80));
    const envN = d2.querySelectorAll('#envChoices .env-card').length;
    ok('降级后投资环境卡片正常渲染', envN >= 3, 'envCards=' + envN);
    dom2.window.close();
  } catch (e) { fail++; console.log('  FAIL 旧存档防御: ' + e.message); }

  // —— v2.4 统一动效系统（FX）——
  try {
    const fx = RH.FX;
    ok('FX 动效系统就绪（飘字/粒子/涟漪/震屏）',
      !!fx && typeof fx.floatText === 'function' && typeof fx.burst === 'function' &&
      typeof fx.ripple === 'function' && typeof fx.shake === 'function' && typeof fx.reduced === 'boolean',
      'methods=' + (fx ? ['floatText','burst','ripple','shake'].filter(k => typeof fx[k] === 'function').join(',') : 'none'));
    // 函数可无异常调用（jsdom 无布局 → 内部跳过，不应抛错）
    let callOk = true;
    try { fx.floatText(0, 0, '测试'); fx.burst(0, 0, 3); fx.ripple(0, 0); fx.shake(80, 2); } catch (e) { callOk = false; }
    ok('FX 方法无异常调用（jsdom 安全降级）', callOk);
  } catch (e) { fail++; console.log('  FAIL FX 系统: ' + e.message); }

  // —— v2.8 布局：顶部行(商店|流程|售出) + 侧栏(羁绊+装备) + 主区(棋盘+上场角色+备战区格子) ——
  try {
    const d = window.document;
    const side = d.querySelector('.arena-side');
    const main = d.querySelector('.arena-main');
    const arena = d.querySelector('#arena');
    const topRow = d.querySelector('#topRow');
    ok('v4.1 布局结构：顶部行只含节点条（不滚动完整显示），侧栏敌方编队+羁绊装备，主区棋盘+备战区+action-bar（商店+开战+售出移底部）',
      !!side && !!main && !!arena && !!topRow &&
      !topRow.querySelector('#btnShopToggle') && !!topRow.querySelector('#nodeFlow') && !topRow.querySelector('#sellZone') && !d.querySelector('#shopToolbar') &&
      !!side.querySelector('.enemy-info') && !!side.querySelector('.bonds-bar-wrap') && !!side.querySelector('#equipPanel') && !side.querySelector('.shop') &&
      !!arena.querySelector('#shopPopover') && !!main.querySelector('.board-battle #board') && !main.querySelector('#rosterRail') &&
      !!main.querySelector('.bench-area') && !!main.querySelector('.action-bar') &&
      !!main.querySelector('.action-bar .action-main #btnShopToggle') && !!main.querySelector('.action-bar .action-main #btnFight') && !!main.querySelector('.action-bar .action-main #sellZone'),
      'top=[' + (topRow ? [!topRow.querySelector('#btnShopToggle'), !!topRow.querySelector('#nodeFlow'), !topRow.querySelector('#sellZone')] : 'none') + ']' +
      ' side=[' + (side ? [!!side.querySelector('.enemy-info'), !!side.querySelector('.bonds-bar-wrap'), !!side.querySelector('#equipPanel')] : 'none') + ']' +
      ' board=' + !!main.querySelector('.board-battle #board') + ' benchArea=' + !!main.querySelector('.bench-area'));
  } catch (e) { fail++; console.log('  FAIL v2.8 布局: ' + e.message); }

  // —— v2.5 快捷键：1-5 买卡 / E 部署选中 / F 开战（overlay 打开时屏蔽） ——
  try {
    const d = window.document;
    const DATA = window.eval('__DATA');
    const G2 = RH.G;
    d.querySelector('#arena').classList.remove('hidden');
    d.querySelectorAll('.overlay').forEach(o => o.classList.add('hidden'));
    const opK = DATA.operators[0];
    G2.gold = 99; G2.board = {}; G2.bench = []; G2.shop = [opK, null, null, null, null]; G2.level = 6;
    d.body.dispatchEvent(new window.KeyboardEvent('keydown', { key: '1', bubbles: true }));
    const buyOk = G2.bench.length === 1 && !G2.shop[0] && G2.gold === 98;
    const uidK = G2.bench[0] && G2.bench[0].uid;
    G2.selected = uidK;
    d.body.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'e', bubbles: true }));
    const depOk = !!uidK && Object.values(G2.board).some(u => u.uid === uidK) && G2.bench.length === 0;
    G2.currentEnemy = [opK, opK, opK].map((o, i) => ({ op: o, star: 1, buff: null }));
    d.body.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'f', bubbles: true }));
    const fightOk = !d.querySelector('#battleScreen').classList.contains('hidden');
    if (G2.frameTimer) { clearInterval(G2.frameTimer); G2.frameTimer = null; }
    d.querySelector('#battleScreen').classList.add('hidden');
    G2.gold = 99; G2.bench = []; G2.shop = [opK, null, null, null, null];
    d.querySelector('#strategyScreen').classList.remove('hidden');
    d.body.dispatchEvent(new window.KeyboardEvent('keydown', { key: '1', bubbles: true }));
    const guardOk = G2.gold === 99 && G2.bench.length === 0;
    d.querySelector('#strategyScreen').classList.add('hidden');
    ok('快捷键：1买卡/E部署/F开战/overlay屏蔽',
      buyOk && depOk && fightOk && guardOk,
      'buy=' + buyOk + ' dep=' + depOk + ' fight=' + fightOk + ' guard=' + guardOk);
  } catch (e) { fail++; console.log('  FAIL 快捷键: ' + e.message); }

  // —— v2.5 战斗舞台化：战斗帧携带 fx 弹道事件（攻击者 uid → 目标 uid） ——
  try {
    const D2 = window.eval('__DATA');
    const ops2 = D2.operators.filter(o => o.stats && o.stats.cost <= 3);
    const a2 = RH.makeCombatUnit(ops2[0], 1, 'ally'); a2.x = 3; a2.y = 0;
    const e2 = RH.makeCombatUnit(ops2[1], 1, 'enemy'); e2.x = 4; e2.y = 0;
    const r2 = RH.simulateBattleGrid([a2], [e2], [{ x: 3, y: 0 }], [{ x: 4, y: 0 }]);
    const fxN = r2.frames.reduce((s, f) => s + (f.fx ? f.fx.length : 0), 0);
    ok('战斗帧携带 fx 弹道事件（攻击者→目标）', fxN > 0, 'fxEvents=' + fxN);
  } catch (e) { fail++; console.log('  FAIL 战斗舞台化: ' + e.message); }

  // —— v2.5 战斗回放 + 战报：结算后 resultRecap 含三榜、btnReplay 回放无异常 ——
  try {
    const d = window.document;
    const D3 = window.eval('__DATA');
    const ops3 = D3.operators.filter(o => o.stats && o.stats.cost <= 3);
    const G3 = RH.G;
    G3.board = { 0: { uid: 'rr0', op: ops3[0], star: 1 }, 8: { uid: 'rr1', op: ops3[1], star: 1 } };
    G3.bench = []; G3.gold = 99; G3.level = 6;
    G3.currentEnemy = [ops3[2], ops3[3]].map((o, i) => ({ op: o, star: 1, buff: null }));
    G3._audioSkip = true;
    RH.onFight();
    if (G3._skip) G3._skip();
    const rcH = d.querySelector('#resultRecap') ? d.querySelector('#resultRecap').innerHTML : '';
    const reportOk = !!G3._lastRes && rcH.indexOf('输出榜') >= 0 && rcH.indexOf('承伤榜') >= 0;
    const repBtn = !!d.querySelector('#btnReplay') && !!d.querySelector('#btnPause');
    d.querySelector('#btnReplay').dispatchEvent(new d.defaultView.MouseEvent('click', { bubbles: true }));
    const replayOk = !d.querySelector('#battleScreen').classList.contains('hidden') &&
      d.querySelector('#resultScreen').classList.contains('hidden') &&
      d.querySelectorAll('#bfGrid .bf-unit').length >= 2;
    if (G3.frameTimer) { clearInterval(G3.frameTimer); G3.frameTimer = null; }
    ok('战斗回放+战报：三榜渲染、按钮存在、回放重播无异常',
      reportOk && repBtn && replayOk,
      'report=' + reportOk + ' btns=' + repBtn + ' replay=' + replayOk);
  } catch (e) { fail++; console.log('  FAIL 战斗回放战报: ' + e.message); }

  // —— v2.5 主题皮肤 + 新手引导：themeBtn 切换往返、引导气泡/高亮/下一步/跳过记忆 ——
  try {
    const d = window.document;
    // jsdom 某些环境 localStorage 不可用 → 注入内存 stub（真实浏览器不受影响）
    let lsProbe = true;
    try { window.localStorage.setItem('__p', '1'); window.localStorage.removeItem('__p'); } catch (e) { lsProbe = false; }
    if (!lsProbe) {
      try {
        const mem = {};
        Object.defineProperty(window, 'localStorage', { configurable: true, value: {
          getItem: k => (k in mem ? mem[k] : null), setItem: (k, v) => { mem[k] = String(v); }, removeItem: k => { delete mem[k]; }
        } });
      } catch (e) {}
    }
    try { window.localStorage.removeItem('ak_tut_v1'); } catch (e) {}
    const tb = d.querySelector('#themeBtn');
    tb.dispatchEvent(new d.defaultView.MouseEvent('click', { bubbles: true }));
    const t1 = d.body.dataset.theme === 'brief';
    tb.dispatchEvent(new d.defaultView.MouseEvent('click', { bubbles: true }));
    const t2 = !d.body.dataset.theme;
    const D4 = window.eval('__DATA');
    const G4 = RH.G;
    G4.gold = 99; G4.board = {}; G4.bench = []; G4.shop = [D4.operators[0], null, null, null, null];
    G4.nodeIdx = 0; G4.level = 6;
    d.querySelector('#arena').classList.remove('hidden');
    RH.renderAll();
    RH.startTutorial();
    const tutShow = !d.querySelector('#tutorial').classList.contains('hidden') && d.querySelectorAll('.tut-hl').length >= 1;
    d.querySelector('#tutNext').dispatchEvent(new d.defaultView.MouseEvent('click', { bubbles: true }));
    const step2 = (d.querySelector('#tutStep') || {}).textContent || '';
    d.querySelector('#tutSkip').dispatchEvent(new d.defaultView.MouseEvent('click', { bubbles: true }));
    let skipOk = false;
    try { skipOk = d.querySelector('#tutorial').classList.contains('hidden') && window.localStorage.getItem('ak_tut_v1') === '1'; } catch (e) {}
    ok('主题切换往返 + 新手引导（显示/高亮/下一步/跳过记忆）',
      t1 && t2 && tutShow && step2.indexOf('②') >= 0 && skipOk,
      'theme=' + t1 + ',' + t2 + ' tut=' + tutShow + ' step2=' + (step2.indexOf('②') >= 0) + ' skip=' + skipOk);
  } catch (e) { fail++; console.log('  FAIL 主题/引导: ' + e.message); }

  // —— v2.6 全屏战场（方案A：左侧日志栏 + 主区棋盘）+ 射程层跟随单位移动 ——
  try {
    const d = window.document;
    const bs = d.querySelector('#battleScreen');
    const s1 = !!bs.querySelector('.bf-side') && !!bs.querySelector('.bf-side #battleLog') &&
      !!bs.querySelector('.bf-actions') && !!bs.querySelector('.bf-actions #btnPause') &&
      !!bs.querySelector('.bf-actions #btnSkip') && !!bs.querySelector('.bf-frame #bfGrid') &&
      !bs.querySelector(':scope > .battle-log');
    const D5 = window.eval('__DATA');
    const ops5 = D5.operators.filter(o => o.stats && o.stats.cost <= 3);
    const G5 = RH.G;
    G5.board = { 0: { uid: 'y0', op: ops5[0], star: 1 }, 8: { uid: 'y1', op: ops5[1], star: 1 } };
    G5.bench = []; G5.gold = 99; G5.level = 6;
    G5.currentEnemy = [ops5[2], ops5[3]].map((o, i) => ({ op: o, star: 1, buff: null }));
    G5._audioSkip = true;
    RH.onFight();
    const unit5 = d.querySelector('#bfGrid .bf-unit.ally');
    const uid5 = unit5.dataset.uid;
    unit5.dispatchEvent(new d.defaultView.MouseEvent('mouseover', { bubbles: true }));
    const tagA = parseFloat(d.querySelector('#bfGrid .bf-range-tag').style.left);
    G5._bfUnits[uid5].x += 2;
    RH.drawRangeLayer(uid5);
    const tagB = parseFloat(d.querySelector('#bfGrid .bf-range-tag').style.left);
    const followOk = Math.abs(tagB - tagA) >= 1;
    unit5.dispatchEvent(new d.defaultView.MouseEvent('mouseout', { bubbles: true }));
    const clearOk = !d.querySelector('#bfGrid .bf-range-layer');
    if (G5.frameTimer) { clearInterval(G5.frameTimer); G5.frameTimer = null; }
    ok('全屏战场结构（左侧日志栏+主区棋盘）+ 射程层跟随移动',
      s1 && followOk && clearOk,
      'struct=' + s1 + ' follow=' + followOk + ' clear=' + clearOk);
  } catch (e) { fail++; console.log('  FAIL 全屏战场: ' + e.message); }

  // —— v3.0 铭刻（勋章）触发共鸣：engraving 的 countAsFaction 计入呼应触发 + 佩戴者吃加成 + 显示层点亮 ——
  try {
    const d = window.document;
    const G6 = RH.G;
    const ops6 = window.eval('__DATA').operators;
    const yan6 = ops6.find(o => (o.bonds || {}).阵营 === '炎');
    const rh6 = ops6.find(o => (o.bonds || {}).阵营 === '罗德岛');
    G6.equipState = { bag: [], slots: { 8101: ['e_m_longmen'] } };
    const bu6 = [
      { uid: 8100, name: yan6.name, bonds: yan6.bonds, star: 1 },
      { uid: 8101, name: rh6.name, bonds: rh6.bonds, star: 1 }, // 罗德岛穿龙门徽章
    ];
    const cb6 = RH.computeBonds(bu6);
    // 战斗层：炎吃 炎|龙门 的 def+6%、穿徽章者吃 龙门 的 atk+6%
    const eff6 = (window.RESONANCE && window.RESONANCE.EFF['炎|龙门']) || null;
    ok('铭刻触发共鸣：炎-龙门 EFF 存在', !!eff6, JSON.stringify(eff6));
    ok('铭刻触发共鸣：炎干员吃 def 加成（+6%）', eff6 && Math.abs(cb6.mult[yan6.name].def - (1 + eff6['炎'].def)) < 1e-9,
      'def=' + cb6.mult[yan6.name].def);
    ok('铭刻触发共鸣：穿徽章者吃龙门 atk 加成（+6%）', eff6 && Math.abs(cb6.mult[rh6.name].atk - (1 + eff6['龙门'].atk)) < 1e-9,
      'atk=' + cb6.mult[rh6.name].atk);
    // 对照组：卸徽章 → 无共鸣加成
    G6.equipState = { bag: [], slots: {} };
    const cb6b = RH.computeBonds(bu6);
    ok('铭刻触发共鸣：卸徽章后无加成（对照组）',
      Math.abs(cb6b.mult[yan6.name].def - 1) < 1e-9 && Math.abs(cb6b.mult[rh6.name].atk - 1) < 1e-9,
      'def=' + cb6b.mult[yan6.name].def + ' atk=' + cb6b.mult[rh6.name].atk);
    // 显示层：renderBonds 点亮呼应对
    G6.board = { 0: { uid: 8100, op: yan6, star: 1 }, 1: { uid: 8101, op: rh6, star: 1 } };
    G6.bench = [];
    G6.equipState = { bag: [], slots: { 8101: ['e_m_longmen'] } };
    RH.renderBonds();
    const bar6 = d.getElementById('bondsBar');
    const html6 = bar6 ? bar6.innerHTML : '';
    ok('铭刻触发共鸣：羁绊面板点亮「龙门」呼应对', html6.indexOf('龙门') >= 0, 'html 含龙门=' + (html6.indexOf('龙门') >= 0));
  } catch (e) { fail++; console.log('  FAIL 铭刻共鸣: ' + e.message); }

  // 启动期零脚本错误（jsdomError = 未捕获异常 / 资源加载失败）
  ok('启动期零运行时错误', errors.length === 0, errors.length ? errors.join(' | ') : 'clean');

  finish();
}

function finish() {
  console.log('--- JSDOM REGRESSION: PASS ' + pass + ' / FAIL ' + fail + ' ---');
  if (errors.length) console.log('ERRORS:\n' + errors.join('\n'));
  process.exit(fail ? 1 : 0);
}
