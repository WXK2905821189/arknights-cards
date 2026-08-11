/* 罗德岛棋局 · 货币战争 — 自走棋核心逻辑 + 控制器（3×3 部署格 / 拖拽上下场 / 站位战斗） */
(function (global) {
  'use strict';

  // DATA 来源：浏览器中由 data.js 注入的全局 const __DATA；Node 测试用 __DATA_TEST__
  const DATA = (typeof __DATA !== 'undefined') ? __DATA
    : (global.__DATA_TEST__ || { operators: [] });
  // 实机接入：data.js 干员无 avatar/art 字段，按 assets/{id}_头像.png / _立绘.png 派生
  DATA.operators.forEach(o => {
    if (!o.avatar) o.avatar = 'assets/' + o.id + '_头像.png';
    if (!o.art) o.art = 'assets/' + o.id + '_立绘.png';
  });

  /* ============ 纯逻辑层 ============ */

  // 羁绊配置：每个轴按同值单位“去重计数”触发档位
  // 职业轴：每职业独立主题化效果（先锋=技力流 / 重装=壁垒 / 医疗=急救 / 术师=术法…）
  //   主属性阶位固定在 [10,20,32]%（每 2/4/6 人触发）；副属性抬到 [8,16,26]% 使每阶都更有手感；
  //   SP 类：spInit 为起手技力绝对值（spMax≈16~21），spRegen 为回复乘数（基础≈1.1/0.1s）。
  // 阵营轴：已按势力主题化（B 任务），键名对齐 data.json 的 bonds['阵营']（已合并同名子类）。
  // 种族轴已并入阵营，不再单列。
  // 阶3 阈值规则（任务 C-1）：每个职业的阶3 阈值须【独立】依据其去重卡池数判定可行性，且【不得高于可上场人数上限】
  //   （部署格上限 = 玩家等级，封顶 9）。当前各职业去重卡池均 ≥9，故统一 thr=[2,4,6]，全部可行；若未来某职业卡池 <6 则需下调阶3。
  //   校验见 gen_bonds_table.py（BOARD_CAP=9，逐职业核对 卡池≥阶3 且 阶3≤9）。
  const BONDS = {
    '职业': {
      '先锋': { thr: [2, 4, 6], spInit: [4, 8, 12], spRegen: [0.15, 0.30, 0.50] },   // 技力流：起手技力 + 技力回复
      '近卫': { thr: [2, 4, 6], atk: [0.10, 0.20, 0.32], aspd: [0.08, 0.16, 0.26] }, // 斗士：攻击 + 攻速
      '重装': { thr: [2, 4, 6], def: [0.10, 0.20, 0.32], hp: [0.08, 0.16, 0.26] },   // 壁垒：防御 + 生命
      '狙击': { thr: [2, 4, 6], atk: [0.10, 0.20, 0.32], crit: [0.08, 0.15, 0.24] }, // 狙击：攻击 + 暴击
      '术师': { thr: [2, 4, 6], magicAmp: [0.10, 0.20, 0.32], spInit: [4, 8, 12] },  // 术法：法伤 + 起手技力
      '医疗': { thr: [2, 4, 6], healAmp: [0.10, 0.20, 0.32], hp: [0.08, 0.16, 0.26], magicAmp: [0.05, 0.10, 0.15] },// 急救：治疗量 + 生命 + 光合法伤（解纯医疗无输出）
      '辅助': { thr: [2, 4, 6], aspd: [0.10, 0.20, 0.32], def: [0.08, 0.16, 0.26], atk: [0.06, 0.12, 0.20] }, // 控场：攻速 + 防御 + 攻击
      '特种': { thr: [2, 4, 6], aspd: [0.10, 0.20, 0.32], crit: [0.08, 0.15, 0.24] }, // 奇袭：攻速 + 暴击
    },
    // 阵营轴：B 任务「势力主题化」——每个势力独立效果包，反映其 AK 身份。
    // 键名必须与 data.json 的 bonds['阵营'] 一致（已合并同类项：罗德岛-精英干员→罗德岛、炎-岁/炎-龙门→炎、龙门近卫局→龙门…）。
    // 未在下方列出 / 卡池<4 的势力自动套用 __default__（通用攻/血），避免死内容。
    // 阈值统一 [2,3,5]（阶1/2/3）。注意：阵营羁绊与职业羁绊对同一干员【叠加】生效。
    '阵营': {
      '__default__': { thr: [2, 3, 5], atk: [0.08, 0.16, 0.26], hp: [0.06, 0.12, 0.20] },   // 长尾小势力兜底：通用攻/血
      '罗德岛':     { thr: [2, 3, 5], healAmp: [0.08, 0.16, 0.26], hp: [0.06, 0.12, 0.20] }, // 医疗理念：治疗量 + 生存（已含精英干员）
      '炎':         { thr: [2, 3, 5], hp: [0.05, 0.10, 0.15], def: [0.03, 0.06, 0.09] },     // 岁兽/炎国：生命 + 防御（已含炎-岁/炎-龙门）— 二次削弱（原 100% 超模）
      '维多利亚':   { thr: [2, 3, 5], atk: [0.08, 0.16, 0.26], def: [0.06, 0.12, 0.20] },    // 骑士王国：攻防兼备
      '莱茵生命':   { thr: [2, 3, 5], magicAmp: [0.08, 0.16, 0.26], spInit: [3, 6, 10] },    // 科研机构：术法 + 起手技力
      '叙拉古':     { thr: [2, 3, 5], crit: [0.06, 0.12, 0.20], aspd: [0.06, 0.12, 0.20] },  // 黑帮：暴击 + 攻速
      '拉特兰':     { thr: [2, 3, 5], atk: [0.08, 0.16, 0.26], crit: [0.10, 0.20, 0.32] },    // 枪之城：攻击 + 暴击（暴击档位上调）
      '莱塔尼亚':   { thr: [2, 3, 5], magicAmp: [0.08, 0.16, 0.26], spInit: [3, 6, 10] },    // 源石技艺帝国：术法 + 起手技力
      '萨尔贡':     { thr: [2, 3, 5], atk: [0.10, 0.20, 0.32], hp: [0.06, 0.12, 0.20] },      // 荒野战士：攻击 + 生命（攻击档位上调）
      '龙门':       { thr: [2, 3, 5], atk: [0.08, 0.16, 0.26], def: [0.06, 0.12, 0.20] },     // 近卫局：攻击 + 防御（已含龙门近卫局）
      '企鹅物流':   { thr: [2, 3, 5], spInit: [3, 6, 10], spRegen: [0.12, 0.24, 0.40] },       // 物流速度：起手技力 + 技力回复
      '巴别塔':     { thr: [2, 3, 5], hp: [0.08, 0.16, 0.26], def: [0.06, 0.12, 0.20] },      // 起源：生存向
      '谢拉格':     { thr: [2, 3, 5], hp: [0.08, 0.16, 0.26], def: [0.06, 0.12, 0.20] },      // 雪境信仰：生命 + 防御
      '深海猎人':   { thr: [2, 3, 5], atk: [0.08, 0.16, 0.26], hp: [0.06, 0.12, 0.20] },      // 猎杀者：攻击 + 生命
      '乌萨斯':     { thr: [2, 3, 5], atk: [0.08, 0.16, 0.26], def: [0.06, 0.12, 0.20] },     // 寒冬帝国：攻击 + 防御
      '伊比利亚':   { thr: [2, 3, 5], magicAmp: [0.08, 0.16, 0.26], hp: [0.06, 0.12, 0.20] },  // 深海外交：术法 + 生命
    },
  };

  // 默认（无羁绊）乘数
  const DEF_MULT = { atk: 1, hp: 1, def: 1, aspd: 1, crit: 0, magicAmp: 1, healAmp: 1, spInit: 0, spRegen: 1 };
  // 星级战斗力乘数（1★/2★/3★）
  const STAR_MULT = { 1: 1, 2: 1.8, 3: 3.2 };
  // P1-1：羁绊乘法叠乘软上限（[PLACEHOLDER · 数值需镜像对局 Monte Carlo 标定]）。
  // 压制满配三星签名核心的乘区爆炸（原可叠到 5–8×），保留 build 表达但杜绝一击秒杀。
  const MAX_ATK_MULT = 6.5, MAX_HP_MULT = 6.5;

  // ② 5费干员「签名羁绊」——每个 cost=5 干员一个独立被动，上场即生效（无需凑人数），叠加在职业+阵营之上。
  //    attr 为属性乘数（复用 BOND_KEYS 机制，并入 mult）；kw 为单位级行为关键字（见 makeCombatUnit/applyKw）。
  const SIGNATURE = {
    '史尔特尔': { attr: { magicAmp: 0.20, spInit: 5 }, kw: { skillAmp: 0.25 } },   // 黄昏一击：技能核爆
    '能天使':   { attr: { aspd: 0.25, atk: 0.08 }, kw: {} },                        // 过载连射
    '灰烬':     { attr: { crit: 0.20, atk: 0.10 }, kw: {} },                        // 蓄力暴击
    '玛恩纳':   { attr: { atk: 0.10 }, kw: { trueDmg: 0.20 } },                     // 解放者：真伤
    '煌':       { attr: { atk: 0.05 }, kw: { rampHit: { per: 0.016, cap: 0.40 } } },// 沸腾：暖机
    '棘刺':     { attr: {}, kw: { pierce: 0.20, counter: 0.15 } },                 // 至高之刺：破甲+反伤
    '山':       { attr: { atk: 0.10 }, kw: { lifesteal: 0.15 } },                   // 蛮勇：吸血
    '锏':       { attr: { atk: 0.15, aspd: 0.10 }, kw: {} },                        // 归于宁静：爆发
    '薇薇安娜': { attr: { magicAmp: 0.18 }, kw: { defShred: 0.15 } },               // 明灭：破甲法伤
    '泥岩':     { attr: { hp: 0.15 }, kw: { damageReduction: 0.15 } },             // 秽壤护体：减伤
    '澄闪':     { attr: { magicAmp: 0.20, spInit: 4 }, kw: {} },                    // 澄净闪耀
    '缪尔赛思': { attr: { magicAmp: 0.15 }, kw: { spRegen: 0.20 } },                // 非熵适应：技回
    '推进之王': { attr: { def: 0.10 }, kw: { rampHit: { per: 0.012, cap: 0.30 } } },// 碎颅：暖机坦克
    '令':       { attr: {}, kw: { summonBeast: 1 } },                               // 宁作吾：召唤岁兽（阶段3）
    '水月':     { attr: { atk: 0.10 }, kw: { slow: 0.30 } },                        // 镜花水月：减速
  };

  // ③ 阵营特殊机制——每个能成羁绊的阵营一个 capstone，按该阵营「最高可达档位」解锁。
  //   tier = 解锁所需羁绊阶；attr 为附加属性乘数（并入 mult）；kw 为行为关键字（见 makeCombatUnit/step）。
  //   池≥5→阶三、池3~4→阶二、池2→阶一（见特殊羁绊机制设计.md 数据事实）。
  const SPECIAL = {
    // —— 池≥5 → 阶三 capstone ——
    '罗德岛':   { tier: 3, kw: 'healAura',        params: { regen: 0.03 } },                                  // 急救协议：低血回血
    '炎':       { tier: 3, kw: 'burnDoT',         params: { dps: 0.025, dur: 3 } },                           // 炽魂：灼烧（削弱 dps）
    '维多利亚': { tier: 3, kw: 'pierce',          params: { value: 0.15 } },                                  // 破阵：破甲
    '莱茵生命': { tier: 3, kw: 'spRegenBuff',     params: { value: 0.30 } },                                  // 源石技艺增幅
    '叙拉古':   { tier: 2, kw: 'summonWolf',      params: { t2: 1, t3: 2 } },                                 // 养狼（阶段3）
    '拉特兰':   { tier: 2, kw: 'critDmg',         params: { value: 1.00 } },                                  // 弹幕覆盖：暴伤（阶二解锁 + 数值上调）
    '莱塔尼亚': { tier: 3, kw: 'castAmp',         params: { aspd: 0.15, amp: 0.15, dur: 3 } },                // 咏唱：施法后强化
    '萨尔贡':   { tier: 2, kw: 'execute',         params: { thresh: 0.30, mult: 0.80 } },                     // 蛮力：处决（阶二解锁 + 数值上调）
    '龙门':     { tier: 3, kw: 'guardAura',       params: { value: 0.10 } },                                  // 协防：相邻减伤
    '企鹅物流': { tier: 3, kw: 'globalAspd',      params: { value: 0.10 } },                                  // 极速配送：全局攻速
    // —— 池=4 → 阶二 capstone ——
    '巴别塔':   { tier: 2, attr: { def: 0.12 }, kw: null },                                                    // 传承：防御
    '谢拉格':   { tier: 2, kw: 'shieldPeriodic',  params: { frac: 0.10, period: 5 } },                         // 霜护：周期护盾
    '深海猎人': { tier: 2, kw: 'pierce',          params: { value: 0.25 } },                                  // 数值压制：破甲
    '乌萨斯':   { tier: 2, kw: 'slowAura',        params: { value: 0.20 } },                                  // 严冬：敌减速
    '伊比利亚': { tier: 2, attr: { magicAmp: 0.15 }, kw: 'defShred', params: { value: 0.10 } },               // 潮汐：法伤+破甲
    // —— 池=3 → 阶二 capstone ——
    '东':       { tier: 2, kw: 'rampHit',         params: { per: 0.06, cap: 0.30 } },                         // 心流：攻速成长
    '哥伦比亚': { tier: 2, kw: 'critDmg',         params: { value: 0.30 } },                                  // 军火：暴伤
    '卡西米尔': { tier: 2, kw: 'trueDmg',         params: { value: 0.15 } },                                  // 骑士团：真伤
    '喀兰贸易': { tier: 2, attr: { atk: 0.12 }, kw: null },                                                    // 雇佣：攻击
    // —— 池=2 → 阶一 capstone ——
    '雷姆必拓': { tier: 1, kw: 'damageReduction', params: { value: 0.08 } },                                  // 矿脉护体：减伤
    '塔拉':     { tier: 1, attr: { aspd: 0.08 }, kw: null },                                                   // 战歌：攻速
    '使徒':     { tier: 1, attr: { hp: 0.10 }, kw: null },                                                     // 神恩：生命
    '鲤氏侦探事务所': { tier: 1, attr: { crit: 0.08 }, kw: null },                                             // 洞察：暴击
  };

  // P2-3：单干员势力「独行被动」——池=1 的阵营无法成羁绊（F8），上场即给轻量风味被动，消除空洞感。
  // 运行时依据 DATA 计算（按职业给差异化属性），不改变平衡大局，仅让每个单位「有东西」。
  const DEPLOY_PASSIVE = (function () {
    const cnt = {};
    DATA.operators.forEach(o => { const f = o.bonds && o.bonds['阵营']; if (f) cnt[f] = (cnt[f] || 0) + 1; });
    const m = {};
    DATA.operators.forEach(o => {
      const f = o.bonds && o.bonds['阵营'];
      if (f && cnt[f] === 1) {
        let attr;
        switch (o.class) {
          case '重装': attr = { hp: 0.12, def: 0.08 }; break;
          case '狙击': case '术师': attr = { atk: 0.10 }; break;
          case '医疗': attr = { healAmp: 0.12 }; break;
          case '辅助': attr = { aspd: 0.10 }; break;
          default: attr = { atk: 0.08, aspd: 0.06 }; // 先锋 / 近卫 / 特种等
        }
        m[f] = { attr };
      }
    });
    return m;
  })();

  // —— light 版召唤物定义（叙拉古养狼 / 令岁兽）——
  // 数值固定、按阶位微调，无独立经验条（完整喂养成长系统记未来 TODO）。
  function makeSummonOp(kind, tier) {
    const k = tier >= 3 ? 1.25 : 1.0;
    if (kind === 'wolf') {
      return {
        name: '狼', en: 'Wolf', class: '召唤物', subclass: '叙拉古眷属', rarity: 3, cost: 0,
        stats: { atk: Math.round(130 * k), hp: Math.round(640 * k), def: 45, spd: 110, dmgType: 'phys', range: 1 },
        skill: null, traits: [], bonds: { 职业: '召唤物', 阵营: '—' }, avatar: 'assets/wolf.png',
      };
    }
    // 岁兽（令签名）
    return {
      name: '岁兽', en: 'Beast', class: '召唤物', subclass: '令之眷属', rarity: 3, cost: 0,
      stats: { atk: Math.round(210 * k), hp: Math.round(1700 * k), def: 90, spd: 95, dmgType: 'phys', range: 1 },
      skill: null, traits: [], bonds: { 职业: '召唤物', 阵营: '—' }, avatar: 'assets/beast.png',
    };
  }

  // 商店刷新概率表（按玩家等级 1..9）
  const ODDS = {
    1: [1.00, 0, 0, 0, 0],
    2: [0.70, 0.30, 0, 0, 0],
    3: [0.55, 0.35, 0.10, 0, 0],
    4: [0.42, 0.38, 0.18, 0.02, 0],
    5: [0.32, 0.38, 0.24, 0.06, 0],
    6: [0.22, 0.34, 0.32, 0.10, 0.02],
    7: [0.18, 0.28, 0.34, 0.16, 0.04],
    8: [0.12, 0.22, 0.34, 0.24, 0.08],
    9: [0.08, 0.16, 0.32, 0.30, 0.14],
  };

  // 战场：我方左 4 列 / 敌方右 4 列，共 8×4
  const GRID_COLS = 4, GRID_ROWS = 4, FIELD_W = 8, FIELD_H = 4;
  const CELL = 64;            // 战斗网格像素
  const DT = 0.1, SAMPLE_DT = 0.6, MAX_T = 60;

  // 羁绊效果键：atk/hp/def/aspd/crit/magicAmp/healAmp 为“分数乘数”(1+val)；spInit 为绝对值；spRegen 为回复乘数
  const BOND_KEYS = ['atk', 'hp', 'def', 'aspd', 'crit', 'magicAmp', 'healAmp', 'spInit', 'spRegen'];

  function computeBonds(boardUnits) {
    const axes = ['职业', '阵营'];
    const seen = { 职业: {}, 阵营: {} };
    boardUnits.forEach(u => {
      axes.forEach(ax => {
        const v = u.bonds[ax];
        (seen[ax][v] = seen[ax][v] || new Set()).add(u.name);
      });
    });
    const active = [];
    const potential = [];
    const mult = {};
    const sig = {};      // name -> { attr, kw }  签名羁绊（单人被动）
    const special = {};  // name -> { kw, params } 阵营特殊机制
    boardUnits.forEach(u => {
      mult[u.name] = { atk: 1, hp: 1, def: 1, aspd: 1, crit: 0, magicAmp: 1, healAmp: 1, spInit: 0, spRegen: 1 };
      sig[u.name] = { attr: {}, kw: {} };
      special[u.name] = null;
    });
    // —— 签名羁绊：cost=5 干员上场即生效，属性并入 mult，行为关键字记入 sig ——
    boardUnits.forEach(u => {
      const s = SIGNATURE[u.name];
      if (!s) return;
      const m = mult[u.name], sk = sig[u.name];
      if (s.attr) Object.keys(s.attr).forEach(k => {
        const val = s.attr[k];
        if (k === 'spInit') m.spInit += val;
        else if (k === 'spRegen') m.spRegen *= (1 + val);
        else if (k === 'crit') m.crit += val;
        else m[k] *= (1 + val);
      });
      if (s.kw) Object.keys(s.kw).forEach(k => { sk.kw[k] = s.kw[k]; });
    });
    // —— 职业 / 阵营 主题羁绊 + 阵营特殊机制 ——
    axes.forEach(ax => {
      const cfg = BONDS[ax];
      if (!cfg) return;
      if (cfg.thr) {
        // 旧式通用轴：所有取值套用同一 atk/hp（当前无 cfg 使用，保留兼容）
        const nByV = seen[ax];
        Object.keys(nByV).forEach(v => {
          const n = nByV[v].size;
          let tier = -1;
          for (let t = 0; t < cfg.thr.length; t++) if (n >= cfg.thr[t]) tier = t;
          if (tier < 0) { if (n >= 1) potential.push({ axis: ax, value: v, count: n, need: cfg.thr[0] }); return; }
          const atkB = cfg.atk[tier] || 0, hpB = cfg.hp[tier] || 0;
          if (atkB || hpB) {
            const bonus = {};
            if (atkB) bonus.atk = atkB;
            if (hpB) bonus.hp = hpB;
            active.push({ axis: ax, value: v, count: n, tier: tier + 1, bonus });
            boardUnits.forEach(u => {
              if (u.bonds[ax] === v) applyMult(mult[u.name], bonus);
            });
          }
        });
      } else {
        // 新式按值主题化（职业 / 阵营）；阵营轴未命中回退 __default__
        Object.keys(seen[ax]).forEach(v => {
          const vc = cfg[v] || (ax === '阵营' ? cfg['__default__'] : null);
          if (!vc) return;
          const n = seen[ax][v].size;
          let tier = -1;
          for (let t = 0; t < vc.thr.length; t++) if (n >= vc.thr[t]) tier = t;
          if (tier < 0) { if (n >= 1) potential.push({ axis: ax, value: v, count: n, need: vc.thr[0] }); return; }
          const tierN = tier + 1;
          const bonus = {};
          BOND_KEYS.forEach(k => { if (vc[k] && vc[k][tier] != null) bonus[k] = vc[k][tier]; });
          active.push({ axis: ax, value: v, count: n, tier: tierN, bonus });
          boardUnits.forEach(u => {
            if (u.bonds[ax] === v) applyMult(mult[u.name], bonus);
          });
          // 阵营特殊机制：达到 SPECIAL.tier 解锁（仅阵营轴）
          if (ax === '阵营') {
            const sp = SPECIAL[v];
            if (sp && tierN >= sp.tier) {
              if (sp.attr) {
                boardUnits.forEach(u => {
                  if (u.bonds[ax] === v) applyMult(mult[u.name], sp.attr);
                });
                Object.assign(bonus, sp.attr);
              }
              boardUnits.forEach(u => {
                if (u.bonds[ax] === v) special[u.name] = { kw: sp.kw || null, params: sp.params || {} };
              });
              active.push({ axis: '特殊', value: v, count: n, tier: tierN, bonus: sp.attr ? Object.assign({}, sp.attr) : {}, kw: sp.kw || null });
            }
          }
        });
      }
    });
    // 签名展示（单人，阶0）
    boardUnits.forEach(u => {
      if (SIGNATURE[u.name]) {
        const s = SIGNATURE[u.name];
        active.push({ axis: '签名', value: u.name, count: 1, tier: 0, bonus: s.attr || {}, kw: (s.kw && Object.keys(s.kw)[0]) || null });
      }
    });
    return { active, potential, mult, sig, special };
  }

  // 把效果包（属性乘数）并入 mult
  function applyMult(m, bonus) {
    if (!m || !bonus) return;
    BOND_KEYS.forEach(k => {
      const val = bonus[k];
      if (val == null) return;
      if (k === 'spInit') m.spInit += val;
      else if (k === 'spRegen') m.spRegen *= (1 + val);
      else if (k === 'crit') m.crit += val;
      else m[k] *= (1 + val);
    });
  }

  function makeCombatUnit(op, star, side, mult, sig, special) {
    const sm = STAR_MULT[star] || 1;
    const m = mult || DEF_MULT;
    // P1-1：攻击/生命 乘数软上限（详见 MAX_ATK_MULT / MAX_HP_MULT 注释），压制乘区爆炸
    const atkMultRaw = sm * (m.atk || 1);
    const hpMultRaw = sm * (m.hp || 1);
    const atk = Math.round(op.stats.atk * Math.min(atkMultRaw, MAX_ATK_MULT));
    const hp = Math.round(op.stats.hp * Math.min(hpMultRaw, MAX_HP_MULT));
    const sk = op.skill || null;
    const spMax = sk ? sk.spMax : 24;
    const aspd = m.aspd || 1;
    const u = {
      op, name: op.name, cls: op.class, avatar: op.avatar, traits: op.traits || [],
      dmgType: op.stats.dmgType, range: op.stats.range, cost: op.stats.cost, star,
      maxHp: hp, hp, atk, baseAtk: atk,
      def: Math.round(op.stats.def * sm * (m.def || 1)),
      spd: op.stats.spd * aspd,
      side,
      next: 100 / (op.stats.spd * aspd), alive: true, stunUntil: 0, slowUntil: 0, slowFactor: 1,
      sp: Math.min(spMax, m.spInit || 0), spMax,
      spRegen: (sk ? sk.spRegen : 1) * (m.spRegen || 1),
      skill: sk ? { name: sk.name, archetype: sk.archetype, effect: sk.effect } : null,
      shield: 0, burn: null,
      crit: m.crit || 0, magicAmp: m.magicAmp || 1, healAmp: m.healAmp || 1,
      // —— 行为关键字（签名 + 阵营特殊）——
      pierce: 0, defShred: 0, trueDmg: 0, skillAmp: 1, lifesteal: 0, slow: 0,
      damageReduction: 0, counter: 0, critDmg: 0,
      rampHitPer: 0, rampHitCap: 0, rampHitAcc: 0,
      summonBeast: 0, specialKw: null, specialParams: {}, castAspd: 1, castAmpMul: 1, castBuffUntil: 0,
    };
    // 合并签名关键字
    const skw = (sig && sig.kw) || {};
    if (skw.pierce) u.pierce = Math.max(u.pierce, skw.pierce);
    if (skw.defShred) u.defShred = Math.max(u.defShred, skw.defShred);
    if (skw.trueDmg) u.trueDmg = Math.max(u.trueDmg, skw.trueDmg);
    if (skw.skillAmp) u.skillAmp = (u.skillAmp || 1) + skw.skillAmp;
    if (skw.lifesteal) u.lifesteal = Math.max(u.lifesteal, skw.lifesteal);
    if (skw.slow) u.slow = Math.max(u.slow, skw.slow);
    if (skw.damageReduction) u.damageReduction = Math.max(u.damageReduction, skw.damageReduction);
    if (skw.counter) u.counter = Math.max(u.counter, skw.counter);
    if (skw.critDmg) u.critDmg = Math.max(u.critDmg, skw.critDmg);
    if (skw.rampHit) { u.rampHitPer = Math.max(u.rampHitPer, skw.rampHit.per); u.rampHitCap = Math.max(u.rampHitCap, skw.rampHit.cap); }
    if (skw.summonBeast) u.summonBeast = skw.summonBeast;
    // 合并阵营特殊关键字
    if (special && special.kw) {
      const p = special.params || {};
      u.specialKw = special.kw; u.specialParams = p;
      if (special.kw === 'pierce') u.pierce = Math.max(u.pierce, p.value || 0);
      else if (special.kw === 'trueDmg') u.trueDmg = Math.max(u.trueDmg, p.value || 0);
      else if (special.kw === 'defShred') u.defShred = Math.max(u.defShred, p.value || 0);
      else if (special.kw === 'critDmg') u.critDmg = Math.max(u.critDmg, p.value || 0);
      else if (special.kw === 'damageReduction') u.damageReduction = Math.max(u.damageReduction, p.value || 0);
      else if (special.kw === 'rampHit') { u.rampHitPer = Math.max(u.rampHitPer, p.per || 0); u.rampHitCap = Math.max(u.rampHitCap, p.cap || 0); }
      else if (special.kw === 'spRegenBuff') u.spRegen *= (1 + (p.value || 0));
    }
    return u;
  }

  function applyBonds(units, side) {
    const { mult, sig, special } = computeBonds(units.map(u => ({ name: u.op.name, bonds: u.op.bonds, star: u.star })));
    // P0-1：接通策略节点的全局战斗增益（锋锐/坚壁/急袭/战意/强军/天启/战术核心）。
    // 仅作用于我方（side==='ally'），敌方一律不享受，避免污染难度平衡。
    let gmult = null;
    if (side === 'ally') {
      const se = aggregateStrategies();
      if (se.allAtkPct || se.allHpPct || se.allAspdPct || se.allMagicPct) {
        gmult = { atk: 1 + se.allAtkPct, hp: 1 + se.allHpPct, aspd: 1 + se.allAspdPct, magicAmp: 1 + se.allMagicPct };
      }
    }
    return units.map(u => {
      let m = mult[u.op.name] || DEF_MULT;
      if (u.buff && u.buff !== 1) { m = Object.assign({}, m); m.atk *= u.buff; m.hp *= u.buff; m.def *= u.buff; }
      if (gmult) { m = Object.assign({}, m); m.atk *= gmult.atk; m.hp *= gmult.hp; m.aspd *= gmult.aspd; m.magicAmp *= gmult.magicAmp; }
      return makeCombatUnit(u.op, u.star, side, m, sig[u.op.name] || { attr: {}, kw: {} }, special[u.op.name] || null);
    });
  }

  // 部署格序号 -> 战斗坐标：第 0 行最前（x=3，紧邻敌方 x=4），逐行向后
  function slotToXY(i) {
    const r = Math.floor(i / 3), c = i % 3;
    return { x: 3 - r, y: c };
  }

  // 按职业基线默认站位：我方前排在 x=3，敌方前排在 x=4
  function autoPositions(units, side) {
    const cells = [];
    if (side === 'ally') {
      for (let x = GRID_COLS - 1; x >= 0; x--) for (let y = 0; y < GRID_ROWS; y++) cells.push([x, y]);
    } else {
      for (let x = 0; x < GRID_COLS; x++) for (let y = 0; y < GRID_ROWS; y++) cells.push([GRID_COLS + x, y]);
    }
    return units.map((u, i) => {
      const c = cells[i % cells.length];
      return { x: c[0], y: c[1] };
    });
  }

  function rollCost(level) {
    const odds = ODDS[Math.max(1, Math.min(9, level))];
    const r = Math.random();
    let acc = 0;
    for (let i = 0; i < 5; i++) { acc += odds[i]; if (r <= acc) return i + 1; }
    return 1;
  }

  // 梯度刷新率：玩家等级越高，商店可出现的干员费用上限越高；低等级不会刷出高费角色，
  // 既保持平衡，也方便玩家集齐低费三星。
  function maxShopCost(level) {
    return [0, 2, 2, 3, 3, 4, 4, 5, 5, 5][Math.max(1, Math.min(9, level))] || 5;
  }

  function pickShop(pool, level) {
    const cap = maxShopCost(level);
    // 开局环境可提升某职业/阵营的出现率（羁绊爆率）
    const bias = (G.env && G.env.effects && G.env.effects.shopBias) || null;
    const byCost = { 1: [], 2: [], 3: [], 4: [], 5: [] };
    pool.forEach(o => { if (o.stats.cost <= cap) byCost[o.stats.cost].push(o); });
    const out = [];
    for (let i = 0; i < 5; i++) {
      let c = rollCost(level);
      if (c > cap) c = cap;
      let arr = byCost[c];
      while (!arr.length && c > 1) { c--; arr = byCost[c]; }
      if (!arr.length) { out.push(null); continue; }
      if (bias) {
        // 加权随机：命中目标职业/阵营的权重 ×mult
        const w = arr.map(o => (o.bonds[bias.field] === bias.value) ? bias.mult : 1);
        let tot = 0; for (const x of w) tot += x;
        let r = Math.random() * tot, pick = arr[0];
        for (let k = 0; k < arr.length; k++) { r -= w[k]; if (r <= 0) { pick = arr[k]; break; } }
        out.push(pick);
      } else {
        out.push(arr[Math.floor(Math.random() * arr.length)]);
      }
    }
    return out;
  }

  function generateEnemyTeam(playerLevel, nodeIdx, isBoss, encDiff, gDiff) {
    const ed = encDiff || { buffMult: 1, countBonus: 0 };
    const gd = gDiff || diffCfg();
    const em = (ed.buffMult || 1) * (gd.enemyMult || 1);
    const cb = (ed.countBonus || 0) + (gd.countBonus || 0);
    const ops = DATA.operators;
    const count = Math.min(9, playerLevel + (isBoss ? 2 : 0) + cb);
    const cap = Math.min(5, 2 + Math.floor(nodeIdx / 2));
    const cand = ops.filter(o => o.stats.cost <= cap);
    const team = [];
    const buff = (1 + nodeIdx * 0.02) * em; // 难度曲线 × 遭遇难度 × 全局难度
    let budget = count * (2.1 + nodeIdx * 0.35) * em;
    let tries = 0;
    while (team.length < count && tries < 300 && budget > 0) {
      tries++;
      const o = cand[Math.floor(Math.random() * cand.length)];
      if (!o) break;
      team.push(o); budget -= o.stats.cost;
    }
    return team.map(o => {
      let st = 1;
      if (nodeIdx >= 4 && Math.random() < 0.30) st = 2;
      if (nodeIdx >= 6 && Math.random() < 0.18) st = 3;
      return { op: o, star: st, buff };
    });
  }

  function cheb(a, b) { return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y)); }

  // 站位战斗模拟：返回逐帧快照（含坐标），供演出
  function simulateBattleGrid(allyRaw, enemyRaw, allyPos, enemyPos) {
    const ally = allyRaw.map(u => Object.assign({}, u));
    const enemy = enemyRaw.map(u => Object.assign({}, u));
    ally.forEach((u, i) => { u.uid = 'a' + i; u.x = allyPos[i].x; u.y = allyPos[i].y; u.cd = 0; u.stunUntil = 0; });
    enemy.forEach((u, i) => { u.uid = 'e' + i; u.x = enemyPos[i].x; u.y = enemyPos[i].y; u.cd = 0; u.stunUntil = 0; });
    const all = ally.concat(enemy);
    const occ = new Map();
    all.forEach(u => occ.set(u.x + ',' + u.y, u));
    // light 版：团队级前置（全队攻速 / 敌方减速）
    if (ally.some(u => u.specialKw === 'globalAspd')) {
      const v = (SPECIAL['企鹅物流'] && SPECIAL['企鹅物流'].params.value) || 0.10;
      ally.forEach(u => { u.spd *= (1 + v); });
    }
    const slowA = ally.find(u => u.specialKw === 'slowAura');
    if (slowA) {
      const v = (slowA.specialParams && slowA.specialParams.value) || 0.20;
      enemy.forEach(u => { u.slowFactor = 1 - v; u.slowUntil = 1e9; });
    }
    const frames = [];
    const logBuf = [];
    const castsThisSnap = [];
    let t = 0;
    // 行动间隔：受减速(slowFactor)与施法加速(castAspd)影响
    const ATK = u => {
      const slowF = (u.slowFactor && t < u.slowUntil) ? u.slowFactor : 1;
      const castF = (u.castAspd && t < u.castBuffUntil) ? u.castAspd : 1;
      return 100 / (u.spd * slowF * castF);
    };
    const MOVE = 0.45;

    function nearestEnemy(u) {
      let best = null, bd = 1e9;
      for (const o of all) {
        if (o.alive && o.side !== u.side) { const d = cheb(u, o); if (d < bd) { bd = d; best = o; } }
      }
      return { tgt: best, d: bd };
    }

    function tryMove(u, mx, my) {
      const nx = u.x + mx, ny = u.y + my;
      if (nx < 0 || nx >= FIELD_W || ny < 0 || ny >= FIELD_H) return false;
      if (occ.has(nx + ',' + ny)) return false;
      occ.delete(u.x + ',' + u.y); u.x = nx; u.y = ny; occ.set(nx + ',' + ny, u);
      return true;
    }

    function dealDamage(src, tgt, rawDmg) {
      if (!tgt || !tgt.alive) return 0;
      let dmg = rawDmg;
      // 法强
      const amp = (src.magicAmp || 1) * (src.castAmpMul || 1);
      if (src.dmgType === 'magic') dmg *= amp;
      else dmg *= (src.castAmpMul || 1);
      // 防御减免（pierce 忽略部分防御）
      let effDef = tgt.def * (1 - (src.pierce || 0));
      effDef = Math.max(0, effDef);
      const mit = src.dmgType === 'magic' ? 120 / (120 + effDef) : 100 / (100 + effDef);
      const mitigated = dmg * mit;
      // 真伤：无视减伤的部分直接加回
      const truePart = dmg * (src.trueDmg || 0);
      let finalDmg = mitigated + truePart;
      // 暴击 + 暴伤
      if (src.crit && Math.random() < src.crit) finalDmg *= (1.6 + (src.critDmg || 0));
      // 处决（萨尔贡特殊）
      if (src.specialKw === 'execute' && tgt.hp / tgt.maxHp < (src.specialParams.thresh || 0.3)) finalDmg *= (1 + (src.specialParams.mult || 0.5));
      // 受击减伤（泥岩 / 雷姆必拓 / 龙门协防）
      if (tgt.damageReduction) finalDmg *= (1 - tgt.damageReduction);
      // 龙门协防（guardAura）：受击方若有存活相邻友军（龙门）则额外减伤
      if (tgt.side) {
        for (const a of all) {
          if (a.alive && a.side === tgt.side && a !== tgt && a.specialKw === 'guardAura' && cheb(a, tgt) <= 1) {
            finalDmg *= (1 - (a.specialParams && a.specialParams.value ? a.specialParams.value : 0.10));
            break;
          }
        }
      }
      finalDmg = Math.max(1, Math.round(finalDmg));
      // 护盾吸收
      if (tgt.shield > 0) {
        const absorb = Math.min(tgt.shield, finalDmg);
        tgt.shield -= absorb; finalDmg -= absorb;
      }
      tgt.hp -= finalDmg;
      if (tgt.hp <= 0) { tgt.alive = false; occ.delete(tgt.x + ',' + tgt.y); }
      // 命中破甲（薇薇安娜 / 伊比利亚）
      if (src.defShred && tgt.alive) tgt.def = Math.max(0, tgt.def * (1 - src.defShred));
      // 命中减速（水月）
      if (src.slow && tgt.alive) { tgt.slowFactor = Math.min(tgt.slowFactor == null ? 1 : tgt.slowFactor, 1 - src.slow); tgt.slowUntil = t + 2; }
      // 吸血（山）
      if (src.lifesteal && src.alive) src.hp = Math.min(src.maxHp, src.hp + Math.round(finalDmg * src.lifesteal));
      // 反伤（棘刺）
      if (tgt.counter && src !== tgt && src.alive) src.hp -= Math.max(1, Math.round(finalDmg * tgt.counter));
      // 灼烧（炎特殊）
      if (src.specialKw === 'burnDoT' && tgt.alive) {
        const dps = (tgt.burn ? tgt.burn.dps : 0) + (src.specialParams.dps || 0);
        tgt.burn = { dps, until: t + (src.specialParams.dur || 3) };
      }
      return finalDmg;
    }

    function castSkill(u) {
      const eff = u.skill.effect, arch = u.skill.archetype;
      const allies = all.filter(x => x.alive && x.side === u.side);
      const foes = all.filter(x => x.alive && x.side !== u.side);
      let line = u.name + ' 释放【' + u.skill.name + '】';
      // 暖机（rampHit）：施法也累积攻击加成
      if (u.rampHitPer) u.rampHitAcc = Math.min(u.rampHitCap, u.rampHitAcc + u.rampHitPer);
      const ramp = 1 + (u.rampHitAcc || 0);
      const amp = (u.skillAmp || 1) * ramp;   // 技能增幅 × 暖机
      if (arch === 'burst' || arch === 'lifesteal' || arch === 'execute') {
        const { tgt } = nearestEnemy(u);
        if (tgt) {
          let m = eff.mult;
          if (arch === 'execute' && tgt.hp / tgt.maxHp < (eff.thresh || 0.35)) m *= 1.8;
          const dmg = dealDamage(u, tgt, u.atk * m * amp);
          line += ' → ' + tgt.name + ' -' + dmg;
          if (arch === 'lifesteal') u.hp = Math.min(u.maxHp, u.hp + Math.round(dmg * (eff.leech || 0.5)));
        } else line += '（无目标）';
      } else if (arch === 'aoe') {
        let tot = 0;
        foes.forEach(fo => { tot += dealDamage(u, fo, u.atk * eff.mult * amp); });
        line += ' 范围打击 -' + tot;
      } else if (arch === 'heal') {
        const low = allies.filter(x => x.hp < x.maxHp).sort((a, b) => a.hp / a.maxHp - b.hp / b.maxHp)[0];
        if (low) { const h = Math.round(u.atk * eff.mult * (u.healAmp || 1)); low.hp = Math.min(low.maxHp, low.hp + h); line += ' 治疗 ' + low.name + ' +' + h; }
        else line += '（友军满血）';
      } else if (arch === 'shield') {
        const tgt = (eff.target === 'self') ? u
          : (allies.filter(x => x !== u).sort((a, b) => a.hp / a.maxHp - b.hp / b.maxHp)[0] || u);
        const s = Math.round(u.atk * (eff.mult || 1)); tgt.shield += s; line += ' 为 ' + tgt.name + ' 提供护盾 ' + s;
      } else if (arch === 'stun') {
        const { tgt } = nearestEnemy(u);
        const dur = (eff.dur || 1.2);
        if (tgt) { tgt.stunUntil = t + dur; line += ' 眩晕 ' + tgt.name + ' ' + dur.toFixed(1) + 's'; } else line += '（无目标）';
      } else if (arch === 'buff') {
        const ba = (eff.atk || 0.3);
        allies.forEach(a => { a.atk = Math.min(Math.round(a.baseAtk * 2.5), Math.round(a.atk * (1 + ba))); });
        line += ' 全军攻击力+' + Math.round(ba * 100) + '%';
      } else if (arch === 'debuff') {
        const bd = (eff.def || 0.3);
        foes.forEach(f => { f.def = Math.round(f.def * (1 - bd)); });
        line += ' 敌军防御-' + Math.round(bd * 100) + '%';
      } else if (arch === 'dot') {
        const { tgt } = nearestEnemy(u);
        if (tgt) { const d = dealDamage(u, tgt, u.atk * (eff.mult || 1) * amp); line += ' 侵蚀 ' + tgt.name + ' -' + d; } else line += '（无目标）';
      } else if (arch === 'summon') {
        const s = Math.round(u.atk * (eff.mult || 1)); u.shield += s; line += ' 召唤援军（护盾+' + s + '）';
      } else {
        const { tgt } = nearestEnemy(u);
        if (tgt) { const d = dealDamage(u, tgt, u.atk * (eff.mult || 2) * amp); line += ' → ' + tgt.name + ' -' + d; }
        else line += '（无目标）';
      }
      // 咏唱（莱塔尼亚特殊）：施法后获得攻速 + 技能增幅 buff
      if (u.specialKw === 'castAmp') {
        const p = u.specialParams || {};
        u.castAmpMul = 1 + (p.amp || 0.15);
        u.castAspd = 1 + (p.aspd || 0.15);
        u.castBuffUntil = t + (p.dur || 3);
      }
      logBuf.push({ k: 'skill', line });
      castsThisSnap.push({ uid: u.uid, arch, name: u.skill.name });
    }

    function step() {
      // 技力回复（每 tick 全单位）
      for (const u of all) {
        if (u.alive && u.skill && u.sp < u.spMax) u.sp = Math.min(u.spMax, u.sp + u.spRegen);
      }
      // —— 每 tick 阵营特殊（light 版）——
      // 减速到期复位
      all.forEach(u => { if (u.slowUntil && t > u.slowUntil) u.slowFactor = 1; });
      // 施法加速到期复位
      all.forEach(u => { if (u.castBuffUntil && t > u.castBuffUntil) { u.castAmpMul = 1; u.castAspd = 1; } });
      // 灼烧 DoT（炎特殊）：按每秒比例结算
      all.forEach(u => {
        if (u.alive && u.burn && t < u.burn.until) {
          const d = Math.round(u.maxHp * u.burn.dps * DT);
          u.hp -= d;
          if (u.hp <= 0) { u.alive = false; occ.delete(u.x + ',' + u.y); }
        }
      });
      // 急救协议（罗德岛特殊）：全队低于 70% 时回血
      const healer = ally.find(u => u.alive && u.specialKw === 'healAura');
      if (healer) {
        const r = (healer.specialParams && healer.specialParams.regen) || 0.03;
        ally.forEach(a => { if (a.alive && a.hp / a.maxHp < 0.7) a.hp = Math.min(a.maxHp, a.hp + a.maxHp * r); });
      }
      // 霜护（谢拉格特殊）：每 period 秒全队获得周期护盾
      const shielder = ally.find(u => u.alive && u.specialKw === 'shieldPeriodic');
      if (shielder && t > 0 && Math.round(t) % (shielder.specialParams.period || 5) === 0) {
        const frac = (shielder.specialParams.frac || 0.10);
        ally.forEach(a => { if (a.alive) a.shield += Math.round(a.maxHp * frac); });
      }

      for (const u of all) {
        if (!u.alive) continue;
        if (u.cd > 0) { u.cd -= DT; continue; }
        if (u.stunUntil > t) { u.cd = 0.1; continue; }
        // 技能释放（攒满技力则本次行动改为施法）
        if (u.skill && u.sp >= u.spMax) {
          castSkill(u);
          u.sp = 0;
          u.cd = ATK(u) * 0.6;
          continue;
        }

        if (u.dmgType === 'heal') {
          let tgt = null, br = 1;
          for (const o of all) {
            if (o.alive && o.side === u.side && o !== u) {
              const d = cheb(u, o);
              if (d <= u.range && o.hp < o.maxHp) {
                const r = o.hp / o.maxHp;
                if (r < br) { br = r; tgt = o; }
              }
            }
          }
          if (tgt) {
            const heal = Math.round(u.atk * (u.healAmp || 1));
            tgt.hp = Math.min(tgt.maxHp, tgt.hp + heal);
            logBuf.push({ k: 'heal', line: u.name + ' 治疗 ' + tgt.name + ' +' + heal, side: u.side });
            u.cd = ATK(u);
          } else {
            // 无人可治 → 前压输出（医疗本职即远程法术攻击）：够得到就打，够不到就移动
            const { tgt: e, d } = nearestEnemy(u);
            if (!e) { u.cd = 0.3; }
            else if (d <= u.range) {
              const raw = u.atk * (u.magicAmp || 1);
              const dmg = dealDamage(u, e, raw);
              logBuf.push({ k: 'hit', line: u.name + ' 光合打击 → ' + e.name + ' -' + dmg, dmgType: u.dmgType, side: u.side });
              u.cd = ATK(u);
            } else {
              const dx = Math.sign(e.x - u.x), dy = Math.sign(e.y - u.y);
              let moved = false;
              if (dx !== 0 && dy !== 0) moved = tryMove(u, dx, 0) || tryMove(u, 0, dy);
              else if (dx !== 0) moved = tryMove(u, dx, 0);
              else moved = tryMove(u, 0, dy);
              u.cd = moved ? MOVE : 0.2;
            }
          }
          continue;
        }

        const { tgt, d } = nearestEnemy(u);
        if (!tgt) { u.cd = 0.3; continue; }

        if (d <= u.range) {
          // 暖机（rampHit）：每次攻击累积攻击加成
          if (u.rampHitPer) u.rampHitAcc = Math.min(u.rampHitCap, u.rampHitAcc + u.rampHitPer);
          const ramp = 1 + (u.rampHitAcc || 0);
          let raw = u.atk * ramp;
          if (u.traits.indexOf('爆发') >= 0) raw *= 1.4;
          const dmg = dealDamage(u, tgt, raw);
          let line = u.name + ' → ' + tgt.name + ' -' + dmg;
          if (u.traits.indexOf('控场') >= 0 && Math.random() < 0.3) { tgt.stunUntil = t + 1.2; line += ' (眩晕)'; }
          if (!tgt.alive) line += ' ☠';
          logBuf.push({ k: 'hit', line, dmgType: u.dmgType, side: u.side });
          u.cd = ATK(u);
        } else {
          const dx = Math.sign(tgt.x - u.x), dy = Math.sign(tgt.y - u.y);
          let moved = false;
          if (dx !== 0 && dy !== 0) moved = tryMove(u, dx, 0) || tryMove(u, 0, dy);
          else if (dx !== 0) moved = tryMove(u, dx, 0);
          else moved = tryMove(u, 0, dy);
          u.cd = moved ? MOVE : 0.2;
        }
      }
    }

    function snap() {
      const map = u => ({ uid: u.uid, hp: Math.max(0, Math.round(u.hp)), max: u.maxHp, alive: u.alive, x: u.x, y: u.y, sp: Math.round(u.sp), spMax: u.spMax, shield: Math.round(u.shield) });
      const lines = logBuf.slice(); logBuf.length = 0;
      const casts = castsThisSnap.slice(); castsThisSnap.length = 0;
      frames.push({ lines, ally: ally.map(map), enemy: enemy.map(map), casts });
    }

    snap();
    let nextSample = SAMPLE_DT;
    while (t < MAX_T) {
      step(); t += DT;
      if (!ally.some(u => u.alive) || !enemy.some(u => u.alive)) break;
      if (t >= nextSample) { snap(); nextSample += SAMPLE_DT; }
    }
    snap();

    const aAlive = ally.filter(u => u.alive).length;
    const eAlive = enemy.filter(u => u.alive).length;
    let winner;
    if (aAlive > 0 && eAlive === 0) winner = 'ally';
    else if (eAlive > 0 && aAlive === 0) winner = 'enemy';
    else {
      const aHp = ally.reduce((s, u) => s + Math.max(0, u.hp), 0);
      const eHp = enemy.reduce((s, u) => s + Math.max(0, u.hp), 0);
      winner = aHp >= eHp ? 'ally' : 'enemy';
    }
    frames.push({ sys: true, line: winner === 'ally' ? '★ 我方胜利！' : '✗ 敌方胜利…' });
    return { winner, frames, aAlive, eAlive };
  }

  // 兼容别名：自动站位（Node 测试用）
  function simulateBattle(ally, enemy) {
    const allyPos = autoPositions(ally, 'ally');
    const enemyPos = autoPositions(enemy, 'enemy');
    return simulateBattleGrid(ally, enemy, allyPos, enemyPos);
  }

  /* ============ 导出（供 Node 测试） ============ */
  // 全局难度等级（按数字 1..5，由易到难）。影响：敌方属性/数量倍率、奖励倍率、战败扣血倍率。
  // enemyMult 同时作用于敌方属性(buff)与敌方预算(budget)，是难度主轴。
  const DIFFICULTY = {
    1: { name: '轻松', enemyMult: 0.72, countBonus: 0, rewardMult: 0.9,  hpLossMult: 0.8,  desc: '敌方更弱，奖励略少。适合熟悉玩法。' },
    2: { name: '普通', enemyMult: 0.88, countBonus: 0, rewardMult: 1.0,  hpLossMult: 1.0,  desc: '标准平衡，推荐大多数玩家。' },
    3: { name: '困难', enemyMult: 1.10, countBonus: 1, rewardMult: 1.3,  hpLossMult: 1.25, desc: '敌方更强、+1 单位，奖励更高。' },
    4: { name: '残酷', enemyMult: 1.30, countBonus: 1, rewardMult: 1.6,  hpLossMult: 1.6,  desc: '高难挑战，敌方属性大幅强化。' },
    5: { name: '梦魇', enemyMult: 1.45, countBonus: 2, rewardMult: 2.2,  hpLossMult: 2.0,  desc: '极限折磨，仅推荐高手。' },
  };
  function diffCfg() { return DIFFICULTY[G.difficulty || 2]; }

  const api = {
    computeBonds, makeCombatUnit, applyBonds, pickShop, generateEnemyTeam,
    simulateBattle, simulateBattleGrid, autoPositions, slotToXY, ODDS, BONDS, STAR_MULT,
    GRID_COLS, GRID_ROWS, FIELD_W, FIELD_H, makeSummonOp, SPECIAL, SIGNATURE, DIFFICULTY,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof document === 'undefined') return; // 浏览器之外不初始化控制器

  /* ============ DOM 控制器 ============ */
  const $ = id => document.getElementById(id);
  const PROMOTE_KEY = 'rh_chess_promote';
  const BENCH_CAP = 10;

  const EXP_NEED = { 1: 2, 2: 6, 3: 10, 4: 20, 5: 36, 6: 56, 7: 80, 8: 108 };
  // —— 开局投资环境：每局随机抽 3 个供选择，用 effects 统一描述增益 ——
  // shopBias: 提升某职业/阵营在商店的出现率（即「羁绊爆率」）
  const ENV_POOL = [
    // 经济 / 运营
    { id: 'gold', name: '资本注入', desc: '起始 +12 金币，前期即可抢高费。', effects: { gold: 12 } },
    { id: 'interest', name: '复利引擎', desc: '利息上限 +5（每 10 金多给）。', effects: { interestMax: 5 } },
    { id: 'exp', name: '精英培养', desc: '每回合额外 +3 经验，更快拉高人口。', effects: { expBonus: 3 } },
    { id: 'discount', name: '罗德岛特供', desc: '所有单位购买费用 -1（最低 1）。', effects: { discount: 1 } },
    { id: 'reroll', name: '战术侦察', desc: '每回合额外 1 次免费刷新。', effects: { rerollBonus: 1 } },
    { id: 'sell', name: '黑市协议', desc: '售出价格 +25%。', effects: { sellValuePct: 0.25 } },
    { id: 'heal', name: '后勤补给', desc: '每次战斗胜利回复 8 生命。', effects: { healPerWin: 8 } },
    { id: 'boardcap', name: '前线扩编', desc: '上场人口上限 +1，同场可多部署一名干员。', effects: { boardCapBonus: 1 } },
    { id: 'hp', name: '重装防线', desc: '小队生命 +40，容错更高。', effects: { maxHp: 40 } },
    // 羁绊爆率提升（商店更常出现对应职业 / 阵营，更容易凑齐羁绊）
    { id: 'b_vanguard', name: '先锋号令', desc: '商店中【先锋】干员出现率大幅提升，易凑先锋羁绊。', effects: { shopBias: { field: '职业', value: '先锋', mult: 2.6 } } },
    { id: 'b_medic', name: '医疗优先', desc: '商店中【医疗】干员出现率大幅提升，易凑医疗羁绊。', effects: { shopBias: { field: '职业', value: '医疗', mult: 2.6 } } },
    { id: 'b_sniper', name: '远程压制', desc: '商店中【狙击】干员出现率大幅提升，易凑狙击羁绊。', effects: { shopBias: { field: '职业', value: '狙击', mult: 2.6 } } },
    { id: 'b_yan', name: '炎之眷顾', desc: '商店中【炎】阵营出现率大幅提升，易凑炎阵营羁绊。', effects: { shopBias: { field: '阵营', value: '炎', mult: 2.6 } } },
    { id: 'b_rh', name: '罗德岛血脉', desc: '商店中【罗德岛】阵营出现率大幅提升，易凑罗德岛羁绊。', effects: { shopBias: { field: '阵营', value: '罗德岛', mult: 2.6 } } },
  ];

  // —— 策略节点（青铜/白银/黄金/彩色）：永久全局增益 ——
  const STRATEGY_TIERS_LABEL = { bronze: '青铜', silver: '白银', gold: '黄金', color: '彩色' };
  const STRATEGY_TIERS_ROMAN = { bronze: 'I', silver: 'II', gold: 'III', color: 'IV' };
  const STRAT_ICON = {
    s_finance: '💰', s_train: '🎯', s_free: '🔄', s_sharp: '⚔', s_wall: '🛡', s_swift: '⚡',
    s_war: '🔥', s_rich: '💎', s_arm: '🪖', s_apoc: '🌟', s_black: '🕶', s_core: '🧠'
  };
  const STRATEGY_POOL = [
    // 青铜
    { id: 's_finance', name: '理财', tier: 'bronze', desc: '每回合 +2 金币。', effects: { goldPerRound: 2 } },
    { id: 's_train', name: '练兵', tier: 'bronze', desc: '每回合 +2 经验。', effects: { expPerRound: 2 } },
    { id: 's_free', name: '免费情报', tier: 'bronze', desc: '每回合 1 次免费刷新。', effects: { freeReroll: 1 } },
    // 白银
    { id: 's_sharp', name: '锋锐', tier: 'silver', desc: '全体干员 +8% 攻击。', effects: { allAtkPct: 0.08 } },
    { id: 's_wall', name: '坚壁', tier: 'silver', desc: '全体干员 +8% 生命。', effects: { allHpPct: 0.08 } },
    { id: 's_swift', name: '急袭', tier: 'silver', desc: '全体干员 +8% 攻速。', effects: { allAspdPct: 0.08 } },
    // 黄金
    { id: 's_war', name: '战意', tier: 'gold', desc: '全体 +15% 攻击、+10% 生命。', effects: { allAtkPct: 0.15, allHpPct: 0.10 } },
    { id: 's_rich', name: '厚赏', tier: 'gold', desc: '每回合 +4 金币、+3 经验。', effects: { goldPerRound: 4, expPerRound: 3 } },
    { id: 's_arm', name: '强军', tier: 'gold', desc: '全体 +12% 攻击、+8% 生命。', effects: { allAtkPct: 0.12, allHpPct: 0.08 } },
    // 彩色
    { id: 's_apoc', name: '天启', tier: 'color', desc: '全体 +20% 攻击、+15% 生命、+12% 攻速。', effects: { allAtkPct: 0.20, allHpPct: 0.15, allAspdPct: 0.12 } },
    { id: 's_black', name: '黑市', tier: 'color', desc: '售出价格 +50%。', effects: { sellValuePct: 0.5 } },
    { id: 's_core', name: '战术核心', tier: 'color', desc: '每回合 1 次免费刷新，全体 +10% 法强。', effects: { freeReroll: 1, allMagicPct: 0.10 } },
  ];
  const STRATEGY_BY_ID = {}; STRATEGY_POOL.forEach(s => STRATEGY_BY_ID[s.id] = s);

  // 汇总已选策略的全局效果
  function aggregateStrategies() {
    const acc = { goldPerRound: 0, expPerRound: 0, freeReroll: 0, allAtkPct: 0, allHpPct: 0, allAspdPct: 0, allMagicPct: 0, sellValuePct: 0, boardCapBonus: 0 };
    (G.strategies || []).forEach(id => {
      const s = STRATEGY_BY_ID[id]; if (!s) return;
      const e = s.effects || {};
      if (e.goldPerRound) acc.goldPerRound += e.goldPerRound;
      if (e.expPerRound) acc.expPerRound += e.expPerRound;
      if (e.freeReroll) acc.freeReroll += e.freeReroll;
      if (e.allAtkPct) acc.allAtkPct += e.allAtkPct;
      if (e.allHpPct) acc.allHpPct += e.allHpPct;
      if (e.allAspdPct) acc.allAspdPct += e.allAspdPct;
      if (e.allMagicPct) acc.allMagicPct += e.allMagicPct;
      if (e.sellValuePct) acc.sellValuePct += e.sellValuePct;
      if (e.boardCapBonus) acc.boardCapBonus += e.boardCapBonus;
    });
    return acc;
  }

  // —— 遭遇节点（难度）——
  // 遭遇难度再平衡（羁绊整体偏弱，下调敌方加成、保留偏丰厚奖励以加速阵容成型）
  const ENCOUNTER_DIFFS = {
    normal:  { label: '普通', buffMult: 0.9,  countBonus: 0, rewardMult: 1.0, desc: '敌方属性 -10%，标准奖励。' },
    elite:   { label: '精英', buffMult: 1.15, countBonus: 1, rewardMult: 1.7, desc: '敌方属性 +15%、+1 单位，奖励 ×1.7。' },
    extreme: { label: '极限', buffMult: 1.45, countBonus: 2, rewardMult: 2.8, desc: '敌方属性 +45%、+2 单位，奖励 ×2.8。' },
  };

  let uidc = 1;
  const G = {
    gold: 0, level: 1, exp: 0, hp: 100, maxHp: 100,
    winStreak: 0, lossStreak: 0,
    bench: [], board: {}, shop: [null, null, null, null, null],
    nodes: [], nodeIdx: 0, env: null, selected: null, difficulty: 2,
    strategies: [], stratCount: 0, freeRerollLeft: 0, encounterDiff: null, boardBonus: 0,
    phase: 'env', battleRes: null, frameTimer: null, _bfEls: {},
  };

  function getPromote() {
    try { return parseInt(localStorage.getItem(PROMOTE_KEY) || '0', 10) || 0; } catch (e) { return 0; }
  }
  function setPromote(v) { try { localStorage.setItem(PROMOTE_KEY, String(v)); } catch (e) { } }

  function effCost(op) {
    let c = op.stats.cost;
    if (G.env && G.env.effects && G.env.effects.discount) c -= G.env.effects.discount;
    return Math.max(1, c);
  }

  // 部署板硬上限（3 列 × 4 行）；同时作为 boardCap 的安全钳制，杜绝溢出隐形单位
  const MAX_BOARD_SLOTS = 12;
  // 上场人口上限 = 等级 + 环境/策略扩编加成（钳制在 MAX_BOARD_SLOTS 内）
  function boardCap() { return Math.min(MAX_BOARD_SLOTS, G.level + (G.boardBonus || 0)); }

  function rnd(a, b) { return a + Math.floor(Math.random() * (b - a + 1)); }
  function shuffle(arr) { const a = arr.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1));[a[i], a[j]] = [a[j], a[i]]; } return a; }

  /* ---- 渲染 ---- */
  function renderTop() {
    $('gold').textContent = G.gold;
    $('level').textContent = G.level;
    $('hp').textContent = Math.max(0, G.hp);
    $('nodeIdx').textContent = G.nodeIdx + 1;
    $('nodeTotal').textContent = G.nodes.length;
    const dc = $('diffChip');
    if (dc) dc.textContent = '难度 ' + (G.difficulty || 2) + ' ' + diffCfg().name;
    const need = EXP_NEED[G.level] || 1;
    $('expfill').style.width = (G.level >= 9 ? 100 : Math.min(100, G.exp / need * 100)) + '%';
    const et = $('expText');
    if (et) et.textContent = G.level >= 9 ? 'MAX' : (G.exp + '/' + need);
    const st = $('streak');
    if (G.winStreak >= 2) st.textContent = '🔥 连胜 ' + G.winStreak;
    else if (G.lossStreak >= 2) st.textContent = '💀 连败 ' + G.lossStreak;
    else st.textContent = '';
  }

  function costChip(c) { return '<span class="cost-dot c' + c + '">' + c + '</span>'; }
  function starStr(s) { return s > 1 ? '★'.repeat(s) : ''; }
  function bondTags(op) {
    const role = op.bonds && op.bonds['职业'];
    const aff = op.bonds && op.bonds['阵营'];
    let h = '';
    if (role) h += '<span class="bond-tag tag-role">' + role + '</span>';
    if (aff) h += '<span class="bond-tag tag-aff">' + aff + '</span>';
    return h ? '<div class="card-tags">' + h + '</div>' : '';
  }
  // 图鉴面板用：返回羁绊标签（含签名），不包外层卡片容器
  function bondTagsFull(op) {
    const role = op.bonds && op.bonds['职业'];
    const aff = op.bonds && op.bonds['阵营'];
    let h = '';
    if (role) h += '<span class="bond-tag tag-role">' + role + '</span>';
    if (aff) h += '<span class="bond-tag tag-aff">' + aff + '</span>';
    if (SIGNATURE[op.name]) h += '<span class="bond-tag tag-sig">签名</span>';
    return h;
  }
  function bondShort(op) {
    const role = op.bonds && op.bonds['职业'];
    const aff = op.bonds && op.bonds['阵营'];
    const parts = [];
    if (aff) parts.push(aff + '阵营');
    if (role) parts.push(role + '职业');
    let s = '羁绊：' + (parts.join('、') || '无');
    if (SIGNATURE[op.name]) s += '；5费签名干员';
    return s + '。';
  }

  function unitCard(u, where) {
    const op = u.op;
    const sel = G.selected === u.uid ? ' sel' : '';
    const cost = op.stats.cost;
    const role = op.bonds && op.bonds['职业'];
    const aff = op.bonds && op.bonds['阵营'];
    const skArch = op.skill ? op.skill.archLabel : '';
    return '<div class="ucard c' + cost + sel + '" data-uid="' + u.uid + '" data-where="' + where + '">' +
      '<img class="avatar" src="' + op.avatar + '" alt="" onerror="this.style.background=\'#222\'">' +
      '<div class="card-fade"></div>' +
      '<div class="card-tags">' +
        (role ? '<span class="ctag"><span class="ctag-icon">⚔</span><span class="ctag-txt">' + role + '</span></span>' : '') +
        (aff ? '<span class="ctag"><span class="ctag-icon">◎</span><span class="ctag-txt">' + aff + '</span></span>' : '') +
        (skArch ? '<span class="ctag ctag-sk"><span class="ctag-icon">✦</span><span class="ctag-txt">' + skArch + '</span></span>' : '') +
      '</div>' +
      '<div class="card-footer"><span class="cf-name">' + op.name + '</span>' +
        '<span class="cf-cost"><span class="coin-icon">●</span>' + cost + '</span></div>' +
      '<div class="cost-pip">' + '□'.repeat(cost) + '</div>' +
      (u.star > 1 ? '<span class="star">' + starStr(u.star) + '</span>' : '') +
    '</div>';
  }

  function firstFreeSlot() {
    for (let i = 0; i < boardCap(); i++) if (!G.board[i]) return i;
    return null;
  }
  function slotOf(uid) {
    for (const k in G.board) if (G.board[k].uid === uid) return parseInt(k, 10);
    return null;
  }

  function renderBoard() {
    const b = $('board');
    let html = '';
    // 渲染所有可用格：取 [0, boardCap) 与已部署格的并集，确保任何单位都不会“隐形参战”
    const cap = boardCap();
    const slots = new Set();
    for (let i = 0; i < cap; i++) slots.add(i);
    Object.keys(G.board).forEach(k => slots.add(parseInt(k, 10)));
    [...slots].sort((a, b) => a - b).forEach(i => {
      const u = G.board[i];
      if (u) html += '<div class="board-cell filled" data-slot="' + i + '" tabindex="0">' + unitCard(u, 'board') + '</div>';
      else html += '<div class="board-cell" data-slot="' + i + '" tabindex="0"></div>';
    });
    b.innerHTML = html;
    $('boardCap').textContent = Object.keys(G.board).length + '/' + boardCap();
    const benchHtml = G.bench.map(u => unitCard(u, 'bench')).join('') || '<div class="slot empty"></div>';
    $('bench').innerHTML = benchHtml;
    $('benchCap').textContent = G.bench.length + '/' + BENCH_CAP;
    benchWarn();
  }

  function benchWarn() {
    const el = $('benchWarn');
    if (G.bench.length > BENCH_CAP) {
      el.classList.remove('hidden');
      el.textContent = '⚠ 备战席溢出（' + G.bench.length + '/' + BENCH_CAP + '）：请售出至少 ' +
        (G.bench.length - BENCH_CAP) + ' 名干员后方可开战。';
    } else el.classList.add('hidden');
  }

  function renderShop() {
    const wrap = $('shopCards');
    wrap.innerHTML = G.shop.map((op, i) => {
      if (!op) return '<div class="slot empty"></div>';
      const afford = G.gold >= effCost(op) ? '' : ' locked';
      const cost = op.stats.cost;
      const role = op.bonds && op.bonds['职业'];
      const aff = op.bonds && op.bonds['阵营'];
      // 方舟风格卡片：大头像 + 底部信息栏 + 标签叠层
      return '<div class="ucard shop-card c' + cost + afford + '" data-shop="' + i + '">' +
        '<img class="avatar" src="' + op.avatar + '" alt="" onerror="this.style.background=\'#222\'">' +
        '<div class="card-fade"></div>' +
        '<div class="card-tags">' +
          (role ? '<span class="ctag"><span class="ctag-icon">⚔</span><span class="ctag-txt">' + role + '</span></span>' : '') +
          (aff ? '<span class="ctag"><span class="ctag-icon">◎</span><span class="ctag-txt">' + aff + '</span></span>' : '') +
          (op.skill ? '<span class="ctag ctag-sk"><span class="ctag-icon">✦</span><span class="ctag-txt">' + op.skill.archLabel + '</span></span>' : '') +
        '</div>' +
        '<div class="card-footer">' +
          '<span class="cf-name">' + op.name + '</span>' +
          '<span class="cf-cost"><span class="coin-icon">●</span>' + cost + '</span>' +
        '</div>' +
        '<div class="cost-pip">' + '□'.repeat(cost) + '</div>' +
      '</div>';
    }).join('');
    const capEl = $('shopCapHint');
    if (capEl) capEl.textContent = 'Lv.' + G.level + ' · 商店最高 ' + maxShopCost(G.level) + ' 费';
  }

  function renderBonds() {
    const { active } = computeBonds(Object.values(G.board).map(u => ({ name: u.op.name, bonds: u.op.bonds, star: u.star })));
    const bar = $('bondsBar');
    if (!active.length) { bar.innerHTML = '<span class="hint" style="font-size:12px">上场干员凑齐同职业/阵营可触发羁绊</span>'; G._activeBondKeys = null; return; }
    // 羁绊解锁音效：仅当新增了此前未激活的羁绊档位时触发（首帧/清空不触发）
    const newKeys = active.map(b => b.axis + '|' + b.value + '|' + b.tier);
    if (G._activeBondKeys && window.AUDIO) {
      newKeys.forEach(k => { if (G._activeBondKeys.indexOf(k) < 0) AUDIO.play('strategic/bond_unlock'); });
    }
    G._activeBondKeys = newKeys;
    bar.innerHTML = active.map(b => {
      const bn = b.bonus || {};
      const parts = [];
      const pct = (k, lbl) => { if (bn[k]) parts.push(lbl + '+' + Math.round(bn[k] * 100) + '%'); };
      pct('atk', '攻'); pct('hp', '血'); pct('def', '防'); pct('aspd', '速'); pct('crit', '暴'); pct('magicAmp', '法'); pct('healAmp', '疗'); pct('spRegen', '技回');
      if (bn.spInit) parts.push('技力+' + bn.spInit);
      return '<div class="bond" data-axis="' + b.axis + '" data-value="' + b.value + '" title="点击查看羁绊详情"><b>' + b.axis + '·' + b.value + '</b> <span class="tier">' + b.tier + '阶 (' + b.count + ')</span> ' + parts.join(' ') + '</div>';
    }).join('');
    bar.querySelectorAll('.bond').forEach(el => el.onclick = () => { if (window.SFX) SFX.play('select'); showBondModal(el.dataset.axis, el.dataset.value); });
  }

  // —— 左侧羁绊面板：已激活 + 潜在（仅统计作战区）——
  function renderBondsPanel() {
    const panel = $('bondsPanel');
    if (!panel) return;
    const boardUnits = Object.values(G.board).map(u => ({ name: u.op.name, bonds: u.op.bonds, star: u.star }));
    const { active, potential } = computeBonds(boardUnits);
    const act = active.filter(b => b.axis === '职业' || b.axis === '阵营' || b.axis === '特殊' || b.axis === '签名');
    const pot = potential.filter(p => p.axis === '职业' || p.axis === '阵营');
    let html = '<div class="bp-head">羁绊面板</div>';
    html += '<div class="bp-sub">已激活</div>';
    if (act.length) {
      html += act.map(b => '<div class="bp-item active" data-axis="' + b.axis + '" data-value="' + b.value + '">' +
        '<span class="bp-dot on"></span><b>' + b.axis + '·' + b.value + '</b> <span class="bp-tier">' + (b.tier >= 1 ? b.tier + '阶' : '被动') + '</span></div>').join('');
    } else html += '<div class="bp-empty">暂无</div>';
    html += '<div class="bp-sub">潜在（作战区）</div>';
    if (pot.length) {
      html += pot.map(p => '<div class="bp-item pot" data-axis="' + p.axis + '" data-value="' + p.value + '">' +
        '<span class="bp-dot"></span><b>' + p.axis + '·' + p.value + '</b> <span class="bp-need">' + p.count + '/' + p.need + '</span></div>').join('');
    } else html += '<div class="bp-empty">暂无（上场同职业/阵营干员可见）</div>';
    panel.innerHTML = html;
    panel.querySelectorAll('.bp-item').forEach(el => el.onclick = () => { if (window.SFX) SFX.play('select'); showBondModal(el.dataset.axis, el.dataset.value); });
  }

  // —— 羁绊详情弹窗 ——
  function describeEffect(k, v) {
    const map = { atk: '攻击', hp: '生命', def: '防御', aspd: '攻速', crit: '暴击', magicAmp: '法强', healAmp: '治疗', spRegen: '技回', spInit: '起手技力' };
    const lbl = map[k] || k;
    if (k === 'spInit') return lbl + '+' + v;
    if (k === 'spRegen') return lbl + '×' + (1 + v);
    return lbl + '+' + Math.round(v * 100) + '%';
  }
  function describeSpecial(sp) {
    const names = {
      pierce: '穿透（无视部分防御）', burnDoT: '灼烧（持续伤害）', slowAura: '减速光环', healAura: '治疗光环',
      castAmp: '咏唱强化（施法后增益）', execute: '处决（残血额外伤害）', critDmg: '暴击伤害提升', summonWolf: '养狼（召唤作战单位）',
      spRegenBuff: '源石技艺增幅', counter: '反击', lifesteal: '吸血', rampHit: '渐增打击', guardAura: '近卫光环',
      shieldPeriodic: '周期护盾', defShred: '破甲', globalAspd: '全队攻速', trueDmg: '真实伤害', slow: '减速', damageReduction: '减伤'
    };
    const kw = sp.kw, p = sp.params || {};
    let s = names[kw] || kw || '—';
    if (p.dps) s += '（' + Math.round(p.dps * 100) + '%/秒）';
    if (p.value) s += '（' + Math.round(p.value * 100) + '%）';
    if (p.mult) s += '（×' + (1 + p.mult) + '）';
    if (p.thresh) s += '（阈值 ' + Math.round(p.thresh * 100) + '%）';
    if (p.t2 !== undefined) s += '（2阶1只 / 3阶2只）';
    return s;
  }
  function describeSig(s) {
    const parts = [];
    if (s.attr) Object.keys(s.attr).forEach(k => parts.push(describeEffect(k, s.attr[k])));
    if (s.kw) Object.keys(s.kw).forEach(k => parts.push(describeSpecial({ kw: k, params: s.kw[k] })));
    return parts.length ? parts.join('、') : '—';
  }
  function showBondModal(axis, value) {
    const titleEl = $('bondModalTitle'), bodyEl = $('bondModalBody');
    const boardNames = new Set(Object.values(G.board).map(u => u.op.name));
    let html = '';
    if (axis === '职业' || axis === '阵营') {
      const cfg = BONDS[axis][value] || (axis === '阵营' ? BONDS[axis]['__default__'] : null);
      if (cfg) {
        html += '<div class="bm-thr">达成阈值：' + cfg.thr.join(' / ') + ' 名同' + (axis === '职业' ? '职业' : '阵营') + '</div>';
        html += '<h4>各阶效果</h4><div class="bm-tiers">';
        cfg.thr.forEach((th, t) => {
          const effs = [];
          BOND_KEYS.forEach(k => { if (cfg[k] && cfg[k][t] != null) effs.push(describeEffect(k, cfg[k][t])); });
          html += '<div class="bm-tier"><b>' + (t + 1) + '阶（' + th + '名）</b>：' + (effs.length ? effs.join('、') : '—') + '</div>';
        });
        html += '</div>';
        if (axis === '阵营') {
          const sp = SPECIAL[value];
          if (sp) html += '<h4>特殊机制（' + sp.tier + '阶解锁）</h4><div class="bm-tier">' + describeSpecial(sp) + '</div>';
        }
      }
      const ops = DATA.operators.filter(o => o.bonds[axis] === value);
      html += '<h4>相关干员（' + ops.length + '）</h4><div class="bm-ops">';
      html += ops.map(o => '<div class="bm-op' + (boardNames.has(o.name) ? ' on' : '') + '">' +
        '<img class="bm-avatar" src="' + o.avatar + '" alt="' + o.name + '" onerror="this.style.background=\'#222\'">' +
        costChip(o.stats.cost) + o.name + (boardNames.has(o.name) ? ' ✓' : '') + '</div>').join('');
      html += '</div>';
    } else if (axis === '特殊') {
      const sp = SPECIAL[value];
      if (sp) {
        html += '<div class="bm-thr">阵营特殊机制，' + sp.tier + '阶解锁</div>';
        html += '<h4>机制说明</h4><div class="bm-tier">' + describeSpecial(sp) + '</div>';
      }
    } else if (axis === '签名') {
      const sd = (typeof SIGNATURE_DESC !== 'undefined') && SIGNATURE_DESC[value];
      if (sd) {
        html += '<div class="bm-thr">5费签名 · ' + sd.title + '（上场即生效）</div>';
        html += '<h4>效果</h4><div class="bm-tier">' + sd.desc + '</div>';
      } else {
        const s = SIGNATURE[value];
        if (s) {
          html += '<div class="bm-thr">5费签名 · 单人被动（上场即生效）</div>';
          html += '<h4>效果</h4><div class="bm-tier">' + describeSig(s) + '</div>';
        }
      }
      const op = DATA.operators.find(o => o.name === value);
      if (op) html += '<div class="bm-ops"><div class="bm-op on">' +
        '<img class="bm-avatar" src="' + op.avatar + '" alt="' + op.name + '" onerror="this.style.background=\'#222\'">' +
        costChip(op.stats.cost) + op.name + '</div></div>';
    }
    titleEl.textContent = axis + '·' + value;
    bodyEl.innerHTML = html;
    $('bondModal').classList.remove('hidden');
  }

  function renderUnitBar() {
    const bar = $('unitBar');
    if (G.selected == null) { bar.classList.add('hidden'); return; }
    const u = findUnit(G.selected);
    if (!u) { bar.classList.add('hidden'); return; }
    bar.classList.remove('hidden');
    const op = u.op, st = op.stats, sm = STAR_MULT[u.star] || 1;
    $('ubAvatar').src = op.avatar;
    $('ubName').textContent = op.name;
    $('ubStar').textContent = starStr(u.star);
    $('ubStats').innerHTML =
      '费 ' + st.cost + '　HP ' + Math.round(st.hp * sm) +
      '　ATK ' + Math.round(st.atk * sm) + '　DEF ' + Math.round((st.def || 0) * sm) +
      '<br>攻速 ' + (st.spd != null ? st.spd : '-') + '　射程 ' + (st.range != null ? st.range : '-') + '　' + (op.role || '-');
    const bd = $('ubBonds');
    if (bd) {
      const tags = bondTagsFull(op);
      bd.innerHTML = (tags ? '<div class="ub-bond-tags">' + tags + '</div>' : '') +
        '<div class="ub-bond-note">' + bondShort(op) + '</div>';
    }
    const skEl = $('ubSkill');
    if (skEl) { skEl.innerHTML = renderSkillBlock(op); bindSkillToggle(); }
  }

  /* ---- 技能描述（简略/详细切换，board/bench 卡与商店弹窗共用） ---- */
  function briefSkill(sk) {
    const e = sk.effect || {};
    const tmap = { nearest: '最近敌人', all: '全体敌人', self: '自身', row: '整行', col: '整列', adj: '周围', lowest: '最低生命', front: '最前排', back: '最后排' };
    const parts = [];
    if (e.mult) parts.push('造成约 ' + Math.round(e.mult * 100) + '% 伤害');
    if (e.target) parts.push('目标 ' + (tmap[e.target] || e.target));
    if (e.thresh) parts.push('触发阈值 ' + e.thresh);
    let s = parts.length ? parts.join('，') + '。' : '';
    if (!s && sk.desc) s = sk.desc.split(/[，。；]/)[0] + '。';
    if (!s) s = (sk.archLabel || sk.type || '特殊') + '类技能。';
    return s;
  }
  function renderSkillBlock(op) {
    const sk = op.skill;
    if (!sk) return '<div class="sk-block"><div class="sk-none">无主动技能（基础攻击）</div></div>';
    const e = sk.effect || {};
    const tmap = { nearest: '最近敌人', all: '全体敌人', self: '自身', row: '整行', col: '整列', adj: '周围', lowest: '最低生命', front: '最前排', back: '最后排' };
    const effParts = [];
    if (e.mult) effParts.push('伤害倍率 ' + Math.round(e.mult * 100) + '%');
    if (e.target) effParts.push('目标 ' + (tmap[e.target] || e.target));
    if (e.thresh) effParts.push('触发阈值 ' + e.thresh);
    const detailed = (sk.desc || '') +
      (effParts.length ? '<br><span class="sk-eff">数值：' + effParts.join('，') + '</span>' : '') +
      '<br><span class="sk-sp">技力 ' + (sk.spMax || '-') + ' · 回复 ' + (sk.spRegen || '-') + '</span>';
    return '<div class="sk-block">' +
      '<div class="sk-head"><span class="sk-name">' + sk.name + '</span>' +
        '<span class="badge">' + (sk.type || '') + '</span>' +
        '<span class="badge gold">' + (sk.archLabel || '') + '</span></div>' +
      '<div class="sk-brief" id="skBrief">' + briefSkill(sk) + '</div>' +
      '<div class="sk-detail hidden" id="skDetail">' + detailed + '</div>' +
      '<button class="btn tiny sk-toggle" id="skToggle" type="button">查看详细描述 ▾</button>' +
    '</div>';
  }
  function bindSkillToggle() {
    const tg = $('skToggle');
    if (!tg) return;
    tg.onclick = () => {
      const b = $('skBrief'), d = $('skDetail');
      if (!b || !d) return;
      const detailHidden = d.classList.contains('hidden');
      d.classList.toggle('hidden', !detailHidden);
      b.classList.toggle('hidden', detailHidden);
      tg.textContent = detailHidden ? '收起详细描述 ▴' : '查看详细描述 ▾';
      if (window.SFX) SFX.play('click');
    };
  }
  function findUnit(uid) {
    return G.bench.find(u => u.uid === uid) || Object.values(G.board).find(u => u.uid === uid) || null;
  }
  function whereIs(uid) {
    if (slotOf(uid) != null) return 'board';
    if (G.bench.some(u => u.uid === uid)) return 'bench';
    return null;
  }

  /* ---- 经济 / 商店 ---- */
  function startRound() {
    const node = G.nodes[G.nodeIdx];
    if (!node) { reset(); return; }
    if (node.type === 'reward') { grantReward(node); return; }
    if (node.type === 'strategy') { showStrategyScreen(node); return; }
    if (node.type === 'encounter') { showEncounterScreen(node); return; }
    enterShopRound(node);
  }

  function enterShopRound(node) {
    G.phase = 'shop';
    if (window.AUDIO) AUDIO.setMusic('shop');
    // 经济类策略 + 开局环境 每回合生效
    const se = aggregateStrategies();
    const ef = (G.env && G.env.effects) || {};
    G.boardBonus = (se.boardCapBonus || 0) + (ef.boardCapBonus || 0);
    G.freeRerollLeft = (se.freeReroll || 0) + (ef.rerollBonus || 0);
    // 敌方编队（遭遇节点按难度缩放，全局难度始终叠加）
    if (node.type === 'encounter' && G.encounterDiff) {
      G.currentEnemy = generateEnemyTeam(G.level, G.nodeIdx, false, ENCOUNTER_DIFFS[G.encounterDiff], diffCfg());
    } else {
      G.currentEnemy = generateEnemyTeam(G.level, G.nodeIdx, node.type === 'boss', null, diffCfg());
    }
    const round = G.nodeIdx + 1;
    const interestMax = 5 + (ef.interestMax || 0);
    const interest = Math.min(interestMax, Math.floor(G.gold / 10));
    let streakBonus = 0;
    const s = Math.max(G.winStreak, G.lossStreak);
    if (s >= 2 && s <= 3) streakBonus = 1; else if (s >= 4 && s <= 5) streakBonus = 2; else if (s >= 6) streakBonus = 3;
    const base = Math.min(round + 2, 7);
    G.gold += base + interest + streakBonus + se.goldPerRound;
    G.exp += 2 + (ef.expBonus || 0) + se.expPerRound;
    levelUp();
    rollShop();
    renderAll();
    $('phaseHint').textContent = '阶段 ' + (node.phase || 1) + '/3 · 第 ' + round + ' 回合 · 运营你的棋库，拖拽部署后开战';
    $('btnFight').classList.remove('hidden');
    $('btnNext').classList.add('hidden');
    G._result = null;
    renderNodeFlow();
    saveGame();
  }

  // —— 策略节点：3 选 1 永久全局被动，档位随已选次数抬高 ——
  function tierRank(t) { return { bronze: 0, silver: 1, gold: 2, color: 3 }[t] || 0; }
  function showStrategyScreen(node) {
    const minTier = ['bronze', 'silver', 'gold'][Math.min(G.stratCount, 2)];
    let pool = STRATEGY_POOL.filter(s => tierRank(s.tier) >= tierRank(minTier));
    if (pool.length < 3) pool = STRATEGY_POOL.slice();
    const picks = shuffle(pool).slice(0, 3);
    const wrap = $('strategyChoices');
    wrap.innerHTML = picks.map(s =>
      '<div class="strategy-card tier-' + s.tier + '" data-sid="' + s.id + '">' +
        '<div class="sc-head">' +
          '<span class="sc-badge">' + STRATEGY_TIERS_ROMAN[s.tier] + '</span>' +
          '<span class="sc-icon">' + (STRAT_ICON[s.id] || '💡') + '</span>' +
        '</div>' +
        '<div class="sc-name">' + s.name + '</div>' +
        '<div class="sc-divider"></div>' +
        '<div class="sc-desc">' + s.desc + '</div>' +
        '<div class="sc-tier-label">' + STRATEGY_TIERS_LABEL[s.tier] + '档</div>' +
      '</div>'
    ).join('');
    wrap.querySelectorAll('.strategy-card').forEach(c => c.onclick = () => {
      if (window.SFX) SFX.play('select');
      G.strategies.push(c.dataset.sid); G.stratCount++;
      $('strategyScreen').classList.add('hidden');
      enterShopRound(node); // 策略节点同时进入一回合（普通战斗）
    });
    $('strategyScreen').classList.remove('hidden');
    if (window.AUDIO) AUDIO.setMusic('exploration');
  }

  // —— 遭遇节点：3 档难度，敌方与奖励随档放大 ——
  function showEncounterScreen(node) {
    const wrap = $('encounterChoices');
    wrap.innerHTML = Object.keys(ENCOUNTER_DIFFS).map(k => {
      const d = ENCOUNTER_DIFFS[k];
      return '<div class="encounter-card" data-diff="' + k + '">' +
        '<div class="ec-label">' + d.label + '</div>' +
        '<div class="ec-desc">' + d.desc + '</div>' +
        '<div class="ec-reward">奖励 ×' + d.rewardMult + '</div>' +
      '</div>';
    }).join('');
    wrap.querySelectorAll('.encounter-card').forEach(c => c.onclick = () => {
      if (window.SFX) SFX.play('select');
      G.encounterDiff = c.dataset.diff;
      $('encounterScreen').classList.add('hidden');
      enterShopRound(node);
    });
    $('encounterScreen').classList.remove('hidden');
    if (window.AUDIO) AUDIO.setMusic('exploration');
  }

  function rollShop() { G.shop = pickShop(DATA.operators, G.level); }

  function levelUp() {
    while (G.level < 9 && G.exp >= (EXP_NEED[G.level] || 1e9)) {
      G.exp -= EXP_NEED[G.level]; G.level++;
    }
  }

  function grantReward(node) {
    const rm = diffCfg().rewardMult || 1;
    const g = Math.round(rnd(8, 14) * rm), e = Math.round(rnd(4, 8) * rm);
    G.gold += g; G.exp += e; levelUp();
    let bonus = '';
    // 偶发增援：免费获得干员，可能把备战席顶过 10（用于演示溢出拦截）
    if (Math.random() < 0.6) {
      const n = rnd(1, 2);
      const pool = shuffle(DATA.operators.filter(o => o.stats.cost <= maxShopCost(G.level))).slice(0, n);
      pool.forEach(op => G.bench.push({ uid: uidc++, op, star: 1 }));
      tryCombine();
      bonus = ' 并接收了 ' + n + ' 名增援干员。';
    }
    G.phase = 'result';
    const rewardBody = '缴获 +' + g + ' 金币，+' + e + ' 经验。' + bonus + '整备后再战。';
    G._result = { title: '补给节点', body: rewardBody, btn: '前进 →', kind: 'next' };
    showResult('补给节点', rewardBody, '前进 →', () => nextNode());
    saveGame();
  }

  /* ---- 交互 ---- */
  function buy(i) {
    const op = G.shop[i];
    if (!op) return;
    const c = effCost(op);
    if (G.gold < c) { flash('金币不足'); if (window.SFX) SFX.play('error'); return; }
    if (G.bench.length >= BENCH_CAP) { flash('备战席已满（' + BENCH_CAP + '），先部署或售出'); if (window.SFX) SFX.play('error'); return; }
    G.gold -= c; G.shop[i] = null;
    G.bench.push({ uid: uidc++, op, star: 1 });
    if (window.SFX) SFX.play('buy');
    tryCombine();
    renderAll();
    saveGame();
  }

  function tryCombine() {
    let changed = true;
    while (changed) {
      changed = false;
      const groups = {};
      G.bench.concat(Object.values(G.board)).forEach(u => {
        const k = u.op.name + '#' + u.star;
        (groups[k] = groups[k] || []).push(u);
      });
      for (const k in groups) {
        const arr = groups[k];
        const star = arr[0].star;
        if (star >= 3) continue;
        if (arr.length >= 3) {
          const three = arr.slice(0, 3);
          const onBoard = three.filter(u => slotOf(u.uid) != null);
          three.forEach(u => {
            G.bench = G.bench.filter(x => x.uid !== u.uid);
            for (const kk in G.board) if (G.board[kk].uid === u.uid) delete G.board[kk];
          });
          const up = { uid: uidc++, op: arr[0].op, star: star + 1 };
          if (onBoard.length >= 2) { const c = firstFreeSlot(); if (c != null) G.board[c] = up; else G.bench.push(up); }
          else G.bench.push(up);
          changed = true;
          break;
        }
      }
    }
  }

  function togglePlace() {
    if (G.selected == null) return;
    const uid = G.selected;
    const where = whereIs(uid);
    const u = findUnit(uid);
    if (!u) return;
    if (where === 'bench') {
      if (Object.keys(G.board).length >= boardCap()) { flash('人口已满（Lv.' + boardCap() + '）'); return; }
      const c = firstFreeSlot();
      if (c == null) { flash('部署区已满'); return; }
      G.bench = G.bench.filter(x => x.uid !== uid);
      G.board[c] = { uid: u.uid, op: u.op, star: u.star };
    } else {
      const k = slotOf(uid);
      delete G.board[k];
      if (G.bench.length < BENCH_CAP) G.bench.push({ uid: u.uid, op: u.op, star: u.star });
      else { G.board[k] = { uid: u.uid, op: u.op, star: u.star }; flash('备战席已满'); }
    }
    renderAll();
    saveGame();
  }

  function sellUnit(uid) {
    const u = findUnit(uid);
    if (!u) return;
    const se = aggregateStrategies();
    const ef = (G.env && G.env.effects) || {};
    const mult = 1 + (se.sellValuePct || 0) + (ef.sellValuePct || 0);
    const refund = Math.round(effCost(u.op) * (u.star === 1 ? 1 : u.star === 2 ? 3 : 9) * mult);
    G.gold += refund;
    G.bench = G.bench.filter(x => x.uid !== uid);
    for (const k in G.board) if (G.board[k].uid === uid) delete G.board[k];
    if (G.selected === uid) G.selected = null;
    renderAll();
    flash('售出 +' + refund + '💰');
    saveGame();
  }
  function sell() { if (G.selected == null) return; if (window.SFX) SFX.play('click'); sellUnit(G.selected); }

  function refresh() {
    if (G.gold < 2) { flash('金币不足'); if (window.SFX) SFX.play('error'); return; }
    G.gold -= 2; rollShop(); if (window.SFX) SFX.play('reroll'); renderAll(); saveGame();
  }
  function buyExp() {
    if (G.level >= 9) { flash('已满级'); return; }
    if (G.gold < 4) { flash('金币不足'); if (window.SFX) SFX.play('error'); return; }
    G.gold -= 4; G.exp += 4; levelUp(); if (window.SFX) SFX.play('click'); if (window.AUDIO) AUDIO.play('shop/levelup'); renderAll(); saveGame();
  }

  function selectUnit(uid) { G.selected = (G.selected === uid) ? null : uid; if (window.SFX) SFX.play('select'); renderBoard(); renderUnitBar(); }

  function flash(msg) {
    const h = $('phaseHint');
    h.textContent = msg;
    h.style.color = '#e8b84b';
    setTimeout(() => { h.style.color = ''; }, 1200);
  }

  /* ---- 战斗（站位） ---- */
  function onFight() {
    if (G.bench.length > BENCH_CAP) { flash('请先处理备战席溢出（售出角色）'); return; }
    if (!Object.keys(G.board).length) { flash('先上场至少 1 名干员'); return; }
    if (window.SFX) SFX.play('node');
    // 自适应音乐：进入战斗，tension 由敌方倍率映射（0.72→0.0，1.45→1.0），首领强制满
    if (window.AUDIO) {
      const node = G.nodes[G.nodeIdx];
      const m = (diffCfg() && diffCfg().enemyMult) || 1;
      const ten = Math.max(0, Math.min(1, (m - 0.7) / (1.45 - 0.7)));
      if (node && node.type === 'boss') { AUDIO.setMusic('boss'); AUDIO.setTension(1); }
      else { AUDIO.setMusic('combat'); AUDIO.setTension(ten); }
    }
    const node = G.nodes[G.nodeIdx];
    const enemyBase = G.currentEnemy || generateEnemyTeam(G.level, G.nodeIdx, node.type === 'boss', null, diffCfg());

    const allyList = [];
    const allyPos = [];
    // 遍历所有已部署格（不再写死 9），确保扩编后的第 10+ 个单位也会参战
    Object.keys(G.board).forEach(k => {
      const i = parseInt(k, 10);
      if (G.board[i]) { allyList.push({ op: G.board[i].op, star: G.board[i].star }); allyPos.push(slotToXY(i)); }
    });
    // —— light 版召唤（叙拉古养狼 / 令岁兽）：开战前生成，并入阵列 ——
    const probe = computeBonds(allyList.map(u => ({ name: u.op.name, bonds: u.op.bonds, star: u.star })));
    const xila = probe.active.find(b => b.axis === '特殊' && b.value === '叙拉古');
    const xilaTier = xila ? xila.tier : 0;
    const lingCount = allyList.filter(u => u.op.name === '令').length;
    const summonUnits = [];
    if (xilaTier >= 2) { const n = xilaTier >= 3 ? 2 : 1; for (let i = 0; i < n; i++) summonUnits.push({ op: makeSummonOp('wolf', xilaTier), star: 3 }); }
    if (lingCount > 0) { for (let i = 0; i < lingCount; i++) summonUnits.push({ op: makeSummonOp('beast', 3), star: 3 }); }
    if (summonUnits.length) {
      const occupied = new Set(allyPos.map(p => p.x + ',' + p.y));
      const allCells = [];
      for (let x = GRID_COLS - 1; x >= 0; x--) for (let y = 0; y < GRID_ROWS; y++) allCells.push({ x, y });
      const cand = allCells.filter(p => !occupied.has(p.x + ',' + p.y)).slice(0, summonUnits.length);
      summonUnits.forEach((s, i) => { if (cand[i]) { allyList.push(s); allyPos.push(cand[i]); } });
      if (summonUnits.length) console.log('[fight] 召唤物已生成:', summonUnits.length);
    }
    console.log('[fight] allyList:', allyList.length, 'enemyBase:', enemyBase.length, 'board keys:', Object.keys(G.board));
    const allyUnits = applyBonds(allyList.map(u => ({ op: u.op, star: u.star })), 'ally');
    const enemyUnits = applyBonds(enemyBase.map(t => ({ op: t.op, star: t.star, buff: t.buff })), 'enemy');
    // 关键：给单位分配 uid，与 simulateBattleGrid 内部的 uid 命名一致（aN / eN）
    allyUnits.forEach((u, i) => { u.uid = 'a' + i; });
    enemyUnits.forEach((u, i) => { u.uid = 'e' + i; });
    const enemyPos = autoPositions(enemyUnits, 'enemy');

    const res = simulateBattleGrid(allyUnits, enemyUnits, allyPos, enemyPos);
    console.log('[fight] battle result:', res.winner, 'frames:', res.frames.length);
    G.battleRes = res;
    showBattle(res, allyUnits, enemyUnits);
  }

  function showBattle(res, allyUnits, enemyUnits) {
    try {
      G.phase = 'fight';
      $('arena').classList.add('hidden');
      $('envScreen').classList.add('hidden');
      $('resultScreen').classList.add('hidden');
      $('battleScreen').classList.remove('hidden');
      const logEl = $('battleLog');
      logEl.innerHTML = '<div class="sys">⚔ 战斗开始！</div>';

      const g = $('bfGrid');
      g.innerHTML = '';
      G._bfEls = {};

      // 防御：校验帧数据
      if (!res || !res.frames || !res.frames.length) {
        logEl.innerHTML += '<div class="sys" style="color:#e74c3c">错误：无战斗帧数据</div>';
        console.error('[battle] 无帧数据', res);
        return;
      }

      const allUnits = allyUnits.concat(enemyUnits);
      console.log('[battle] units:', allUnits.length, 'frames:', res.frames.length);

      const initPos = {};
      const f0 = res.frames[0];
      if (f0.ally) f0.ally.forEach(s => { if (s && s.uid) initPos[s.uid] = s; });
      if (f0.enemy) f0.enemy.forEach(s => { if (s && s.uid) initPos[s.uid] = s; });

      // 渲染单位
      let rendered = 0;
      allUnits.forEach(u => {
        const p = initPos[u.uid];
        if (!p) { console.warn('[battle] 无初始位置', u.uid, u.name); return; }
        const el = document.createElement('div');
        el.className = 'bf-unit ' + (u.side === 'ally' ? 'ally' : 'enemy');
        el.dataset.uid = u.uid;
        el.dataset.side = u.side;
        el.style.background = u.side === 'ally' ? 'rgba(64,180,220,0.12)' : 'rgba(220,80,80,0.12)';
        el.innerHTML =
          '<img class="av" src="' + u.avatar + '" onerror="this.style.background=\'#222\'">' +
          '<div class="nm">' + u.name + (u.star > 1 ? '★' + u.star : '') + '</div>' +
          '<div class="hpbar"><i style="width:100%"></i></div>' +
          '<div class="spbar"><i style="width:0%"></i></div>';
        el.style.transform = 'translate(' + (p.x * CELL + 4) + 'px,' + (p.y * CELL + 4) + 'px)';
        if (!p.alive) el.classList.add('dead');
        el.dataset.alive = p.alive ? 'alive' : 'dead';
        g.appendChild(el);
        G._bfEls[u.uid] = el;
        rendered++;
      });

      console.log('[battle] rendered:', rendered, '/', allUnits.length);

      // 如果没有渲染出任何单位，显示错误
      if (rendered === 0) {
        logEl.innerHTML += '<div class="sys" style="color:#e74c3c">⚠ 单位渲染失败（无单位或位置数据缺失）</div>';
        return;
      }

      // 启动帧动画
      let fi = 0;
      const speed = 300;
      if (G.frameTimer) clearInterval(G.frameTimer);
      G.frameTimer = setInterval(() => {
        if (fi >= res.frames.length) { clearInterval(G.frameTimer); endBattle(res); return; }
        applyFrame(res.frames[fi]); fi++;
      }, speed);
      G._skip = () => {
        G._audioSkip = true;
        clearInterval(G.frameTimer);
        while (fi < res.frames.length) { applyFrame(res.frames[fi]); fi++; }
        G._audioSkip = false;
        endBattle(res);
      };
    } catch (e) {
      console.error('[battle] showBattle 异常:', e);
      $('battleLog').innerHTML += '<div class="sys" style="color:#e74c3c">战斗演出异常: ' + e.message + '</div>';
    }
  }

  function updateUnit(s) {
    const el = G._bfEls[s.uid];
    if (!el) return;
    el.style.transform = 'translate(' + (s.x * CELL + 4) + 'px,' + (s.y * CELL + 4) + 'px)';
    el.classList.toggle('dead', !s.alive);
    if (!s.alive) {
      if (el.dataset.alive !== 'dead') {
        el.dataset.alive = 'dead';
        if (!G._audioSkip && window.AUDIO) AUDIO.play('combat/death', { side: el.dataset.side });
      }
    } else {
      el.dataset.alive = 'alive';
    }
    const hp = el.querySelector('.hpbar i');
    if (hp) hp.style.width = (s.max ? Math.max(0, s.hp / s.max * 100) : 0) + '%';
    const sp = el.querySelector('.spbar i');
    if (sp) sp.style.width = (s.spMax ? Math.max(0, Math.min(100, s.sp / s.spMax * 100)) : 0) + '%';
    if (s.shield > 0) el.classList.add('has-shield'); else el.classList.remove('has-shield');
  }

  function applyFrame(fr) {
    try {
      if (fr.sys) {
        const log = $('battleLog');
        const div = document.createElement('div');
        div.className = 'sys'; div.textContent = fr.line;
        log.appendChild(div); log.scrollTop = log.scrollHeight;
        return;
      }
      if (fr.ally) fr.ally.forEach(s => updateUnit(s));
      if (fr.enemy) fr.enemy.forEach(s => updateUnit(s));
      // 施法闪光
      if (fr.casts && fr.casts.length) fr.casts.forEach(c => {
        const el = G._bfEls[c.uid];
        if (el) { el.classList.add('casting'); setTimeout(() => el.classList.remove('casting'), 280); }
      });
      if (fr.lines && fr.lines.length) {
        const log = $('battleLog');
        fr.lines.forEach(l => {
          const div = document.createElement('div');
          div.className = l.k || ''; div.textContent = l.line || '';
          log.appendChild(div);
        });
        log.scrollTop = log.scrollHeight;
      }
      // 战斗音效：由模拟帧驱动；跳过演出时静音。每帧限流避免拥堵。
      if (!G._audioSkip && window.AUDIO) {
        if (fr.casts && fr.casts.length) {
          let cn = 0;
          fr.casts.forEach(c => {
            if (cn >= 2) return;
            const side = (c.uid && c.uid.charAt(0) === 'a') ? 'ally' : 'enemy';
            AUDIO.play('combat/skill', { arch: c.arch, side: side });
            cn++;
          });
        }
        if (fr.lines && fr.lines.length) {
          let hn = 0;
          fr.lines.forEach(l => {
            if (l.k === 'hit') { if (hn < 2) { AUDIO.play('combat/hit', { dmgType: l.dmgType, side: l.side }); hn++; } }
            else if (l.k === 'heal') { AUDIO.play('combat/heal'); }
          });
        }
      }
    } catch (e) {
      console.error('[battle] applyFrame 异常:', e, fr);
    }
  }

  function endBattle(res) { finishBattle(res); }

  function finishBattle(res) {
    G.phase = 'result';
    const node = G.nodes[G.nodeIdx];
    if (window.AUDIO) {
      if (res.winner === 'ally') AUDIO.setMusic(node.type === 'boss' ? 'boss' : 'victory');
      else AUDIO.setMusic('defeat');
    }
    if (res.winner === 'ally') {
      G.winStreak++; G.lossStreak = 0;
      const ef = (G.env && G.env.effects) || {};
      const rm = diffCfg().rewardMult || 1;
      if (ef.healPerWin) G.hp = Math.min(G.maxHp, G.hp + ef.healPerWin);
      if (node.type === 'boss') {
        const p = getPromote() + 1; setPromote(p);
        G._result = { title: '🏆 通关！晋升达成', body: '你击败了最终首领，棋局晋升至 Lv.' + p + '。历史最高晋升：Lv.' + p, btn: '再来一局', kind: 'reset' };
        showResult(G._result.title, G._result.body, G._result.btn, () => reset());
        saveGame();
        return;
      }
      let body = '本节点告捷，连胜 ' + G.winStreak + '。';
      // 精英节点额外奖励（按全局难度倍率）
      if (node.type === 'elite') { G.gold += Math.round(6 * rm); G.exp += Math.round(4 * rm); levelUp(); body += ' 精英奖励 +' + Math.round(6 * rm) + '💰 +' + Math.round(4 * rm) + 'exp。'; }
      // 遭遇节点胜利奖励（全局难度 × 该遭遇档位奖励倍率，之前只在卡片显示，现真正结算）
      if (node.type === 'encounter' && G.encounterDiff) {
        const er = Math.round(rnd(10, 16) * rm * (ENCOUNTER_DIFFS[G.encounterDiff].rewardMult || 1));
        G.gold += er; levelUp(); body += ' 遭遇奖励 +' + er + '💰。';
      }
      G._result = { title: '胜利', body, btn: '前进 →', kind: 'next' };
      showResult(G._result.title, G._result.body, G._result.btn, () => nextNode());
      saveGame();
    } else {
      G.lossStreak++; G.winStreak = 0;
      const dmg = Math.round((res.eAlive * 4 + 3) * (diffCfg().hpLossMult || 1));
      G.hp -= dmg;
      renderTop();
      if (node.type === 'boss') {
        G._result = { title: '⚔ 败于最终首领', body: '你倒在了最终首领面前（剩余生命 ' + Math.max(0, G.hp) + '）。历史最高晋升：Lv.' + getPromote(), btn: '再来一局', kind: 'reset' };
        showResult(G._result.title, G._result.body, G._result.btn, () => reset());
        saveGame();
        return;
      }
      if (G.hp <= 0) {
        G._result = { title: '💀 棋局崩盘', body: '小队生命归零。历史最高晋升：Lv.' + getPromote(), btn: '再来一局', kind: 'reset' };
        showResult(G._result.title, G._result.body, G._result.btn, () => reset());
        saveGame();
        return;
      }
      G._result = { title: '战败', body: '损失 ' + dmg + ' 生命（剩余 ' + Math.max(0, G.hp) + '）。整顿后再战。', btn: '前进 →', kind: 'next' };
      showResult(G._result.title, G._result.body, G._result.btn, () => nextNode());
      saveGame();
    }
  }

  function showResult(title, body, btn, cb) {
    $('resultTitle').textContent = title;
    $('resultBody').textContent = body;
    const b = $('btnResult');
    b.textContent = btn;
    b.onclick = () => { if (window.SFX) SFX.play('click'); cb(); };
    $('resultScreen').classList.remove('hidden');
    $('battleScreen').classList.add('hidden');
  }

  function nextNode() {
    G.nodeIdx++;
    G.selected = null;
    G.encounterDiff = null;
    if (window.SFX) SFX.play('node');
    $('resultScreen').classList.add('hidden');
    $('arena').classList.remove('hidden');
    startRound();
  }

  function buildNodes() {
    // 三阶段 × 9 节点 = 27 节点。
    // 每个阶段固定：1 个策略 + 1 个遭遇（阶段内倒数第三，作为该阶段挑战关）+ 1 个补给（阶段内倒数第二）；
    // 第一阶段开头额外 2 个补给节点（节点 1、2）；第三阶段末尾是 BOSS（补给紧邻 BOSS 之前）。
    const phase1 = ['reward', 'reward', 'battle', 'strategy', 'battle', 'battle', 'encounter', 'reward', 'battle'];
    const phase2 = ['battle', 'strategy', 'battle', 'battle', 'battle', 'battle', 'encounter', 'reward', 'battle'];
    const phase3 = ['battle', 'strategy', 'battle', 'battle', 'battle', 'battle', 'encounter', 'reward', 'boss'];
    G.nodes = []
      .concat(phase1.map(t => ({ type: t, phase: 1 })))
      .concat(phase2.map(t => ({ type: t, phase: 2 })))
      .concat(phase3.map(t => ({ type: t, phase: 3 })));
  }

  function showEnemyPreview() {
    const node = G.nodes[G.nodeIdx];
    let tag = '普通战';
    if (node.type === 'elite') tag = '精英战';
    if (node.type === 'encounter') tag = '⚡ 遭遇战';
    if (node.type === 'boss') tag = '★ BOSS';
    $('enemyDesc').textContent = tag + ' · 节点 ' + (G.nodeIdx + 1);
    const team = G.currentEnemy || [];
    $('enemyTeam').innerHTML = team.map(t =>
      '<div class="mini-chip">' + costChip(t.op.stats.cost) +
      '<img src="' + t.op.avatar + '" onerror="this.style.background=\'#222\'">' +
      '<span>' + t.op.name + (t.star > 1 ? '★' + t.star : '') + '</span></div>'
    ).join('');
  }

  function renderAll() {
    renderTop(); renderBoard(); renderShop(); renderBonds(); renderBondsPanel(); renderUnitBar(); showEnemyPreview();
  }

  /* ---- 投资环境 ---- */
  function renderEnv() {
    const promo = getPromote();
    const wrap = $('envChoices');
    const choices = shuffle(ENV_POOL).slice(0, 3);
    wrap.innerHTML = choices.map(e =>
      '<div class="env-card" data-env="' + e.id + '"><h4>' + e.name + '</h4><p>' + e.desc + '</p></div>'
    ).join('') + '<div class="hint" style="width:100%;margin-top:10px">历史最高晋升：Lv.' + promo + '</div>';
    wrap.querySelectorAll('.env-card').forEach(c => c.onclick = () => {
      if (window.SFX) SFX.play('click');
      G.env = ENV_POOL.find(e => e.id === c.dataset.env);
      const ef = (G.env && G.env.effects) || {};
      if (ef.gold) G.gold += ef.gold;
      if (ef.maxHp) { G.maxHp += ef.maxHp; G.hp += ef.maxHp; }
      $('envScreen').classList.add('hidden');
      $('arena').classList.remove('hidden');
      startRound();
    });
  }

  /* ---- 难度选择（数字 1-5，由易到难） ---- */
  function renderDiff() {
    const wrap = $('diffChoices');
    if (!wrap) { console.error('[renderDiff] #diffChoices 不存在'); return; }
    wrap.innerHTML = Object.keys(DIFFICULTY).map(k => {
      const d = DIFFICULTY[k];
      return '<div class="diff-card" data-diff="' + k + '">' +
        '<div class="dc-num">' + k + '</div>' +
        '<div class="dc-name">' + d.name + '</div>' +
        '<div class="dc-desc">' + d.desc + '</div>' +
        '<div class="dc-enemy">敌强 ×' + d.enemyMult + (d.countBonus ? ' (+' + d.countBonus + ')' : '') + '　奖励 ×' + d.rewardMult + '</div>' +
      '</div>';
    }).join('');
    wrap.querySelectorAll('.diff-card').forEach(c => c.onclick = () => {
      if (window.SFX) SFX.play('click');
      G.difficulty = parseInt(c.dataset.diff, 10) || 2;
      $('diffScreen').classList.add('hidden');
      $('envScreen').classList.remove('hidden');
      if (window.AUDIO) AUDIO.setMusic('exploration');
      renderEnv();
    });
  }

  function reset() {
    clearSave();
    G.gold = 0; G.level = 1; G.exp = 0; G.hp = 100; G.maxHp = 100;
    G.winStreak = 0; G.lossStreak = 0;
    G.bench = []; G.board = {}; G.shop = [null, null, null, null, null];
    G.nodeIdx = 0; G.env = null; G.selected = null; G.difficulty = 2;
    buildNodes();
    $('resultScreen').classList.add('hidden');
    $('battleScreen').classList.add('hidden');
    $('arena').classList.add('hidden');
    $('envScreen').classList.add('hidden');
    const ds = $('diffScreen');
    if (ds) {
      ds.classList.remove('hidden');
      if (window.AUDIO) AUDIO.setMusic('exploration');
      try { renderDiff(); } catch (e) { console.error('[reset] renderDiff 失败，降级到环境选择:', e); $('envScreen').classList.remove('hidden'); if (window.AUDIO) AUDIO.setMusic('exploration'); renderEnv(); }
    } else {
      $('envScreen').classList.remove('hidden');
      if (window.AUDIO) AUDIO.setMusic('exploration');
      renderEnv();
    }
  }

  /* ---- 拖拽系统（稳健版） ---- */
  let drag = null;
  let clickSuppress = false;

  // 在判定落点时临时隐藏幽灵，彻底避免 elementFromPoint 命中幽灵本身
  function elementAt(x, y) {
    const g = drag && drag.ghost;
    if (g) g.style.display = 'none';
    const el = document.elementFromPoint(x, y);
    if (g) g.style.display = '';
    return el;
  }
  function clearHover() {
    document.querySelectorAll('.drop-hover').forEach(e => e.classList.remove('drop-hover'));
  }
  function markHover(x, y) {
    clearHover();
    const el = elementAt(x, y);
    if (!el) return;
    const cell = el.closest('.board-cell');
    if (cell && !cell.classList.contains('locked')) { cell.classList.add('drop-hover'); return; }
    const bench = el.closest('#bench');
    if (bench) { bench.classList.add('drop-hover'); return; }
    const sz = el.closest('#sellZone');
    if (sz) sz.classList.add('drop-hover');
  }
  function pickTarget(x, y) {
    const el = elementAt(x, y);
    if (!el) return null;
    const cell = el.closest('.board-cell');
    if (cell) return { type: 'cell', idx: parseInt(cell.dataset.slot, 10) };
    const bench = el.closest('#bench');
    if (bench) return { type: 'bench' };
    if (el.closest('#sellZone')) return { type: 'sell' };
    return null;
  }
  function createGhost(card) {
    const g = document.createElement('div');
    g.className = 'drag-ghost';
    g.innerHTML = card.outerHTML;
    const r = card.getBoundingClientRect();
    g.style.width = r.width + 'px';
    g.style.height = r.height + 'px';
    document.body.appendChild(g);
    return g;
  }

  function onPointerDown(e) {
    if (e.button !== undefined && e.button !== 0) return;
    const card = e.target.closest('.ucard');
    if (!card) return;
    if (!e.target.closest('#arena')) return;
    const shopCard = card.closest('[data-shop]');
    let from, uid = null, op = null, shopIdx = null, unit = null;
    if (shopCard) {
      from = 'shop'; shopIdx = parseInt(shopCard.dataset.shop, 10); op = G.shop[shopIdx];
      if (!op) return;
    } else {
      from = card.dataset.where; uid = parseInt(card.dataset.uid, 10); unit = findUnit(uid);
      if (!unit) return;
    }
    drag = { active: false, from, uid, op, shopIdx, unit, startX: e.clientX, startY: e.clientY, ghost: null };
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    e.preventDefault();
  }

  function onPointerMove(e) {
    if (!drag) return;
    const dx = e.clientX - drag.startX, dy = e.clientY - drag.startY;
    if (!drag.active) {
      if (Math.hypot(dx, dy) < 6) return;
      drag.active = true;
      const card = drag.from === 'shop'
        ? document.querySelector('.ucard[data-shop="' + drag.shopIdx + '"]')
        : document.querySelector('.ucard[data-uid="' + drag.uid + '"][data-where="' + drag.from + '"]');
      if (card) { card.classList.add('dragging'); drag.ghost = createGhost(card); }
    }
    if (drag.ghost) {
      drag.ghost.style.left = (e.clientX - 39) + 'px';
      drag.ghost.style.top = (e.clientY - 46) + 'px';
    }
    markHover(e.clientX, e.clientY);
  }

  function onPointerUp(e) {
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', onPointerUp);
    if (!drag) return;
    const d = drag; drag = null;
    clearHover();
    if (d.ghost) { d.ghost.remove(); d.ghost = null; }
    document.querySelectorAll('.ucard.dragging').forEach(c => c.classList.remove('dragging'));

    if (!d.active) {
      if (d.from !== 'shop' && d.uid != null) { clickSuppress = true; selectUnit(d.uid); }
      return;
    }
    clickSuppress = true;
    const tgt = pickTarget(e.clientX, e.clientY);
    if (tgt && tgt.type === 'cell') dropOnCell(d, tgt.idx);
    else if (tgt && tgt.type === 'bench') dropOnBench(d);
    else if (tgt && tgt.type === 'sell' && d.uid != null) sellUnit(d.uid);
    renderAll();
  }

  function dropOnCell(d, idx) {
    if (idx >= boardCap()) { flash('人口不足（Lv.' + boardCap() + '），升人口解锁更多格子'); return; }
    const occU = G.board[idx];
    const boardCount = Object.keys(G.board).length;

    if (d.from === 'shop') {
      const op = d.op, c = effCost(op);
      if (G.gold < c) { flash('金币不足'); return; }
      if (occU) {
        if (G.bench.length >= BENCH_CAP) { flash('备战席已满'); return; }
        const old = occU;
        G.board[idx] = { uid: uidc++, op, star: 1 };
        G.bench.push(old);
        G.shop[d.shopIdx] = null; G.gold -= c;
      } else {
        if (boardCount >= boardCap()) { flash('人口已满（Lv.' + boardCap() + '）'); return; }
        G.board[idx] = { uid: uidc++, op, star: 1 };
        G.shop[d.shopIdx] = null; G.gold -= c;
      }
    } else if (d.from === 'bench') {
      const u = d.unit;
      if (occU) {
        if (G.bench.length >= BENCH_CAP) { flash('备战席已满'); return; }
        const old = occU;
        delete G.board[idx];
        G.board[idx] = { uid: u.uid, op: u.op, star: u.star };
        G.bench = G.bench.filter(x => x.uid !== u.uid);
        G.bench.push(old);
      } else {
        if (boardCount >= boardCap()) { flash('人口已满（Lv.' + boardCap() + '）'); return; }
        G.bench = G.bench.filter(x => x.uid !== u.uid);
        G.board[idx] = { uid: u.uid, op: u.op, star: u.star };
      }
    } else { // from board
      const u = d.unit;
      const srcIdx = slotOf(u.uid);
      if (srcIdx === idx) return;
      if (occU) {
        // 交换：把拖动的 u 放到目标格，目标 o 移到源格（修复：原逻辑漏写 G.board[idx]=u 导致卡片消失）
        const o = G.board[idx];
        G.board[idx] = { uid: u.uid, op: u.op, star: u.star };
        G.board[srcIdx] = o;
      } else {
        delete G.board[srcIdx];
        G.board[idx] = { uid: u.uid, op: u.op, star: u.star };
      }
    }
    tryCombine();
  }

  function dropOnBench(d) {
    if (d.from === 'shop') { buy(d.shopIdx); return; }
    if (d.from === 'board') {
      const u = d.unit;
      const k = slotOf(u.uid);
      if (k == null) return;
      if (G.bench.length >= BENCH_CAP) { flash('备战席已满'); return; }
      delete G.board[k];
      G.bench.push({ uid: u.uid, op: u.op, star: u.star });
    }
    // bench -> bench 无操作
  }

  /* ---- 事件绑定 ---- */
  function bind() {
    document.body.addEventListener('click', e => {
      if (clickSuppress) { clickSuppress = false; return; }
      // 键盘/点击上场：已选中单位时，点棋盘格 / 备战席 / 售出区进行部署（照顾无法拖拽的用户）
      if (G.selected != null) {
        const u = findUnit(G.selected);
        const cell = e.target.closest('.board-cell');
        if (cell && !cell.classList.contains('locked')) {
          if (u) { const from = G.bench.some(x => x.uid === u.uid) ? 'bench' : 'board';
            dropOnCell({ from, uid: u.uid, unit: u, op: u.op, shopIdx: null }, parseInt(cell.dataset.slot, 10)); }
          G.selected = null; renderAll(); return;
        }
        if (e.target.closest('#bench')) { if (u) dropOnBench({ from: G.bench.some(x => x.uid === u.uid) ? 'bench' : 'board', uid: u.uid, unit: u, op: u.op }); G.selected = null; renderAll(); return; }
        if (e.target.closest('#sellZone')) { sellUnit(G.selected); G.selected = null; renderAll(); return; }
        // 点击已选单位本身或空白处：取消选择
        if (e.target.closest('.ucard[data-uid="' + G.selected + '"]') || !e.target.closest('.ucard')) { selectUnit(G.selected); return; }
      }
      const sc = e.target.closest('[data-shop]');
      if (sc) { const i = parseInt(sc.dataset.shop, 10); buy(i); return; }
      const uc = e.target.closest('.ucard[data-uid]');
      if (uc) { selectUnit(parseInt(uc.dataset.uid, 10)); return; }
    });
    document.body.addEventListener('keydown', e => {
      if (e.key === 'Escape' && G.selected != null) { selectUnit(G.selected); return; }
      if ((e.key === 'Enter' || e.key === ' ') && G.selected != null) {
        const cell = e.target.closest && e.target.closest('.board-cell');
        if (cell && !cell.classList.contains('locked')) {
          e.preventDefault();
          const u = findUnit(G.selected);
          if (u) { const from = G.bench.some(x => x.uid === u.uid) ? 'bench' : 'board';
            dropOnCell({ from, uid: u.uid, unit: u, op: u.op, shopIdx: null }, parseInt(cell.dataset.slot, 10)); }
          G.selected = null; renderAll();
        }
      }
    });
    document.body.addEventListener('pointerdown', onPointerDown);
    $('btnRefresh').onclick = refresh;
    $('btnExp').onclick = buyExp;
    $('btnFight').onclick = onFight;
    $('btnSkip').onclick = () => { if (G._skip) G._skip(); };
    $('ubSell').onclick = sell;
    // 新游戏：清除存档并进入难度选择（始终可用，不依赖是否存在存档）
    $('btnNew').onclick = () => { clearSave(); $('startScreen').classList.add('hidden'); reset(); };
    $('bondModalClose').onclick = () => $('bondModal').classList.add('hidden');
    $('bondModal').addEventListener('click', e => { if (e.target === $('bondModal')) $('bondModal').classList.add('hidden'); });
    const sfxBtn = $('sfxBtn');
    if (sfxBtn) sfxBtn.onclick = () => {
      const m = (window.SFX && window.SFX.toggle()) || false;
      sfxBtn.textContent = m ? '🔇' : '🔊';
      sfxBtn.classList.toggle('muted', m);
    };
  }

  /* ---- 存档系统（本地进度续档） ---- */
  const SAVE_KEY = 'rh_chess_save';
  const NODE_ICON = { reward: '🎁', battle: '⚔', elite: '★', boss: '👑', strategy: '💡', encounter: '⚡' };
  const NODE_LABEL = { reward: '补给节点', battle: '普通战', elite: '精英战', boss: 'BOSS 战', strategy: '策略节点', encounter: '遭遇节点' };

  function saveGame() {
    try {
      const sv = {
        v: 1, ts: Date.now(),
        nodeIdx: G.nodeIdx, gold: G.gold, level: G.level, exp: G.exp,
        hp: G.hp, maxHp: G.maxHp, winStreak: G.winStreak, lossStreak: G.lossStreak,
        env: G.env ? G.env.id : null, phase: G.phase,
        bench: G.bench.map(u => ({ uid: u.uid, op: u.op.id, star: u.star })),
        board: Object.fromEntries(Object.entries(G.board).map(([k, u]) => [k, { uid: u.uid, op: u.op.id, star: u.star }])),
        shop: G.shop.map(o => o ? o.id : null),
        currentEnemy: (G.currentEnemy || []).map(t => ({ op: t.op.id, star: t.star })),
        selected: G.selected, result: G._result || null,
      };
      localStorage.setItem(SAVE_KEY, JSON.stringify(sv));
    } catch (e) { /* 隐私模式等存储异常，忽略 */ }
  }

  function loadSave() {
    try {
      const raw = localStorage.getItem(SAVE_KEY);
      if (!raw) return null;
      const sv = JSON.parse(raw);
      if (!sv || typeof sv.nodeIdx !== 'number') return null;
      return sv;
    } catch (e) { return null; }
  }

  function clearSave() { try { localStorage.removeItem(SAVE_KEY); } catch (e) {} }

  function loadGame(sv) {
    const byId = id => DATA.operators.find(o => o.id === id);
    G.gold = sv.gold; G.level = sv.level; G.exp = sv.exp;
    G.hp = sv.hp; G.maxHp = sv.maxHp;
    G.winStreak = sv.winStreak; G.lossStreak = sv.lossStreak;
    G.nodeIdx = sv.nodeIdx;
    G.env = sv.env ? ENV_POOL.find(e => e.id === sv.env) : null;
    G.phase = sv.phase;
    G.bench = (sv.bench || []).map(u => ({ uid: u.uid, op: byId(u.op), star: u.star })).filter(u => u.op);
    G.board = {};
    Object.entries(sv.board || {}).forEach(([k, u]) => { const op = byId(u.op); if (op) G.board[k] = { uid: u.uid, op, star: u.star }; });
    G.shop = (sv.shop || []).map(id => id ? byId(id) : null);
    G.currentEnemy = (sv.currentEnemy || []).map(t => ({ op: byId(t.op), star: t.star })).filter(t => t.op);
    G.selected = sv.selected || null;
    G._result = sv.result || null;
    if (G.phase === 'result' && G._result) {
      $('envScreen').classList.add('hidden');
      $('arena').classList.add('hidden');
      $('battleScreen').classList.add('hidden');
      showResultFromSave();
    } else {
      $('envScreen').classList.add('hidden');
      $('battleScreen').classList.add('hidden');
      $('resultScreen').classList.add('hidden');
      $('arena').classList.remove('hidden');
      if (window.AUDIO) AUDIO.setMusic('shop');
      renderAll();
    }
    renderNodeFlow();
  }

  function showResultFromSave() {
    const r = G._result;
    $('resultTitle').textContent = r.title;
    $('resultBody').textContent = r.body;
    $('btnResult').textContent = r.btn;
    $('resultScreen').classList.remove('hidden');
    $('btnResult').onclick = (r.kind === 'reset') ? reset : nextNode;
  }

  function showStartScreen(sv) {
    const node = G.nodes[sv.nodeIdx];
    const envName = sv.env ? ((ENV_POOL.find(e => e.id === sv.env) || {}).name || '未选择') : '未选择';
    $('startInfo').innerHTML = '检测到存档：进度 <b>节点 ' + (sv.nodeIdx + 1) + ' / ' + G.nodes.length +
      '</b>（' + (NODE_LABEL[node.type] || node.type) + '）　·　环境：' + envName +
      '　·　Lv.' + sv.level + '　·　生命 ' + Math.max(0, sv.hp);
    $('btnContinue').onclick = () => { $('startScreen').classList.add('hidden'); loadGame(sv); };
    $('startScreen').classList.remove('hidden');
    if (window.AUDIO) AUDIO.setMusic('exploration');
    renderNodeFlow(); // 此时 G.env 为空，内部会自动隐藏
  }

  function renderNodeFlow() {
    const el = $('nodeFlow');
    if (!el) return;
    if (!G.env) { el.classList.add('hidden'); return; }
    el.classList.remove('hidden');
    const nodes = G.nodes, cur = G.nodeIdx;
    const curNode = nodes[cur];
    if (!curNode) return;
    const curPhase = curNode.phase || 1;
    // 只显示当前阶段的 9 个节点；进入下一阶段时自动切到下一阶段的节点
    const phaseNodes = nodes.filter(n => (n.phase || 1) === curPhase);
    let html = '<div class="nf-head">阶段 ' + curPhase + ' / 3　·　本阶段 ' + phaseNodes.length + ' 节点（共 ' + nodes.length + ' 节点）</div>';
    html += '<div class="nf-track">';
    phaseNodes.forEach((n, pIdx) => {
      const gi = nodes.indexOf(n);
      let cls = 'nf-node';
      if (gi < cur) cls += ' done';
      else if (gi === cur) cls += ' current';
      else cls += ' upcoming';
      html += '<div class="' + cls + '"><span class="nf-ico">' + NODE_ICON[n.type] + '</span>' +
        '<span class="nf-num">' + (pIdx + 1) + '</span><span class="nf-tag">' + NODE_LABEL[n.type] + '</span></div>';
      if (pIdx < phaseNodes.length - 1) html += '<span class="nf-link ' + (gi < cur ? 'passed' : '') + '"></span>';
    });
