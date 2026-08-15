/* 罗德岛棋局 · 货币战争 — 自走棋核心逻辑 + 控制器（3×3 部署格 / 拖拽上下场 / 站位战斗） */
(function (global) {
  'use strict';

  // 提前声明游戏状态对象，避免 computeBonds/aggregateStrategies 等纯逻辑函数在 G 初始化前
  // 访问 G 触发 TDZ（Cannot access 'G' before initialization）。TDZ 期内 G 为 null，
  // 相关读取均做了 typeof/空值保护；浏览器初始化阶段会在下方重新赋值。
  let G = null;

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
  // v3.0 阵营行为模板：4 类型组（heal/defense/attack/support），3/5 阶行为（7+ 走 SPECIAL.deep 觉醒）
  // 全部复用现成 kw 家族，零新引擎；数值 [PLACEHOLDER] 待 balance_sim 标定
  const FAC_BEHAVIOR_TMPL = {
    // v3.0 标定（balance_sim 500局）：行为单独贡献 ≈50% 无感 → 回调至微感带（52-60%）；数值 [PLACEHOLDER] 待终标
    heal:    { 3: [{ kw: 'healAura', params: { regen: 0.03 } }], 5: [{ kw: 'healCrit', params: { pct: 0.35 } }] },
    defense: { 3: [{ kw: 'shieldPeriodic', params: { frac: 0.08, period: 5 } }], 5: [{ kw: 'counter', params: { value: 0.10 } }] },
    attack:  { 3: [{ kw: 'critDmg', params: { value: 1.40 } }], 5: [{ kw: 'splash', params: { pct: 0.20 } }] },
    support: { 3: [{ kw: 'spRegenBuff', params: { value: 0.30 } }], 5: [{ kw: 'goldOnKill', params: { amount: 1 } }] },
  };
  const BONDS = {
    '职业': {
      // v2.5 M3：职业羁绊 2/4/6/8/10 五阶。6 阶起 behavior（复用现成 kw 家族，零新引擎）；
      // 8 阶双行为 / 10 阶专属大招。数值与 kw 参数全 [PLACEHOLDER] 待标定。
      '先锋': { thr: [2, 4, 6, 8, 10], spInit: [4, 8, 12, 16, 20], spRegen: [0.15, 0.30, 0.50, 0.70, 0.95],
                behavior: { 6: [{ kw: 'spRegenBuff', params: { value: 0.25 } }], 8: [{ kw: 'goldOnKill', params: { amount: 1 } }], 10: [{ kw: 'globalAspd', params: { value: 0.15 } }] } }, // 技力流：起手技力+回复 → 击杀回费 → 全场提速
      '近卫': { thr: [2, 4, 6, 8, 10], atk: [0.10, 0.20, 0.32, 0.44, 0.56], aspd: [0.08, 0.16, 0.26, 0.36, 0.46],
                behavior: { 6: [{ kw: 'berzerk', params: { thresh: 0.30, atkPct: 0.20, leech: 0.10 } }], 8: [{ kw: 'rampHit', params: { per: 0.02, cap: 0.20 } }], 10: [{ kw: 'lifesteal', params: { pct: 0.15 } }, { kw: 'counter', params: { pct: 0.10 } }] } }, // 斗士：攻+速 → 低血狂暴 → 越战越勇 → 吸血反伤
      '重装': { thr: [2, 4, 6, 8, 10], def: [0.10, 0.20, 0.32, 0.44, 0.56], hp: [0.08, 0.16, 0.26, 0.36, 0.46],
                behavior: { 6: [{ kw: 'guardAura', params: { value: 0.06 } }], 8: [{ kw: 'shieldPeriodic', params: { frac: 0.08, period: 5 } }], 10: [{ kw: 'counter', params: { value: 0.15 } }, { kw: 'damageReduction', params: { value: 0.10 } }] } }, // 壁垒：防+血 → 协防 → 周期盾 → 反伤减伤
      '狙击': { thr: [2, 4, 6, 8, 10], atk: [0.10, 0.20, 0.32, 0.44, 0.56], crit: [0.08, 0.15, 0.24, 0.33, 0.42],
                behavior: { 6: [{ kw: 'splash', params: { pct: 0.30 } }], 8: [{ kw: 'pierce', params: { value: 0.20 } }, { kw: 'execute', params: { thresh: 0.30, mult: 0.50 } }], 10: [{ kw: 'globalAspd', params: { value: 0.12 } }, { kw: 'splash', params: { pct: 0.50 } }] } }, // 狙击：攻+暴 → 溅射 → 破甲处决 → 弹幕齐射
      '术师': { thr: [2, 4, 6, 8, 10], magicAmp: [0.10, 0.20, 0.32, 0.44, 0.56], spInit: [4, 8, 12, 16, 20],
                behavior: { 6: [{ kw: 'castAmp', params: { aspd: 0.15, amp: 0.15, dur: 3 } }], 8: [{ kw: 'overload', params: { value: 0.30, period: 6, dur: 3 } }], 10: [{ kw: 'trueDmg', params: { value: 0.15 } }, { kw: 'defShred', params: { value: 0.15 } }] } }, // 术法：法伤+起手 → 咏唱强化 → 周期法爆 → 真伤破甲
      '医疗': { thr: [2, 4, 6, 8, 10], healAmp: [0.10, 0.20, 0.32, 0.44, 0.56], hp: [0.08, 0.16, 0.26, 0.36, 0.46], magicAmp: [0.05, 0.10, 0.15, 0.20, 0.25],
                behavior: { 6: [{ kw: 'healAura', params: { regen: 0.02 } }], 8: [{ kw: 'healCrit', params: { pct: 0.25 } }], 10: [{ kw: 'triage', params: { revivePct: 0.30, charges: 1 } }] } }, // 急救：疗+血 → 治疗光环 → 治疗暴击 → 不抛下任何人
      '辅助': { thr: [2, 4, 6, 8, 10], aspd: [0.10, 0.20, 0.32, 0.44, 0.56], def: [0.08, 0.16, 0.26, 0.36, 0.46], atk: [0.06, 0.12, 0.20, 0.28, 0.36],
                behavior: { 6: [{ kw: 'slowAura', params: { value: 0.15 } }], 8: [{ kw: 'trueDmg', params: { value: 0.10 } }], 10: [{ kw: 'castAmp', params: { aspd: 0.20, amp: 0.20, dur: 3 } }, { kw: 'slowAura', params: { value: 0.25 } }] } }, // 控场：速+防+攻 → 减速光环 → 真伤 → 咏唱+强减速
      '特种': { thr: [2, 4, 6, 8, 10], aspd: [0.10, 0.20, 0.32, 0.44, 0.56], crit: [0.08, 0.15, 0.24, 0.33, 0.42],
                behavior: { 6: [{ kw: 'quickStart', params: { aspd: 0.30 } }], 8: [{ kw: 'execute', params: { thresh: 0.35, mult: 0.60 } }], 10: [{ kw: 'splash', params: { pct: 0.40 } }, { kw: 'lifesteal', params: { pct: 0.15 } }] } }, // 奇袭：速+暴 → 开局爆发 → 处决 → 溅射吸血
    },
    // 阵营轴：B 任务「势力主题化」——每个势力独立效果包，反映其 AK 身份。
    // 键名必须与 data.json 的 bonds['阵营'] 一致（已合并同类项：罗德岛-精英干员→罗德岛、炎-岁/炎-龙门→炎、龙门近卫局→龙门…）。
    // 未在下方列出 / 卡池<4 的势力自动套用 __default__（通用攻/血），避免死内容。
    // 阈值统一 [2,3,5]（阶1/2/3）。注意：阵营羁绊与职业羁绊对同一干员【叠加】生效。
    '阵营': {
      '__default__': { thr: [2, 3, 5], atk: [0.08, 0.16, 0.26], hp: [0.06, 0.12, 0.20] },   // 长尾小势力兜底：通用攻/血
      // —— 阵营多阶（2026-08-12）：仅 Epic(pool≥9)/Large(7≤pool≤8) 拉长 thr 与属性数组；前 3 阶数值不变，零回归 ——
      // 顶点阶：Epic=[2,3,5,7,9,10]（满盘单阵营 mono + 扩编 10 人觉醒），Large=[2,3,5,7,8]（8 人觉醒技）。
      // v2.5 M4：扩编令解锁第 10 格后，Epic 阵营 10 人触发觉醒技（tierN=6）；Large 8 人触发（tierN=5）。
      '罗德岛':     { thr: [2, 3, 5, 7, 9, 10], healAmp: [0.08, 0.16, 0.26, 0.34, 0.42, 0.48], hp: [0.06, 0.12, 0.20, 0.26, 0.32, 0.36], behavior: FAC_BEHAVIOR_TMPL.heal }, // 医疗理念：治疗量 + 生存（已含精英干员）
      '炎':         { thr: [2, 3, 5, 7, 9, 10], hp: [0.05, 0.10, 0.15, 0.20, 0.25, 0.28], def: [0.03, 0.06, 0.09, 0.12, 0.15, 0.17], behavior: FAC_BEHAVIOR_TMPL.defense },     // 岁兽/炎国：生命 + 防御（已含炎-岁/炎-龙门）— 二次削弱（原 100% 超模）
      '维多利亚':   { thr: [2, 3, 5, 7, 8], atk: [0.08, 0.16, 0.26, 0.34, 0.40], def: [0.06, 0.12, 0.20, 0.26, 0.30], behavior: FAC_BEHAVIOR_TMPL.attack }, // 骑士王国：攻防兼备（深度阶 +攻防 → 8 人觉醒）
      '莱茵生命':   { thr: [2, 3, 5, 7, 8], magicAmp: [0.08, 0.16, 0.26, 0.34, 0.40], spInit: [3, 6, 10, 14, 18], behavior: FAC_BEHAVIOR_TMPL.support }, // 科研机构：术法 + 起手技力（深度阶 +术法/技力 → 8 人觉醒）
      '叙拉古':     { thr: [2, 3, 5, 7, 8], crit: [0.06, 0.12, 0.20, 0.26, 0.32], aspd: [0.06, 0.12, 0.20, 0.26, 0.32], behavior: FAC_BEHAVIOR_TMPL.attack }, // 黑帮：暴击 + 攻速（深度阶 +暴击/攻速 → 8 人觉醒）
      '拉特兰':     { thr: [2, 3, 5, 7, 8], atk: [0.08, 0.16, 0.26, 0.34, 0.40], crit: [0.10, 0.20, 0.32, 0.42, 0.50], behavior: FAC_BEHAVIOR_TMPL.attack }, // 枪之城：攻击 + 暴击（深度阶 +攻击/暴击 → 8 人觉醒）
      '莱塔尼亚':   { thr: [2, 3, 5, 7, 8], magicAmp: [0.08, 0.16, 0.26, 0.34, 0.40], spInit: [3, 6, 10, 14, 18], behavior: FAC_BEHAVIOR_TMPL.support },    // 源石技艺帝国：术法 + 起手技力（v3.0 扩 Large：8 人觉醒技）
      '萨尔贡':     { thr: [2, 3, 5], atk: [0.10, 0.20, 0.32], hp: [0.06, 0.12, 0.20], behavior: FAC_BEHAVIOR_TMPL.attack },      // 荒野战士：攻击 + 生命（攻击档位上调）
      '龙门':       { thr: [2, 3, 5], atk: [0.08, 0.16, 0.26], def: [0.06, 0.12, 0.20], behavior: FAC_BEHAVIOR_TMPL.defense },     // 近卫局：攻击 + 防御（已含龙门近卫局）
      '企鹅物流':   { thr: [2, 3, 5], spInit: [3, 6, 10], spRegen: [0.12, 0.24, 0.40], behavior: FAC_BEHAVIOR_TMPL.support },       // 物流速度：起手技力 + 技力回复
      '巴别塔':     { thr: [2, 3, 5], hp: [0.08, 0.16, 0.26], def: [0.06, 0.12, 0.20], behavior: FAC_BEHAVIOR_TMPL.defense },      // 起源：生存向
      '谢拉格':     { thr: [2, 3, 5], hp: [0.08, 0.16, 0.26], def: [0.06, 0.12, 0.20], behavior: FAC_BEHAVIOR_TMPL.defense },      // 雪境信仰：生命 + 防御
      '深海猎人':   { thr: [2, 3, 5], atk: [0.08, 0.16, 0.26], hp: [0.06, 0.12, 0.20], behavior: FAC_BEHAVIOR_TMPL.attack },      // 猎杀者：攻击 + 生命
      '乌萨斯':     { thr: [2, 3, 5], atk: [0.08, 0.16, 0.26], def: [0.06, 0.12, 0.20], behavior: FAC_BEHAVIOR_TMPL.defense },     // 寒冬帝国：攻击 + 防御
      '伊比利亚':   { thr: [2, 3, 5], magicAmp: [0.08, 0.16, 0.26], hp: [0.06, 0.12, 0.20], behavior: FAC_BEHAVIOR_TMPL.support },  // 深海外交：术法 + 生命
      '卡兹戴尔':   { thr: [2, 3, 5], def: [0.08, 0.16, 0.26], hp: [0.06, 0.12, 0.20], behavior: FAC_BEHAVIOR_TMPL.defense },      // 萨卡兹故土：防御 + 生存（池=2，泥岩+赫德雷）
      // —— v3.0 显式化：原走 __default__ 的 8 个小阵营，补专属数值 + 组模板 behavior（24 阵营全配置闭环）——
      '东':         { thr: [2, 3, 5], aspd: [0.08, 0.16, 0.26], crit: [0.06, 0.12, 0.20], behavior: FAC_BEHAVIOR_TMPL.attack },  // 心流：攻速 + 暴击（池=3）
      '哥伦比亚':   { thr: [2, 3, 5], atk: [0.10, 0.20, 0.32], crit: [0.08, 0.16, 0.26], behavior: FAC_BEHAVIOR_TMPL.attack },  // 军火：攻击 + 暴击（池=3）
      '卡西米尔':   { thr: [2, 3, 5], atk: [0.08, 0.16, 0.26], hp: [0.06, 0.12, 0.20], behavior: FAC_BEHAVIOR_TMPL.attack },    // 骑士团：攻击 + 生命（池=3）
      '喀兰贸易':   { thr: [2, 3, 5], atk: [0.08, 0.16, 0.26], spInit: [3, 6, 10], behavior: FAC_BEHAVIOR_TMPL.attack },       // 雇佣：攻击 + 起手技力（池=3）
      '雷姆必拓':   { thr: [2, 3, 5], def: [0.08, 0.16, 0.26], hp: [0.06, 0.12, 0.20], behavior: FAC_BEHAVIOR_TMPL.defense },  // 矿脉护体：防御 + 生命（池=2）
      '塔拉':       { thr: [2, 3, 5], aspd: [0.08, 0.16, 0.26], hp: [0.06, 0.12, 0.20], behavior: FAC_BEHAVIOR_TMPL.attack },  // 战歌：攻速 + 生命（池=2）
      '使徒':       { thr: [2, 3, 5], hp: [0.08, 0.16, 0.26], def: [0.06, 0.12, 0.20], behavior: FAC_BEHAVIOR_TMPL.defense },  // 神恩：生命 + 防御（池=2）
      '鲤氏侦探事务所': { thr: [2, 3, 5], crit: [0.08, 0.16, 0.26], atk: [0.06, 0.12, 0.20], behavior: FAC_BEHAVIOR_TMPL.attack }, // 洞察：暴击 + 攻击（池=2）
    },
  };

  // 默认（无羁绊）乘数
  const DEF_MULT = { atk: 1, hp: 1, def: 1, aspd: 1, crit: 0, magicAmp: 1, healAmp: 1, spInit: 0, spRegen: 1 };
  // 星级战斗力乘数（1★/2★/3★）
  const STAR_MULT = { 1: 1, 2: 1.8, 3: 3.2 };
  // P1-1：羁绊乘法叠乘软上限（[PLACEHOLDER · 数值需镜像对局 Monte Carlo 标定]）。
  // 压制满配三星签名核心的乘区爆炸（原可叠到 5–8×），保留 build 表达但杜绝一击秒杀。
  const MAX_ATK_MULT = 6.5, MAX_HP_MULT = 6.5;
  // v2.5 标定：攻速软上限（与 MAX_ATK_MULT 同哲学，P1 已验证）。
  // 攻速在模型里是最高效属性（dps 线性 + 快攒技力），叠乘无上限会制造「全员攻速」无解（标定 5v5 全员 100%）。
  // 上限约束总乘数（含职业羁绊/签名/装备），开局光环在软上限之后仍可叠加但不再无限。[PLACEHOLDER 待精标定]
  const MAX_ASPD_MULT = 2.5;

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
    // —— 阵营多阶：deep 深度阶（仅 Epic/Large；Standard 无 deep → 行为零回归）——
    // 结构：deep:{ [tierN]: { label, attr?, kws:[{kw,params},...] } }。computeBonds 仅在存在 deep[tierN] 时注入
    //   （Epic tierN=4↔7人 / 5↔9人；Large tierN=4↔7人；Standard 无 deep → 永不注入 → 字节级零回归）。
    // 与基础 SPECIAL.kw 同名 → 覆盖参数（进化）；异名 → 追加 capstone 行为。数值全 [PLACEHOLDER]。
    '罗德岛':   { tier: 3, kw: 'healAura',        params: { regen: 0.03 },
                  deep: { 4: { label: '战地医疗网', kws: [{ kw: 'healAura', params: { regen: 0.045 } }] },
                          5: { label: '不抛下任何人', kws: [{ kw: 'triage', params: { revivePct: 0.30, charges: 1 } }] },
                          6: { label: '生命方舟·觉醒', attr: { healAmp: 0.06 }, kws: [{ kw: 'healAura', params: { regen: 0.06 } }, { kw: 'triage', params: { revivePct: 0.40, charges: 1 } }] } } }, // 急救协议：低血回血 → 深度进化治疗 / 阵亡复活 → 10 人觉醒：全队治疗翻倍+强复活
    '炎':       { tier: 3, kw: 'burnDoT',         params: { dps: 0.025, dur: 3 },
                  deep: { 4: { label: '炽魂蔓延', kws: [{ kw: 'burnDoT', params: { dps: 0.040, dur: 4, spread: true } }] },
                          5: { label: '岁兽觉醒', kws: [{ kw: 'infernoRally', params: { value: 0.15 } }] },
                          6: { label: '燎原·觉醒', attr: { atk: 0.06 }, kws: [{ kw: 'burnDoT', params: { dps: 0.055, dur: 5, spread: true } }, { kw: 'infernoRally', params: { value: 0.25 } }] } } }, // 炽魂：灼烧 → 溅射 / 攻强光环 → 10 人觉醒：全屏灼烧+攻强爆发
    '维多利亚': { tier: 3, kw: 'pierce',          params: { value: 0.15 },
                  deep: { 4: { label: '方阵穿透 + 骑士旗帜', attr: { atk: 0.05 }, kws: [
                    { kw: 'pierce', params: { value: 0.28 } },                 // 进化：破甲强化且普攻生效
                    { kw: 'knightBanner', params: { base: 0.08, per: 0.02 } } // capstone：全队攻光环·随人数缩放
                  ] },
                          5: { label: '骑士王座·觉醒', attr: { def: 0.06 }, kws: [
                    { kw: 'knightBanner', params: { base: 0.12, per: 0.03 } }, // 觉醒：旗帜光环大幅强化
                    { kw: 'guardAura', params: { value: 0.08 } }               // 觉醒：全体协防
                  ] } } },                                                                          // 破阵：破甲（Large 8 人觉醒技）
    '莱茵生命': { tier: 3, kw: 'spRegenBuff',     params: { value: 0.30 },
                  deep: { 4: { label: '源石技艺链接 + 过载协议', kws: [
                    { kw: 'castAmp', params: { aspd: 0.20, amp: 0.22, dur: 3 } }, // 进化：咏唱强化
                    { kw: 'overload', params: { value: 0.30, period: 6, dur: 3 } } // capstone：周期法强爆发
                  ] },
                          5: { label: '过载协议·觉醒', attr: { magicAmp: 0.08 }, kws: [
                    { kw: 'castAmp', params: { aspd: 0.30, amp: 0.35, dur: 4 } },  // 觉醒：咏唱大幅强化
                    { kw: 'overload', params: { value: 0.45, period: 4, dur: 4 } } // 觉醒：法爆更频更强
                  ] } } },                                                                          // 源石技艺增幅（Large 8 人觉醒技）
    '叙拉古':   { tier: 2, kw: 'summonWolf',      params: { t2: 1, t3: 2 },
                  deep: { 4: { label: '狼群扩张 + 教父', attr: { crit: 0.05 }, kws: [
                    { kw: 'summonWolf', params: { t2: 1, t3: 2, t4: 3 } },      // 进化：7 人出 3 狼
                    { kw: 'capo', params: { aspd: 0.20 } }                      // capstone：狼群攻速光环
                  ] },
                          5: { label: '狼主降临·觉醒', attr: { crit: 0.10 }, kws: [
                    { kw: 'summonWolf', params: { t2: 1, t3: 2, t4: 3, t5: 5 } }, // 觉醒：8 人出 5 狼
                    { kw: 'capo', params: { aspd: 0.35 } },                      // 觉醒：狼群狂攻速
                    { kw: 'globalAspd', params: { value: 0.10 } }                // 觉醒：全队提速
                  ] } } },                                                                          // 养狼（阶段3 → Large 8 人觉醒技）
    '拉特兰':   { tier: 2, kw: 'critDmg',         params: { value: 1.00 },
                  deep: { 4: { label: '标记射击 + 弹幕风暴', kws: [
                    { kw: 'critDmg', params: { value: 1.40 } },                 // 进化：暴伤强化 + 技能必暴
                    { kw: 'barrage', params: { hits: 3, spread: 0.6 } }         // capstone：多段普攻
                  ] },
                          5: { label: '圣城审判·觉醒', attr: { crit: 0.10 }, kws: [
                    { kw: 'critDmg', params: { value: 1.80 } },                 // 觉醒：暴伤爆炸
                    { kw: 'barrage', params: { hits: 5, spread: 0.8 } },        // 觉醒：弹幕风暴全覆盖
                    { kw: 'execute', params: { thresh: 0.35, mult: 0.60 } }     // 觉醒：圣城处决
                  ] } } },                                                                          // 弹幕覆盖：暴伤（阶二解锁 + 数值上调 → Large 8 人觉醒技）
    '莱塔尼亚': { tier: 3, kw: 'castAmp',         params: { aspd: 0.15, amp: 0.15, dur: 3 },
                  deep: { 4: { label: '帝国回响', kws: [
                    { kw: 'castAmp', params: { aspd: 0.25, amp: 0.25, dur: 3 } }               // 深度阶：咏唱强化
                  ] },
                          5: { label: '黄金之城·觉醒', attr: { magicAmp: 0.10 }, kws: [
                    { kw: 'castAmp', params: { aspd: 0.30, amp: 0.35, dur: 3 } },              // 觉醒：咏唱爆炸
                    { kw: 'overload', params: { value: 0.35, period: 6, dur: 3 } }             // 觉醒：周期法爆
                  ] } } },                                                                      // 咏唱：施法后强化（v3.0 扩 Large：8 人觉醒技）
    '萨尔贡':   { tier: 2, kw: 'execute',         params: { thresh: 0.30, mult: 0.80 } },                     // 蛮力：处决（阶二解锁 + 数值上调）
    '龙门':     { tier: 3, kw: 'guardAura',       params: { value: 0.10 } },                                  // 协防：相邻减伤
    '企鹅物流': { tier: 3, kw: 'globalAspd',      params: { value: 0.10 } },                                  // 极速配送：全局攻速
    // —— 池=4 → 阶二 capstone ——
    '巴别塔':   { tier: 2, attr: { def: 0.12 }, kw: 'guardAura',      params: { value: 0.06 } },                // 传承：防御 + 协防减伤（v2.4 质变层）
    '谢拉格':   { tier: 2, kw: 'shieldPeriodic',  params: { frac: 0.10, period: 5 } },                         // 霜护：周期护盾
    '深海猎人': { tier: 2, kw: 'pierce',          params: { value: 0.25 } },                                  // 数值压制：破甲
    '乌萨斯':   { tier: 2, kw: 'slowAura',        params: { value: 0.20 } },                                  // 严冬：敌减速
    '伊比利亚': { tier: 2, attr: { magicAmp: 0.15 }, kw: 'defShred', params: { value: 0.10 } },               // 潮汐：法伤+破甲
    // —— 池=3 → 阶二 capstone ——
    '东':       { tier: 2, kw: 'rampHit',         params: { per: 0.06, cap: 0.30 } },                         // 心流：攻速成长
    '哥伦比亚': { tier: 2, kw: 'critDmg',         params: { value: 0.30 } },                                  // 军火：暴伤
    '卡西米尔': { tier: 2, kw: 'trueDmg',         params: { value: 0.15 } },                                  // 骑士团：真伤
    '喀兰贸易': { tier: 2, attr: { atk: 0.12 }, kw: 'rampHit', params: { per: 0.04, cap: 0.20 } },            // 雇佣：攻击 + 渐增（v2.4 质变层）
    // —— 池=2 → 阶一 capstone ——
    '雷姆必拓': { tier: 1, kw: 'damageReduction', params: { value: 0.08 } },                                  // 矿脉护体：减伤
    '塔拉':     { tier: 1, attr: { aspd: 0.08 }, kw: 'lifesteal', params: { value: 0.10 } },                  // 战歌：攻速 + 吸血（v2.4 质变层）
    '使徒':     { tier: 1, attr: { hp: 0.10 }, kw: 'shieldPeriodic', params: { frac: 0.06, period: 5 } },     // 神恩：生命 + 周期护盾（v2.4 质变层）
    '鲤氏侦探事务所': { tier: 1, attr: { crit: 0.08 }, kw: 'execute', params: { thresh: 0.25, mult: 0.50 } },// 洞察：暴击 + 处决（v2.4 质变层）
    '卡兹戴尔':       { tier: 1, attr: { def: 0.10 }, kw: 'counter', params: { value: 0.08 } },               // 源石壁垒：防御 + 反伤（v2.4 质变层）
  };

  // ③b 装备系统（v2 · 2026-08-12 用户拍板）：无限制 / 纯属性或纯机制 / 阵营铭刻（装备后视为该阵营，羁绊计数叠加）
  //  type: 'attr' 纯属性（fold 进 makeCombatUnit mult，走 MAX_ATK_MULT/MAX_HP_MULT 软上限）
  //       'mech' 单一机制 kw（独立命名空间 u.equipKw，复用现有字段 counter/revive/lifesteal/pierce）
  //       'engraving' 阵营铭刻（computeBonds 阵营计数叠加 countAsFaction，不替换原阵营）
  //  用户拍板：不做合成 / 无同名限制 / 无全局限量 / 无穿戴等级闸 / 无职业绑定。数值全 [PLACEHOLDER]。
  const EQUIP_POOL = [
    // —— 属性装（attr）——
    { id: 'e_blade',   name: '制式单刃', icon: '🗡', type: 'attr', cat4: 'weapon', rarity: 0, cost: 3, attr: { atk: 0.15 },  desc: '攻击 +15%', flavor: '罗德岛工坊批量维护的制式近战刃，朴素趁手，是近卫干员出任务前最常顺手抓起的那一把。' },        // [PLACEHOLDER]
    { id: 'e_plate',   name: '城防护板', icon: '🛡', type: 'attr', cat4: 'armor',  rarity: 0, cost: 3, attr: { hp: 0.20 },   desc: '生命 +20%', flavor: '拆解自龙门城防模块的标准合金护板，厚重而可靠，足以替使用者挡下多数流弹与冲击。' },        // [PLACEHOLDER]
    { id: 'e_swift',   name: '轻量突击组件', icon: '⚡', type: 'attr', cat4: 'weapon', rarity: 1, cost: 5, attr: { aspd: 0.13 }, desc: '攻速 +13%', flavor: '哥伦比亚量产的外骨骼加速器，轻巧地扣在腕部，让持握者的出手快上半拍。' },        // [PLACEHOLDER] v2.5 标定：20%→13%（攻速超模回调）
    { id: 'e_cuirass', name: '动力装甲板', icon: '🪖', type: 'attr', cat4: 'armor',  rarity: 1, cost: 5, attr: { def: 0.25 },  desc: '防御 +25%', flavor: '承自乌萨斯重工业化武思路的动力骨架装甲，靠液压硬扛每一次重击。' },        // [PLACEHOLDER]
    { id: 'e_serum',   name: '战术兴奋剂', icon: '💉', type: 'attr', cat4: 'device', rarity: 2, cost: 8, attr: { crit: 0.15 }, desc: '暴击率 +15%', flavor: '封装在便携针管里的神经兴奋剂，临战一针，让反应与出手更加凌厉。' },      // [PLACEHOLDER]
    // —— 机制装（mech）——
    { id: 'e_thorn',   name: '荆棘护甲', icon: '🌵', type: 'mech', cat4: 'armor',  rarity: 0, cost: 3, kw: 'counter',     params: { pct: 0.15 },    desc: '受击反弹 15% 伤害', flavor: '表面布满倒刺的改装护甲，攻击者每一次挥击，都会被原样奉还一部分。' },          // 复用 counter
    { id: 'e_fang',    name: '噬血利齿', icon: '🩸', type: 'mech', cat4: 'weapon', rarity: 1, cost: 5, kw: 'lifesteal',   params: { pct: 0.25 },    desc: '攻击吸血 25%', flavor: '刃口刻着源石回路的奇巧兵装，每一次撕裂伤口，都从对手的血液中汲取力量。' },              // 复用 lifesteal
    { id: 'e_regen',   name: '再生力场', icon: '♻️', type: 'mech', cat4: 'armor',  rarity: 1, cost: 5, kw: 'regenShield', params: { period: 5, frac: 0.08 }, desc: '每 5s 生成 8% 生命护盾', flavor: '取自莱塔尼亚源石稳定技术的小型力场发生器，每隔数秒便在体表凝出一层薄盾。' },
    { id: 'e_quick',   name: '疾袭协议', icon: '⏱', type: 'mech', cat4: 'device', rarity: 2, cost: 8, kw: 'quickStart',  params: { aspd: 0.35 },   desc: '战斗前 2s 攻速 +35%', flavor: '战斗初始强制超频的启动协议，让装备者在开局的几秒内快得几乎看不清身影。' },
    { id: 'e_piercer', name: '穿甲弩头', icon: '🏹', type: 'mech', cat4: 'weapon', rarity: 2, cost: 8, kw: 'pierce',      params: { value: 0.15 },  desc: '攻击无视 15% 防御', flavor: '维多利亚军械匠打磨的特种弩头，专门咬穿重甲与源石护壁的薄弱处。' },        // 复用 pierce
    { id: 'e_warfare', name: '战意核心', icon: '🔥', type: 'mech', cat4: 'weapon', rarity: 2, cost: 8, kw: 'berzerk',     params: { thresh: 0.30, atkPct: 0.20, leech: 0.10 }, desc: '血量低于 30% 时伤害 +20% 并吸血 10%', flavor: '萨卡兹佣兵间流传的源石核心，越是濒死，越是点燃使用者骨子里的凶性。' },
    { id: 'e_barrage', name: '弹幕装置', icon: '💥', type: 'mech', cat4: 'device', rarity: 3, cost: 12, kw: 'splash',     params: { pct: 0.40 },    desc: '普攻对相邻敌人溅射 40% 伤害', flavor: '龙门近卫局制式的散射挂件，一次挥击便将冲击甩向周围所有敌人。' },
    { id: 'e_phantom', name: '幽影协议', icon: '👻', type: 'mech', cat4: 'device', rarity: 3, cost: 12, kw: 'revive',     params: { pct: 0.15 },    desc: '死亡后以 15% 血量复活一次', flavor: '深海猎人带来的濒死重构技术，让躯体在彻底碎裂前，于阴影里重新拼合一次。' },  // 复用 revive（双复活上限 1）[PLACEHOLDER] v2.5 标定：30%→15%（复活无解回调）
    // —— 阵营铭刻（engraving · 对应 6 个多阶阵营，帮凑深度阶）——
    { id: 'e_m_rhodes',   name: '罗德岛徽记', icon: '✚', type: 'engraving', cat4: 'engraving', rarity: 3, cost: 12, countAsFaction: '罗德岛',   desc: '视为罗德岛（阵营羁绊计数）', flavor: '刻着罗德岛徽记的身份铭刻。戴上它，你便被视为这艘船的一员——为了同一个方向而战。' },
    { id: 'e_m_yen',      name: '炎国龙纹', icon: '🐉', type: 'engraving', cat4: 'engraving', rarity: 3, cost: 12, countAsFaction: '炎',       desc: '视为炎（阵营羁绊计数）', flavor: '绘着炎国古龙纹样的铭刻。龙脉的余温仍在金属里流动，将佩戴者认作炎土的子民。' },
    { id: 'e_m_victoria', name: '维多利亚勋纹', icon: '⚔', type: 'engraving', cat4: 'engraving', rarity: 3, cost: 12, countAsFaction: '维多利亚', desc: '视为维多利亚（阵营羁绊计数）', flavor: '维多利亚王家授勋式的微型纹章，凭它，骑士王国的荣光承认你为一同冲锋的同伴。' },
    { id: 'e_m_rhine',    name: '莱茵生命铭牌', icon: '🧪', type: 'engraving', cat4: 'engraving', rarity: 3, cost: 12, countAsFaction: '莱茵生命', desc: '视为莱茵生命（阵营羁绊计数）', flavor: '莱茵生命研发现场的员工铭牌，藏着这家哥伦比亚巨企对“生命”二字近乎偏执的执念。' },
    { id: 'e_m_siracusa', name: '叙拉古家徽', icon: '💼', type: 'engraving', cat4: 'engraving', rarity: 3, cost: 12, countAsFaction: '叙拉古',   desc: '视为叙拉古（阵营羁绊计数）', flavor: '十二家族中某一支的微型家徽。在叙拉古，血统与忠诚写在族谱上——而族谱，承认你。' },
    { id: 'e_m_laterano', name: '拉特兰圣铳', icon: '🔫', type: 'engraving', cat4: 'engraving', rarity: 3, cost: 12, countAsFaction: '拉特兰',   desc: '视为拉特兰（阵营羁绊计数）', flavor: '拉特兰教廷制式的微型圣铳铭刻。在这座以“铳”为信仰的城市，持铳者便被视作信众的一员。' },

    // —— 阵营签名装备（C 类目录落地 · 2026-08-14 内容叙事设计师补全 24 阵营）——
    //   红线：attr 仅消费 atk/hp/aspd/def/crit（magicAmp/spInit 不在 fold，改用近似 attr 或 mech）；
    //        mech 仅 counter/revive/lifesteal/pierce/regenShield/quickStart/splash/berzerk。
    //        16 个有 BONDS 轴的阵营按自身属性轴落 attr；8 个走 __default__ 的阵营仅作风味掉落。
    // —— 罗德岛（医疗理念：治疗量+生存 → 取 hp）——
    { id: 'e_f_rhodes',   name: '罗德岛制式铳刃', icon: '⚔', type: 'attr', cat4: 'weapon', rarity: 2, cost: 8, attr: { hp: 0.12 }, desc: '生命 +12%', flavor: '罗德岛工坊按干员手型调过的制式铳刃，朴素、顺手，刃口还留着源石碎屑的冷光——和甲板上的每一个人一样。' },        // [PLACEHOLDER]
    // —— 龙门（近卫局：攻击+防御）——
    { id: 'e_f_longmen',  name: '近卫局智能枪械', icon: '🛡', type: 'attr', cat4: 'weapon', rarity: 2, cost: 8, attr: { atk: 0.08, def: 0.08 }, desc: '攻击 +8% 防御 +8%', flavor: '龙门近卫局列装的智能枪械，瞄准辅助与城防模块同源。在龙门，治安与战备只有一线之隔。' },        // [PLACEHOLDER]
    // —— 炎（岁兽/炎国：生命+防御）——
    { id: 'e_f_yan',      name: '炎国古武·戟', icon: '🗡', type: 'attr', cat4: 'weapon', rarity: 3, cost: 12, attr: { hp: 0.10, def: 0.06 }, desc: '生命 +10% 防御 +6%', flavor: '炎国古武谱上的制式戟，龙脉的余温在金属里流动，沉而厚重，像一座不肯被轻易撼动的城。' },        // [PLACEHOLDER]
    // —— 拉特兰（枪之城：攻击+暴击）——
    { id: 'e_f_latran',   name: '教廷制式铳', icon: '🔫', type: 'attr', cat4: 'weapon', rarity: 3, cost: 12, attr: { crit: 0.12, atk: 0.06 }, desc: '暴击 +12% 攻击 +6%', flavor: '拉特兰人出生时领到的不是名字，是一把铳。教廷制式的铳比祈祷更让人安心——前提是弹槽里有信。' },        // [PLACEHOLDER]
    // —— 维多利亚（骑士王国：攻防兼备）——
    { id: 'e_f_victoria', name: '蒸汽Royal军械', icon: '⚙', type: 'attr', cat4: 'weapon', rarity: 3, cost: 12, attr: { atk: 0.08, def: 0.08 }, desc: '攻击 +8% 防御 +8%', flavor: '维多利亚王家军械匠的蒸汽发条作品，骑士冲锋时，齿轮与荣誉一同转动，铆钉里嵌着旧大陆的体面。' },        // [PLACEHOLDER]
    // —— 莱茵生命（科研机构：术法+起手技力 → 二者均不在 attr fold，改用 mech regenShield 贴合“生命”主题）——
    { id: 'e_f_rhine',    name: '莱茵生命源生护场', icon: '♻', type: 'mech', cat4: 'armor', rarity: 3, cost: 12, kw: 'regenShield', params: { period: 5, frac: 0.08 }, desc: '每 5s 生成 8% 生命护盾', flavor: '莱茵生命对“生命”二字的执念，凝成一片持续再生的力场——他们连护盾都要做成活的组织。' },        // [PLACEHOLDER]
    // —— 叙拉古（家族：暴击+攻速）——
    { id: 'e_f_siracusa', name: '家族定制配枪', icon: '🤵', type: 'attr', cat4: 'weapon', rarity: 3, cost: 12, attr: { crit: 0.10, aspd: 0.08 }, desc: '暴击 +10% 攻速 +8%', flavor: '十二家族中某一支的定制配枪，枪柄刻着族徽。在叙拉古，忠诚先写在武器上，再刻进族谱。' },        // [PLACEHOLDER]
    // —— 莱塔尼亚（源石技艺帝国：术法+起手技力 → 取 atk 作术式威力近似）——
    { id: 'e_f_laterano', name: '浮空源石法杖', icon: '🔮', type: 'attr', cat4: 'weapon', rarity: 3, cost: 12, attr: { atk: 0.10 }, desc: '攻击 +10%', flavor: '莱塔尼亚源石技艺帝国的浮空法杖，源石在杖首低吟。术式的重量，压过一切修辞。' },        // [PLACEHOLDER]
    // —— 萨尔贡（荒野战士：攻击+生命）——
    { id: 'e_f_sargon',   name: '荒野战斧', icon: '🪓', type: 'attr', cat4: 'weapon', rarity: 2, cost: 8, attr: { atk: 0.10, hp: 0.06 }, desc: '攻击 +10% 生命 +6%', flavor: '萨尔贡荒野战士的宽刃战斧，刃口磨得能劈开沙暴里的兽骨。荒野不教战术，只教活着。' },        // [PLACEHOLDER]
    // —— 企鹅物流（物流速度：起手技力+技力回复 → 取 aspd 作“快”的近似）——
    { id: 'e_f_penguin',  name: '改装快递箱', icon: '📦', type: 'attr', cat4: 'device', rarity: 2, cost: 8, attr: { aspd: 0.15 }, desc: '攻速 +15%', flavor: '企鹅物流的改装配送箱，能塞下一切，也能让持箱人快得像赶着送最后一单。能天使说这玩意比源石技艺还好用。' },        // [PLACEHOLDER]
    // —— 巴别塔（起源：生存向 hp+def）——
    { id: 'e_f_babel',    name: '旧式巴别塔军械', icon: '⚒', type: 'attr', cat4: 'armor', rarity: 2, cost: 8, attr: { hp: 0.10, def: 0.06 }, desc: '生命 +10% 防御 +6%', flavor: '巴别塔旧制的军械，样式已经过时，却仍带着那个理想主义年代的余温。被遗忘的，未必不曾被相信。' },        // [PLACEHOLDER]
    // —— 谢拉格（雪境信仰：生命+防御）——
    { id: 'e_f_sierg',    name: '雪境登山具', icon: '🏔', type: 'attr', cat4: 'armor', rarity: 2, cost: 8, attr: { hp: 0.10, def: 0.06 }, desc: '生命 +10% 防御 +6%', flavor: '谢拉格雪境的登山制式具，寒风里攀行的人，靠它把体温与信念一起护住。山不语，但记得每一个向上的人。' },        // [PLACEHOLDER]
    // —— 深海猎人（攻击+生命）——
    { id: 'e_f_abyssal',  name: '深海猎人三叉戟', icon: '🔱', type: 'attr', cat4: 'weapon', rarity: 3, cost: 12, attr: { atk: 0.10, hp: 0.06 }, desc: '攻击 +10% 生命 +6%', flavor: '深海猎人的制式三叉戟，刃身凝着海嗣的血锈。猎杀者的孤独，藏在每一次掷出的弧线里。' },        // [PLACEHOLDER]
    // —— 乌萨斯（寒冬帝国：攻击+防御）——
    { id: 'e_f_ursus',    name: '寒霜重装甲', icon: '❄', type: 'attr', cat4: 'armor', rarity: 3, cost: 12, attr: { atk: 0.08, def: 0.08 }, desc: '攻击 +8% 防御 +8%', flavor: '乌萨斯寒冬帝国的制式重装甲，钢层里冻着西伯利亚的风，硬扛每一次重击，像帝国扛过每一次寒冬。' },        // [PLACEHOLDER]
    // —— 伊比利亚（深海外交：术法+生命 → 取 hp 作生存近似）——
    { id: 'e_f_iberia',   name: '深海声呐装置', icon: '📡', type: 'attr', cat4: 'device', rarity: 3, cost: 12, attr: { hp: 0.12 }, desc: '生命 +12%', flavor: '伊比利亚深海外交部队的声呐装置，潮汐的频率在金属里回响，提醒佩戴者海面下还压着什么。海潮之下，旧事未央。' },        // [PLACEHOLDER]
    // —— 卡兹戴尔（萨卡兹故土：防御+生存）——
    { id: 'e_f_kazdel',   name: '源石诅咒兵装', icon: '☠', type: 'attr', cat4: 'armor', rarity: 3, cost: 12, attr: { def: 0.10, hp: 0.06 }, desc: '防御 +10% 生命 +6%', flavor: '萨卡兹故土的源石诅咒兵装，诅咒是胎记也是铠甲。卡兹戴尔不愿被征服的人，把诅咒穿在身上。' },        // [PLACEHOLDER]
    // —— 哥伦比亚（非 BONDS 轴，__default__ 通用攻血；仅风味掉落）——
    { id: 'e_f_columbia', name: '哥伦比亚量产步枪', icon: '🔫', type: 'attr', cat4: 'weapon', rarity: 2, cost: 8, attr: { atk: 0.10, crit: 0.06 }, desc: '攻击 +10% 暴击 +6%', flavor: '哥伦比亚流水线上的量产步枪，现代企业把战争也做成了标准件，喷漆是按季度更新的。' },        // [PLACEHOLDER]
    // —— 卡西米尔（非 BONDS 轴；骑士团/竞技）——
    { id: 'e_f_casimir',  name: '骑士铠', icon: '🛡', type: 'attr', cat4: 'armor', rarity: 2, cost: 8, attr: { atk: 0.08, def: 0.06 }, desc: '攻击 +8% 防御 +6%', flavor: '卡西米尔竞技场的骑士铠，荣耀与奖金都写在甲片反光里。披上它，你先是选手，才是自己。' },        // [PLACEHOLDER]
    // —— 阿戈尔（非 BONDS 轴；海面下文明，有 RESONANCE 键）——
    { id: 'e_f_agogo',    name: '阿戈尔水压装甲', icon: '🌊', type: 'attr', cat4: 'armor', rarity: 3, cost: 12, attr: { atk: 0.10, hp: 0.06 }, desc: '攻击 +10% 生命 +6%', flavor: '海面之下另有一座文明的制式装甲，水压与寂静一同锻成，不为任何城邦的旗号而造。' },        // [PLACEHOLDER]
    // —— 喀兰贸易（非 BONDS 轴；杜林工坊精品）——
    { id: 'e_f_kerr',     name: '杜林工坊精品', icon: '🔧', type: 'attr', cat4: 'weapon', rarity: 2, cost: 8, attr: { atk: 0.10 }, desc: '攻击 +10%', flavor: '喀兰贸易旗下杜林工坊的精品武装，雇佣兵的信条是：东西好用，比旗号重要。' },        // [PLACEHOLDER]
    // —— 使徒（非 BONDS 轴；SPECIAL hp，天使主题/神恩）——
    { id: 'e_f_apostle',  name: '十字枪', icon: '✝', type: 'attr', cat4: 'weapon', rarity: 3, cost: 12, attr: { hp: 0.10 }, desc: '生命 +10%', flavor: '使徒的十字枪，羽翼与神恩的意象铸进枪身。离开故土的萨卡兹，仍带着信仰的重量。' },        // [PLACEHOLDER]
    // —— 雷姆必拓（非 BONDS 轴；SPECIAL 减伤，矿工伤痕）——
    { id: 'e_f_rim',      name: '矿脉护体装置', icon: '⛏', type: 'attr', cat4: 'armor', rarity: 2, cost: 8, attr: { def: 0.10 }, desc: '防御 +10%', flavor: '雷姆必拓矿工代代相传的护体装置，矿工伤痕里长出的不是怨，是硬扛落石的本能。' },        // [PLACEHOLDER]
    // —— 塔拉（非 BONDS 轴；SPECIAL 攻速，战歌）——
    { id: 'e_f_tara',     name: '战歌图腾', icon: '🥁', type: 'attr', cat4: 'device', rarity: 2, cost: 8, attr: { aspd: 0.12 }, desc: '攻速 +12%', flavor: '塔拉游吟者的战歌图腾，鼓点一起，连脚步都跟着快了半拍。歌里唱的，是还没回家的那些人。' },        // [PLACEHOLDER]
    // —— 鲤氏侦探事务所（非 BONDS 轴；SPECIAL 暴击，推理/洞察）——
    { id: 'e_f_li',       name: '侦探礼装', icon: '🎩', type: 'attr', cat4: 'armor', rarity: 3, cost: 12, attr: { crit: 0.10 }, desc: '暴击 +10%', flavor: '鲤氏侦探事务所的礼装，推理与洞察织进衣褶。真相，往往藏在最体面的那一层。' },        // [PLACEHOLDER]

    // —— 战术装置（B 类目录落地 · 仅取当前机制支持的 kw/attr；spInit/dodge/taunt 类暂缺 kw，待机制扩展）——
    { id: 'e_g_reactor',  name: '源石反应堆', icon: '🔋', type: 'attr', cat4: 'device', rarity: 2, cost: 8, attr: { atk: 0.08, hp: 0.08 }, desc: '攻击 +8% 生命 +8%', flavor: '驱动核心级的源石反应堆，把澎湃的源石能同时灌进攻击与体魄——前提是你扛得住它的温度。' },        // [PLACEHOLDER]
    { id: 'e_g_anchor',   name: '源石稳定锚', icon: '🧲', type: 'mech', cat4: 'device', rarity: 2, cost: 8, kw: 'regenShield', params: { period: 5, frac: 0.08 }, desc: '每 5s 生成 8% 生命护盾', flavor: '莱塔尼亚源石技艺稳定技术的便携版，像船锚一样把失控的术式压回正轨，也把佩戴者的体表凝出一层薄盾。' },        // [PLACEHOLDER]
    { id: 'e_g_drone',    name: '工程无人机', icon: '🛸', type: 'attr', cat4: 'device', rarity: 1, cost: 5, attr: { aspd: 0.10 }, desc: '攻速 +10%', flavor: '可露希尔说它比某些干员听话。工程部的无人机绕着你转，把补给与节奏一起递到手上。' },        // [PLACEHOLDER]
    // —— v2.4 装备池扩展（P1 · 全部复用现成消费点，数值 [PLACEHOLDER]）——
    // —— 属性装 +5（attr fold 已扩展支持 magicAmp/healAmp/spRegen/defShred/slow）——
    { id: 'e_magic',     name: '术式增幅器', icon: '🔮', type: 'attr', cat4: 'weapon', rarity: 1, cost: 5, attr: { magicAmp: 0.15 }, desc: '法强 +15%', flavor: '莱塔尼亚术师协会的制式增幅环，把源石技艺的功率拧到上限，代价是更容易烧灼术式回路。' },        // [PLACEHOLDER]
    { id: 'e_loop',      name: '技力回环', icon: '🌀', type: 'attr', cat4: 'device', rarity: 2, cost: 8, attr: { spRegen: 0.20 }, desc: '技力回复 +20%', flavor: '以企鹅物流的调度算法为灵感做成的源石回路，让佩戴者的技能转得比时钟还准时。' },        // [PLACEHOLDER]
    { id: 'e_bandage',   name: '急救绷带', icon: '🩹', type: 'attr', cat4: 'armor',  rarity: 0, cost: 3, attr: { healAmp: 0.15 }, desc: '治疗量 +15%', flavor: '罗德岛医疗部标准急救包，绷带浸过消毒剂与一点源石粉末，止血快，痛得也短。' },        // [PLACEHOLDER]
    { id: 'e_shredder',  name: '破甲刃', icon: '🗜', type: 'attr', cat4: 'weapon', rarity: 1, cost: 5, attr: { defShred: 0.10 }, desc: '命中破甲 10%', flavor: '刃口带锯齿的破甲刃，砍进重甲后会咬住不放，把对方的防御一点点剥下来。' },        // [PLACEHOLDER]
    { id: 'e_ice',       name: '冰霜弹', icon: '🧊', type: 'attr', cat4: 'weapon', rarity: 2, cost: 8, attr: { slow: 0.20 }, desc: '命中减速 20%', flavor: '内含低温源石的冰冻弹，命中后让目标身上凝出一层霜——谢拉格人管这叫"家乡的温度"。' },        // [PLACEHOLDER]
    // —— 机制装 +5（mech 折叠已扩展支持 execute/trueDmg/rampHit/castAmp/stun）——
    { id: 'e_hammer',    name: '震荡锤', icon: '🔨', type: 'mech', cat4: 'weapon', rarity: 2, cost: 8, kw: 'stun', params: { pct: 0.15 }, desc: '普攻 15% 概率眩晕 1.2s', flavor: '乌萨斯军工的震荡锤，挥下去时连地面都在发抖。中招的敌人需要一点时间，才能重新想起自己叫什么都。' },        // [PLACEHOLDER]
    { id: 'e_exec',      name: '处决刃', icon: '💀', type: 'mech', cat4: 'weapon', rarity: 3, cost: 12, kw: 'execute', params: { thresh: 0.30, mult: 0.50 }, desc: '对残血目标伤害 +50%', flavor: '萨尔贡处刑官的短刃，专门等对手强弩之末时补上最后一下。荒野的规矩：活下去的才有资格讲道理。' },        // [PLACEHOLDER]
    { id: 'e_true',      name: '源石刃', icon: '⚡', type: 'mech', cat4: 'weapon', rarity: 3, cost: 12, kw: 'trueDmg', params: { value: 0.20 }, desc: '20% 真实伤害', flavor: '以源石结晶开刃的武器，切割的不是血肉，是物理法则本身。' },        // [PLACEHOLDER]
    { id: 'e_ramp',      name: '渐增回路', icon: '📈', type: 'mech', cat4: 'device', rarity: 1, cost: 5, kw: 'rampHit', params: { per: 0.02, cap: 0.20 }, desc: '每次攻击伤害 +2%（上限 +20%）', flavor: '越战越勇的增幅回路，东国武士的"心流"概念被做成了源石电路板。' },        // [PLACEHOLDER]
    { id: 'e_channel',   name: '咏唱核心', icon: '🎼', type: 'mech', cat4: 'device', rarity: 3, cost: 12, kw: 'castAmp', params: { aspd: 0.15, amp: 0.15, dur: 3 }, desc: '施法后 3s 内攻速与伤害提升', flavor: '莱塔尼亚术士咏唱时佩戴的核心，让下一次施法带着整支曲子的共鸣。' },        // [PLACEHOLDER]
    // —— 铭刻 +3（龙门/企鹅物流/萨尔贡，池≥3 有 5 阶价值）——
    { id: 'e_m_longmen',  name: '龙门近卫徽章', icon: '🏯', type: 'engraving', cat4: 'engraving', rarity: 3, cost: 12, countAsFaction: '龙门',       desc: '视为龙门（阵营羁绊计数）', flavor: '龙门近卫局的制式徽章。戴上它，魏彦吾的城便把你算作自己人——治安与共犯，都认这枚章。' },        // [PLACEHOLDER]
    { id: 'e_m_penguin',  name: '企鹅物流工牌', icon: '📦', type: 'engraving', cat4: 'engraving', rarity: 3, cost: 12, countAsFaction: '企鹅物流',   desc: '视为企鹅物流（阵营羁绊计数）', flavor: '企鹅物流的工牌，背面印着"准时送达或退款"。戴上它，你就是这家快递公司的编外员工，赶工单优先。' },        // [PLACEHOLDER]
    { id: 'e_m_sargon',   name: '萨尔贡沙徽', icon: '🏜', type: 'engraving', cat4: 'engraving', rarity: 3, cost: 12, countAsFaction: '萨尔贡',     desc: '视为萨尔贡（阵营羁绊计数）', flavor: '萨尔贡王帐发的沙徽，刻着绿洲与王杖。荒野认徽章不认人——有它，你就是王帐的子民。' },        // [PLACEHOLDER]
  ];
  const EQUIP_BY_ID = {}; EQUIP_POOL.forEach(e => EQUIP_BY_ID[e.id] = e);

  // P2-3b：单干员势力「独行被动」叙事文案（叙事设计师补写，纯原创 prose，非台词，可自由润色）
  // 与上节阵营 t1/t2/t3 同一笔调：写"为什么这个势力只能独行"，不冒充原台词。
  const SOLO_FLAVOR = {
    '格拉斯哥帮': '没有旗帜，没有故乡，只有自己握紧的枪。推进之王从不向任何人俯首——地下城的规矩，是她亲手写的。',
    '黑钢国际': '合同之外无盟友，火力之内皆正义。黑钢的佣兵把信任折算成报酬，却总在最后一发子弹前，选择留下。',
    'S.W.E.E.P.': '表面是清洁公司，暗处是维多利亚最利落的刀。阿斯卡纶擦去的从不止尘埃，还有不该被记住的痕迹。',
    '阿戈尔': '海面之下另有一座文明，沉默、古老、不被理解。浊心斯卡蒂站在这里，也站在那片深蓝的边缘。',
    '萨米': '雪原的旅人追随着古老的神谕，巨兽的足迹即是道路。提丰的箭，从不为某一座城邦而发。',
    '米诺斯': '剑与荣光都沉进了废墟，米诺斯只剩一个不肯低头的名字。帕拉斯提起的，是整片大陆都快遗忘的骄傲。',
    '汐斯塔': '移动的霓虹，不夜的舞台。黑在枪线与节拍之间游走，把战场当成另一场演出。',
    '莱欧斯小队': '异界的旅人误入泰拉，剑与魔法只为找回归途。玛露西尔的术式，照亮的从不是同一片星空。',
    '行动组A4': '没有番号值得记住，只有任务必须完成。麒麟R夜刀的身影，总在指令到达之前消失于东方的雾里。',
    '行动预备组A6': '预备，意味着随时顶上，也意味着随时被遗忘。焰狐龙梓兰扣下扳机时，从不多看一眼身后。',
    'Ave Mujica': '来自另一段旋律的客人，琴弦里缠着不属于这片大地的悲欢。丰川祥子带来的，是一首尚未写完的安魂曲。'
  };

  // v3.0 单干员势力「独行羁绊」——池=1 的阵营无法成羁绊，上场即给「attr 数值 + behavior 独有机制」。
  // 11 个独行干员各 1 独门绝学（复用现成 kw 家族，零新引擎）；数值 [PLACEHOLDER] 待 balance_sim 标定。
  // 键名与 data.json 池=1 阵营一致；若未来池变化需同步增删。
  const DEPLOY_PASSIVE = {
    '格拉斯哥帮': { attr: { atk: 0.15, hp: 0.10, spInit: 6 }, behavior: [{ kw: 'knightBanner', params: { base: 0.12, per: 0.02 } }], desc: SOLO_FLAVOR['格拉斯哥帮'] },   // 王之旗：全队攻光环
    'Ave Mujica': { attr: { atk: 0.12, aspd: 0.10 }, behavior: [{ kw: 'barrage', params: { hits: 2, spread: 0 } }], desc: SOLO_FLAVOR['Ave Mujica'] },               // 面具之舞：普攻多段连击
    '米诺斯':     { attr: { atk: 0.10, def: 0.08 }, behavior: [{ kw: 'berzerk', params: { thresh: 0.30, atkPct: 0.25, leech: 0.10 } }], desc: SOLO_FLAVOR['米诺斯'] }, // 米诺斯之盾：低血狂暴
    '黑钢国际':   { attr: { hp: 0.12, def: 0.12 }, behavior: [{ kw: 'counter', params: { value: 0.15 } }], desc: SOLO_FLAVOR['黑钢国际'] },                         // 黑钢协议：受击反伤
    '萨米':       { attr: { atk: 0.12, crit: 0.10 }, behavior: [{ kw: 'critDmg', params: { value: 1.40 } }], desc: SOLO_FLAVOR['萨米'] },                           // 萨米弓术：暴伤
    '行动预备组A6': { attr: { atk: 0.10, aspd: 0.08 }, behavior: [{ kw: 'quickStart', params: { aspd: 0.25 } }], desc: SOLO_FLAVOR['行动预备组A6'] },                // 预备组：开局攻速
    '汐斯塔':     { attr: { atk: 0.10, crit: 0.10 }, behavior: [{ kw: 'berzerk', params: { thresh: 0.40, atkPct: 0.30 } }], desc: SOLO_FLAVOR['汐斯塔'] },           // 汐斯塔狂热：低血狂击
    '莱欧斯小队': { attr: { magicAmp: 0.15, spInit: 4 }, behavior: [{ kw: 'castAmp', params: { amp: 0.15, aspd: 0 } }], desc: SOLO_FLAVOR['莱欧斯小队'] },           // 莱欧斯共振：技能增幅
    '阿戈尔':     { attr: { healAmp: 0.12, aspd: 0.10 }, behavior: [{ kw: 'healAura', params: { regen: 0.03 } }], desc: SOLO_FLAVOR['阿戈尔'] },                     // 深海之歌：全队治疗光环
    'S.W.E.E.P.': { attr: { aspd: 0.12, crit: 0.08 }, behavior: [{ kw: 'rampHit', params: { per: 0.06, cap: 3 } }], desc: SOLO_FLAVOR['S.W.E.E.P.'] },              // 追踪印记：渐强叠印
    '行动组A4':   { attr: { aspd: 0.10, atk: 0.12 }, behavior: [{ kw: 'execute', params: { thresh: 0.25, mult: 0.60 } }], desc: SOLO_FLAVOR['行动组A4'] },           // 夜袭：残血处决
  };

  // ============ 真实召唤物（v2.1 · summon archetype）============
  // 狼（叙拉古养狼）/ 岁兽（令签名）转为可独立攻防、占格、死亡的战斗单位。
  // 数值 [PLACEHOLDER]：基础值沿用 light 版初值，每级成长 ×1.25（标定可调）；等级/经验为局内（本 run）状态，不写 Meta。
  const SUMMON_TEMPLATES = {
    wolf:  { name: '狼', en: 'Wolf', sub: '叙拉古眷属', avatar: 'assets/wolf.png',
             atk: 130, hp: 640, def: 45, spd: 110, dmgType: 'phys', range: 1, growth: 1.25 },
    beast: { name: '岁兽', en: 'Beast', sub: '令之眷属', avatar: 'assets/beast.png',
             atk: 210, hp: 1700, def: 90, spd: 95, dmgType: 'phys', range: 1, growth: 1.25 },
  };
  // 成长阈值（累计 EXP）：level1→40→100→180→280（上限 5 级），沿用设计稿 §5 初值 [PLACEHOLDER]
  const SUMMON_LEVEL_EXP = [0, 40, 100, 180, 280];
  const SUMMON_MAX_LEVEL = SUMMON_LEVEL_EXP.length; // 5
  function summonLevelFromExp(exp) {
    let lv = 1;
    for (let i = 0; i < SUMMON_LEVEL_EXP.length; i++) { if (exp >= SUMMON_LEVEL_EXP[i]) lv = i + 1; else break; }
    return Math.min(lv, SUMMON_MAX_LEVEL);
  }
  // 构造一个真实召唤物战斗单位（继承 CombatUnit 结构，附加 isSummon 元信息）
  function makeCombatSummon(kind, level, side, summonerId) {
    const tmpl = SUMMON_TEMPLATES[kind];
    if (!tmpl) return null;
    const g = Math.pow(tmpl.growth, Math.max(0, level - 1));
    const op = {
      name: tmpl.name, en: tmpl.en, class: '召唤物', subclass: tmpl.sub, rarity: 3, cost: 0,
      stats: {
        atk: Math.round(tmpl.atk * g), hp: Math.round(tmpl.hp * g), def: Math.round(tmpl.def * g),
        spd: tmpl.spd, dmgType: tmpl.dmgType, range: tmpl.range,
      },
      skill: null, traits: [], bonds: { 职业: '召唤物', 阵营: '—' }, avatar: tmpl.avatar,
    };
    // 召唤物不按星级缩放（沿用 light 版固定基础值 × 等级成长，避免 STAR_MULT 放大破坏平衡），故 star 传 1
    const u = makeCombatUnit(op, 1, side, DEF_MULT, { attr: {}, kw: {} }, null, null);
    u.isSummon = true;
    u.summonerId = summonerId || null;
    u.summonType = kind;
    u.level = level || 1;
    u.exp = 0;
    u.maxExp = SUMMON_LEVEL_EXP[Math.min(u.level, SUMMON_MAX_LEVEL) - 1];
    u.evolves = false;
    u.killExp = 5; // 击杀贡献 EXP [PLACEHOLDER]
    return u;
  }
  // 战前口粮临时加成（下一场战斗生效，战后清空）
  function applyFeedBuff(u, ss) {
    if (!ss) return;
    if (ss.feedAtk) { u.atk = Math.round(u.atk * (1 + ss.feedAtk)); u.baseAtk = u.atk; }
    if (ss.feedHp) { u.maxHp = Math.round(u.maxHp * (1 + ss.feedHp)); u.hp = u.maxHp; }
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

  // 战场：我方左 4 列 / 敌方右 4 列，半场 4×6；整体 8×6（与部署区一一对应）
  const GRID_COLS = 4, GRID_ROWS = 6, FIELD_W = 8, FIELD_H = 6;
  const CELL = 64;            // 战斗网格像素
  const DT = 0.1, SAMPLE_DT = 0.6, MAX_T = 60;

  // 羁绊效果键：atk/hp/def/aspd/crit/magicAmp/healAmp 为“分数乘数”(1+val)；spInit 为绝对值；spRegen 为回复乘数
  const BOND_KEYS = ['atk', 'hp', 'def', 'aspd', 'crit', 'magicAmp', 'healAmp', 'spInit', 'spRegen'];

  function computeBonds(boardUnits) {
    // 策略节点「羁绊亲和」(bondEase)：阶位需求 -N（最低 1）；「呼应共振」(resoBonus)：呼应加成 ×(1+N)。
    let bondEase = 0, resoBonus = 0;
    try { if (typeof G !== 'undefined' && G && G.strategies) { const se = aggregateStrategies(); bondEase = se.bondEase || 0; resoBonus = se.resonanceBonusPct || 0; } } catch (e) {}
    const axes = ['职业', '阵营'];
    const seen = { 职业: {}, 阵营: {} };
    boardUnits.forEach(u => {
      axes.forEach(ax => {
        const v = u.bonds[ax];
        (seen[ax][v] = seen[ax][v] || new Set()).add(u.name);
      });
      // 装备·阵营铭刻（v2）：装备后视为该阵营（羁绊计数叠加，不替换原阵营）。
      // 实现决策：seen 按 u.name 去重 → 外援穿铭刻 +1（帮凑深度阶）；本阵营干员穿同名铭刻不额外 +1（防计数失控）。
      // 仅当 boardUnits 带 uid 且 G.equipState 存在时生效（Node 单测/无装备场景自动跳过）。
      if (u.uid && typeof G !== 'undefined' && G && G.equipState) {
        (G.equipState.slots[u.uid] || []).forEach(eqId => {
          const eq = EQUIP_BY_ID[eqId];
          if (eq && eq.type === 'engraving' && eq.countAsFaction) {
            (seen['阵营'][eq.countAsFaction] = seen['阵营'][eq.countAsFaction] || new Set()).add(u.name);
          }
        });
      }
    });
    const active = [];
    const potential = [];
    const mult = {};
    const sig = {};      // name -> { attr, kw }  签名羁绊（单人被动）
    const special = {};  // name -> { kw, params } 阵营特殊机制
    const specialEff = {}; // name -> { kw: 累计value } 呼应行为型 kw 溢出（P1②）
    boardUnits.forEach(u => {
      mult[u.name] = { atk: 1, hp: 1, def: 1, aspd: 1, crit: 0, magicAmp: 1, healAmp: 1, spInit: 0, spRegen: 1 };
      sig[u.name] = { attr: {}, kw: {} };
      special[u.name] = null;
      specialEff[u.name] = null;
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
          for (let t = 0; t < cfg.thr.length; t++) if (n >= Math.max(1, cfg.thr[t] - bondEase)) tier = t;
          if (tier < 0) { if (n >= 1) potential.push({ axis: ax, value: v, count: n, need: Math.max(1, cfg.thr[0] - bondEase) }); return; }
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
          for (let t = 0; t < vc.thr.length; t++) if (n >= Math.max(1, vc.thr[t] - bondEase)) tier = t;
          if (tier < 0) { if (n >= 1) potential.push({ axis: ax, value: v, count: n, need: Math.max(1, vc.thr[0] - bondEase) }); return; }
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
              // 深度阶（阵营多阶）：堆叠注入所有 deep[tierN']（tierN'<=tierN），与基础 kw 同名→覆盖参数（进化），异名→追加 capstone 行为
              const dpKeys = sp.deep ? Object.keys(sp.deep).map(Number).filter(k => k <= tierN).sort((a, b) => a - b) : [];
              dpKeys.forEach(dk => {
                const dp = sp.deep[dk];
                if (dp.attr) {
                  boardUnits.forEach(u => {
                    if (u.bonds[ax] === v) applyMult(mult[u.name], dp.attr);
                  });
                  Object.assign(bonus, dp.attr);
                }
              });
              boardUnits.forEach(u => {
                if (u.bonds[ax] !== v) return;
                const entry = { kw: sp.kw || null, params: sp.params || {}, kws: [] };
                dpKeys.forEach(dk => {
                  const dp = sp.deep[dk];
                  if (!dp.kws) return;
                  dp.kws.forEach(e => {
                    if (e.kw === entry.kw) entry.params = e.params || {};            // 进化：覆盖基础参数
                    else entry.kws.push({ kw: e.kw, params: e.params || {} });       // capstone：新增行为
                  });
                });
                special[u.name] = entry;
              });
              const deepLabel = dpKeys.length ? dpKeys.map(k => sp.deep[k].label).join(' + ') : null;
              active.push({ axis: '特殊', value: v, count: n, tier: tierN, bonus: sp.attr ? Object.assign({}, sp.attr) : {}, kw: sp.kw || null, deep: deepLabel });
            }
          }
        });
      }
    });
    // v2.5 M3：职业羁绊 behavior（6/8/10 阶 kw）——axes 循环后统一合并进 special[name]
    // （此时阵营 deep 已确定，追加不覆盖；与阵营 kw 并存多槽）
    (function applyClassBehavior() {
      const jobCfg = BONDS['职业'];
      if (!jobCfg) return;
      Object.keys(seen['职业']).forEach(v => {
        const vc = jobCfg[v];
        if (!vc || !vc.behavior) return;
        const n = seen['职业'][v].size;
        let tier = -1;
        for (let t = 0; t < vc.thr.length; t++) if (n >= Math.max(1, vc.thr[t] - bondEase)) tier = t;
        if (tier < 0) return;
        const tierN = tier + 1;
        const behKws = [];
        // behavior 键 = 人数档位（6/8/10），用 n（人数）比较：6 人→6 阶行为、8 人→8 阶、10 人→10 阶
        Object.keys(vc.behavior).forEach(bk => { if (n >= parseInt(bk, 10)) vc.behavior[bk].forEach(e => behKws.push(e)); });
        if (!behKws.length) return;
        boardUnits.forEach(u => {
          if (u.bonds['职业'] !== v) return;
          if (!special[u.name]) special[u.name] = { kw: null, params: {}, kws: [] };
          behKws.forEach(e => {
            if (e.kw === special[u.name].kw) special[u.name].params = e.params || {}; // 同名覆盖（罕见）
            else if (!special[u.name].kws.some(x => x.kw === e.kw)) special[u.name].kws.push(e);
          });
        });
        // 展示：追加行为标签到对应职业羁绊条目
        const behLabel = Object.keys(vc.behavior).filter(bk => n >= parseInt(bk, 10)).map(bk => vc.behavior[bk].map(e => e.kw).join('+')).join(' ');
        if (behLabel) {
          const act = active.find(a => a.axis === '职业' && a.value === v);
          if (act) act.beh = behLabel;
        }
      });
    })();
    // v3.0 阵营羁绊 behavior（3/5 阶 kw，7+ 走 SPECIAL.deep 觉醒）——与职业 behavior 同构，axes 后统一合并
    (function applyFactionBehavior() {
      const facCfg = BONDS['阵营'];
      if (!facCfg) return;
      Object.keys(seen['阵营']).forEach(v => {
        const vc = facCfg[v];
        if (!vc || !vc.behavior) return;
        const n = seen['阵营'][v].size;
        const behKws = [];
        // behavior 键 = 人数档位（3/5），用 n（人数）比较；7+ 交给 SPECIAL.deep（不重复注入）
        Object.keys(vc.behavior).forEach(bk => { if (n >= parseInt(bk, 10)) vc.behavior[bk].forEach(e => behKws.push(e)); });
        if (!behKws.length) return;
        boardUnits.forEach(u => {
          if (!u.bonds['阵营'] || u.bonds['阵营'] !== v) return;
          if (!special[u.name]) special[u.name] = { kw: null, params: {}, kws: [] };
          behKws.forEach(e => {
            if (e.kw === special[u.name].kw) { /* 同名：SPECIAL 主题机制优先，模板不覆盖（防低值削弱高值） */ }
            else if (!special[u.name].kws.some(x => x.kw === e.kw)) special[u.name].kws.push(e);
          });
        });
        // 展示：追加行为标签到对应阵营羁绊条目
        const behLabel = Object.keys(vc.behavior).filter(bk => n >= parseInt(bk, 10)).map(bk => vc.behavior[bk].map(e => e.kw).join('+')).join(' ');
        if (behLabel) {
          const act = active.find(a => a.axis === '阵营' && a.value === v);
          if (act) act.beh = behLabel;
        }
      });
    })();
    // 签名展示（单人，阶0）
    boardUnits.forEach(u => {
      if (SIGNATURE[u.name]) {
        const s = SIGNATURE[u.name];
        active.push({ axis: '签名', value: u.name, count: 1, tier: 0, bonus: s.attr || {}, kw: (s.kw && Object.keys(s.kw)[0]) || null });
      }
    });
    // P2-3：单干员势力「独行被动」也进入展示，让玩家看到每个单位「有东西」
    boardUnits.forEach(u => {
      const f = (u.bonds && u.bonds['阵营']);
      if (DEPLOY_PASSIVE[f]) active.push({ axis: '独行', value: f, count: 1, tier: 0, bonus: DEPLOY_PASSIVE[f].attr, kw: null });
    });
    // P1：跨阵营呼应 → 真实轻量战斗加成（仅复用 BOND_KEYS 乘数；行为型 kw 暂留 PAIRS.bonus 叙事方向）
    // 数值为保守占位 [PLACEHOLDER]，须经蒙特卡洛 + 试玩标定；EFF 无条目（tension/gap）的 pair 不生效。
    if (typeof RESONANCE !== 'undefined' && RESONANCE.EFF) {
      const activeFactions = new Set(boardUnits.map(u => (u.bonds || {}).阵营).filter(Boolean));
      RESONANCE.compute(activeFactions, boardUnits).forEach(p => {
        const eff = RESONANCE.EFF[p.a + '|' + p.b];
        if (!eff) return;
        boardUnits.forEach(u => {
          const f = (u.bonds || {}).阵营;
          if (eff[f]) {
            const scaled = {};
            Object.keys(eff[f]).forEach(k => { scaled[k] = eff[f][k] * (1 + resoBonus); });
            applyMult(mult[u.name], scaled);
          }
        });
      });
    }
    // ② 行为型呼应 → SPECIAL 关键字（数值型 += 叠加 / aura 型追加进 specialKw 多槽）
    // 数值为保守占位 [PLACEHOLDER]，须经蒙特卡洛 + 试玩标定；SPECIAL_EFF / SPECIAL_EFF_AURA 无条目不生效。
    const resoKw = {}; // name -> { kw, params, label }
    if (typeof RESONANCE !== 'undefined') {
      const activeFactions = new Set(boardUnits.map(u => (u.bonds || {}).阵营).filter(Boolean));
      const effEntries = Object.assign({}, RESONANCE.SPECIAL_EFF || {}, RESONANCE.SPECIAL_EFF_AURA || {});
      RESONANCE.compute(activeFactions, boardUnits).forEach(p => {
        const se = effEntries[p.a + '|' + p.b];
        if (!se) return;
        // aura 型：优先用 entry.params；否则镜像来源阵营 SPECIAL[src]（单一真相源，随 capstone 联动）
        let params = se.params;
        if (!params && se.src && typeof SPECIAL !== 'undefined' && SPECIAL[se.src]) params = SPECIAL[se.src].params || {};
        params = params || {};
        // 回声强度系数 scale（默认 1）：令跨阵营回声弱于原生 capstone（设计原则），0.6 为 MC 保守安全值
        const auraScale = (se.scale != null) ? se.scale : 1;
        if (auraScale !== 1) params = scaleAuraParams(se.kw, params, auraScale);
        boardUnits.forEach(u => {
          const f = (u.bonds || {}).阵营;
          if (se.factions.indexOf(f) >= 0) resoKw[u.name] = { kw: se.kw, params, label: se.label };
        });
      });
    }
    return { active, potential, mult, sig, special, resoKw };
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

  // 回声强度系数：仅缩放「幅度」类数值字段，不动时间/阈值类（dur/period/thresh 等）
  // 覆盖当前与可预见的 aura kw 幅度字段（value/aspd/amp/frac/regen/dps/t2/t3/mult）。
  function scaleAuraParams(kw, p, s) {
    const o = Object.assign({}, p || {});
    ['value', 'aspd', 'amp', 'frac', 'regen', 'dps', 't2', 't3', 'mult'].forEach(k => {
      if (typeof o[k] === 'number') o[k] *= s;
    });
    return o;
  }

  // 攻击射程（按职业，Chebyshev 距离）：近战贴脸 3x3，远程隔空输出。
  // 覆盖 data.json 中统一的 range:1；未列出的职业回落 op.stats.range ?? 1（兼容且未来可单卡覆盖）。
  // 数值为 [PLACEHOLDER]，须经 balance_sim.py 蒙特卡洛 + 试玩标定后替换。
  const CLASS_RANGE = {
    '先锋': 1, '近卫': 1, '重装': 1, '特种': 1,          // 近战：相邻 3x3
    '狙击': 4, '术师': 3, '辅助': 2, '医疗': 2,           // 远程：隔空输出（狙击最长）
  };

  // v2.4 子职业射程细分（Chebyshev）：SUBCLASS_RANGE[subclass] 优先于 CLASS_RANGE[class]。
  // 近战系大多 1（贴脸 3x3）；个别远程/策士型给 2；远程系按子类拉开档次（神射手最远 5）。
  // 数值均为 [PLACEHOLDER]，须经 balance_sim.py 蒙特卡洛 + 试玩标定后替换。
  const SUBCLASS_RANGE = {
    // 近卫
    '领主': 1, '重剑手': 1, '撼地者': 1, '术战者': 2, '解放者': 1, '收割者': 1, '斗士': 1, '武者': 1, '教官': 1, '无畏者': 1, '强攻手': 1, '剑豪': 1,
    // 先锋
    '情报官': 1, '战术家': 2, '策士': 2, '尖兵': 1, '执旗手': 1, '冲锋手': 1,
    // 重装
    '本源铁卫': 1, '哨戒铁卫': 1, '要塞': 2, '守护者': 1, '铁卫': 1, '不屈者': 1, '驭法铁卫': 2, '决战者': 1,
    // 特种
    '巡空者': 1, '处决者': 1, '陷阱师': 1, '炼金师': 2, '傀儡师': 1, '怪杰': 1, '钩索师': 1, '伏击客': 1, '推击手': 1, '行商': 1,
    // 狙击
    '炮手': 3, '散射手': 3, '回环射手': 3, '攻城手': 3, '速射手': 3, '重射手': 4, '投掷手': 3, '猎手': 3, '神射手': 5,
    // 术师
    '轰击术师': 3, '中坚术师': 3, '阵法术师': 3, '扩散术师': 2, '本源术师': 3, '链术师': 3, '塑灵术师': 2, '驭械术师': 3, '秘术师': 4,
    // 医疗
    '链愈师': 2, '医师': 2, '守望者': 2, '群愈师': 1, '疗养师': 2, '咒愈师': 2, '行医': 1,
    // 辅助
    '召唤师': 1, '巫役': 2, '工匠': 2, '凝滞师': 3, '吟游者': 1, '护佑者': 1, '削弱者': 2,
  };
  // 统一射程解析：子职业 > 职业 > 单卡 stats.range > 1（部署高亮 / 战斗单位 / 详情条三处共用）
  function rangeOf(op) {
    if (!op) return 1;
    const sc = op.subclass ? SUBCLASS_RANGE[op.subclass] : null;
    if (sc != null) return sc;
    if (op.class && CLASS_RANGE[op.class] != null) return CLASS_RANGE[op.class];
    return (op.stats && op.stats.range != null) ? op.stats.range : 1;
  }

  function makeCombatUnit(op, star, side, mult, sig, special, resoKw, equip) {
    const sm = STAR_MULT[star] || 1;
    const m = mult || DEF_MULT;
    // P1-1：攻击/生命 乘数软上限（详见 MAX_ATK_MULT / MAX_HP_MULT 注释），压制乘区爆炸
    const atkMultRaw = sm * (m.atk || 1);
    const hpMultRaw = sm * (m.hp || 1);
    const atk = Math.round(op.stats.atk * Math.min(atkMultRaw, MAX_ATK_MULT));
    const hp = Math.round(op.stats.hp * Math.min(hpMultRaw, MAX_HP_MULT));
    // v2.5 M1：星级分阶技能——1★/2★/3★ 分别用 skillsAll[0]/[1]/[2]（3★=op.skill，零回归）
    // 选中的技能若缺战斗参数（M2 全干员改造前），回退 op.skill 兜底，保证任何星级都有可用技能
    const pickSkillByStar = () => {
      const idx = star >= 3 ? 2 : (star === 2 ? 1 : 0);
      const all = (op.skillsAll && op.skillsAll.length) ? op.skillsAll : null;
      const cand = all && all[idx] && (all[idx].archetype || all[idx].effect) ? all[idx] : null;
      return cand || op.skill || null;
    };
    const sk = pickSkillByStar();
    const spMax = sk ? sk.spMax : 24;
    // v2.5 标定：攻速软上限——aspd 乘数收口（防攻速无限叠乘超模）
    const aspd = Math.min(m.aspd || 1, MAX_ASPD_MULT);
    const u = {
      op, name: op.name, cls: op.class, avatar: op.avatar, traits: op.traits || [],
      dmgType: op.stats.dmgType, range: rangeOf(op), cost: op.stats.cost, star,
      maxHp: hp, hp, atk, baseAtk: atk,
      def: Math.round(op.stats.def * sm * (m.def || 1)),
      spd: op.stats.spd * aspd,
      side,
      next: 100 / (op.stats.spd * aspd), alive: true, stunUntil: 0, slowUntil: 0, slowFactor: 1,
      sp: Math.min(spMax, m.spInit || 0), spMax,
      spRegen: (sk ? sk.spRegen : 1) * (m.spRegen || 1),
      skill: sk ? { name: sk.name, archetype: sk.archetype, effect: sk.effect, range: sk.range, starIdx: star } : null,
      shield: 0, burn: null,
      crit: m.crit || 0, magicAmp: m.magicAmp || 1, healAmp: m.healAmp || 1,
      // —— 行为关键字（签名 + 阵营特殊）——
      pierce: 0, defShred: 0, trueDmg: 0, skillAmp: 1, lifesteal: 0, slow: 0,
      damageReduction: 0, counter: 0, critDmg: 0,
      rampHitPer: 0, rampHitCap: 0, rampHitAcc: 0,
      summonBeast: 0, specialKw: [], specialParams: {}, castAspd: 1, castAmpMul: 1, castBuffUntil: 0,
      reviveCharges: 0, revivePct: 0,
      // v2.4 装备扩展字段
      hitStun: 0, executeThresh: 0, executeMult: 0,
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
    // 合并阵营特殊关键字（specialKw 多槽：写入数组，params 按 kw 索引；kw:null 阵营保持空数组）
    if (special && special.kw) {
      const p = special.params || {};
      u.specialKw = [special.kw]; u.specialParams = { [special.kw]: p };
      if (special.kw === 'pierce') u.pierce = Math.max(u.pierce, p.value || 0);
      else if (special.kw === 'trueDmg') u.trueDmg = Math.max(u.trueDmg, p.value || 0);
      else if (special.kw === 'defShred') u.defShred = Math.max(u.defShred, p.value || 0);
      else if (special.kw === 'critDmg') u.critDmg = Math.max(u.critDmg, p.value || 0);
      else if (special.kw === 'damageReduction') u.damageReduction = Math.max(u.damageReduction, p.value || 0);
      else if (special.kw === 'rampHit') { u.rampHitPer = Math.max(u.rampHitPer, p.per || 0); u.rampHitCap = Math.max(u.rampHitCap, p.cap || 0); }
      else if (special.kw === 'spRegenBuff') u.spRegen *= (1 + (p.value || 0));
      else if (special.kw === 'lifesteal') u.lifesteal = Math.max(u.lifesteal, p.value || 0); // v2.4 塔拉·战歌
      else if (special.kw === 'counter') u.counter = Math.max(u.counter, p.value || 0);      // v2.4 卡兹戴尔·源石反噬
    }
    // 阵营多阶：深度阶 kws[]（与基础 kw 同名已在上面覆盖参数；此处处理异名 capstone 行为 + healAura/burnDoT 进化已在上面）
    if (special && special.kws && special.kws.length) {
      special.kws.forEach(e => {
        const KW = e.kw, p = e.params || {};
        if (u.specialKw.indexOf(KW) < 0) u.specialKw.push(KW);
        u.specialParams[KW] = p;
        if (KW === 'pierce') u.pierce = Math.max(u.pierce, p.value || 0);
        else if (KW === 'trueDmg') u.trueDmg = Math.max(u.trueDmg, p.value || 0);
        else if (KW === 'defShred') u.defShred = Math.max(u.defShred, p.value || 0);
        else if (KW === 'critDmg') u.critDmg = Math.max(u.critDmg, p.value || 0);
        else if (KW === 'damageReduction') u.damageReduction = Math.max(u.damageReduction, p.value || 0);
        else if (KW === 'rampHit') { u.rampHitPer = Math.max(u.rampHitPer, p.per || 0); u.rampHitCap = Math.max(u.rampHitCap, p.cap || 0); }
        else if (KW === 'spRegenBuff') u.spRegen *= (1 + (p.value || 0));
        else if (KW === 'lifesteal') u.lifesteal = Math.max(u.lifesteal, p.value || 0); // v2.4 塔拉·战歌
        else if (KW === 'counter') u.counter = Math.max(u.counter, p.value || 0);      // v2.4 卡兹戴尔·源石反噬
        else if (KW === 'castAmp') { u.castAmpMul = 1 + (p.amp || 0.15); u.castAspd = 1 + (p.aspd || 0.15); u.castBuffUntil = Math.max(u.castBuffUntil, 1e9); }
        else if (KW === 'triage') { u.reviveCharges = (p.charges || 1); u.revivePct = (p.revivePct || 0.30); }
        else if (KW === 'revive') { u.reviveCharges = Math.min(1, u.reviveCharges + 1); u.revivePct = Math.max(u.revivePct, p.pct || 0.15); } // v2.6 策略战斗规则：全队首死复活
        // v2.5 M3：职业羁绊 behavior kw 字段折叠（其余靠 specialKw 数组在 step/dealDamage 消费）
        else if (KW === 'berzerk') u.berzerk = { thresh: p.thresh || 0.30, atkPct: p.atkPct || 0.20, leech: p.leech || 0.10 };
        else if (KW === 'goldOnKill') u.goldOnKill = (u.goldOnKill || 0) + (p.amount || 1);
        else if (KW === 'healCrit') u.healCrit = Math.max(u.healCrit || 0, p.pct || 0.25);
        else if (KW === 'splash') u.splash = Math.max(u.splash || 0, p.pct || 0.30);
        else if (KW === 'quickStart') u.quickF = Math.max(u.quickF || 1, 1 + (p.aspd || 0.30));
        else if (KW === 'execute') { u.executeThresh = p.thresh || 0.30; u.executeMult = p.mult || 0.50; }
        // infernoRally / knightBanner / overload / capo / barrage 在 step/onFight 专门消费
      });
    }
    // ② 行为型呼应：数值型 kw（pierce/trueDmg/damageReduction 等）以 += 叠加在阵营 special 之上；
    //    aura 型 kw（guardAura/healAura/shieldPeriodic/castAmp/burnDoT/slowAura/execute/globalAspd/summonWolf）
    //    追加进 u.specialKw 多槽（与阵营 special 共存），params 按 kw 存于 u.specialParams[kw]。
    if (resoKw && resoKw.kw) {
      const p = resoKw.params || {};
      const AURA_KW = { guardAura: 1, healAura: 1, shieldPeriodic: 1, castAmp: 1, burnDoT: 1, slowAura: 1, execute: 1, globalAspd: 1, summonWolf: 1 };
      if (AURA_KW[resoKw.kw]) {
        if (u.specialKw.indexOf(resoKw.kw) < 0) { u.specialKw.push(resoKw.kw); u.specialParams[resoKw.kw] = p; }
      } else if (resoKw.kw === 'pierce') u.pierce += (p.value || 0);
      else if (resoKw.kw === 'defShred') u.defShred += (p.value || 0);
      else if (resoKw.kw === 'trueDmg') u.trueDmg += (p.value || 0);
      else if (resoKw.kw === 'critDmg') u.critDmg += (p.value || 0);
      else if (resoKw.kw === 'damageReduction') u.damageReduction += (p.value || 0);
      else if (resoKw.kw === 'rampHit') { u.rampHitPer += (p.per || 0); u.rampHitCap += (p.cap || 0); }
      else if (resoKw.kw === 'spRegenBuff') u.spRegen *= (1 + (p.value || 0));
      else if (resoKw.kw === 'skillAmp') u.skillAmp = (u.skillAmp || 1) + (p.value || 0);
      else if (resoKw.kw === 'lifesteal') u.lifesteal += (p.value || 0);
      else if (resoKw.kw === 'slow') u.slow += (p.value || 0);
      else if (resoKw.kw === 'counter') u.counter += (p.value || 0);
    }
    // ③ 装备（v2）：独立命名空间 u.equipKw + u.equipParams（不复用 specialKw，避免与阵营/签名/呼应 kw 冲突）。
    //    attr 装 fold 进属性（受 MAX_ATK_MULT/MAX_HP_MULT 软上限）；mech 装复用现有字段或新 kw；engraving 不进战斗（computeBonds 层消费）。
    if (equip && equip.length) {
      u.equipKw = []; u.equipParams = {};
      equip.forEach(eq => {
        const p = eq.params || {};
        if (eq.type === 'attr') {
          if (eq.attr.atk) u.atk = Math.min(Math.round(u.baseAtk * MAX_ATK_MULT), Math.round(u.atk * (1 + eq.attr.atk)));
          if (eq.attr.hp) { u.maxHp = Math.min(Math.round(u.maxHp * MAX_HP_MULT), Math.round(u.maxHp * (1 + eq.attr.hp))); u.hp = u.maxHp; }
          if (eq.attr.aspd) u.spd *= (1 + eq.attr.aspd);
          if (eq.attr.def) u.def = Math.round(u.def * (1 + eq.attr.def));
          if (eq.attr.crit) u.crit += eq.attr.crit;
          // v2.4 扩展：法强/治疗/技回/破甲/减速（复用既有乘区与字段）
          if (eq.attr.magicAmp) u.magicAmp *= (1 + eq.attr.magicAmp);
          if (eq.attr.healAmp) u.healAmp *= (1 + eq.attr.healAmp);
          if (eq.attr.spRegen) u.spRegen *= (1 + eq.attr.spRegen);
          if (eq.attr.defShred) u.defShred += eq.attr.defShred;
          if (eq.attr.slow) u.slow += eq.attr.slow;
        } else if (eq.type === 'mech') {
          if (u.equipKw.indexOf(eq.kw) < 0) u.equipKw.push(eq.kw);
          u.equipParams[eq.kw] = p;
          if (eq.kw === 'counter') u.counter += (p.pct || 0);        // 复用反伤字段
          else if (eq.kw === 'revive') { u.reviveCharges = Math.min(1, u.reviveCharges + 1); u.revivePct = Math.max(u.revivePct, p.pct || 0.30); } // 双复活上限 1
          else if (eq.kw === 'lifesteal') u.lifesteal += (p.pct || 0); // 复用吸血字段
          else if (eq.kw === 'pierce') u.pierce = Math.max(u.pierce, p.value || 0); // 复用破甲字段
          else if (eq.kw === 'regenShield') u.regenShield = { period: p.period || 5, frac: p.frac || 0.08 };
          else if (eq.kw === 'quickStart') u.quickF = 1 + (p.aspd || 0.35); // 走 ATK() 通道
          else if (eq.kw === 'splash') u.splash = p.pct || 0.40;
          else if (eq.kw === 'berzerk') u.berzerk = { thresh: p.thresh || 0.30, atkPct: p.atkPct || 0.20, leech: p.leech || 0.10 };
          // v2.4 扩展机制装（复用现有消费点）
          else if (eq.kw === 'execute') { u.executeThresh = p.thresh || 0.30; u.executeMult = p.mult || 0.50; } // dealDamage 处决同款
          else if (eq.kw === 'trueDmg') u.trueDmg += (p.value || 0);   // 复用真伤字段
          else if (eq.kw === 'rampHit') { u.rampHitPer += (p.per || 0); u.rampHitCap += (p.cap || 0); } // 复用暖机字段
          else if (eq.kw === 'castAmp') { u.castAmpMul = 1 + (p.amp || 0.15); u.castAspd = 1 + (p.aspd || 0.15); u.castBuffUntil = 1e9; } // 复用咏唱字段
          else if (eq.kw === 'stun') u.hitStun = p.pct || 0.15; // step 普攻眩晕
        }
      });
    }
    return u;
  }

  function applyBonds(units, side, positions) {
    const { mult, sig, special, resoKw } = computeBonds(units.map(u => ({ uid: u.uid, name: u.op.name, bonds: u.op.bonds, star: u.star })));
    // P0-1：接通策略节点的全局战斗增益（锋锐/坚壁 等 stat 卡）。
    // 仅作用于我方（side==='ally'），敌方一律不享受，避免污染难度平衡。
    const se = aggregateStrategies();
    let gmult = null;
    if (side === 'ally' && (se.allAtkPct || se.allHpPct || se.allAspdPct || se.allMagicPct)) {
      gmult = { atk: 1 + se.allAtkPct, hp: 1 + se.allHpPct, aspd: 1 + se.allAspdPct, magicAmp: 1 + se.allMagicPct };
    }
    return units.map((u, idx) => {
      let m = mult[u.op.name] || DEF_MULT;
      if (u.buff && u.buff !== 1) { m = Object.assign({}, m); m.atk *= u.buff; m.hp *= u.buff; m.def *= u.buff; }
      if (gmult) { m = Object.assign({}, m); m.atk *= gmult.atk; m.hp *= gmult.hp; m.aspd *= gmult.aspd; m.magicAmp *= gmult.magicAmp; }
      // v3.0 单干员势力「独行羁绊」：attr 数值 + behavior 独有机制（注入 special.kws，复用现成 kw 通道）
      const dp = DEPLOY_PASSIVE[(u.op.bonds && u.op.bonds['阵营'])];
      if (dp) {
        m = Object.assign({}, m);
        Object.keys(dp.attr).forEach(k => {
          if (k === 'spInit') m.spInit += dp.attr[k];
          else if (k === 'spRegen') m.spRegen *= (1 + dp.attr[k]);
          else m[k] = (m[k] || 1) * (1 + dp.attr[k]);
        });
        if (dp.behavior && dp.behavior.length && side === 'ally') {
          const sp = special[u.op.name] || (special[u.op.name] = { kw: null, params: {}, kws: [] });
          dp.behavior.forEach(e => { if (!sp.kws.some(x => x.kw === e.kw)) sp.kws.push(e); });
        }
      }
      // 策略节点 comp 定向加成（阵容导向）+ 位置加成（引导前后排站位），仅我方
      if (side === 'ally') {
        const cm = (se.classBonusPct && se.classBonusPct[u.op.class]) || null;
        const fm = (se.factionBonusPct && se.factionBonusPct[(u.op.bonds || {}).阵营]) || null;
        const isSig = (typeof SIGNATURE !== 'undefined') && !!SIGNATURE[u.op.name];
        const applyBonus = (b) => { if (!b) return; Object.keys(b).forEach(k => { if (k === 'spInit') m.spInit += b[k]; else if (k === 'spRegen') m.spRegen *= (1 + b[k]); else m[k] = (m[k] || 1) * (1 + b[k]); }); };
        if (cm || fm || (isSig && se.sigBonusPct)) {
          m = Object.assign({}, m);
          applyBonus(cm); applyBonus(fm);
          if (isSig && se.sigBonusPct) { m.atk *= (1 + se.sigBonusPct); m.hp *= (1 + se.sigBonusPct); }
        }
        // 位置加成：我方列 0-3，front=x>=2（临近敌方）、back=x<=1（远离敌方）
        if (positions && positions[idx]) {
          const x = positions[idx].x;
          const front = x >= 2, back = x <= 1;
          let ra = 0, rh = 0, rd = 0;
          if (front) { ra += (se.roleAtkPct.front || 0); rh += (se.roleHpPct.front || 0); rd += (se.roleDefPct.front || 0); }
          if (back) { ra += (se.roleAtkPct.back || 0); rh += (se.roleHpPct.back || 0); rd += (se.roleDefPct.back || 0); }
          if (ra || rh || rd) {
            m = Object.assign({}, m);
            if (ra) m.atk *= (1 + ra);
            if (rh) m.hp *= (1 + rh);
            if (rd) m.def *= (1 + rd);
          }
        }
      }
      // v2.6 策略战斗注入（rule 战斗规则 / power 全队机制）：仅我方，优先复用现成 kw 家族
      if (side === 'ally') {
        const stk = [];
        if (se.teamLifesteal) stk.push({ kw: 'lifesteal', params: { value: se.teamLifesteal } });
        if (se.teamArmorShred) stk.push({ kw: 'pierce', params: { value: se.teamArmorShred } });
        if (se.skillAmpPct) stk.push({ kw: 'castAmp', params: { amp: se.skillAmpPct, aspd: 0 } });
        if (se.reviveOncePct) stk.push({ kw: 'revive', params: { pct: se.reviveOncePct } });
        if (se.startAspdPct) { m = Object.assign({}, m); m.aspd = (m.aspd || 1) * (1 + se.startAspdPct); }
        if (se.startSpPct) { m = Object.assign({}, m); m.spInit = (m.spInit || 0) + se.startSpPct; }
        if (stk.length) {
          const sp = special[u.op.name] || (special[u.op.name] = { kw: null, params: {}, kws: [] });
          stk.forEach(k => { if (!sp.kws.some(x => x.kw === k.kw)) sp.kws.push(k); });
        }
      }
      return makeCombatUnit(u.op, u.star, side, m, sig[u.op.name] || { attr: {}, kw: {} }, special[u.op.name] || null, resoKw ? resoKw[u.op.name] : null, equipFor(u.uid));
    });
  }

  // v2 装备：按干员 uid 取已穿戴装备条目（G.equipState.slots[uid] → EQUIP_POOL 条目数组）
  function equipFor(uid) {
    try {
      if (!uid || typeof G === 'undefined' || !G || !G.equipState || !G.equipState.slots) return [];
      return (G.equipState.slots[uid] || []).filter(Boolean).map(eqId => EQUIP_BY_ID[eqId]).filter(Boolean);
    } catch (e) { return []; }
  }

  // 部署格序号 -> 战斗坐标：8×6 部署区，格 (col,row) 直接对应战斗坐标 (x,y)，左右半场一一对应
  function slotToXY(i) {
    const col = i % 8, row = Math.floor(i / 8);
    return { x: col, y: row };
  }

  // 按职业基线默认站位：我方前排在 x=3，敌方前排在 x=4
  // 行优先铺位：先把前列整行填满再退到后列 — 避免少量单位全堆在前列单列、底部行被裁切。
  // 例：6 个 ally 在 4×6 → (3,0)(2,0)(1,0)(0,0)(3,1)(2,1)，均匀铺开。
  function autoPositions(units, side) {
    const cells = [];
    if (side === 'ally') {
      for (let y = 0; y < GRID_ROWS; y++) for (let x = GRID_COLS - 1; x >= 0; x--) cells.push([x, y]);
    } else {
      for (let y = 0; y < GRID_ROWS; y++) for (let x = 0; x < GRID_COLS; x++) cells.push([GRID_COLS + x, y]);
    }
    return units.map((u, i) => {
      const c = cells[i % cells.length];
      return { x: c[0], y: c[1] };
    });
  }

  // v2.1 召唤物站位：优先放在召唤者（干员）相邻空闲格；无空闲相邻格则退化到最近空闲格。
  // plan: [{ unit, summonerPos }]；返回 { allyList, allyPos }（已并入召唤物）。
  function placeAdjacentSummons(allyList, allyPos, plan) {
    const occupied = new Set(allyPos.map(p => p.x + ',' + p.y));
    const allCells = [];
    for (let x = 0; x < FIELD_W; x++) for (let y = 0; y < FIELD_H; y++) allCells.push({ x, y });
    const freeCells = () => allCells.filter(p => !occupied.has(p.x + ',' + p.y));
    const adjOf = c => [
      { x: c.x + 1, y: c.y }, { x: c.x - 1, y: c.y }, { x: c.x, y: c.y + 1 }, { x: c.x, y: c.y - 1 },
    ].filter(p => p.x >= 0 && p.x < FIELD_W && p.y >= 0 && p.y < FIELD_H);
    const outList = allyList.slice(), outPos = allyPos.slice();
    plan.forEach(s => {
      let cell = null;
      if (s.summonerPos) {
        for (const a of adjOf(s.summonerPos)) { if (!occupied.has(a.x + ',' + a.y)) { cell = a; break; } }
      }
      if (!cell) { const f = freeCells(); if (f.length) cell = f[0]; }
      if (!cell) return; // 极端满场：放弃该召唤
      occupied.add(cell.x + ',' + cell.y);
      outList.push(s.unit); outPos.push(cell);
    });
    return { allyList: outList, allyPos: outPos };
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

  // v2.4 方案A：动态定向招募——玩家场上/备战席已有小阵营（池≤5）时，商店提升该阵营出现率（越凑越容易）
  // 多阵营并存按已有单位数加权（谁多谁优先），不锁死单一阵营；数值 [PLACEHOLDER] 待标定
  // 权重设计：2-3 人池 ×1.6 实测几乎无感（40 抽命中≈随机基线），已调高——池越小权重越高
  function factionTrackBias() {
    const bias = {}; // 阵营 -> 权重
    try {
      if (typeof G === 'undefined' || !G) return bias;
      const cnt = {};
      Object.values(G.board).forEach(u => { const f = u.op.bonds && u.op.bonds['阵营']; if (f) cnt[f] = (cnt[f] || 0) + 1; });
      G.bench.forEach(u => { const f = u.op.bonds && u.op.bonds['阵营']; if (f) cnt[f] = (cnt[f] || 0) + 1; });
      Object.keys(cnt).forEach(f => {
        const pool = DATA.operators.filter(o => o.bonds && o.bonds['阵营'] === f).length;
        // 小阵营（池≤5）才定向：已有 1 人 ×2.5，2+ 人 ×3.5（越凑越容易）；大阵营不干预（随手就有）
        if (pool <= 5 && pool >= 2) bias[f] = (cnt[f] >= 2) ? 3.5 : 2.5;
      });
    } catch (e) {}
    return bias;
  }

  function pickShop(pool, level) {
    const cap = maxShopCost(level);
    // 开局环境可提升某职业/阵营的出现率（羁绊爆率）
    const bias = (G.env && G.env.effects && G.env.effects.shopBias) || null;
    const track = factionTrackBias(); // v2.4 动态定向招募（小阵营）
    const byCost = { 1: [], 2: [], 3: [], 4: [], 5: [] };
    pool.forEach(o => { if (o.stats.cost <= cap) byCost[o.stats.cost].push(o); });
    const out = [];
    for (let i = 0; i < 5; i++) {
      let c = rollCost(level);
      if (c > cap) c = cap;
      let arr = byCost[c];
      while (!arr.length && c > 1) { c--; arr = byCost[c]; }
      if (!arr.length) { out.push(null); continue; }
      const hasEnvBias = !!(bias && bias.field);
      const hasTrack = Object.keys(track).length > 0;
      if (hasEnvBias || hasTrack) {
        // 加权随机：开局环境 bias ×mult，动态定向招募按阵营加权（两者可叠加）
        const w = arr.map(o => {
          let wt = 1;
          if (hasEnvBias && o.bonds[bias.field] === bias.value) wt *= bias.mult;
          if (hasTrack) { const f = o.bonds && o.bonds['阵营']; if (track[f]) wt *= track[f]; }
          return wt;
        });
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
    // 08-15 修复：护盾上限 = maxHp × SHIELD_CAP_MULT，防自施放盾无限堆积（配合 step() 射程外先推进）
    const SHIELD_CAP_MULT = 2;
    const addShield = (u, amt) => { u.shield = Math.min(u.shield + Math.max(0, amt), Math.round(u.maxHp * SHIELD_CAP_MULT)); };
    // 对称先手：随机决定先手方，并按 (先手, 后手) 逐索引交错排列，
    // 消除「ally 每 tick 恒定先动」带来的系统性偏置（原为 ally.concat(enemy)）。
    const firstSide = (typeof global !== 'undefined' && global.__forceFirst) ? global.__forceFirst : (Math.random() < 0.5 ? 'ally' : 'enemy'); // __forceFirst 调试钩子
    const ord = firstSide === 'ally' ? [ally, enemy] : [enemy, ally];
    const all = [];
    const _maxLen = Math.max(ally.length, enemy.length);
    for (let _i = 0; _i < _maxLen; _i++) {
      for (const _side of ord) { if (_i < _side.length) all.push(_side[_i]); }
    }
    const occ = new Map();
    all.forEach(u => occ.set(u.x + ',' + u.y, u));
    // light 版：团队级前置（全队攻速 / 减速光环）——双向对称：双方各自阵营机制作用于己方
    for (const _sx of [ally, enemy]) {
      const foes = _sx === ally ? enemy : ally;
      if (_sx.some(u => u.specialKw.includes('globalAspd'))) {
        // v2.5 M3：读持有者自身 params（职业 10 阶先锋/狙击与企鹅物流并存时各取各的，取最大）
        let v = 0;
        _sx.forEach(u => { if (u.specialKw.includes('globalAspd')) v = Math.max(v, (u.specialParams['globalAspd'] || {}).value || 0); });
        if (!v) v = (SPECIAL['企鹅物流'] && SPECIAL['企鹅物流'].params.value) || 0.10;
        _sx.forEach(u => { u.spd *= (1 + v); });
      }
      const slowA = _sx.find(u => u.specialKw.includes('slowAura'));
      if (slowA) {
        const v = (slowA.specialParams && slowA.specialParams['slowAura'] && slowA.specialParams['slowAura'].value) || 0.20;
        foes.forEach(u => { u.slowFactor = 1 - v; u.slowUntil = 1e9; });
      }
      // 阵营多阶 · 深度阶光环（战斗开局一次性施加，双向对称）
      const inferno = _sx.find(u => u.specialKw.includes('infernoRally'));
      if (inferno) { // 炎[9] 岁兽觉醒：炎单位攻强（呼应"炎含炎-岁"）
        const v = (inferno.specialParams['infernoRally'] || {}).value || 0.15;
        _sx.forEach(u => { if ((u.op.bonds || {}).阵营 === '炎') { u.atk = Math.round(u.atk * (1 + v)); u.baseAtk = u.atk; } });
      }
      const banner = _sx.find(u => u.specialKw.includes('knightBanner'));
      if (banner) { // 维多利亚[9→Large 并入 7] 骑士旗帜：全队攻光环，随维多利亚上场数缩放
        const p = banner.specialParams['knightBanner'] || {};
        const cnt = _sx.filter(u => (u.op.bonds || {}).阵营 === '维多利亚').length;
        const v = (p.base || 0.08) + (p.per || 0.02) * cnt;
        _sx.forEach(u => { u.atk = Math.round(u.atk * (1 + v)); u.baseAtk = u.atk; });
      }
      const capo = _sx.find(u => u.specialKw.includes('capo'));
      if (capo) { // 叙拉古[9→Large 并入 7] 教父：狼群攻速光环
        const v = (capo.specialParams['capo'] || {}).aspd || 0.20;
        _sx.forEach(u => { if (u.isSummon && u.summonType === 'wolf') { u.spd *= (1 + v); } });
      }
    }
    const frames = [];
    const logBuf = [];
    const castsThisSnap = [];
    let t = 0;
    let tickIdx = Math.random() < 0.5 ? 0 : 1; // 行动顺序计数器（初始奇偶随机）：每 tick 交替先手方，抵消先手滚雪球偏置；初始随机使决定性技能齐放先手方随机化
    let suddenDeath = false; // 猝死阶段：禁用续航、无视护盾、伤害翻倍，强制终结僵局
    // P2-4：战斗统计（复盘用）——双方累计伤害与阵亡数
    const stats = { allyDmg: 0, enemyDmg: 0, allyDeaths: 0, enemyDeaths: 0, summonKills: 0, goldEarned: 0, dmgBy: {}, takenBy: {}, healBy: {} };
    // 行动间隔：受减速(slowFactor)与施法加速(castAspd)影响
    const ATK = u => {
      const slowF = (u.slowFactor && t < u.slowUntil) ? u.slowFactor : 1;
      const castF = (u.castAspd && t < u.castBuffUntil) ? u.castAspd : 1;
      const quickF = (u.quickF && t < 2) ? u.quickF : 1; // v2 装备·行动记录：战斗前 2s 攻速
      return 100 / (u.spd * slowF * castF * quickF);
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

    const attackFxBuf = []; // v2.5 弹道：帧内攻击事件缓冲（from uid → to uid），snap 时并入帧
    function dealDamage(src, tgt, rawDmg) {
      if (!tgt || !tgt.alive) return 0;
      if (src && src.uid && tgt.uid) attackFxBuf.push({ f: src.uid, t: tgt.uid });
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
      // v2 装备·战意核心（berzerk）：血量低于阈值时增伤 + 吸血（动态判定，非一次性）
      if (src.berzerk && src.hp / src.maxHp < src.berzerk.thresh) {
        finalDmg *= (1 + src.berzerk.atkPct);
        if (src.alive) { const _hb = Math.round(finalDmg * src.berzerk.leech); src.hp = Math.min(src.maxHp, src.hp + _hb); if (src.uid) stats.healBy[src.uid] = (stats.healBy[src.uid] || 0) + _hb; }
      }
      // 处决（萨尔贡特殊 / v2.4 装备·处决刃）
      if ((src.specialKw.includes('execute') || src.executeThresh) && tgt.hp / tgt.maxHp < (src.executeThresh || (src.specialParams['execute'] || {}).thresh || 0.3)) {
        finalDmg *= (1 + (src.executeMult || (src.specialParams['execute'] || {}).mult || 0.5));
      }
      // 受击减伤（泥岩 / 雷姆必拓 / 龙门协防）
      if (tgt.damageReduction) finalDmg *= (1 - tgt.damageReduction);
      // 龙门协防（guardAura）：受击方若有存活相邻友军（龙门）则额外减伤
      if (tgt.side) {
        for (const a of all) {
          if (a.alive && a.side === tgt.side && a !== tgt && a.specialKw.includes('guardAura') && cheb(a, tgt) <= 1) {
            finalDmg *= (1 - (a.specialParams && a.specialParams['guardAura'] && a.specialParams['guardAura'].value ? a.specialParams['guardAura'].value : 0.10));
            break;
          }
        }
      }
      finalDmg = Math.max(1, Math.round(finalDmg));
      let dealtTotal = finalDmg;            // 含护盾吸收的总输出（用于对称裁定）
      if (suddenDeath) { const _sdMult = 2 + Math.floor((t - MAX_T) / 3) * 2; finalDmg *= _sdMult; dealtTotal = finalDmg; } // 猝死阶段伤害随时间递增（每3s +2x），强制终结坦克僵局，避免落入超时偏置分支
      // 护盾吸收（猝死阶段无视护盾，避免僵局）
      if (tgt.shield > 0 && !suddenDeath) {
        const absorb = Math.min(tgt.shield, finalDmg);
        tgt.shield -= absorb; finalDmg -= absorb;
      }
      tgt.hp -= finalDmg;
      if (src) { stats.dmgBy[src.uid] = (stats.dmgBy[src.uid] || 0) + dealtTotal; stats.takenBy[tgt.uid] = (stats.takenBy[tgt.uid] || 0) + dealtTotal; }
      if (src && src.side === 'ally') stats.allyDmg += dealtTotal; else if (src) stats.enemyDmg += dealtTotal;
      if (tgt.hp <= 0) {
        if (tgt.reviveCharges > 0 && !suddenDeath) { // 罗德岛[9→深度阶] 不抛下任何人：阵亡复活一次
          tgt.reviveCharges--; tgt.hp = Math.max(1, Math.round(tgt.maxHp * (tgt.revivePct || 0.30))); if (tgt.burn) tgt.burn = null;
          tgt._reviveFx = 1; // v2.4 可视化：金光重生
          logBuf.push({ k: 'revive', line: tgt.name + ' 复活！(' + tgt.hp + ' HP)', side: tgt.side });
        } else {
          tgt.alive = false; occ.delete(tgt.x + ',' + tgt.y); if (tgt.side === 'ally') stats.allyDeaths++; else stats.enemyDeaths++; if (src && src.isSummon) stats.summonKills++;
          // v2.5 M3 先锋 8 阶「击杀回费」：我方非召唤物击杀 → 累计（onFight 结算），防养狼刷钱
          if (src && src.side === 'ally' && src.goldOnKill && !src.isSummon) stats.goldEarned += src.goldOnKill;
        }
      }
      // 命中破甲（薇薇安娜 / 伊比利亚）
      if (src.defShred && tgt.alive) tgt.def = Math.max(0, tgt.def * (1 - src.defShred));
      // 命中减速（水月）
      if (src.slow && tgt.alive) { tgt.slowFactor = Math.min(tgt.slowFactor == null ? 1 : tgt.slowFactor, 1 - src.slow); tgt.slowUntil = t + 2; }
      // 吸血（山）
      if (src.lifesteal && src.alive) { const _hl = Math.round(finalDmg * src.lifesteal); src.hp = Math.min(src.maxHp, src.hp + _hl); if (src.uid) stats.healBy[src.uid] = (stats.healBy[src.uid] || 0) + _hl; }
      // 反伤（棘刺）
      if (tgt.counter && src !== tgt && src.alive) src.hp -= Math.max(1, Math.round(finalDmg * tgt.counter));
      // 灼烧（炎特殊）
      if (src.specialKw.includes('burnDoT') && tgt.alive) {
        const bp = src.specialParams['burnDoT'] || {};
        const dps = (tgt.burn ? tgt.burn.dps : 0) + (bp.dps || 0);
        tgt.burn = { dps, until: t + (bp.dur || 3) };
        if (bp.spread) { // 炎[7→深度阶] 炽魂蔓延：溅射相邻敌人（半伤）
          all.forEach(o => {
            if (o.alive && o.side !== src.side && cheb(o, tgt) <= 1) {
              const od = (o.burn ? o.burn.dps : 0) + (bp.dps || 0) * 0.5;
              o.burn = { dps: od, until: t + (bp.dur || 3) };
            }
          });
        }
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
      // 技能独立射程：默认沿用施法者自身 range，支持单技能 skill.range 覆盖（干员技能单独做射程）
      const skRange = (u.skill && u.skill.range != null) ? u.skill.range : u.range;
      if (arch === 'burst' || arch === 'lifesteal' || arch === 'execute') {
        const ne = nearestEnemy(u);
        const tgt = (ne.tgt && ne.d <= skRange) ? ne.tgt : null;
        if (tgt) {
          let m = eff.mult;
          if (arch === 'execute' && tgt.hp / tgt.maxHp < (eff.thresh || 0.35)) m *= 1.8;
          const dmg = dealDamage(u, tgt, u.atk * m * amp);
          line += ' → ' + tgt.name + ' -' + dmg;
          if (arch === 'lifesteal') u.hp = Math.min(u.maxHp, u.hp + Math.round(dmg * (eff.leech || 0.5)));
        } else line += '（射程外）';
      } else if (arch === 'aoe') {
        let tot = 0;
        foes.filter(fo => cheb(fo, u) <= skRange).forEach(fo => { tot += dealDamage(u, fo, u.atk * eff.mult * amp); });
        line += (tot > 0 ? ' 范围打击 -' + tot : '（射程外）');
      } else if (arch === 'heal') {
        const wounded = allies.some(x => x.hp < x.maxHp);
        const low = allies.filter(x => x.hp < x.maxHp && cheb(x, u) <= skRange).sort((a, b) => a.hp / a.maxHp - b.hp / b.maxHp)[0];
        if (low) {
          let h = Math.round(u.atk * eff.mult * (u.healAmp || 1));
          if (u.healCrit && Math.random() < u.healCrit) h = Math.round(h * 2); // v2.5 M3 医疗 8 阶：治疗暴击
          low.hp = Math.min(low.maxHp, low.hp + h); line += ' 治疗 ' + low.name + ' +' + h + (u.healCrit && h > Math.round(u.atk * eff.mult * (u.healAmp || 1)) ? '（暴击）' : '');
        }
        else line += (wounded ? '（射程外）' : '（友军满血）');
      } else if (arch === 'shield') {
        const tgt = (eff.target === 'self') ? u
          : (allies.filter(x => x !== u && cheb(x, u) <= skRange).sort((a, b) => a.hp / a.maxHp - b.hp / b.maxHp)[0] || u);
        const s = Math.round(u.atk * (eff.mult || 1)); addShield(tgt, s); line += ' 为 ' + tgt.name + ' 提供护盾 ' + s;
      } else if (arch === 'stun') {
        const ne = nearestEnemy(u);
        const tgt = (ne.tgt && ne.d <= skRange) ? ne.tgt : null;
        const dur = (eff.dur || 1.2);
        if (tgt) { tgt.stunUntil = t + dur; line += ' 眩晕 ' + tgt.name + ' ' + dur.toFixed(1) + 's'; } else line += '（射程外）';
      } else if (arch === 'buff') {
        const ba = (eff.atk || 0.3);
        allies.forEach(a => { a.atk = Math.min(Math.round(a.baseAtk * 2.5), Math.round(a.atk * (1 + ba))); });
        line += ' 全军攻击力+' + Math.round(ba * 100) + '%';
      } else if (arch === 'debuff') {
        const bd = (eff.def || 0.3);
        foes.forEach(f => { f.def = Math.round(f.def * (1 - bd)); });
        line += ' 敌军防御-' + Math.round(bd * 100) + '%';
      } else if (arch === 'dot') {
        const ne = nearestEnemy(u);
        const tgt = (ne.tgt && ne.d <= skRange) ? ne.tgt : null;
        if (tgt) { const d = dealDamage(u, tgt, u.atk * (eff.mult || 1) * amp); line += ' 侵蚀 ' + tgt.name + ' -' + d; } else line += '（射程外）';
      } else if (arch === 'summon') {
        const s = Math.round(u.atk * (eff.mult || 1)); addShield(u, s); line += ' 召唤援军（护盾+' + s + '）';
      } else {
        const ne = nearestEnemy(u);
        const tgt = (ne.tgt && ne.d <= skRange) ? ne.tgt : null;
        if (tgt) { const d = dealDamage(u, tgt, u.atk * (eff.mult || 2) * amp); line += ' → ' + tgt.name + ' -' + d; }
        else line += '（射程外）';
      }
      // v2.1：令签名召唤岁兽——技能施放时强化场上岁兽；若无则兜底召唤一只（战斗召唤）
      // 对称修正：召唤物归属「施法者所在方」(u.side)，推入对应数组，避免真镜像中对 ally 单边偏置
      if (u.summonBeast) {
        const _myArr = (u.side === 'ally') ? ally : enemy;
        const _uidPrefix = (u.side === 'ally') ? 'a' : 'e';
        const beasts = _myArr.filter(x => x.alive && x.isSummon && x.summonType === 'beast');
        if (beasts.length) {
          beasts.forEach(b => { b.atk = Math.round(b.atk * 1.15); b.maxHp = Math.round(b.maxHp * 1.10); b.hp = b.maxHp; }); // [PLACEHOLDER] 强化数值
          line += ' 岁兽强化（攻+15%/血+10%）';
        } else {
          const lvl = (typeof G !== 'undefined' && G.summonState && G.summonState.beast) ? G.summonState.beast.level : 1;
          const nb = makeCombatSummon('beast', lvl, u.side, u.uid);
          let cell = null;
          const adj = [{ x: u.x + 1, y: u.y }, { x: u.x - 1, y: u.y }, { x: u.x, y: u.y + 1 }, { x: u.x, y: u.y - 1 }].filter(p => p.x >= 0 && p.x < FIELD_W && p.y >= 0 && p.y < FIELD_H);
          for (const a of adj) { if (!occ.has(a.x + ',' + a.y)) { cell = a; break; } }
          if (!cell) { for (let x = 0; x < FIELD_W && !cell; x++) for (let y = 0; y < FIELD_H && !cell; y++) { if (!occ.has(x + ',' + y)) cell = { x, y }; } }
          if (cell) {
            // uid 必须全局唯一：死亡单位仍留在 ally 数组内，'a'+ally.length 会撞已有 uid（令多次施法尤甚），故取当前最大数值 uid+1
            const maxUid = _myArr.reduce((m, x) => { const n = parseInt((x.uid || _uidPrefix + '0').slice(1), 10); return isNaN(n) ? m : Math.max(m, n); }, -1);
            nb.x = cell.x; nb.y = cell.y; nb.uid = _uidPrefix + (maxUid + 1);
            all.push(nb); _myArr.push(nb); occ.set(cell.x + ',' + cell.y, nb); line += ' 召唤岁兽！';
          }
        }
      }
      // 咏唱（莱塔尼亚特殊）：施法后获得攻速 + 技能增幅 buff
      if (u.specialKw.includes('castAmp')) {
        const p = (u.specialParams && u.specialParams['castAmp']) || {};
        u.castAmpMul = 1 + (p.amp || 0.15);
        u.castAspd = 1 + (p.aspd || 0.15);
        u.castBuffUntil = t + (p.dur || 3);
      }
      logBuf.push({ k: 'skill', line });
      castsThisSnap.push({ uid: u.uid, arch, name: u.skill.name, fac: (u.op && u.op.bonds && u.op.bonds['阵营']) || '' });
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
      // 灼烧 DoT（炎特殊）：按每秒比例结算（归属施放对手，计入伤害裁定）
      all.forEach(u => {
        if (u.alive && u.burn && t < u.burn.until) {
          const d = Math.round(u.maxHp * u.burn.dps * DT);
          u.hp -= d;
          if (u.side === 'ally') stats.enemyDmg += d; else stats.allyDmg += d;
          if (u.hp <= 0) {
            if (u.reviveCharges > 0 && !suddenDeath) { // 灼烧致死也可触发复活
              u.reviveCharges--; u.hp = Math.max(1, Math.round(u.maxHp * (u.revivePct || 0.30))); if (u.burn) u.burn = null;
              u._reviveFx = 1; // v2.4 可视化：金光重生
            } else { u.alive = false; occ.delete(u.x + ',' + u.y); if (u.side === 'ally') stats.allyDeaths++; else stats.enemyDeaths++; }
          }
        }
      });
      // 急救协议（罗德岛特殊）/ 霜护（谢拉格特殊）——双向对称：双方各自阵营机制作用于己方
      if (!suddenDeath) {
        for (const _sx of [ally, enemy]) {
          const healer = _sx.find(u => u.alive && u.specialKw.includes('healAura'));
          if (healer) {
            // 取该侧 healAura 持有者中最高的 regen（深度阶 0.045 覆盖基础 0.03，进化生效）
            let r = 0;
            _sx.forEach(u => { if (u.alive && u.specialKw.includes('healAura')) { const rr = (u.specialParams['healAura'] || {}).regen || 0.03; if (rr > r) r = rr; } });
            _sx.forEach(a => { if (a.alive && a.hp / a.maxHp < 0.7) a.hp = Math.min(a.maxHp, a.hp + a.maxHp * r); });
          }
          // 阵营多阶 · 莱茵[9→Large 并入 7] 过载协议：周期法强爆发（窗口内 castAmpMul 提升）
          const over = _sx.find(u => u.alive && u.specialKw.includes('overload'));
          if (over && t > 0 && Math.round(t) % ((over.specialParams['overload'] || {}).period || 6) === 0) {
            const p = over.specialParams['overload'] || {};
            _sx.forEach(a => { if (a.alive) { a.castAmpMul = 1 + (p.value || 0.30); a.castBuffUntil = t + (p.dur || 3); } });
          }
          const shielder = _sx.find(u => u.alive && u.specialKw.includes('shieldPeriodic'));
          if (shielder && t > 0 && Math.round(t) % ((shielder.specialParams['shieldPeriodic'] || {}).period || 5) === 0) {
            const frac = ((shielder.specialParams['shieldPeriodic'] || {}).frac || 0.10);
            _sx.forEach(a => { if (a.alive) addShield(a, Math.round(a.maxHp * frac)); });
          }
          // v2 装备·再生装甲（regenShield）：仅持有者自身周期回盾（独立 kw，区别于谢拉格全队光环）
          _sx.forEach(a => {
            if (a.alive && a.regenShield && t > 0 && Math.round(t) % a.regenShield.period === 0) {
              addShield(a, Math.round(a.maxHp * a.regenShield.frac));
            }
          });
        }
      }

      // 每 tick 交替先手方（按 tickIdx 奇偶翻转交错顺序），使先手优势在数百个 tick 内自行抵消，
      // 消除「固定先手方每 tick 恒定先动」导致的胜负被先手决定的滚雪球偏置。
      const _startAlly = (tickIdx % 2 === 0);
      const _ord = _startAlly ? [ally, enemy] : [enemy, ally];
      const _order = [];
      const _maxLen2 = Math.max(ally.length, enemy.length);
      for (let _k = 0; _k < _maxLen2; _k++) {
        for (const _s of _ord) { if (_k < _s.length) _order.push(_s[_k]); }
      }
      for (const u of _order) {
        if (!u.alive) continue;
        if (u.cd > 0) { u.cd -= DT; continue; }
        if (u.stunUntil > t) { u.cd = 0.1; continue; }
        // 技能释放（攒满技力则本次行动改为施法）
        // 停滞修复：敌人不在射程内时放弃空放技能，落入下方移动分支推进 —— 否则自施放单位(盾/奶/增益)会无限叠技能、永不接近敌人
        if (u.skill && u.sp >= u.spMax) {
          const _neCast = nearestEnemy(u);
          if (_neCast.tgt && _neCast.d > u.range) { /* 敌人在射程外 → 交给移动分支 */ }
          else { castSkill(u); u.sp = 0; u.cd = ATK(u) * 0.6; continue; }
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
            let heal = Math.round(u.atk * (u.healAmp || 1));
            if (u.healCrit && Math.random() < u.healCrit) heal = Math.round(heal * 2); // v2.5 M3 医疗 8 阶：治疗暴击
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
          if (u.specialKw.includes('barrage')) { // 拉特兰[9→Large 并入 7] 弹幕风暴：多段普攻（每段分伤，命中至多 hits 个敌人）
            const bp = u.specialParams['barrage'] || {};
            const hits = bp.hits || 1, frac = (bp.spread != null) ? bp.spread : 1;
            const foes = all.filter(o => o.alive && o.side !== u.side).sort((a, b) => cheb(u, a) - cheb(u, b)).slice(0, hits);
            let line = u.name + ' 弹幕风暴';
            foes.forEach(fo => { const dmg = dealDamage(u, fo, u.atk * ramp * frac); line += ' → ' + fo.name + ' -' + dmg; if (!fo.alive) line += ' ☠'; });
            logBuf.push({ k: 'hit', line, dmgType: u.dmgType, side: u.side });
            u.cd = ATK(u);
          } else if (u.splash) { // v2 装备·弹幕装置（splash）：普攻对目标相邻敌人溅射
            const dmg = dealDamage(u, tgt, u.atk * ramp);
            let line = u.name + ' → ' + tgt.name + ' -' + dmg;
            if (!tgt.alive) line += ' ☠';
            all.forEach(o => {
              if (o.alive && o.side !== u.side && o !== tgt && cheb(o, tgt) <= 1) {
                const sd = dealDamage(u, o, u.atk * u.splash);
                line += ' (溅射 ' + o.name + ' -' + sd + ')';
              }
            });
            logBuf.push({ k: 'hit', line, dmgType: u.dmgType, side: u.side });
            u.cd = ATK(u);
          } else {
            let raw = u.atk * ramp;
            if (u.traits.indexOf('爆发') >= 0) raw *= 1.4;
            const dmg = dealDamage(u, tgt, raw);
            let line = u.name + ' → ' + tgt.name + ' -' + dmg;
            if (u.traits.indexOf('控场') >= 0 && Math.random() < 0.3) { tgt.stunUntil = t + 1.2; line += ' (眩晕)'; }
            else if (u.hitStun && Math.random() < u.hitStun) { tgt.stunUntil = t + 1.2; line += ' (震荡眩晕)'; } // v2.4 装备·震荡锤
            if (!tgt.alive) line += ' ☠';
            logBuf.push({ k: 'hit', line, dmgType: u.dmgType, side: u.side });
            u.cd = ATK(u);
          }
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
      // v2.4 可视化层：帧携带 burn/slow/revive 状态，供战斗演出切换视觉类
      const map = u => {
        const st = {
          uid: u.uid, name: u.name, hp: Math.max(0, Math.round(u.hp)), max: u.maxHp, alive: u.alive, x: u.x, y: u.y,
          sp: Math.round(u.sp), spMax: u.spMax, shield: Math.round(u.shield),
          burn: u.burn && t < u.burn.until ? 1 : 0,
          slow: u.slowUntil && t < u.slowUntil ? 1 : 0,
          reviving: u._reviveFx ? 1 : 0,
        };
        if (u._reviveFx) u._reviveFx = 0; // 一次性金光标记，仅复活当帧生效
        return st;
      };
      const lines = logBuf.slice(); logBuf.length = 0;
      const casts = castsThisSnap.slice(); castsThisSnap.length = 0;
      const fx = attackFxBuf.slice(); attackFxBuf.length = 0; // v2.5 弹道事件
      frames.push({ lines, ally: ally.map(map), enemy: enemy.map(map), casts, fx });
    }

    snap();
    let nextSample = SAMPLE_DT;
    const SUDDEN_MAX = 30; // 猝死阶段上限（秒），与 MAX_T 合计 ≤90s 必终结
    while (t < MAX_T + SUDDEN_MAX) {
      if (t >= MAX_T && !suddenDeath) {
        suddenDeath = true; // 进入猝死：禁用续航、无视护盾、伤害翻倍，强制打破僵局
      }
      step(); t += DT; tickIdx++;
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
      // 超时裁定：以「累计造成的总伤害」衡量谁更胜一筹（含护盾吸收量，去 ally 偏置）；等量再以剩余血量决胜
      const aD = stats.allyDmg, eD = stats.enemyDmg;
      if (aD > eD) winner = 'ally';
      else if (eD > aD) winner = 'enemy';
      else {
        const aHp = ally.reduce((s, u) => s + Math.max(0, u.hp), 0);
        const eHp = enemy.reduce((s, u) => s + Math.max(0, u.hp), 0);
        if (aHp > eHp) winner = 'ally';
        else if (eHp > aHp) winner = 'enemy';
        else winner = Math.random() < 0.5 ? 'ally' : 'enemy'; // 完全镜像真平局（aHp==eHp）：公平掷骰，去 ally 偏置（原 >= 恒判 ally）
      }
    }
    frames.push({ sys: true, line: winner === 'ally' ? '★ 我方胜利！' : '✗ 敌方胜利…' });
    return { winner, frames, aAlive, eAlive, stats };
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
    GRID_COLS, GRID_ROWS, FIELD_W, FIELD_H, makeCombatSummon, placeAdjacentSummons,
    grantSummonExp, summonLevelFromExp, SPECIAL, SIGNATURE, DIFFICULTY,
    EQUIP_POOL, EQUIP_BY_ID,  // v2.5 标定用：Node 侧构造装备
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  // 游戏状态对象：提到控制器之外，保证 Node 测试路径下也已初始化（引擎函数 applyBonds/generateEnemyTeam 依赖 G）
  let uidc = 1;
  G = {
    gold: 0, level: 1, exp: 0, hp: 100, maxHp: 100,
    winStreak: 0, lossStreak: 0,
    bench: [], board: {}, shop: [null, null, null, null, null],
    nodes: [], nodeIdx: 0, env: null, selected: null, difficulty: 2,
    strategies: [], stratCount: 0, freeRerollLeft: 0, encounterDiff: null, boardBonus: 0,
    phase: 'env', battleRes: null, frameTimer: null, _bfEls: {},
    // v2 装备：背包 + 干员槽位（仅本场，不写 Meta）
    equipState: { bag: [], slots: {} },
  };

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
  // v2.6 四轴分类：主类/子类/风险/成长 展示标签（risk 默认 safe，growth 默认 persistent）
  const STRAT_CAT_LABEL = { comp: '构型', rule: '规则', tempo: '经济', power: '强化' };
  const STRAT_RISK_LABEL = { safe: '', conditional: '条件', costly: '代价', gamble: '赌博' };
  const STRAT_GROWTH_LABEL = { instant: '即时', persistent: '持续', scaling: '成长' };
  const STRAT_ICON = {
    s_finance: '💰', s_train: '🎯', s_free: '🔄', s_sharp: '⚔', s_wall: '🛡', s_swift: '⚡',
    s_war: '🔥', s_rich: '💎', s_arm: '🪖', s_apoc: '🌟', s_core: '🧠',
    s_comp_pioneer: '🚩', s_comp_rhodes: '🏥', s_comp_guard: '🛡', s_comp_sig: '⭐', s_comp_sniper: '🎯',
    s_comp_xila: '🐺', s_comp_summon: '🐾', s_comp_front: '🧱', s_comp_back: '🔫', s_comp_mage: '🔮',
    s_comp_victoria: '⚔', s_comp_heat: '🔥', s_rule_bond: '🔗', s_rule_resonance: '💞', s_rule_expand: '📐',
    s_rule_vanguard: '📯', s_rule_warclan: '🎺', s_rule_revive: '💊', s_rule_synergy: '⚡',
    s_tempo_interest: '📈', s_tempo_streak: '🏆', s_tempo_gamble: '🎲', s_tempo_loan: '🏦'
  };
  // —— 策略节点卡池：四轴分类 v2（2026-08-15 重分类，22→60+ 扩充中）——
  // category：comp 阵容构型 / rule 规则改写 / tempo 经济引擎 / power 强化引擎（原 stat 已并入 power）
  // sub：A1-A4 / B1-B3 / C1-C4 / D1-D3（展示分组，不参与逻辑）
  // risk：safe 稳定 / conditional 条件 / costly 代价 / gamble 赌博（默认 safe）
  // growth：instant 即时 / persistent 持续 / scaling 成长（默认 persistent）
  // effects 键：
  //   全局（legacy）：goldPerRound / expPerRound / freeReroll / allAtkPct / allHpPct / allAspdPct / allMagicPct / sellValuePct / boardCapBonus
  //   定向（comp）：classBonusPct{职业:{atk,hp,def,crit,aspd,magicAmp,spInit,spRegen}} / factionBonusPct{阵营:{...}} / sigBonusPct / summonBonusPct / summonExpMult
  //   位置（comp）：roleAtkPct{front,back} / roleHpPct{front,back} / roleDefPct{front,back}（我方列 0-3，front=x>=2 临近敌方，back=x<=1）
  //   规则（rule）：bondEase / resonanceBonusPct
  //   新增（v2.6）：goldNow / expNow / interestRate / winStreakGold / startAspdPct / startSpPct / reviveOncePct / teamLifesteal / teamArmorShred / skillAmpPct
  //   sellValuePct 仅开局环境 ENV_POOL「黑市协议」在用（策略卡 s_black 已删：+50% 售价可低买高卖无限刷钱，超模）
  // 数值全 [PLACEHOLDER]，待 balance_sim.py 蒙特卡洛标定。
  const STRATEGY_POOL = [
    // ===== comp：阵容构型（12/29，引导"玩什么阵"）=====
    // A1 职业专精
    { id: 's_comp_pioneer', name: '先锋专精', tier: 'bronze', category: 'comp', sub: 'A1', desc: '先锋干员 +12% 攻击、+12% 生命。', effects: { classBonusPct: { '先锋': { atk: 0.12, hp: 0.12 } } } },
    { id: 's_comp_guard', name: '重装壁垒', tier: 'silver', category: 'comp', sub: 'A1', desc: '重装干员 +15% 防御、+12% 生命。', effects: { classBonusPct: { '重装': { def: 0.15, hp: 0.12 } } } },
    { id: 's_comp_sniper', name: '狙击专注', tier: 'gold', category: 'comp', sub: 'A1', desc: '狙击干员 +18% 攻击、+12% 暴击。', effects: { classBonusPct: { '狙击': { atk: 0.18, crit: 0.12 } } } },
    { id: 's_comp_mage', name: '术师奥能', tier: 'color', category: 'comp', sub: 'A1', desc: '术师干员 +20% 法强、+6 起手技力。', effects: { classBonusPct: { '术师': { magicAmp: 0.20, spInit: 6 } } } },
    // A2 阵营专精
    { id: 's_comp_rhodes', name: '罗德岛共识', tier: 'bronze', category: 'comp', sub: 'A2', desc: '罗德岛干员 +10% 治疗量、+10% 生命。', effects: { factionBonusPct: { '罗德岛': { healAmp: 0.10, hp: 0.10 } } } },
    { id: 's_comp_xila', name: '叙拉古家族', tier: 'gold', category: 'comp', sub: 'A2', desc: '叙拉古干员 +15% 暴击、+15% 攻速；狼群受益。', effects: { factionBonusPct: { '叙拉古': { crit: 0.15, aspd: 0.15 } } } },
    { id: 's_comp_victoria', name: '维多利亚骑士', tier: 'color', category: 'comp', sub: 'A2', desc: '维多利亚干员 +18% 攻击、+18% 防御。', effects: { factionBonusPct: { '维多利亚': { atk: 0.18, def: 0.18 } } } },
    { id: 's_comp_heat', name: '炎国烈焰', tier: 'color', category: 'comp', sub: 'A2', desc: '炎干员 +15% 生命、+15% 防御；灼烧受益。', effects: { factionBonusPct: { '炎': { hp: 0.15, def: 0.15 } } } },
    // A3 定位专精
    { id: 's_comp_front', name: '前排铁壁', tier: 'silver', category: 'comp', sub: 'A3', desc: '前排（临近敌方列）干员 +15% 防御、+15% 生命。', effects: { roleHpPct: { front: 0.15 }, roleDefPct: { front: 0.15 } } },
    { id: 's_comp_back', name: '后排火力', tier: 'gold', category: 'comp', sub: 'A3', desc: '后排（远离敌方列）干员 +18% 攻击。', effects: { roleAtkPct: { back: 0.18 } } },
    // A4 体系专精
    { id: 's_comp_summon', name: '召唤铺场', tier: 'gold', category: 'comp', sub: 'A4', desc: '召唤物 +20% 攻击、+20% 生命；召唤经验 +50%。', effects: { summonBonusPct: 0.20, summonExpMult: 0.50 } },
    { id: 's_comp_sig', name: '签名号令', tier: 'silver', category: 'comp', sub: 'A4', desc: '5 费签名干员 +15% 攻击、+15% 生命。', effects: { sigBonusPct: 0.15 } },
    // ===== rule：规则改写（7/29）=====
    // B1 羁绊规则
    { id: 's_rule_bond', name: '羁绊亲和', tier: 'silver', category: 'rule', sub: 'B1', desc: '所有羁绊阶位需求 -1（最低 1）。', effects: { bondEase: 1 } },
    { id: 's_rule_resonance', name: '呼应共振', tier: 'gold', category: 'rule', sub: 'B1', desc: '跨阵营呼应加成 +40%。', effects: { resonanceBonusPct: 0.40 } },
    // B2 棋盘规则
    { id: 's_rule_expand', name: '扩编令', tier: 'color', category: 'rule', sub: 'B2', growth: 'instant', desc: '部署上限 +1（满级可达 10 人口，解锁第 10 格）。', effects: { boardCapBonus: 1 } },
    // ===== tempo：经济引擎（8/29）=====
    // C1 稳定收益
    { id: 's_finance', name: '理财', tier: 'bronze', category: 'tempo', sub: 'C1', desc: '每回合 +2 金币。', effects: { goldPerRound: 2 } },
    { id: 's_train', name: '练兵', tier: 'bronze', category: 'tempo', sub: 'C1', desc: '每回合 +2 经验。', effects: { expPerRound: 2 } },
    { id: 's_rich', name: '厚赏', tier: 'gold', category: 'tempo', sub: 'C1', desc: '每回合 +4 金币、+3 经验。', effects: { goldPerRound: 4, expPerRound: 3 } },
    // C2 即时爆发
    { id: 's_free', name: '免费情报', tier: 'bronze', category: 'tempo', sub: 'C2', desc: '每回合 1 次免费刷新。', effects: { freeReroll: 1 } },
    // ===== power：强化引擎（2/29，原 stat 并入）=====
    // D1 全队属性
    { id: 's_sharp', name: '锋锐', tier: 'silver', category: 'power', sub: 'D1', desc: '全体干员 +8% 攻击。', effects: { allAtkPct: 0.08 } },
    { id: 's_wall', name: '坚壁', tier: 'silver', category: 'power', sub: 'D1', desc: '全体干员 +8% 生命。', effects: { allHpPct: 0.08 } },
    // ===== v2.6 P3 首批新卡（rule B3 战斗规则 4 张 + tempo C4 风险投资 4 张，覆盖 条件/代价/赌博 标签；s_black 已删）=====
    // B3 战斗规则
    { id: 's_rule_vanguard', name: '开局号令', tier: 'gold', category: 'rule', sub: 'B3', risk: 'safe', growth: 'instant', desc: '战斗开始全体干员攻速 +30%。', effects: { startAspdPct: 0.30 } },
    { id: 's_rule_synergy', name: '兵贵神速', tier: 'bronze', category: 'rule', sub: 'B3', risk: 'safe', growth: 'instant', desc: '战斗开始全体干员起手技力 +5。', effects: { startSpPct: 5 } },
    { id: 's_rule_revive', name: '战场急救', tier: 'silver', category: 'rule', sub: 'B3', risk: 'conditional', desc: '全队首次阵亡时以 20% 血量复活一次（每场仅一次）。', effects: { reviveOncePct: 0.20 } },
    { id: 's_rule_warclan', name: '先声夺人', tier: 'color', category: 'rule', sub: 'B3', risk: 'costly', growth: 'instant', desc: '战斗开始全体起手技力 +12，但全队攻速 -10%。', effects: { startSpPct: 12, allAspdPct: -0.10 } },
    // C4 风险投资
    { id: 's_tempo_interest', name: '利息协议', tier: 'bronze', category: 'tempo', sub: 'C4', risk: 'safe', growth: 'scaling', desc: '每回合金币利息 +50%（滚雪球越滚越多）。', effects: { interestRate: 0.5 } },
    { id: 's_tempo_streak', name: '连胜赏金', tier: 'silver', category: 'tempo', sub: 'C4', risk: 'conditional', desc: '连胜或连败 ≥2 时，每回合额外 +2 金币。', effects: { winStreakGold: 2 } },
    { id: 's_tempo_gamble', name: '赌徒协议', tier: 'gold', category: 'tempo', sub: 'C4', risk: 'gamble', growth: 'instant', desc: '立即掷骰：50% 得 12 金币，50% 失去 4 金币。', effects: { goldGamble: 12 } },
    { id: 's_tempo_loan', name: '高利贷', tier: 'color', category: 'tempo', sub: 'C4', risk: 'costly', growth: 'instant', desc: '立即 +18 金币，但此后每回合 -3 金币。', effects: { goldNow: 18, goldPerRound: -3 } },
  ];  const STRATEGY_BY_ID = {}; STRATEGY_POOL.forEach(s => STRATEGY_BY_ID[s.id] = s);

  // v3.0 行为 kw → 中文标签（羁绊/独行 behavior 展示用）
  const KW_LABEL = {
    healAura: '治疗光环', healCrit: '治疗暴击', triage: '复活', shieldPeriodic: '周期护盾', counter: '反伤',
    damageReduction: '减伤', critDmg: '暴伤', splash: '溅射', pierce: '破甲', execute: '处决',
    globalAspd: '攻速光环', castAmp: '咏唱强化', spRegenBuff: '技力加速', goldOnKill: '击杀回费',
    berzerk: '狂暴', quickStart: '开局爆发', lifesteal: '吸血', trueDmg: '真伤', defShred: '破防',
    overload: '周期法爆', slowAura: '减速光环', guardAura: '协防', infernoRally: '攻强光环',
    knightBanner: '攻光环', capo: '狼群攻速', barrage: '多段普攻', burnDoT: '灼烧', rampHit: '渐强叠印',
    summonWolf: '召唤狼', revive: '复活',
  };
  const kwLabel = (kw) => KW_LABEL[kw] || kw;

  // 汇总已选策略的全局 / 定向 / 规则效果
  function aggregateStrategies() {
    const acc = {
      goldPerRound: 0, expPerRound: 0, freeReroll: 0, allAtkPct: 0, allHpPct: 0, allAspdPct: 0, allMagicPct: 0, sellValuePct: 0, boardCapBonus: 0,
      classBonusPct: {}, factionBonusPct: {}, sigBonusPct: 0, summonBonusPct: 0, summonExpMult: 0,
      roleAtkPct: {}, roleHpPct: {}, roleDefPct: {}, resonanceBonusPct: 0, bondEase: 0,
      goldNow: 0, expNow: 0, interestRate: 0, winStreakGold: 0, goldGamble: 0, startAspdPct: 0, startSpPct: 0,
      reviveOncePct: 0, teamLifesteal: 0, teamArmorShred: 0, skillAmpPct: 0
    };
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
      if (e.sigBonusPct) acc.sigBonusPct += e.sigBonusPct;
      if (e.summonBonusPct) acc.summonBonusPct += e.summonBonusPct;
      if (e.summonExpMult) acc.summonExpMult += e.summonExpMult;
      if (e.resonanceBonusPct) acc.resonanceBonusPct += e.resonanceBonusPct;
      if (e.bondEase) acc.bondEase += e.bondEase;
      if (e.goldNow) acc.goldNow += e.goldNow;
      if (e.goldGamble) acc.goldGamble += e.goldGamble;
      if (e.expNow) acc.expNow += e.expNow;
      if (e.interestRate) acc.interestRate += e.interestRate;
      if (e.winStreakGold) acc.winStreakGold += e.winStreakGold;
      if (e.startAspdPct) acc.startAspdPct += e.startAspdPct;
      if (e.startSpPct) acc.startSpPct += e.startSpPct;
      if (e.reviveOncePct) acc.reviveOncePct += e.reviveOncePct;
      if (e.teamLifesteal) acc.teamLifesteal += e.teamLifesteal;
      if (e.teamArmorShred) acc.teamArmorShred += e.teamArmorShred;
      if (e.skillAmpPct) acc.skillAmpPct += e.skillAmpPct;
      const mergeMap = (src, dst) => { if (!src) return; Object.keys(src).forEach(k => { const t = dst[k] || (dst[k] = {}); const v = src[k]; Object.keys(v).forEach(a => { t[a] = (t[a] || 0) + v[a]; }); }); };
      mergeMap(e.classBonusPct, acc.classBonusPct);
      mergeMap(e.factionBonusPct, acc.factionBonusPct);
      mergeMap(e.roleAtkPct, acc.roleAtkPct);
      mergeMap(e.roleHpPct, acc.roleHpPct);
      mergeMap(e.roleDefPct, acc.roleDefPct);
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

  function getPromote() {
    try { return parseInt(localStorage.getItem(PROMOTE_KEY) || '0', 10) || 0; } catch (e) { return 0; }
  }
  function setPromote(v) { try { localStorage.setItem(PROMOTE_KEY, String(v)); } catch (e) { } }

  function effCost(op) {
    let c = op.stats.cost;
    if (G.env && G.env.effects && G.env.effects.discount) c -= G.env.effects.discount;
    return Math.max(1, c);
  }

  // 统一棋盘 8×6：左半 24 格（列 0-3）供我方部署（全部可放），右半 24 格（列 4-7）为敌方站位预览
  // 人口限制的是"场上角色总数"，而非解锁格子数
  const MAX_BOARD_SLOTS = 48;
  function boardCap() { return Math.min(MAX_BOARD_SLOTS, G.level + (G.boardBonus || 0)); }
  function isLeftSlot(i) { return (i % 8) < 4; }
  function boardCount() { return Object.keys(G.board).length; }

  function rnd(a, b) { return a + Math.floor(Math.random() * (b - a + 1)); }
  function shuffle(arr) { const a = arr.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1));[a[i], a[j]] = [a[j], a[i]]; } return a; }

  /* ---- 渲染 ---- */
  /* ===== v2.4 统一动效系统：飘字/粒子/涟漪/震屏，respects prefers-reduced-motion ===== */
  const FX = (function () {
    let reduced = false;
    try { reduced = (typeof window !== 'undefined' && !!window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches); } catch (e) {}
    function mk(className, x, y, html) {
      if (reduced || typeof document === 'undefined') return null;
      const d = document.createElement('div');
      d.className = className;
      d.style.left = x + 'px'; d.style.top = y + 'px';
      if (html != null) d.innerHTML = html;
      document.body.appendChild(d);
      return d;
    }
    function floatText(x, y, text, cls) {
      const d = mk('fx-float ' + (cls || ''), x, y, text);
      if (d) setTimeout(function () { d.remove(); }, 1100);
    }
    function burst(x, y, n, color, cls) {
      if (!n || typeof document === 'undefined' || reduced) return;
      const arr = [];
      for (let i = 0; i < n; i++) {
        const sp = mk('fx-particle ' + (cls || ''), x, y);
        if (!sp) return;
        if (color) sp.style.background = color;
        const ang = Math.random() * Math.PI * 2;
        const dist = 18 + Math.random() * 34;
        sp.style.setProperty('--dx', (Math.cos(ang) * dist) + 'px');
        sp.style.setProperty('--dy', (Math.sin(ang) * dist) + 'px');
        arr.push(sp);
      }
      setTimeout(function () { arr.forEach(x2 => x2.remove()); }, 700);
    }
    function ripple(x, y, color) {
      const d = mk('fx-ripple', x - 16, y - 16);
      if (d) { if (color) d.style.borderColor = color; setTimeout(function () { d.remove(); }, 600); }
    }
    function shake(ms, dist) {
      if (reduced || typeof document === 'undefined') return;
      const b = document.body;
      ms = ms || 130; dist = dist || 6;
      b.classList.remove('fx-shake'); void b.offsetWidth;
      b.style.setProperty('--shake-dist', dist + 'px');
      b.style.setProperty('--shake-ms', ms + 'ms');
      b.classList.add('fx-shake');
      setTimeout(function () { b.classList.remove('fx-shake'); }, ms);
    }
    return { reduced: reduced, floatText: floatText, burst: burst, ripple: ripple, shake: shake };
  })();

  function renderTop() {
    const ge = $('gold');
    if (G._lastGold != null && ge && G._lastGold !== G.gold) {
      try {
        const r = ge.getBoundingClientRect();
        if (r && (r.width || r.height)) FX.floatText(r.left + r.width / 2, r.top + 10, (G.gold > G._lastGold ? '+' : '') + (G.gold - G._lastGold), G.gold > G._lastGold ? 'gold' : 'red');
        ge.classList.remove('num-pop'); void ge.offsetWidth; ge.classList.add('num-pop');
      } catch (e) {}
    }
    G._lastGold = G.gold;
    ge.textContent = G.gold;
    // v2.5 经济可视化：顶栏显示下回合预期收入（基础 + 利息 + 连胜，hover 看明细）
    try {
      const gn = $('goldNext');
      if (gn) {
        const se = (typeof aggregateStrategies === 'function') ? aggregateStrategies() : {};
        const ef = (G.env && G.env.effects) || {};
        const round = G.nodeIdx + 1;
        const interestMax = 5 + (ef.interestMax || 0);
        const interest = Math.min(interestMax, Math.floor(G.gold / 10) * (1 + (se.interestRate || 0)));
        const stk = Math.max(G.winStreak, G.lossStreak);
        let streakBonus = 0;
        if (stk >= 2 && stk <= 3) streakBonus = 1; else if (stk >= 4 && stk <= 5) streakBonus = 2; else if (stk >= 6) streakBonus = 3;
        if (stk >= 2) streakBonus += (se.winStreakGold || 0);
        const base = Math.min(round + 2, 7);
        const total = base + interest + streakBonus + (se.goldPerRound || 0);
        gn.textContent = '＋' + total;
        gn.title = '下回合收入：基础 ' + base + ' + 利息 ' + interest + (streakBonus ? ' + 连胜 ' + streakBonus : '') + (se.goldPerRound ? ' + 策略 ' + se.goldPerRound : '');
      }
    } catch (e) {}
    // v2.5 经济可视化：顶栏显示下回合预期收入（基础 + 利息 + 连胜，hover 看明细）
    try {
      const gn = $('goldNext');
      if (gn) {
        const se = (typeof aggregateStrategies === 'function') ? aggregateStrategies() : {};
        const ef = (G.env && G.env.effects) || {};
        const round = G.nodeIdx + 1;
        const interestMax = 5 + (ef.interestMax || 0);
        const interest = Math.min(interestMax, Math.floor(G.gold / 10) * (1 + (se.interestRate || 0)));
        const stk = Math.max(G.winStreak, G.lossStreak);
        let streakBonus = 0;
        if (stk >= 2 && stk <= 3) streakBonus = 1; else if (stk >= 4 && stk <= 5) streakBonus = 2; else if (stk >= 6) streakBonus = 3;
        if (stk >= 2) streakBonus += (se.winStreakGold || 0);
        const base = Math.min(round + 2, 7);
        const total = base + interest + streakBonus + (se.goldPerRound || 0);
        gn.textContent = '＋' + total;
        gn.title = '下回合收入：基础 ' + base + ' + 利息 ' + interest + (streakBonus ? ' + 连胜 ' + streakBonus : '') + (se.goldPerRound ? ' + 策略 ' + se.goldPerRound : '');
      }
    } catch (e) {}
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

  // v2.5 M1：取干员当前星级技能（1★[0]/2★[1]/3★[2]；缺参数或没有 skillsAll 回退 op.skill）
  function skillFor(op, star) {
    const idx = star >= 3 ? 2 : (star === 2 ? 1 : 0);
    const all = (op.skillsAll && op.skillsAll.length) ? op.skillsAll : null;
    const cand = all && all[idx] && (all[idx].archetype || all[idx].effect) ? all[idx] : null;
    return cand || op.skill || null;
  }
  function skillLabelFor(u) {
    const s = skillFor(u.op, u.star);
    return s ? (s.name || s.archLabel || '') : '';
  }

  function unitCard(u, where) {
    const op = u.op;
    const sel = G.selected === u.uid ? ' sel' : '';
    const cost = op.stats.cost;
    const role = op.bonds && op.bonds['职业'];
    const aff = op.bonds && op.bonds['阵营'];
    const skArch = skillLabelFor(u); // v2.5 M1：按星级显示技能名
    // v2 装备角标：该干员 2 槽装备（背包待穿时显示空槽提示）
    let eqBadges = '';
    try {
      const slots = (G.equipState && G.equipState.slots && G.equipState.slots[u.uid]) || [];
      if (slots.length || G._eqPending != null) {
        eqBadges = '<span class="eq-badges">' +
          [0, 1].map(i => {
            const eqId = slots[i];
            const e = eqId ? EQUIP_BY_ID[eqId] : null;
            return '<span class="eq-slot' + (e ? ' rarity' + e.rarity : ' empty') + '" data-eq-unequip="' + u.uid + '" data-eq-slot="' + i + '" title="' + (e ? (e.name || e.id) + '：' + e.desc + '（点击卸下）' : '空槽（点背包装备后点干员穿戴）') + '">' +
              (e ? (e.icon || (e.type === 'engraving' ? '◎' : e.type === 'attr' ? '⬆' : '✦')) : '+') +
            '</span>';
          }).join('') + '</span>';
      }
    } catch (err) {}
    const _cls = 'ucard c' + cost + sel + (where === 'board' ? ' board-lite' : '');
    return '<div class="' + _cls + '" data-uid="' + u.uid + '" data-where="' + where + '">' +
      '<img class="avatar" src="' + op.avatar + '" alt="" loading="lazy" decoding="async" onerror="this.style.background=\'#222\'">' +
      '<div class="card-fade"></div>' +
      '<div class="card-tags">' +
        (role ? '<span class="ctag"><span class="ctag-icon">⚔</span><span class="ctag-txt">' + role + '</span></span>' : '') +
        (aff ? '<span class="ctag"><span class="ctag-icon">◎</span><span class="ctag-txt">' + aff + '</span></span>' : '') +
        (skArch ? '<span class="ctag ctag-sk"><span class="ctag-icon">✦</span><span class="ctag-txt">' + skArch + '</span></span>' : '') +
      '</div>' +
      '<div class="card-footer"><span class="cf-name">' + op.name + '</span>' +
        '<span class="cf-cost">' + cost + '</span></div>' +
      (u.star > 1 ? '<span class="star">' + starStr(u.star) + '</span>' : '') +
      eqBadges +
    '</div>';
  }

  function firstFreeSlot() {
    if (boardCount() >= boardCap()) return null;
    for (let i = 0; i < 48; i++) { if (isLeftSlot(i) && !G.board[i]) return i; }
    return null;
  }
  function slotOf(uid) {
    for (const k in G.board) if (G.board[k].uid === uid) return parseInt(k, 10);
    return null;
  }

  // 棋盘射程高亮：选中（或悬停）单位时，按 cheb(自身格, 目标格) <= range 高亮其射程覆盖格（含敌方半场）。
  let _hoverSlot = null;
  function highlightRange() {
    const b = $('board'); if (!b) return;
    const cells = b.querySelectorAll('.board-cell');
    let active = _hoverSlot;
    if (active == null && G.selected != null) {
      const s = slotOf(G.selected);
      if (s != null && G.board[s]) active = s;
    }
    cells.forEach(c => c.classList.remove('in-range'));
    if (active == null || !G.board[active]) return;
    const op = G.board[active].op;
    const rng = rangeOf(op);
    const p = slotToXY(active);
    cells.forEach(c => {
      const i = +c.dataset.slot;
      c.removeAttribute('data-range');
      if (i === active) return;                 // 不标自身格
      const q = slotToXY(i);
      const d = Math.max(Math.abs(p.x - q.x), Math.abs(p.y - q.y));
      if (d <= rng) { c.classList.add('in-range'); c.setAttribute('data-range', rng); }
      else c.classList.remove('in-range');
    });
  }

  function renderBoard() {
    const b = $('board');
    let html = '';
    // 固定渲染 8×6=48 格：左半 24 格（列 0-3）全部为我方部署位，右半 24 格（列 4-7）为敌方站位预览底格
    for (let i = 0; i < 48; i++) {
      const col = i % 8;
      const u = G.board[i];
      if (col >= 4) {
        html += '<div class="board-cell enemy-zone" data-slot="' + i + '" tabindex="-1" aria-disabled="true"></div>';
      } else if (u) {
        html += '<div class="board-cell filled" data-slot="' + i + '" tabindex="0">' + unitCard(u, 'board') + '</div>';
      } else {
        html += '<div class="board-cell" data-slot="' + i + '" tabindex="0"></div>';
      }
    }
    b.innerHTML = html;
    $('boardCap').textContent = boardCount() + '/' + boardCap();
    const benchHtml = G.bench.map(u => unitCard(u, 'bench')).join('') || '<div class="slot empty"></div>';
    $('bench').innerHTML = benchHtml;
    $('benchCap').textContent = G.bench.length + '/' + BENCH_CAP;
    benchWarn();
    // 射程高亮：#board 元素本身不被重建，一次性绑定 hover 委托即可
    if (!b._rb) {
      b._rb = true;
      b.addEventListener('mouseover', e => { const c = e.target.closest && e.target.closest('.board-cell'); if (!c) return; const i = +c.dataset.slot; if (G.board[i]) { _hoverSlot = i; highlightRange(); } });
      b.addEventListener('mouseout', e => { const c = e.target.closest && e.target.closest('.board-cell'); if (!c) return; _hoverSlot = null; highlightRange(); });
    }
    highlightRange();
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
      // v2.4 升星提示：买这张能升星 → 卡面闪烁星星（能升 2 星闪 ★★，3 星闪 ★★★）
      const starGain = predictStarGain(op);
      // 方舟风格卡片：大头像 + 底部信息栏 + 标签叠层
      return '<div class="ucard shop-card c' + cost + afford + '" data-shop="' + i + '" style="animation-delay:' + (i * 70) + 'ms">' +
        (starGain >= 2 ? '<span class="star-hint s' + starGain + '">' + '★'.repeat(starGain) + '</span>' : '') +
        '<img class="avatar" src="' + op.avatar + '" alt="" loading="lazy" decoding="async" onerror="this.style.background=\'#222\'">' +
        '<div class="card-fade"></div>' +
        '<div class="card-tags">' +
          (role ? '<span class="ctag"><span class="ctag-icon">⚔</span><span class="ctag-txt">' + role + '</span></span>' : '') +
          (aff ? '<span class="ctag"><span class="ctag-icon">◎</span><span class="ctag-txt">' + aff + '</span></span>' : '') +
          (op.skill ? '<span class="ctag ctag-sk"><span class="ctag-icon">✦</span><span class="ctag-txt">' + op.skill.archLabel + '</span></span>' : '') +
        '</div>' +
        '<div class="card-footer">' +
          '<span class="cf-name">' + op.name + '</span>' +
          '<span class="cf-cost">' + cost + '</span>' +
        '</div>' +
      '</div>';
    }).join('');
    const capEl = $('shopCapHint');
    if (capEl) capEl.textContent = 'Lv.' + G.level + ' · 商店最高 ' + maxShopCost(G.level) + ' 费';
    renderFeedPanel();
    renderEquipPanel();
  }

  // v2 装备：商店装备行（刷新 1 件可购）+ 背包行 + 穿戴交互
  const RARITY_LABEL = ['白', '蓝', '紫', '橙'];
  function maxEquipRarity(level) { return level >= 8 ? 3 : level >= 7 ? 2 : level >= 5 ? 1 : 0; } // [PLACEHOLDER] 等级解锁
  function rollEquipShop() {
    if (Math.random() < 0.4) { // [PLACEHOLDER] 40% 概率刷 1 件
      const mr = maxEquipRarity(G.level);
      const pool = EQUIP_POOL.filter(e => e.rarity <= mr);
      if (pool.length) G._equipShop = pool[Math.floor(Math.random() * pool.length)].id;
      else G._equipShop = null;
    } else G._equipShop = null;
  }
  function renderEquipPanel() {
    const panel = $('equipPanel'); if (!panel) return;
    panel.classList.remove('hidden');
    const shopRow = $('equipShopRow'), bagRow = $('equipBagRow'), msg = $('equipMsg');
    if (msg) msg.textContent = '';
    // 商店可购行
    const es = G._equipShop ? EQUIP_BY_ID[G._equipShop] : null;
    shopRow.innerHTML = es
      ? '<div class="equip-card rarity' + es.rarity + (G.gold >= es.cost ? '' : ' locked') + '" data-eq-shop="' + es.id + '" title="' + (es.flavor || '') + '">' +
          '<span class="eq-rarity">' + RARITY_LABEL[es.rarity] + '</span>' +
          '<span class="eq-icon">' + (es.icon || '⚒') + '</span>' +
          '<span class="eq-name">' + (es.name || es.id) + '</span>' +
          '<span class="eq-desc">' + es.desc + '</span>' +
          '<span class="eq-cost">' + es.cost + '💰</span>' +
        '</div>'
      : '<span class="hint">本回合无装备出售</span>';
    // 背包行（可点击 → 标记待穿，再点干员）
    const bag = G.equipState && G.equipState.bag || [];
    bagRow.innerHTML = bag.length
      ? bag.map((eqId, i) => {
          const e = EQUIP_BY_ID[eqId];
          return '<div class="equip-card rarity' + e.rarity + (G._eqPending === i ? ' pending' : '') + '" data-eq-bag="' + i + '" title="' + (e.flavor || '点击选中，再点场上/备战席干员穿戴') + '">' +
            '<span class="eq-rarity">' + RARITY_LABEL[e.rarity] + '</span>' +
            '<span class="eq-icon">' + (e.icon || '⚒') + '</span>' +
            '<span class="eq-name">' + (e.name || e.id) + '</span>' +
            '<span class="eq-desc">' + e.desc + '</span>' +
            '<span class="eq-sell" data-eq-sell="' + i + '">卖 ' + Math.round(e.cost * 0.6) + '💰</span>' +
          '</div>';
        }).join('')
      : '<span class="hint">背包为空</span>';
  }
  function buyEquip(eqId) {
    const e = EQUIP_BY_ID[eqId]; if (!e) return;
    if (G.gold < e.cost) { flash('金币不足'); return; }
    G.gold -= e.cost; G._equipShop = null;
    G.equipState.bag.push(eqId);
    if (window.SFX) SFX.play('buy');
    renderAll(); saveGame();
  }
  function equipToUnit(uid, eqId) {
    if (!G.equipState.slots[uid]) G.equipState.slots[uid] = [null, null];
    const idx = G.equipState.slots[uid].indexOf(null);
    if (idx < 0) { flash('该干员 2 槽已满，先卸下一件'); return; }
    G.equipState.slots[uid][idx] = eqId;
    G.equipState.bag.splice(G._eqPending, 1);
    G._eqPending = null;
    if (window.SFX) SFX.play('select');
    renderAll(); saveGame();
  }
  function unequip(uid, idx) {
    const eqId = G.equipState.slots[uid][idx];
    if (!eqId) return;
    G.equipState.bag.push(eqId);
    G.equipState.slots[uid][idx] = null;
    renderAll(); saveGame();
  }
  function sellEquip(bagIdx) {
    const e = EQUIP_BY_ID[G.equipState.bag[bagIdx]];
    if (!e) return;
    G.gold += Math.round(e.cost * 0.6); // [PLACEHOLDER] 出售回收 60%
    G.equipState.bag.splice(bagIdx, 1);
    if (window.SFX) SFX.play('sell');
    renderAll(); saveGame();
  }

  // v2.1 养狼：商店喂养面板（仅当作战区有叙拉古干员时显示）
  function renderFeedPanel() {
    const panel = $('feedPanel'); if (!panel) return;
    const hasXila = Object.values(G.board).some(u => u.op.bonds && u.op.bonds['阵营'] === '叙拉古');
    if (!hasXila) { panel.classList.add('hidden'); return; }
    panel.classList.remove('hidden');
    const ss = G.summonState || { wolf: { level: 1, exp: 0 } };
    const lv = ss.wolf.level, exp = ss.wolf.exp;
    const lo = SUMMON_LEVEL_EXP[Math.min(lv, SUMMON_MAX_LEVEL) - 1];
    const hi = (lv >= SUMMON_MAX_LEVEL) ? lo : SUMMON_LEVEL_EXP[lv];
    const span = Math.max(1, hi - lo);
    const cur = Math.max(0, exp - lo);
    const pct = Math.min(100, Math.round(cur / span * 100));
    const lvEl = $('feedLv'); if (lvEl) lvEl.textContent = 'Lv.' + lv + (lv >= SUMMON_MAX_LEVEL ? '（满）' : '');
    const fill = $('feedExpFill'); if (fill) fill.style.width = pct + '%';
    const txt = $('feedExpTxt'); if (txt) txt.textContent = (lv >= SUMMON_MAX_LEVEL) ? 'MAX' : (cur + ' / ' + span);
    const meatBtn = $('btnFeedMeat'); if (meatBtn) meatBtn.disabled = G.gold < 3;
    const rationBtn = $('btnFeedRation'); if (rationBtn) rationBtn.disabled = G.gold < 5;
    const msg = $('feedMsg'); if (msg) msg.textContent = '';
    // v2.1 UI：形态图标 + 主题色 + 升级闪光特效（狼崽 🐾 / 成年狼 🐺 / 狼王 👑）
    const form = lv >= SUMMON_MAX_LEVEL ? 'king' : (lv >= 3 ? 'adult' : 'pup');
    const formIcon = form === 'king' ? '👑' : (form === 'adult' ? '🐺' : '🐾');
    panel.classList.remove('form-pup', 'form-adult', 'form-king');
    panel.classList.add('form-' + form);
    const fi = $('feedForm'); if (fi) fi.textContent = formIcon;
    if (G._feedShownWolfLv !== undefined && lv > G._feedShownWolfLv) {
      panel.classList.remove('flash'); void panel.offsetWidth; panel.classList.add('flash'); // 重启动画
      if (fi) { fi.classList.remove('bump'); void fi.offsetWidth; fi.classList.add('bump'); }
    }
    G._feedShownWolfLv = lv;
  }

  // v2.1 养狼：商店购买喂养（生肉 +EXP / 战前口粮 临时加成下一场）
  function buyFeed(kind) {
    if (!G.summonState) G.summonState = { wolf: { level: 1, exp: 0 }, beast: { level: 1, exp: 0 }, feedAtk: 0, feedHp: 0 };
    const ss = G.summonState;
    if (kind === 'meat') {
      if (G.gold < 3) return;
      G.gold -= 3;
      ss.wolf.exp += 30; // [PLACEHOLDER] 生肉 EXP
      ss.wolf.level = summonLevelFromExp(ss.wolf.exp);
      ss.beast.exp += Math.floor(30 * 0.6); // 岁兽同步 60%
      ss.beast.level = summonLevelFromExp(ss.beast.exp);
      if (window.AUDIO) AUDIO.play('wolf/feed');
    } else if (kind === 'ration') {
      if (G.gold < 5) return;
      G.gold -= 5;
      ss.feedAtk = (ss.feedAtk || 0) + 0.10; // [PLACEHOLDER] 战前口粮 攻+10%
      ss.feedHp = (ss.feedHp || 0) + 0.10;  // [PLACEHOLDER] 血+10%
      if (window.AUDIO) AUDIO.play('wolf/feed');
    }
    if (typeof renderTop === 'function') renderTop();
    renderShop(); renderFeedPanel();
  }

  function renderBonds() {
    const boardMembers = Object.values(G.board).map(u => ({ name: u.op.name, bonds: u.op.bonds, star: u.star }));
    const { active } = computeBonds(boardMembers);
    // v2.5 羁绊规划器：统计场上各 (axis|value) 计数，未激活条目给出「还差 N 激活」；已激活 chip 给「下一阶还差 N」
    // v2.5 羁绊规划器：统计场上各 (axis|value) 计数，未激活条目给出「还差 N 激活」；已激活 chip 给「下一阶还差 N」
    const cntMap = {};
    boardMembers.forEach(m => { if (m.bonds) for (const ax in m.bonds) { const key = ax + '|' + m.bonds[ax]; cntMap[key] = (cntMap[key] || 0) + 1; } });
    const activeKeys = new Set(active.map(b => b.axis + '|' + b.value));
    const pendHtml = [];
    for (const key in cntMap) {
      if (activeKeys.has(key)) continue;
      const sp = key.indexOf('|');
      const ax = key.slice(0, sp), val = key.slice(sp + 1);
      const cfg = BONDS[ax] && BONDS[ax][val];
      if (!cfg || !cfg.thr || !cfg.thr.length) continue;
      const need = cfg.thr[0] - cntMap[key];
      if (need <= 0) continue;
      pendHtml.push('<div class="bond pending" data-axis="' + ax + '" data-value="' + val + '" title="再上 ' + need + ' 名「' + val + '」干员可激活首阶"><b>' + ax + '·' + val + '</b> <span class="tier">还差 ' + need + ' 激活</span></div>');
    }
    // —— 跨阵营呼应（Narrative Resonance）：取作战区所有阵营键，二次结算隐藏呼应对 ——
    const facSet = new Set();
    Object.values(G.board).forEach(u => { const f = u.op.bonds && u.op.bonds['阵营']; if (f) facSet.add(f); });
    const reso = (typeof RESONANCE !== 'undefined') ? RESONANCE.compute(facSet) : [];
    const bar = $('bondsBar');
    if (!active.length && !reso.length) { bar.innerHTML = '<span class="hint" style="font-size:12px">上场干员凑齐同职业/阵营可触发羁绊；部分阵营同场会触发隐藏呼应</span>'; G._activeBondKeys = null; const c0=$('bondsCount'); if(c0) c0.textContent='0'; return; }
    // 羁绊解锁音效：仅当新增了此前未激活的羁绊档位 / 新呼应对时触发（首帧/清空不触发）
    const newKeys = active.map(b => b.axis + '|' + b.value + '|' + b.tier);
    const freshKeys = new Set(G._activeBondKeys ? newKeys.filter(k => G._activeBondKeys.indexOf(k) < 0) : []);
    reso.forEach(p => newKeys.push('reso|' + p.a + '|' + p.b));
    // —— v2.4 演出层：capstone / deep 深度阶解锁时全屏横幅（普通 tier 升级只播轻音效）——
    if (G._activeBondKeys && window.AUDIO) {
      freshKeys.forEach(k => {
        if (1) {
          AUDIO.play('strategic/bond_unlock');
          try { const pp = k.split('|'); if (pp.length === 3 && typeof window !== 'undefined' && window.innerWidth) { FX.floatText(window.innerWidth / 2, 120, pp[0] + '·' + pp[1] + ' ' + pp[2] + '阶激活！', 'gold'); FX.shake(120, 3); } } catch (e) {}
          const parts = k.split('|');
          if (parts.length === 3 && parts[0] === '阵营') {
            const v = parts[1], tier = parseInt(parts[2], 10);
            const sp = SPECIAL[v];
            const isCap = sp && tier >= sp.tier;
            const isDeep = sp && sp.deep && Object.keys(sp.deep).some(dk => parseInt(dk, 10) === tier);
            if (isCap || isDeep) {
              const deepLabel = isDeep ? (sp.deep[tier] && sp.deep[tier].label) : null;
              showBondBanner(v, isDeep ? deepLabel : (sp.kw ? describeSpecial({ kw: sp.kw, params: sp.params }) : null), tier, isDeep);
            }
          }
        }
      });
    }
    G._activeBondKeys = newKeys;
    let html = active.map(b => {
      const bn = b.bonus || {};
      const parts = [];
      const pct = (k, lbl) => { if (bn[k]) parts.push(lbl + '+' + Math.round(bn[k] * 100) + '%'); };
      pct('atk', '攻'); pct('hp', '血'); pct('def', '防'); pct('aspd', '速'); pct('crit', '暴'); pct('magicAmp', '法'); pct('healAmp', '疗'); pct('spRegen', '技回');
      if (bn.spInit) parts.push('技力+' + bn.spInit);
      // 叙事 flavor：悬浮提示用阵营 capstone（剥离【台词出处】角标，保持 UI 干净）
      const flav = (typeof BONDS_FLAVOR !== 'undefined' && BONDS_FLAVOR.faction) ? BONDS_FLAVOR.faction[b.value] : null;
      const tip = (flav && flav.cap) ? flavorText(flav.cap).slice(0, 46) : '点击查看羁绊详情';
      // v3.0 行为标签（职业/阵营 behavior）：3/5 阶质变提示
      const behTxt = b.beh ? ' <span class="beh">' + b.beh.split('+').map(k => kwLabel(k)).join('+') + '</span>' : '';
      const _thr = (BONDS[b.axis] && BONDS[b.axis][b.value] && BONDS[b.axis][b.value].thr) || [];
      const _ti = _thr.indexOf(b.tier);
      const _next = _thr[_ti + 1];
      const _need = _next ? (_next - b.count) : 0;
      return '<div class="bond' + (freshKeys.has(b.axis + '|' + b.value + '|' + b.tier) ? ' fresh' : '') + '" data-axis="' + b.axis + '" data-value="' + b.value + '" data-tier="' + b.tier + '" title="' + tip.replace(/"/g, '&quot;') + '"><b>' + b.axis + '·' + b.value + '</b> <span class="tier">' + b.tier + '阶 (' + b.count + ')</span> ' + parts.join(' ') + behTxt + (_need > 0 ? ' <span class="bond-next">下一阶还差' + _need + '</span>' : '') + '</div>';
    }).join('');
    // v2.5 规划器：未激活但有干员的条目（淡色，提示还差几张激活）
    html += pendHtml.join('');
    // v2.5 规划器：未激活但有干员的条目（淡色，提示还差几张激活）
    html += pendHtml.join('');
    // 呼应 chips：独立于普通羁绊，青色标识，点击看呼应详情
    html += reso.map(p => {
      const cls = 'reso' + (p.confidence === 'gap' ? ' gap' : '') + (p.creative ? ' creative' : '');
      return '<div class="' + cls + '" data-a="' + p.a + '" data-b="' + p.b + '" title="' + (p.flavor ? flavorText(p.flavor).slice(0, 46).replace(/"/g, '&quot;') : '点击查看阵营呼应') + '">' +
        '<b>呼应 · ' + p.a + ' ⊕ ' + p.b + '</b>' + (p.creative ? '<span class="reso-flag">✦推演</span>' : '') + '</div>';
    }).join('');
    bar.innerHTML = html;
    const c1=$('bondsCount'); if(c1) c1.textContent=active.length + reso.length;
    bar.querySelectorAll('.bond').forEach(el => el.onclick = () => { if (window.SFX) SFX.play('select'); showBondModal(el.dataset.axis, el.dataset.value, el.dataset.tier ? parseInt(el.dataset.tier, 10) : 0); });
    bar.querySelectorAll('.reso').forEach(el => el.onclick = () => { if (window.SFX) SFX.play('select'); showBondModal('呼应', el.dataset.a + '|' + el.dataset.b); });
  }

  // v2.4 演出层：capstone/deep 解锁全屏横幅（金色描边 + 2s 自动消失）
  // v2.5 M4 叙事接线：deep 阶横幅优先用 BONDS_FLAWOR.awaken[阵营][tier].banner（叙事设计师交付），
  //   缺失回退机制侧 SPECIAL.deep[tier].label；awaken:true 阶加紫色「✦ 创作推演」角标（同 resonance creative）。
  let _bannerTimer = null;
  function showBondBanner(faction, specialDesc, tier, isDeep) {
    const el = $('bondBanner'); if (!el) return;
    const txt = $('bondBannerText'); if (!txt) return;
    let label = isDeep ? specialDesc : (specialDesc || '阵营特殊机制');
    let awaken = false;
    if (isDeep) {
      const aw = (typeof BONDS_FLAVOR !== 'undefined' && BONDS_FLAVOR.awaken) ? BONDS_FLAVOR.awaken[faction] : null;
      const awT = aw ? aw[tier] : null;
      if (awT) {
        if (awT.banner) label = awT.banner;          // 叙事横幅短句优先
        if (awT.awaken) awaken = true;               // 最终觉醒阶
      }
    }
    txt.textContent = '✦ ' + faction + ' · ' + tier + ' 阶 · ' + label + ' 已解锁' + (awaken ? '　✦创作推演' : '');
    el.classList.remove('hidden', 'bb-deep');
    if (isDeep) el.classList.add('bb-deep');
    void el.offsetWidth; // 重启动画
    el.classList.add('bb-pop');
    if (window.AUDIO) { try { AUDIO.play('strategic/bond_unlock'); } catch (e) {} }
    clearTimeout(_bannerTimer);
    _bannerTimer = setTimeout(() => { el.classList.add('hidden'); }, 2200);
  }

  // 左侧羁绊面板已整合进顶部「可折叠羁绊条」(.bonds-bar-wrap)；renderBondsPanel 弃用

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
      shieldPeriodic: '周期护盾', defShred: '破甲', globalAspd: '全队攻速', trueDmg: '真实伤害', slow: '减速', damageReduction: '减伤',
      // —— 阵营多阶深度阶（2026-08-12）——
      triage: '不抛下任何人（阵亡复活一次）', infernoRally: '岁兽觉醒（炎攻强光环）', knightBanner: '骑士旗帜（全队攻光环·随人数缩放）',
      overload: '过载协议（周期法强爆发）', capo: '教父（狼群攻速光环）', barrage: '弹幕风暴（多段普攻）'
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
  // 叙事 flavor 渲染辅助：剥离【台词出处】等开发角标，保持游戏 UI 干净
  function flavorText(s) { return s ? String(s).replace(/【[^】]*】/g, '').replace(/\s+/g, ' ').trim() : ''; }
  function showBondModal(axis, value, tier) {
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
          // 叙事 flavor：阵营三阶文案 + capstone（按当前 tier 渐进披露，无 tier 时全显）
          const fl = (typeof BONDS_FLAVOR !== 'undefined' && BONDS_FLAVOR.faction) ? BONDS_FLAVOR.faction[value] : null;
          if (fl) {
            const tN = tier || 0;
            html += '<h4>叙事</h4><div class="bm-flavor">';
            ['t1', 't2', 't3'].forEach((k, i) => {
              if (!fl[k]) return;
              const reached = (tN === 0) || (i + 1) <= tN;
              html += '<p class="bm-fl' + (reached ? '' : ' lock') + '">' + flavorText(fl[k]) + '</p>';
            });
            if (fl.cap) html += '<p class="bm-fl bm-cap">' + flavorText(fl.cap) + '</p>';
            html += '</div>';
          }
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
        if (sp.deep) { // 阵营多阶：深度阶（多阶进化）清单，按当前 tier 标注已解锁 / 待解锁
          const aw = (typeof BONDS_FLAVOR !== 'undefined' && BONDS_FLAVOR.awaken) ? BONDS_FLAVOR.awaken[value] : null;
          html += '<h4>深度阶（多阶进化）</h4><div class="bm-tier">';
          Object.keys(sp.deep).map(Number).sort((a, b) => a - b).forEach(dk => {
            const dp = sp.deep[dk];
            const unlocked = tier >= dk;
            const kwDesc = (dp.kws || []).map(e => describeSpecial({ kw: e.kw, params: e.params })).join('；');
            const awT = aw ? aw[dk] : null;
            const flav = awT && awT.flavor ? flavorText(awT.flavor) : null;
            html += '<div style="' + (unlocked ? 'color:#e8b84b;font-weight:600' : 'opacity:.45') + '">' +
              (unlocked ? '★ ' : '☆ ') + (awT && awT.name ? awT.name : dp.label) + '（' + dk + '阶' + (unlocked ? '·已解锁' : '·待解锁') + '）' +
              (awT && awT.awaken ? ' <span class="bm-creative">✦创作推演</span>' : '') +
              (kwDesc ? '：' + kwDesc : '') +
              (flav ? '<div class="bm-fl bm-cap" style="font-weight:400">' + flav + '</div>' : '') +
              '</div>';
          });
          html += '</div>';
        }
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
      const sigFl = (typeof BONDS_FLAVOR !== 'undefined' && BONDS_FLAVOR.signature) ? BONDS_FLAVOR.signature[value] : null;
      if (sigFl) html += '<h4>干员独白</h4><div class="bm-flavor"><p class="bm-fl bm-cap">' + flavorText(sigFl) + '</p></div>';
      const op = DATA.operators.find(o => o.name === value);
      if (op) html += '<div class="bm-ops"><div class="bm-op on">' +
        '<img class="bm-avatar" src="' + op.avatar + '" alt="' + op.name + '" onerror="this.style.background=\'#222\'">' +
        costChip(op.stats.cost) + op.name + '</div></div>';
    } else if (axis === '独行') {
      const dp = (typeof DEPLOY_PASSIVE !== 'undefined') && DEPLOY_PASSIVE[value];
      if (dp) {
        html += '<div class="bm-thr">单干员势力 · 上场即生效（独行被动）</div>';
        const effs = [];
        BOND_KEYS.forEach(k => { if (dp.attr && dp.attr[k] != null) effs.push(describeEffect(k, dp.attr[k])); });
        html += '<h4>独行被动</h4><div class="bm-tier">' + (effs.length ? effs.join('、') : '—') + '</div>';
        if (dp.desc) html += '<h4>叙事</h4><div class="bm-flavor"><p class="bm-fl bm-cap">' + flavorText(dp.desc) + '</p></div>';
      }
      const op = DATA.operators.find(o => o.bonds && o.bonds['阵营'] === value);
      if (op) html += '<div class="bm-ops"><div class="bm-op on">' +
        '<img class="bm-avatar" src="' + op.avatar + '" alt="' + op.name + '" onerror="this.style.background=\'#222\'">' +
        costChip(op.stats.cost) + op.name + '</div></div>';
    } else if (axis === '呼应') {
      const parts = value.split('|');
      const a = parts[0], b = parts[1];
      const p = (typeof RESONANCE !== 'undefined') && RESONANCE.PAIRS.find(x => x.a === a && x.b === b);
      if (p) {
        const typeDesc = (RESONANCE.TYPE_DESC && RESONANCE.TYPE_DESC[p.type]) || p.type;
        const confLabel = { verified: '确证（史实）', thematic: '主题（创作推演）', gap: '缺口（待补父键）' }[p.confidence] || p.confidence;
        html += '<div class="bm-thr">阵营呼应 · ' + typeDesc + '</div>';
        html += '<div class="bm-thr" style="border-left:3px solid var(--info)">置信度：' + confLabel + '</div>';
        if (p.creative && RESONANCE.CREATIVE_BADGE) {
          html += '<div class="bm-creative">✦ ' + RESONANCE.CREATIVE_BADGE.label + ' · 非游戏史实</div>';
          html += '<div class="bm-tier" style="color:var(--text-2);font-size:12px;margin-top:-2px">' + RESONANCE.CREATIVE_BADGE.note + '</div>';
        }
        html += '<h4>叙事</h4><div class="bm-tier">' + p.flavor + '</div>';
        const eff = (typeof RESONANCE !== 'undefined' && RESONANCE.EFF) ? RESONANCE.EFF[p.a + '|' + p.b] : null;
        const seEff = (typeof RESONANCE !== 'undefined')
          ? (RESONANCE.SPECIAL_EFF[p.a + '|' + p.b] || (RESONANCE.SPECIAL_EFF_AURA && RESONANCE.SPECIAL_EFF_AURA[p.a + '|' + p.b]) || null)
          : null;
        const live = !!(eff || seEff);
        html += '<h4>' + (live ? '战斗加成/机制（已生效）' : '叙事构想（暂未接入）') + '</h4><div class="bm-tier">' + p.bonus + '</div>';
        if (eff) {
          const parts = [];
          Object.keys(eff).forEach(f => { const m = eff[f]; Object.keys(m).forEach(k => parts.push(f + ' ' + describeEffect(k, m[k]))); });
          html += '<div class="bm-thr" style="border-left:3px solid var(--info)">实际属性加成：' + parts.join('、') + '</div>';
        }
        if (seEff) {
          // aura 型条目用 src 镜像 SPECIAL 参数（单一真相源），确保弹窗显示实际数值
          const seParams = seEff.params || (seEff.src && typeof SPECIAL !== 'undefined' && SPECIAL[seEff.src] ? SPECIAL[seEff.src].params : {});
          const seParts = seEff.factions.map(f => f + ' 「' + seEff.label + '」' + describeSpecial({ kw: seEff.kw, params: seParams })).join('、');
          html += '<div class="bm-thr" style="border-left:3px solid #4fd1c5">实际战斗机制：' + seParts + '</div>';
        }
        if (p.type === 'ecosystem' && p.third) html += '<div class="bm-thr">需三者同场：' + p.a + ' ⊕ ' + p.b + ' ⊕ ' + p.third + '</div>';
      }
    }
    titleEl.textContent = (axis === '呼应') ? ('呼应 · ' + value.split('|').join(' ⊕ ')) : (axis + '·' + value);
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
    const _rng = rangeOf(op);
    $('ubStats').innerHTML =
      '费 ' + st.cost + '　HP ' + Math.round(st.hp * sm) +
      '　ATK ' + Math.round(st.atk * sm) + '　DEF ' + Math.round((st.def || 0) * sm) +
      '<br>攻速 ' + (st.spd != null ? st.spd : '-') + '　射程 ' + _rng + '　' + (op.role || '-');
    const bd = $('ubBonds');
    if (bd) {
      const tags = bondTagsFull(op);
      // v3.0 独行羁绊：池=1 阵营上场自带独门绝学（attr + behavior）
      const soloF = op.bonds && op.bonds['阵营'];
      const solo = (soloF && DEPLOY_PASSIVE[soloF]) || null;
      const soloTxt = solo ? '<div class="ub-solo">独行 · ' +
        (solo.behavior || []).map(e => kwLabel(e.kw)).join('+') +
        (solo.desc ? '<span class="ub-solo-desc" title="' + solo.desc.replace(/"/g, '&quot;') + '">（' + (solo.behavior || []).map(e => kwLabel(e.kw)).join('/') + '）</span>' : '') +
        '</div>' : '';
      bd.innerHTML = (tags ? '<div class="ub-bond-tags">' + tags + '</div>' : '') +
        '<div class="ub-bond-note">' + bondShort(op) + '</div>' + soloTxt;
    }
    const skEl = $('ubSkill');
    if (skEl) { skEl.innerHTML = renderSkillBlock(u); bindSkillToggle(); }
    // v2.3 装备详情条（方案C：棋盘卡信息下沉，装备在此完整展示/卸下；复用 data-eq-unequip 委托）
    const eqEl = $('ubEquip');
    if (eqEl) {
      const slots = (G.equipState && G.equipState.slots && G.equipState.slots[u.uid]) || [];
      eqEl.innerHTML = (slots && slots.length) ?
        '<div class="ub-equip-title">装备</div>' +
        '<div class="ub-equip-row">' +
        [0, 1].map(i => {
          const eqId = slots[i];
          const e = eqId ? EQUIP_BY_ID[eqId] : null;
          return '<span class="ub-eq' + (e ? ' rarity' + e.rarity : ' empty') + '" data-eq-unequip="' + u.uid + '" data-eq-slot="' + i + '" title="' + (e ? (e.name || e.id) + '：' + e.desc + '（点击卸下）' : '空槽（暂无装备）') + '">' +
            '<b>' + (e ? (e.icon || (e.type === 'engraving' ? '◎' : e.type === 'attr' ? '⬆' : '✦')) : '+') + '</b>' +
            '<i>' + (e ? (e.name || e.id) : '空槽') + '</i>' +
          '</span>';
        }).join('') + '</div>'
        : '';
    }
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
  function renderSkillBlock(u) {
    const sk = skillFor(u.op, u.star); // v2.5 M1：按星级显示当前技能
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
    routeNode(node);
  }

  // P2-1：节点路由（抽出自成函数，便于分叉节点解析后复用）
  function routeNode(node) {
    if (node.type === 'reward') { grantReward(node); return; }
    if (node.type === 'strategy') { showStrategyScreen(node); return; }
    if (node.type === 'encounter') { showEncounterScreen(node); return; }
    if (node.type === 'market') { showMarketScreen(node); return; }
    if (node.type === 'fork') { showForkScreen(node); return; }
    enterShopRound(node);
  }

  function enterShopRound(node) {
    G.phase = 'shop';
    if (window.AUDIO) AUDIO.setMusic('shop');
    // 经济类策略 + 开局环境 每回合生效
    const se = aggregateStrategies();
    const ef = (G.env && G.env.effects) || {};
    G.boardBonus = (se.boardCapBonus || 0) + (ef.boardCapBonus || 0);
    G.freeRerollLeft = (se.freeReroll || 0) + (ef.rerollBonus || 0) + (G.pendingFreeReroll || 0) + (getMeta().unlocks.rerollPlus ? 1 : 0);
    G.pendingFreeReroll = 0;
    // 敌方编队（遭遇节点按难度缩放，全局难度始终叠加）
    if (node.type === 'encounter' && G.encounterDiff) {
      G.currentEnemy = generateEnemyTeam(G.level, G.nodeIdx, false, ENCOUNTER_DIFFS[G.encounterDiff], diffCfg());
    } else {
      G.currentEnemy = generateEnemyTeam(G.level, G.nodeIdx, node.type === 'boss', null, diffCfg());
    }
    const round = G.nodeIdx + 1;
    const interestMax = 5 + (ef.interestMax || 0);
    // v2.6 策略经济：利息加成（interestRate）+ 连胜/连败额外奖金（winStreakGold）
    const interest = Math.min(interestMax, Math.floor(G.gold / 10) * (1 + (se.interestRate || 0)));
    let streakBonus = 0;
    const s = Math.max(G.winStreak, G.lossStreak);
    if (s >= 2 && s <= 3) streakBonus = 1; else if (s >= 4 && s <= 5) streakBonus = 2; else if (s >= 6) streakBonus = 3;
    if (s >= 2) streakBonus += (se.winStreakGold || 0);
    const base = Math.min(round + 2, 7);
    G.gold += base + interest + streakBonus + se.goldPerRound;
    G.exp += 2 + (ef.expBonus || 0) + se.expPerRound;
    levelUp();
    rollShop();
    rollEquipShop(); // v2 装备：40% 概率刷 1 件
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
  // 分类多样 3 选 1：尽量从不同 category 各取一张，优先 comp（引导玩法），杜绝三张同方向（尤其纯数值堆叠）。
  function pickDiverseStrategies(pool, n) {
    const byCat = {};
    pool.forEach(s => { (byCat[s.category] = byCat[s.category] || []).push(s); });
    Object.keys(byCat).forEach(c => { byCat[c] = shuffle(byCat[c]); });
    const order = ['comp', 'rule', 'tempo', 'power'].filter(c => byCat[c] && byCat[c].length);
    const chosen = [];
    let i = 0;
    while (chosen.length < n && chosen.length < pool.length) {
      let progressed = false;
      for (let k = 0; k < order.length; k++) {
        const c = order[(i + k) % order.length];
        const arr = byCat[c];
        if (arr && arr.length) { chosen.push(arr.shift()); progressed = true; break; }
      }
      if (!progressed) break;
      i++;
    }
    if (chosen.length < n) {
      const rest = shuffle(pool.filter(s => chosen.indexOf(s) < 0));
      chosen.push(...rest.slice(0, n - chosen.length));
    }
    return chosen.slice(0, n);
  }
  function showStrategyScreen(node) {
    const minTier = ['bronze', 'silver', 'gold'][Math.min(G.stratCount, 2)];
    // 去重（痛点①）：已选 ID 永不返回。软档位：先按 tier 过滤，不足 3 张可选则放宽到全池（仍排除已选）。
    let pool = STRATEGY_POOL.filter(s => tierRank(s.tier) >= tierRank(minTier) && G.strategies.indexOf(s.id) < 0);
    if (pool.length < 3) pool = STRATEGY_POOL.filter(s => G.strategies.indexOf(s.id) < 0);
    if (pool.length === 0) pool = STRATEGY_POOL.slice(); // 极端：全选过，允许重复兜底
    const picks = pickDiverseStrategies(pool, 3);
    // v2.6 风险配额：3 选 1 至少 1 张非"稳定"（池子允许时），保证"选强力但难受"的取舍张力
    const nonStable = pool.filter(s => (s.risk || 'safe') !== 'safe');
    if (nonStable.length && !picks.some(s => (s.risk || 'safe') !== 'safe')) {
      const rep = nonStable.filter(s => picks.indexOf(s) < 0);
      if (rep.length) picks[Math.floor(Math.random() * picks.length)] = rep[Math.floor(Math.random() * rep.length)];
    }
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
        '<div class="sc-tier-label">' + STRATEGY_TIERS_LABEL[s.tier] + '档 · ' + (STRAT_CAT_LABEL[s.category] || s.category) +
          (s.risk && s.risk !== 'safe' ? ' · <span class="sc-risk">' + STRAT_RISK_LABEL[s.risk] + '</span>' : '') + '</div>' +
      '</div>'
    ).join('');
    wrap.querySelectorAll('.strategy-card').forEach(c => c.onclick = () => {
      if (window.SFX) SFX.play('select');
      G.strategies.push(c.dataset.sid); G.stratCount++;
      // v2.6 即时型策略：选卡立即结算（goldNow/expNow）
      const selS = STRATEGY_BY_ID[c.dataset.sid];
      if (selS && selS.effects) {
        if (selS.effects.goldNow) G.gold += selS.effects.goldNow;
        if (selS.effects.goldGamble) { if (Math.random() < 0.5) G.gold += selS.effects.goldGamble; else G.gold = Math.max(0, G.gold - Math.round(selS.effects.goldGamble * 0.33)); }
        if (selS.effects.expNow) { G.exp += selS.effects.expNow; levelUp(); }
      }
      $('strategyScreen').classList.add('hidden');
      enterShopRound(node); // 策略节点同时进入一回合（普通战斗）
    });
    $('strategyScreen').classList.remove('hidden');
    if (window.AUDIO) AUDIO.setMusic('exploration');
  }

  // —— 市场节点（每阶段 1 次）：10 干员 + 5 装备 任选购买，补强后开战 ——
  function showMarketScreen(node) {
    // 生成补给池（干员：随机 5 + 定向 5——按玩家已有小阵营补缺；装备：全类型 5 件，稀有度随等级解锁）
    if (!G._marketUnits || !G._marketUnits.length) {
      const lv = maxShopCost(G.level);
      const cand = DATA.operators.filter(o => o.stats.cost <= lv);
      // 随机 5：全池
      const rnd5 = shuffle(cand.slice()).slice(0, 5);
      // 定向 5：玩家已有小阵营（池≤5）的干员补缺（v2.4 方案B）
      const track = factionTrackBias();
      let target = [];
      Object.keys(track).forEach(f => {
        const got = new Set();
        Object.values(G.board).forEach(u => { if (u.op.bonds && u.op.bonds['阵营'] === f) got.add(u.op.name); });
        G.bench.forEach(u => { if (u.op.bonds && u.op.bonds['阵营'] === f) got.add(u.op.name); });
        cand.filter(o => o.bonds && o.bonds['阵营'] === f && !got.has(o.name)).forEach(o => target.push(o));
      });
      const dir5 = target.length ? shuffle(target).slice(0, 5) : shuffle(cand.slice()).slice(0, 5);
      // 去重合并（避免随机与定向重复），补足 10 个
      const seen = new Set(); const merged = [];
      rnd5.concat(dir5).forEach(o => { if (!seen.has(o.id)) { seen.add(o.id); merged.push(o); } });
      while (merged.length < 10) { const o = cand[Math.floor(Math.random() * cand.length)]; if (!seen.has(o.id)) { seen.add(o.id); merged.push(o); } }
      G._marketUnits = merged.slice(0, 10);
    }
    if (!G._marketEquips || !G._marketEquips.length) {
      const mr = maxEquipRarity(G.level);
      let pool = EQUIP_POOL.filter(e => e.rarity <= mr);
      if (pool.length < 5) pool = EQUIP_POOL.slice(); // 低等级白装不足 5 件时放宽到全池
      G._marketEquips = shuffle(pool).slice(0, 5);
    }
    const wrap = $('marketUnits');
    wrap.innerHTML = G._marketUnits.map((op, i) => {
      if (!op) return '<div class="slot empty"></div>';
      const afford = G.gold >= effCost(op) ? '' : ' locked';
      const role = op.bonds && op.bonds['职业'];
      const aff = op.bonds && op.bonds['阵营'];
      return '<div class="ucard shop-card c' + op.stats.cost + afford + '" data-mk-unit="' + i + '">' +
        '<img class="avatar" src="' + op.avatar + '" alt="" loading="lazy" decoding="async" onerror="this.style.background=\'#222\'">' +
        '<div class="card-fade"></div>' +
        '<div class="card-tags">' +
          (role ? '<span class="ctag"><span class="ctag-icon">⚔</span><span class="ctag-txt">' + role + '</span></span>' : '') +
          (aff ? '<span class="ctag"><span class="ctag-icon">◎</span><span class="ctag-txt">' + aff + '</span></span>' : '') +
        '</div>' +
        '<div class="card-footer"><span class="cf-name">' + op.name + '</span><span class="cf-cost">' + op.stats.cost + '</span></div>' +
      '</div>';
    }).join('');
    const ew = $('marketEquips');
    ew.innerHTML = G._marketEquips.map((e, i) => {
      const afford = G.gold >= e.cost ? '' : ' locked';
      return '<div class="equip-card rarity' + e.rarity + ' mk-eq' + afford + '" data-mk-eq="' + i + '">' +
        '<span class="eq-rarity">' + RARITY_LABEL[e.rarity] + '</span>' +
        '<span class="eq-name">' + (e.name || e.id) + '</span>' +
        '<span class="eq-desc">' + e.desc + '</span>' +
        '<span class="eq-cost">' + e.cost + '💰</span>' +
      '</div>';
    }).join('');
    // 购买事件
    wrap.querySelectorAll('[data-mk-unit]').forEach(c => c.onclick = () => {
      const i = parseInt(c.dataset.mkUnit, 10);
      const op = G._marketUnits[i];
      if (!op) return;
      const cost = effCost(op);
      if (G.gold < cost) { flash('金币不足'); return; }
      if (G.bench.length >= BENCH_CAP) { flash('备战席已满'); return; }
      G.gold -= cost; G._marketUnits[i] = null;
      G.bench.push({ uid: uidc++, op, star: 1 });
      if (window.SFX) SFX.play('buy');
      tryCombine();
      renderTop(); showMarketScreen(node);
    });
    ew.querySelectorAll('[data-mk-eq]').forEach(c => c.onclick = () => {
      const i = parseInt(c.dataset.mkEq, 10);
      const e = G._marketEquips[i];
      if (!e) return;
      if (G.gold < e.cost) { flash('金币不足'); return; }
      G.gold -= e.cost; G._marketEquips.splice(i, 1);
      G.equipState.bag.push(e.id);
      if (window.SFX) SFX.play('buy');
      renderTop(); showMarketScreen(node);
    });
    $('btnMarketDone').onclick = () => {
      if (window.SFX) SFX.play('select');
      $('marketScreen').classList.add('hidden');
      G._marketUnits = null; G._marketEquips = null; // 一次性补给，清空防重复
      enterShopRound(node); // 进入本节点战斗回合
    };
    $('marketScreen').classList.remove('hidden');
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
    if (G.bench.length >= BENCH_CAP && predictStarGain(op) === 0) { flash('备战席已满（' + BENCH_CAP + '），先部署或售出'); if (window.SFX) SFX.play('error'); return; }
    G.gold -= c; G.shop[i] = null;
    G.bench.push({ uid: uidc++, op, star: 1 });
    if (window.SFX) SFX.play('buy');
    // v2.4 购买飞卡：卡片位置金色光粒爆散
    try { const _sc = document.querySelector('.shop-card[data-shop="' + i + '"]'); if (_sc) { const _r = _sc.getBoundingClientRect(); if (_r && _r.width) FX.burst(_r.left + _r.width / 2, _r.top + _r.height / 2, 8); } } catch (e) {}
    tryCombine();
    renderAll();
    saveGame();
  }

  // v2.4 升星动画（用户拍板：棋盘作主体 / 回主体原位 / 状态先落+演出）：
  // 棋盘上同名同星优先作主体；结果回主体原位（主体在备战席才留备战席）；光流演出纯叠加、不阻塞、连升依次播。
  function cardCenter(uid) {
    if (typeof document === 'undefined') return null;
    const el = document.querySelector('.ucard[data-uid="' + uid + '"]');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    if (!r || (!r.width && !r.height)) return null;
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }
  function sparkFly(fx) {
    if (typeof document === 'undefined' || !fx) return;
    const to = cardCenter(fx.uid);
    if (!to) return;
    const body = document.body;
    const srcs = (fx.from || []).filter(Boolean);
    if (!srcs.length) srcs.push({ x: to.x - 90, y: to.y - 26 }, { x: to.x + 90, y: to.y - 26 });
    const sparks = [];
    srcs.forEach(s => {
      for (let i = 0; i < 4; i++) {
        const sp = document.createElement('div');
        sp.className = 'combine-spark';
        const sx = s.x + (Math.random() * 26 - 13), sy = s.y + (Math.random() * 26 - 13);
        const tx = to.x + (Math.random() * 22 - 11), ty = to.y + (Math.random() * 22 - 11);
        sp.style.left = sx + 'px'; sp.style.top = sy + 'px';
        sp.style.width = sp.style.height = (3 + Math.random() * 4) + 'px';
        body.appendChild(sp); sparks.push(sp);
        requestAnimationFrame(function () {
          sp.style.transform = 'translate(' + (tx - sx) + 'px,' + (ty - sy) + 'px)';
          sp.style.opacity = '0';
        });
      }
    });
    const ring = document.createElement('div');
    ring.className = 'combine-ring';
    ring.style.left = (to.x - 26) + 'px'; ring.style.top = (to.y - 26) + 'px';
    body.appendChild(ring);
    const txt = document.createElement('div');
    txt.className = 'combine-txt';
    txt.textContent = '升星 ★' + (fx.star || 2);
    txt.style.left = to.x + 'px'; txt.style.top = (to.y - 44) + 'px';
    body.appendChild(txt);
    setTimeout(function () { sparks.forEach(x => x.remove()); ring.remove(); txt.remove(); }, 1000);
  }
  function playCombineFx(q) {
    if (!q || !q.length) return;
    let i = 0;
    const next = function () {
      if (i >= q.length) return;
      const fx = q[i++];
      sparkFly(fx);
      setTimeout(next, 1000);
    };
    next();
  }
  // v2.4 商店升星提示：预测买入该干员（1 星）后能否完成合成（返回最大可达星级 0/2/3）
  function predictStarGain(op) {
    if (!op) return 0;
    let c1 = 0, c2 = 0;
    Object.values(G.board).concat(G.bench).forEach(u => {
      if (u.op.name === op.name) { if (u.star === 1) c1++; else if (u.star === 2) c2++; }
    });
    const new1 = c1 + 1;
    if (new1 < 3) return 0;
    const made2 = Math.floor(new1 / 3);
    if (c2 + made2 >= 3) return 3;
    return 2;
  }
  function tryCombine() {
    let changed = true;
    while (changed) {
      changed = false;
      const groups = {};
      Object.values(G.board).concat(G.bench).forEach(u => {
        const k = u.op.name + '#' + u.star;
        (groups[k] = groups[k] || []).push(u);
      });
      for (const k in groups) {
        const arr = groups[k];
        const star = arr[0].star;
        if (star >= 3) continue;
        if (arr.length >= 3) {
          const three = arr.slice(0, 3);
          const mainSlot = slotOf(three[0].uid); // 棋盘作主体：删前记录原位
          // v2 装备：三合一后新单位继承第一件（arr[0]）的 2 槽装备，其余两件的装备回背包
          let inheritEq = [];
          if (G.equipState && G.equipState.slots) {
            inheritEq = (G.equipState.slots[three[0].uid] || []).filter(Boolean);
            [three[1], three[2]].forEach(u => {
              (G.equipState.slots[u.uid] || []).forEach(eqId => { if (eqId) G.equipState.bag.push(eqId); });
              delete G.equipState.slots[u.uid];
            });
            delete G.equipState.slots[three[0].uid];
          }
          // 升星动画：先记录被吸收卡与主体的位置（DOM 尚未刷新；主体目标用新 uid 定位）
          const up = { uid: uidc++, op: arr[0].op, star: star + 1 };
          (G._combineFx = G._combineFx || []).push({
            uid: up.uid,
            from: [three[1].uid, three[2].uid].map(u => cardCenter(u.uid)),
            star: star + 1
          });
          three.forEach(u => {
            G.bench = G.bench.filter(x => x.uid !== u.uid);
            for (const kk in G.board) if (G.board[kk].uid === u.uid) delete G.board[kk];
          });
          if (G.equipState) G.equipState.slots[up.uid] = inheritEq; // 装备继承（新 uid）
          if (mainSlot != null) G.board[mainSlot] = up; else G.bench.push(up); // 回主体原位；主体在备战席才留备战席
          changed = true;
          break;
        }
      }
    }
    // 状态已落（调用方随后渲染 DOM），延迟 40ms 播放动画；连升依次排队
    if (G._combineFx && G._combineFx.length) {
      const q = G._combineFx; G._combineFx = [];
      setTimeout(function () { playCombineFx(q); }, 40);
    }
  }

  function togglePlace() {
    if (G.selected == null) return;
    const uid = G.selected;
    const where = whereIs(uid);
    const u = findUnit(uid);
    if (!u) return;
    if (where === 'bench') {
      if (boardCount() >= boardCap()) { flash('人口已满（Lv.' + boardCap() + '）'); return; }
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
    // v2 装备：出售干员时已穿装备自动回背包（不随干员销毁）
    if (G.equipState && G.equipState.slots && G.equipState.slots[uid]) {
      (G.equipState.slots[uid] || []).forEach(eqId => { if (eqId) G.equipState.bag.push(eqId); });
      delete G.equipState.slots[uid];
    }
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
    const se = aggregateStrategies(); // 策略节点全局/定向/规则效果（comp 召唤加成与经验倍率在此取用）

    let allyList = [];
    let allyPos = [];
    // 遍历所有已部署格（不再写死 9），确保扩编后的第 10+ 个单位也会参战
    Object.keys(G.board).forEach(k => {
      const i = parseInt(k, 10);
      if (G.board[i]) { allyList.push({ uid: G.board[i].uid, op: G.board[i].op, star: G.board[i].star }); allyPos.push(slotToXY(i)); }
    });
    // —— v2.1 真实召唤物（叙拉古养狼 / 令岁兽）：按局内等级生成，相邻格站位 ——
    const probe = computeBonds(allyList.map(u => ({ uid: u.uid, name: u.op.name, bonds: u.op.bonds, star: u.star })));
    const xila = probe.active.find(b => b.axis === '特殊' && b.value === '叙拉古');
    const xilaTier = xila ? xila.tier : 0;
    const xilaCount = allyList.filter(u => u.op.bonds && u.op.bonds['阵营'] === '叙拉古').length;
    const lingIdx = allyList.findIndex(u => u.op.name === '令');
    const ss = G.summonState || { wolf: { level: 1, exp: 0 }, beast: { level: 1, exp: 0 }, feedAtk: 0, feedHp: 0 };
    const summonPlan = [];
    const placedSummons = []; // 用于音频/复盘
    if (xilaTier >= 2) {
      // v2.5 M4：读叙拉古 SPECIAL 的狼数参数（t2/t3/t4/t5，含 deep 覆盖），不再硬编码——8 人觉醒出 5 狼
      // 合成规则：deep[tierN] 若存在则用其 params（覆盖基础），否则用基础 params
      const spSw = SPECIAL['叙拉古'] || {};
      let swP = (spSw.params || {});
      const dpK = spSw.deep ? Object.keys(spSw.deep).map(Number).filter(k => k <= xilaTier).sort((a, b) => a - b) : [];
      dpK.forEach(dk => { const e = (spSw.deep[dk].kws || []).find(x => x.kw === 'summonWolf'); if (e) swP = e.params; });
      let n = 1;
      if (swP.t5 && xilaTier >= 5) n = swP.t5;
      else if (swP.t4 && xilaTier >= 4) n = swP.t4;
      else if (swP.t3 && xilaTier >= 3) n = swP.t3;
      else if (swP.t2 && xilaTier >= 2) n = swP.t2;
      const deepWolf = xilaTier >= 4; // 叙拉古深度阶：狼继承叙拉古暴击
      const sIdx = allyList.findIndex(u => u.op.bonds && u.op.bonds['阵营'] === '叙拉古');
      for (let i = 0; i < n; i++) {
        const u = makeCombatSummon('wolf', ss.wolf.level, 'ally', sIdx >= 0 ? 'a' + sIdx : null);
        applyFeedBuff(u, ss);
        if (deepWolf) u.crit = Math.min(1, (u.crit || 0) + 0.05); // [PLACEHOLDER] 狼继承暴击
        summonPlan.push({ unit: u, summonerPos: sIdx >= 0 ? allyPos[sIdx] : null });
        placedSummons.push(u);
      }
    }
    if (lingIdx >= 0) {
      const u = makeCombatSummon('beast', ss.beast.level, 'ally', 'a' + lingIdx);
      applyFeedBuff(u, ss);
      summonPlan.push({ unit: u, summonerPos: allyPos[lingIdx] });
      placedSummons.push(u);
    }
    // v2.1+：策略节点「召唤铺场」comp 卡 → 召唤物 +atk/+hp（乘法叠加 feeding）
    if (se.summonBonusPct) {
      summonPlan.forEach(p => {
        const u = p.unit;
        u.atk = Math.round(u.atk * (1 + se.summonBonusPct)); u.baseAtk = u.atk;
        u.maxHp = Math.round(u.maxHp * (1 + se.summonBonusPct)); u.hp = u.maxHp;
      });
    }
    if (summonPlan.length) {
      const placed = placeAdjacentSummons(allyList, allyPos, summonPlan);
      allyList = placed.allyList; allyPos = placed.allyPos;
      // v2.1 音频：召唤降临 + 狼形态叫声（tier3=狼王，否则成年狼）；克制环已取消
      if (!G._audioSkip && window.AUDIO) {
        placedSummons.forEach(u => {
          const isWolf = u.summonType === 'wolf';
          AUDIO.play('summon/spawn', { kind: isWolf ? 'wolf' : 'beast' });
          if (isWolf) AUDIO.play('wolf/howl', { form: xilaTier >= 4 ? 'king' : 'adult' });
        });
      }
    }
    // v2.1 关键修正：召唤物已是完整 CombatUnit（带 isSummon / level / summonType / 局内成长属性），
    // 必须绕过 applyBonds —— applyBonds 会经 makeCombatUnit 重建单位，导致 (1) isSummon 标识丢失（召唤物退化为普通单位）、
    // (2) 等级成长属性（growth^(level-1)）被清零、(3) 召唤物的 bonds（职业:召唤物 / 阵营:—）进入 computeBonds 污染羁绊计数。
    // 因此先把召唤物从 allyList 中剥离，仅对常规干员套用羁绊，再把召唤物原样接回（保持与 allyPos 索引对齐：常规在前、召唤在后）。
    const regEntries = [], summonUnits = [];
    allyList.forEach(u => { if (u.isSummon) summonUnits.push(u); else regEntries.push(u); });
    const allyUnits = applyBonds(regEntries.map(u => ({ uid: u.uid, op: u.op, star: u.star })), 'ally', allyPos);
    const enemyUnits = applyBonds(enemyBase.map(t => ({ op: t.op, star: t.star, buff: t.buff })), 'enemy');
    // uid 由 simulateBattleGrid 统一重排（ally:a0.. / enemy:e0..），这里按顺序拼接即可。
    const allyAll = allyUnits.concat(summonUnits);
    const enemyPos = autoPositions(enemyUnits, 'enemy');

    const res = simulateBattleGrid(allyAll, enemyUnits, allyPos, enemyPos);
    G.battleRes = res;
    // v2.5 M3 先锋 8 阶「击杀回费」：战斗结束统一结算（不在模拟中途改 G）
    if (res.stats && res.stats.goldEarned) { G.gold += res.stats.goldEarned; }
    // —— v2.1 养狼：战斗后 EXP 结算（仅本 run，不写 Meta）——
    const lvlUp = grantSummonExp(xilaCount, xilaTier, res, ss, 1 + (se.summonExpMult || 0));
    G._summonLevelUp = lvlUp; // 供复盘/recap 提示（升级：下一场以新等级重生）
    ss.feedAtk = 0; ss.feedHp = 0; // 清空一次性战前口粮
    G._lastAll = { ally: allyAll, enemy: enemyUnits }; // v2.5 回放：保存战斗单位供重播
    G._lastAll = { ally: allyAll, enemy: enemyUnits }; // v2.5 回放：保存战斗单位供重播
    showBattle(res, allyAll, enemyUnits);
  }

  // v2.1 养狼：战斗后 EXP 累积与升级（state 为 G.summonState，仅本 run 有效）
  // 狼 EXP = 叙拉古干员数 × 羁绊阶 × 10 + 击杀贡献（每只召唤物击杀 ×5）；岁兽约为狼的 60% 速度。
  function grantSummonExp(xilaCount, xilaTier, res, ss, expMult) {
    expMult = expMult || 1; // 策略节点「召唤铺场」经验倍率（默认 1）
    const killExp = (res && res.stats && res.stats.summonKills) ? res.stats.summonKills * 5 : 0;
    const wolfGain = xilaCount > 0 ? Math.round((xilaCount * xilaTier * 10 + killExp) * expMult) : 0; // [PLACEHOLDER] 公式
    const beastGain = Math.floor(wolfGain * 0.6); // 岁兽约 60% 狼速度 [PLACEHOLDER]
    const ups = [];
    if (wolfGain > 0 && ss.wolf) {
      const before = ss.wolf.level;
      ss.wolf.exp += wolfGain;
      ss.wolf.level = summonLevelFromExp(ss.wolf.exp);
      if (ss.wolf.level > before) ups.push({ type: 'wolf', from: before, to: ss.wolf.level, exp: ss.wolf.exp });
    }
    if (beastGain > 0 && ss.beast) {
      const before = ss.beast.level;
      ss.beast.exp += beastGain;
      ss.beast.level = summonLevelFromExp(ss.beast.exp);
      if (ss.beast.level > before) ups.push({ type: 'beast', from: before, to: ss.beast.level, exp: ss.beast.exp });
    }
    return ups;
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
      G._bfUnits = {}; // v2.4 战斗射程可视化：uid -> {x,y,range,name}
      // 实测网格尺寸：bf-grid 全屏时会被放大，按真实 cell 比例定位才能填满并居中
      const _gr = g.getBoundingClientRect();
      const _gw = _gr.width || (FIELD_W * CELL), _gh = _gr.height || (FIELD_H * CELL);
      const _cw = _gw / FIELD_W, _ch = _gh / FIELD_H;
      const _uw = Math.max(40, Math.min(72, _cw - 4)), _uh = Math.max(46, Math.min(80, _ch - 4)); // v2.4 单位放大填格，减小部署/战斗视觉空隙
      G._bfCell = { cw: _cw, ch: _ch, uw: _uw, uh: _uh };
      g.style.backgroundSize = _cw + 'px ' + _ch + 'px';

      // 防御：校验帧数据
      if (!res || !res.frames || !res.frames.length) {
        logEl.innerHTML += '<div class="sys" style="color:#e74c3c">错误：无战斗帧数据</div>';
        console.error('[battle] 无帧数据', res);
        return;
      }

      // 渲染源必须与 res.frames 里的 uid 一致：simulateBattleGrid 内部分配 uid='a'+i / 'e'+i
      const allUnits = [];
      allyUnits.forEach((u, i) => { u.uid = 'a' + i; u.side = 'ally'; allUnits.push(u); });
      enemyUnits.forEach((u, i) => { u.uid = 'e' + i; u.side = 'enemy'; allUnits.push(u); });

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
        el.dataset.summon = (u.op && u.op.class === '召唤物') ? '1' : '';  // v2.1：召唤物标记（死亡时播专属音）
        el.style.background = u.side === 'ally' ? 'rgba(64,180,220,0.12)' : 'rgba(220,80,80,0.12)';
        el.innerHTML =
          '<img class="av" src="' + u.avatar + '" onerror="this.style.background=\'#222\'">' +
          '<div class="nm">' + u.name + (u.star > 1 ? '★' + u.star : '') + '</div>' +
          '<div class="hpbar"><i style="width:100%"></i></div>' +
          '<div class="spbar"><i style="width:0%"></i></div>' +
          (u.level ? '<div class="lv-badge">' + u.level + '</div>' : '');
        el.style.width = _uw + 'px'; el.style.height = _uh + 'px';
        const _av = el.querySelector('.av'); if (_av) { _av.style.width = (_uw - 14) + 'px'; _av.style.height = (_uw - 14) + 'px'; }
        el.style.transform = 'translate(' + (p.x * _cw + (_cw - _uw) / 2) + 'px,' + (p.y * _ch + (_ch - _uh) / 2) + 'px)';
        if (!p.alive) el.classList.add('dead');
        el.dataset.alive = p.alive ? 'alive' : 'dead';
        g.appendChild(el);
        G._bfEls[u.uid] = el;
        G._bfUnits[u.uid] = { x: p.x, y: p.y, range: u.range, name: u.name };
        rendered++;
      });


      // 如果没有渲染出任何单位，显示错误
      if (rendered === 0) {
        logEl.innerHTML += '<div class="sys" style="color:#e74c3c">⚠ 单位渲染失败（无单位或位置数据缺失）</div>';
        return;
      }

      // v2.4 战斗射程可视化：hover 单位显示其 Chebyshev 射程覆盖格（一次性绑定）
      if (!g.dataset.rangeBound) {
        g.dataset.rangeBound = '1';
        let _bfLayer = null;
        const clearLayer = function () { if (_bfLayer) { _bfLayer.remove(); _bfLayer = null; } };
        g.addEventListener('mouseover', function (e) {
          const t = e.target.closest && e.target.closest('.bf-unit');
          if (!t) return;
          const u = G._bfUnits && G._bfUnits[t.dataset.uid];
          if (!u || G._bfCell == null) return;
          clearLayer();
          const layer = document.createElement('div');
          layer.className = 'bf-range-layer';
          const _c = G._bfCell;
          for (let x = 0; x < FIELD_W; x++) for (let y = 0; y < FIELD_H; y++) {
            const d = Math.max(Math.abs(u.x - x), Math.abs(u.y - y));
            if (d >= 1 && d <= u.range) {
              const cell = document.createElement('div');
              cell.className = 'bf-range-cell' + (d === 1 ? ' near' : '');
              cell.style.left = (x * _c.cw) + 'px'; cell.style.top = (y * _c.ch) + 'px';
              cell.style.width = _c.cw + 'px'; cell.style.height = _c.ch + 'px';
              layer.appendChild(cell);
            }
          }
          const tag = document.createElement('div');
          tag.className = 'bf-range-tag';
          tag.textContent = u.name + ' · 射程 ' + u.range;
          tag.style.left = ((u.x + 0.5) * _c.cw) + 'px';
          tag.style.top = (u.y * _c.ch - 22) + 'px';
          layer.appendChild(tag);
          g.appendChild(layer);
          _bfLayer = layer;
        });
        g.addEventListener('mouseout', function (e) {
          if (e.target.closest && e.target.closest('.bf-unit')) clearLayer();
        });
      }
      // 启动帧动画
      let fi = 0;
      const speed = 300;
      if (G.frameTimer) clearInterval(G.frameTimer);
      G.frameTimer = setInterval(() => {
        if (G._playPaused) return; // v2.5 暂停/继续
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
    if (G._bfUnits && G._bfUnits[s.uid]) { G._bfUnits[s.uid].x = s.x; G._bfUnits[s.uid].y = s.y; }
    const _c = G._bfCell || { cw: CELL, ch: CELL, uw: 58, uh: 66 };
    el.style.transform = 'translate(' + (s.x * _c.cw + (_c.cw - _c.uw) / 2) + 'px,' + (s.y * _c.ch + (_c.ch - _c.uh) / 2) + 'px)';
    el.classList.toggle('dead', !s.alive);
    if (!s.alive) {
      if (el.dataset.alive !== 'dead') {
        el.dataset.alive = 'dead';
        try { const _av = el.querySelector('.av'); const _r = _av ? _av.getBoundingClientRect() : null; if (_r && _r.width) FX.burst(_r.left + _r.width / 2, _r.top + _r.height / 2, 10, '#ffb3b3'); if (!G._fxShakenThisFrame) { FX.shake(90, 2); G._fxShakenThisFrame = 1; } } catch (e) {}
        if (!G._audioSkip && window.AUDIO) {
          // v2.1：召唤物死亡播专属"兽落"音，普通单位播通用 combat/death
          if (el.dataset.summon === '1') AUDIO.play('summon/death', { side: el.dataset.side });
          else AUDIO.play('combat/death', { side: el.dataset.side });
        }
      }
    } else {
      el.dataset.alive = 'alive';
    }
    const hp = el.querySelector('.hpbar i');
    const prevPct = el.dataset.prevHp != null ? parseFloat(el.dataset.prevHp) : null;
    const curPct = s.max ? Math.max(0, s.hp / s.max * 100) : 0;
    if (prevPct != null && hp) {
      const diff = curPct - prevPct;
      if (diff < -0.5) {
        el.classList.remove('fx-hit'); void el.offsetWidth; el.classList.add('fx-hit');
        G._fxHitsThisFrame = (G._fxHitsThisFrame || 0);
        if (G._fxHitsThisFrame < 4) {
          G._fxHitsThisFrame++;
          const _av = el.querySelector('.av'); const _r = _av ? _av.getBoundingClientRect() : null;
          if (_r && _r.width) FX.floatText(_r.left + _r.width / 2, _r.top - 4, '-' + Math.round(s.max * Math.abs(diff) / 100), 'red');
        }
        if (!G._fxShakenThisFrame && diff < -25) { FX.shake(100, 2); G._fxShakenThisFrame = 1; }
      } else if (diff > 0.5) {
        el.classList.remove('fx-heal'); void el.offsetWidth; el.classList.add('fx-heal');
        const _av = el.querySelector('.av'); const _r = _av ? _av.getBoundingClientRect() : null;
        if (_r && _r.width) FX.floatText(_r.left + _r.width / 2, _r.top - 6, '+' + Math.round(s.max * diff / 100), 'green');
      }
    }
    el.dataset.prevHp = curPct;
    if (hp) hp.style.width = curPct + '%';
    const sp = el.querySelector('.spbar i');
    if (sp) sp.style.width = (s.spMax ? Math.max(0, Math.min(100, s.sp / s.spMax * 100)) : 0) + '%';
    if (s.shield > 0) el.classList.add('has-shield'); else el.classList.remove('has-shield');
    // v2.4 可视化层：burn/slow/revive 状态视觉（CSS 类驱动）
    el.classList.toggle('on-burn', !!s.burn);
    el.classList.toggle('on-slow', !!s.slow);
    if (s.reviving && el.dataset.revived !== '1') {
      el.dataset.revived = '1';
      el.classList.add('fx-revive');
      setTimeout(() => el.classList.remove('fx-revive'), 600);
    } else if (!s.reviving && el.dataset.revived === '1') {
      el.dataset.revived = '0';
    }
  }

  // v2.5 战斗弹道：帧攻击事件 → 光弹从攻击者中心飞向目标中心（限流 6 条/帧）
  function playAttackFx(fx) {
    if (!fx || !fx.length || typeof document === 'undefined' || FX.reduced) return;
    let n = 0;
    for (let i = 0; i < fx.length; i++) {
      const ev = fx[i];
      if (++n > 6) break;
      const from = G._bfEls && G._bfEls[ev.f], to = G._bfEls && G._bfEls[ev.t];
      if (!from || !to) continue;
      const rf = from.getBoundingClientRect(), rt = to.getBoundingClientRect();
      if (!rf.width || !rt.width) continue;
      const b = document.createElement('div');
      b.className = 'bf-bolt';
      const sx = rf.left + rf.width / 2, sy = rf.top + rf.height / 2;
      const tx = rt.left + rt.width / 2, ty = rt.top + rt.height / 2;
      b.style.left = sx + 'px'; b.style.top = sy + 'px';
      b.style.setProperty('--bx', (tx - sx) + 'px');
      b.style.setProperty('--by', (ty - sy) + 'px');
      document.body.appendChild(b);
      requestAnimationFrame(function () { b.classList.add('go'); });
      setTimeout(function () { b.remove(); }, 260);
    }
  }

  // v2.5 战斗弹道：帧攻击事件 → 光弹从攻击者中心飞向目标中心（限流 6 条/帧）
  function playAttackFx(fx) {
    if (!fx || !fx.length || typeof document === 'undefined' || FX.reduced) return;
    let n = 0;
    for (let i = 0; i < fx.length; i++) {
      const ev = fx[i];
      if (++n > 6) break;
      const from = G._bfEls && G._bfEls[ev.f], to = G._bfEls && G._bfEls[ev.t];
      if (!from || !to) continue;
      const rf = from.getBoundingClientRect(), rt = to.getBoundingClientRect();
      if (!rf.width || !rt.width) continue;
      const b = document.createElement('div');
      b.className = 'bf-bolt';
      const sx = rf.left + rf.width / 2, sy = rf.top + rf.height / 2;
      const tx = rt.left + rt.width / 2, ty = rt.top + rt.height / 2;
      b.style.left = sx + 'px'; b.style.top = sy + 'px';
      b.style.setProperty('--bx', (tx - sx) + 'px');
      b.style.setProperty('--by', (ty - sy) + 'px');
      document.body.appendChild(b);
      requestAnimationFrame(function () { b.classList.add('go'); });
      setTimeout(function () { b.remove(); }, 260);
    }
  }

  function applyFrame(fr) {
    try {
      G._fxHitsThisFrame = 0;
      G._fxShakenThisFrame = 0; // v2.4 震屏帧内全局限频（防多单位同帧叠加抖动）
      if (fr.sys) {
        const log = $('battleLog');
        const div = document.createElement('div');
        div.className = 'sys'; div.textContent = fr.line;
        log.appendChild(div); log.scrollTop = log.scrollHeight;
        return;
      }
      if (fr.ally) fr.ally.forEach(s => updateUnit(s));
      if (fr.enemy) fr.enemy.forEach(s => updateUnit(s));
      // v2.5 弹道：帧攻击事件 → 光弹
      if (fr.fx) playAttackFx(fr.fx);
      // 施法闪光 + 技能特效场（蓝色技能圈 + 技能名飘字）
      if (fr.casts && fr.casts.length) fr.casts.forEach(c => {
        const el = G._bfEls[c.uid];
        if (el) {
          el.classList.add('casting'); setTimeout(() => el.classList.remove('casting'), 280);
          if (!FX.reduced) {
            try { const r = el.getBoundingClientRect(); if (r && r.width) { FX.ripple(r.left + r.width / 2, r.top + r.height / 2, '#7fdff0'); FX.floatText(r.left + r.width / 2, r.top - 14, c.name, 'blue'); } } catch (e) {}
          }
        }
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
            AUDIO.play('combat/skill', { arch: c.arch, side: side, faction: c.fac });
            // v2.1：令的召唤/强化技能（arch=summon）额外叠"赋能"音（强化岁兽）
            if (c.arch === 'summon') AUDIO.play('summon/enhance', { side: side });
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
    G._lastRes = res; // v2.5 回放：结算后保留战斗帧供「回放战斗」
    const node = G.nodes[G.nodeIdx];
    // P2-4：复盘数据（胜利/失败都展示，失败额外给死因提示）
    const recap = buildRecap(res);
    // v2.5 战报：输出/承伤/治疗三榜（HTML，追加在复盘后）
    const report = buildReport(res);
    // v2.1 养狼：召唤物升级时播专属升级音（W2 音频契约兑现）
    if (G._summonLevelUp && G._summonLevelUp.length && !G._audioSkip && window.AUDIO) AUDIO.play('wolf/levelup');
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
        // P2-2：通关 BOSS 获得跨局战利品币（[PLACEHOLDER] 数额需标定）
        const gain = 8 + G.difficulty * 2;
        const meta = addMetaCoins(gain);
        G._result = { title: '🏆 通关！晋升达成', body: '你击败了最终首领，棋局晋升至 Lv.' + p + '。获得战利品币 💎' + gain + '（累计 ' + meta.coins + '）。', btn: '再来一局', kind: 'reset' };
        showResult(G._result.title, G._result.body, G._result.btn, () => reset(), recap + report);
        saveGame();
        return;
      }
      let body = '本节点告捷，连胜 ' + G.winStreak + '。';
      // v2 装备：胜利掉落（20% 白~蓝）/ 无伤胜利保底（100% 白~蓝）[PLACEHOLDER]
      try {
        const mr = Math.min(1, maxEquipRarity(G.level));
        const dropPool = EQUIP_POOL.filter(e => e.type !== 'engraving' && e.rarity <= mr);
        const flawless = !(res.stats && res.stats.allyDeaths > 0);
        const chance = flawless ? 1 : 0.2;
        if (dropPool.length && Math.random() < chance) {
          const eq = dropPool[Math.floor(Math.random() * dropPool.length)];
          G.equipState.bag.push(eq.id);
          body += (flawless ? ' 无伤胜利，缴获装备「' + (eq.name || eq.id) + '」！' : ' 缴获装备「' + (eq.name || eq.id) + '」。');
        }
      } catch (e) { /* 掉落失败不阻塞结算 */ }
      // 精英节点额外奖励（按全局难度倍率）
      if (node.type === 'elite') { G.gold += Math.round(6 * rm); G.exp += Math.round(4 * rm); levelUp(); body += ' 精英奖励 +' + Math.round(6 * rm) + '💰 +' + Math.round(4 * rm) + 'exp。'; }
      // 遭遇节点胜利奖励（全局难度 × 该遭遇档位奖励倍率，之前只在卡片显示，现真正结算）
      if (node.type === 'encounter' && G.encounterDiff) {
        const er = Math.round(rnd(10, 16) * rm * (ENCOUNTER_DIFFS[G.encounterDiff].rewardMult || 1));
        G.gold += er; levelUp(); body += ' 遭遇奖励 +' + er + '💰。';
      }
      G._result = { title: '胜利', body, btn: '前进 →', kind: 'next' };
      showResult(G._result.title, G._result.body, G._result.btn, () => nextNode(), recap + report);
      saveGame();
    } else {
      G.lossStreak++; G.winStreak = 0;
      // P1-2：战败扣血平滑——上限 22% 当前血量 ×难度倍率，杜绝「梦魇-78 近即死」（[PLACEHOLDER] 上限需标定）
      const hlm = diffCfg().hpLossMult || 1;
      const rawLoss = (res.eAlive * 4 + 3) * hlm;
      const maxLoss = G.maxHp * 0.22 * hlm;
      const dmg = Math.min(Math.round(rawLoss), Math.round(maxLoss));
      G.hp -= dmg;
      // 落后补给：连败额外赠送 1 次免费刷新（橡皮筋），下一运营回合生效
      G.pendingFreeReroll = (G.pendingFreeReroll || 0) + 1;
      renderTop();
      if (node.type === 'boss') {
        G._result = { title: '⚔ 败于最终首领', body: '你倒在了最终首领面前（剩余生命 ' + Math.max(0, G.hp) + '）。历史最高晋升：Lv.' + getPromote(), btn: '再来一局', kind: 'reset' };
        showResult(G._result.title, G._result.body, G._result.btn, () => reset(), recap + report);
        saveGame();
        return;
      }
      if (G.hp <= 0) {
        G._result = { title: '💀 棋局崩盘', body: '小队生命归零。历史最高晋升：Lv.' + getPromote(), btn: '再来一局', kind: 'reset' };
        showResult(G._result.title, G._result.body, G._result.btn, () => reset(), recap + report);
        saveGame();
        return;
      }
      G._result = { title: '战败', body: '损失 ' + dmg + ' 生命（剩余 ' + Math.max(0, G.hp) + '）。连败补给：下次刷新免费。整顿后再战。', btn: '前进 →', kind: 'next' };
      showResult(G._result.title, G._result.body, G._result.btn, () => nextNode(), recap + report);
      saveGame();
    }
  }

  // P2-4：战败/胜利复盘面板——把战斗统计与阵容信息合成为可读取的反馈（补上 F9 缺失的反馈通道）
  // v2.5 战报：输出/承伤/治疗三榜（per-unit，前 3 名，HTML）
  function buildReport(res) {
    try {
      const st = res && res.stats;
      if (!st || !res.frames) return '';
      const nameOf = function (uid) {
        if (!uid) return '?';
        for (const fr of res.frames) {
          const a = fr.ally.find(u => u.uid === uid), e = fr.enemy.find(u => u.uid === uid);
          if (a) return a.name || '干员';
          if (e) return e.name || '敌方';
        }
        return uid.charAt(0) === 'a' ? '我方干员' : '敌方单位';
      };
      const top = function (obj, n) {
        const arr = [];
        for (const k in obj) if (obj[k] > 0) arr.push([nameOf(k), obj[k]]);
        arr.sort((a, b) => b[1] - a[1]);
        return arr.slice(0, n);
      };
      const row = function (arr) {
        if (!arr.length) return '';
        return arr.map((x, i) => '<div style="display:flex;justify-content:space-between;gap:10px;line-height:1.5"><span>' + (i + 1) + '. ' + x[0] + '</span><b>' + x[1] + '</b></div>').join('');
      };
      const sec = function (title, arr) {
        if (!arr.length) return '';
        return '<div style="margin-top:7px;font-weight:700;font-size:12px;color:#8a6d1a">' + title + '</div>' + row(arr);
      };
      return sec('⚔ 输出榜', top(st.dmgBy, 3)) + sec('🛡 承伤榜', top(st.takenBy, 3)) + sec('✚ 治疗榜', top(st.healBy, 3));
    } catch (e) { return ''; }
  }

  function buildRecap(res) {
    const board = Object.keys(G.board).map(k => G.board[k]);
    if (!board.length) return '';
    const info = board.map(u => ({ name: u.op.name, bonds: u.op.bonds, star: u.star }));
    const bonds = computeBonds(info);
    const realBonds = bonds.active.filter(b => b.axis === '职业' || b.axis === '阵营' || b.axis === '特殊').length;
    const avgStar = (board.reduce((s, u) => s + u.star, 0) / board.length).toFixed(1);
    const st = res.stats || { allyDmg: 0, enemyDmg: 0, allyDeaths: 0, enemyDeaths: 0 };
    let cause = '';
    if (st.allyDeaths > 0 && st.allyDmg < st.enemyDmg * 0.85) cause = '（关键死因：输出不足，建议补强后排/法伤）';
    else if (st.allyDeaths >= Math.ceil(board.length * 0.6)) cause = '（关键死因：前排承伤不足，建议补重装/减伤）';
    else if (st.allyDmg >= st.enemyDmg && res.winner === 'enemy') cause = '（关键死因：被处决/真伤穿透，建议分散站位）';
    // v2.1 养狼：战斗后升级提示（仅本 run；G._summonLevelUp 由 onFight→grantSummonExp 计算）
    let sumLine = '';
    const lu = G._summonLevelUp;
    if (lu && lu.length) {
      const parts = lu.map(u => (u.type === 'wolf' ? '🐺狼' : '🐾岁兽') + ' Lv.' + u.from + '→' + u.to);
      sumLine = ' · 召唤物升级：' + parts.join('、');
    }
    return '复盘 → 阵容羁绊 ' + realBonds + ' 组 · 平均 ' + avgStar + '★ · 输出 ' + st.allyDmg + ' / 承伤 ' + st.enemyDmg +
      ' · 我方阵亡 ' + st.allyDeaths + ' / 敌方 ' + st.enemyDeaths + (res.winner === 'enemy' ? cause : '') + sumLine;
  }

  function showResult(title, body, btn, cb, recap) {
    $('resultTitle').textContent = title;
    $('resultBody').textContent = body;
    const rc = $('resultRecap');
    if (rc) { if (recap) { rc.innerHTML = recap; rc.classList.remove('hidden'); } else rc.classList.add('hidden'); }
    const b = $('btnResult');
    b.textContent = btn;
    b.onclick = () => { if (window.SFX) SFX.play('click'); cb(); };
    $('resultScreen').classList.remove('hidden');
    $('battleScreen').classList.add('hidden');
    // v2.4 结算粒子：胜利/告捷时标题处金色光点
    if (/胜利|通关|晋升|告捷/.test(title)) {
      try { const tr = $('resultTitle').getBoundingClientRect(); if (tr && tr.width) FX.burst(tr.left + tr.width / 2, tr.top + 4, 12); } catch (e) {}
    }
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
    // P2-1：三阶段 roguelite 分支地图。每阶段保留固定结构（开头补给 / 策略 / 遭遇 / 阶段末补给 / BOSS 前补给），
    // 但把中段若干「普通战」替换为「分叉节点」(fork)：玩家在三选一路径中做抉择，补齐中期 agency。
    // 分叉选项在 build 时随机生成（保证至少一条战斗线），选择后 node.type 锁定并存入存档，重载不再重选。
    function withForks(arr) {
      const battles = [];
      arr.forEach((t, i) => { if (t === 'battle') battles.push(i); });
      if (battles.length >= 2) {
        const a = battles[1], b = battles[battles.length - 1];
        if (a !== b) { arr[a] = 'fork'; arr[b] = 'fork'; }
      }
      return arr;
    }
    const optsPool = ['battle', 'reward', 'strategy', 'encounter'];
    const mk = t => {
      if (t === 'fork') {
        const opts = shuffle(optsPool.slice()).slice(0, 3);
        if (opts.indexOf('battle') < 0) opts[0] = 'battle'; // 保证至少一条战斗线
        return { type: 'fork', options: opts };
      }
      return { type: t };
    };
    // P2-1+：每阶段插入 1 个市场节点（market：10 干员 + 5 装备 补强）——替换每阶段中段第 4 个 battle
    function withMarket(arr) {
      const battles = [];
      arr.forEach((t, i) => { if (t === 'battle') battles.push(i); });
      if (battles.length >= 1) arr[battles[Math.floor(battles.length / 2)]] = 'market';
      return arr;
    }
    const phase1 = withMarket(withForks(['reward', 'reward', 'battle', 'strategy', 'battle', 'battle', 'encounter', 'reward', 'battle'])).map(mk);
    const phase2 = withMarket(withForks(['battle', 'strategy', 'battle', 'battle', 'battle', 'battle', 'encounter', 'reward', 'battle'])).map(mk);
    const phase3 = withMarket(withForks(['battle', 'strategy', 'battle', 'battle', 'battle', 'battle', 'encounter', 'reward', 'boss'])).map(mk);
    const all = phase1.concat(phase2).concat(phase3);
    all.forEach((n, i) => { n.phase = (i < 9 ? 1 : i < 18 ? 2 : 3); });
    G.nodes = all;
  }

  // P2-1：分叉节点选择屏（复用 overlay/panel/env-choices 样式）
  function showForkScreen(node) {
    const wrap = $('forkChoices');
    if (!wrap) { routeNode(Object.assign({}, node, { type: 'battle' })); return; }
    const opts = (node.options && node.options.length) ? node.options : ['battle', 'reward', 'strategy'];
    wrap.innerHTML = opts.map(o =>
      '<div class="env-card" data-fork="' + o + '"><h4>' + NODE_LABEL[o] + '</h4><p>' + FORK_DESC[o] + '</p></div>'
    ).join('');
    wrap.querySelectorAll('.env-card').forEach(c => c.onclick = () => {
      if (window.SFX) SFX.play('click');
      const pick = c.dataset.fork;
      node.type = pick;            // 锁定选择，存档后不再重选
      $('forkScreen').classList.add('hidden');
      routeNode(node);
    });
    $('forkScreen').classList.remove('hidden');
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
    // 敌方站位预览：叠加在统一棋盘右半 4×6 区域（pointer-events:none 不干扰拖拽）
    const overlay = $('enemyOverlay');
    if (overlay) {
      overlay.innerHTML = '';
      const enemies = team;
      const eps = autoPositions(enemies, 'enemy'); // 敌方坐标 x∈[4,7]（右半4列）, y∈[0,7]
      enemies.forEach((t, i) => {
        const p = eps[i]; if (!p) return;
        // 战场坐标 -> 部署区右半局部坐标：localCol = x-4 ∈[0,3], row = y ∈[0,5]
        const localCol = p.x - GRID_COLS;
        const row = p.y;
        if (localCol < 0 || localCol >= GRID_COLS || row < 0 || row >= GRID_ROWS) return;
        const c = document.createElement('div');
        c.className = 'eo-chip';
        // 百分比定位：overlay 严格覆盖部署区右半（4 列 × 6 行），与战斗坐标一一对应，头像填满格子
        c.style.left = ((localCol + 0.5) / GRID_COLS * 100) + '%';
        c.style.top = ((row + 0.5) / GRID_ROWS * 100) + '%';
        c.style.width = (100 / GRID_COLS) + '%';
        c.style.height = (100 / GRID_ROWS) + '%';
        c.style.transform = 'translate(-50%,-50%)';
        c.innerHTML = '<img src="' + t.op.avatar + '" alt="" onerror="this.style.background=\'#222\'">';
        c.title = t.op.name + (t.star > 1 ? '★' + t.star : '');
        overlay.appendChild(c);
      });
    }
  }

  function renderAll() {
    renderTop(); renderBoard(); renderShop(); renderBonds(); renderUnitBar(); showEnemyPreview();
  }

  /* ---- 投资环境 ---- */
  function renderEnv() {
    const wrap = $('envChoices');
    if (!wrap) { console.error('[renderEnv] #envChoices 不存在'); return; }
    // 防御：ENV_POOL 或 shuffle 不可用时用硬编码保底
    let pool = (typeof ENV_POOL !== 'undefined' && ENV_POOL && ENV_POOL.length) ? ENV_POOL : null;
    if (!pool) {
      console.warn('[renderEnv] ENV_POOL 不可用，使用保底环境列表');
      pool = [
        { id: 'gold', name: '资本注入', desc: '起始 +12 金币，前期即可抢高费。', effects: { gold: 12 } },
        { id: 'exp', name: '精英培养', desc: '每回合额外 +3 经验，更快拉高人口。', effects: { expBonus: 3 } },
        { id: 'hp', name: '重装防线', desc: '小队生命 +40，容错更高。', effects: { maxHp: 40 } },
      ];
    }
    const shuf = (typeof shuffle === 'function') ? shuffle : (arr) => arr.slice().sort(() => Math.random() - 0.5);
    let count = 3;
    try { if (typeof getMeta === 'function' && getMeta()?.unlocks?.envPlus) count = 4; } catch(e) { /* 保持默认 3 */ }
    const promo = (typeof getPromote === 'function') ? (() => { try { return getPromote(); } catch(e) { return 1; } })() : 1;
    const choices = shuf(pool).slice(0, count);
    wrap.innerHTML = choices.map(e =>
      '<div class="env-card" data-env="' + e.id + '"><h4>' + e.name + '</h4><p>' + e.desc + '</p></div>'
    ).join('') + '<div class="hint" style="width:100%;margin-top:10px">历史最高晋升：Lv.' + promo + '</div>';
    // 防御：确认卡片确实渲染出来了
    if (wrap.querySelectorAll('.env-card').length === 0) {
      console.error('[renderEnv] 卡片渲染失败，使用紧急保底');
      wrap.innerHTML = '<div class="env-card" data-env="gold"><h4>资本注入</h4><p>起始 +12 金币。</p></div>' +
        '<div class="env-card" data-env="exp"><h4>精英培养</h4><p>每回合额外 +3 经验。</p></div>' +
        '<div class="env-card" data-env="hp"><h4>重装防线</h4><p>小队生命 +40。</p></div>' +
        '<div class="hint" style="width:100%;margin-top:10px">历史最高晋升：Lv.' + promo + '</div>';
    }
    wrap.querySelectorAll('.env-card').forEach(c => c.onclick = () => {
      if (window.SFX) SFX.play('click');
      G.env = (pool || []).find(e => e.id === c.dataset.env) || { id: c.dataset.env, name: '', effects: {} };
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
    // 防御：DIFFICULTY 不可用时用保底
    const diff = (typeof DIFFICULTY !== 'undefined' && DIFFICULTY) ? DIFFICULTY : {
      '1': { name: '轻松', desc: '适合熟悉游戏机制。', enemyMult: 0.88, countBonus: 0, rewardMult: 0.8 },
      '2': { name: '普通', desc: '标准难度，适合大多数玩家。', enemyMult: 1.0, countBonus: 0, rewardMult: 1.0 },
      '3': { name: '困难', desc: '敌方较强，需要合理规划。', enemyMult: 1.2, countBonus: 1, rewardMult: 1.4 },
      '4': { name: '噩梦', desc: '非常困难，每项属性都压制你。', enemyMult: 1.35, countBonus: 1, rewardMult: 1.8 },
      '5': { name: '梦魇', desc: '极限挑战，只有最强棋手能存活。', enemyMult: 1.45, countBonus: 2, rewardMult: 2.5 },
    };
    wrap.innerHTML = Object.keys(diff).map(k => {
      const d = diff[k];
      return '<div class="diff-card" data-diff="' + k + '">' +
        '<div class="dc-num">' + k + '</div>' +
        '<div class="dc-name">' + d.name + '</div>' +
        '<div class="dc-desc">' + d.desc + '</div>' +
        '<div class="dc-enemy">敌强 ×' + d.enemyMult + (d.countBonus ? ' (+' + d.countBonus + ')' : '') + '　奖励 ×' + d.rewardMult + '</div>' +
      '</div>';
    }).join('');
    // 防御：确认卡片渲染成功
    if (wrap.querySelectorAll('.diff-card').length === 0) {
      console.error('[renderDiff] 难度卡片渲染失败');
      wrap.innerHTML = '<div class="diff-card" data-diff="2"><div class="dc-num">2</div><div class="dc-name">普通</div><div class="dc-desc">标准难度。</div></div>';
    }
    wrap.querySelectorAll('.diff-card').forEach(c => {
      c.onclick = () => {
        if (window.SFX) SFX.play('click');
        G.difficulty = parseInt(c.dataset.diff, 10) || 2;
        $('diffScreen').classList.add('hidden');
        $('envScreen').classList.remove('hidden');
        if (window.AUDIO) AUDIO.setMusic('exploration');
        renderEnv();
      };
    });
  }

  function reset() {
    clearSave();
    G.gold = 0; G.level = 1; G.exp = 0; G.hp = 100; G.maxHp = 100;
    G.pendingFreeReroll = 0;
    // P2-2：Meta 解锁「先发棋手」——每局起始等级 +1
    if (getMeta().unlocks.startLevel) G.level = 2;
    G.winStreak = 0; G.lossStreak = 0;
    G.bench = []; G.board = {}; G.shop = [null, null, null, null, null];
    G.nodeIdx = 0; G.env = null; G.selected = null; G.difficulty = 2;
    // v2.1 养狼：局内（本 run）召唤物状态——开局初始化，局结束重置，不写 Meta（cross-run）
    G.summonState = { wolf: { level: 1, exp: 0 }, beast: { level: 1, exp: 0 }, feedAtk: 0, feedHp: 0 };
    G._summonLevelUp = null;
    G._feedShownWolfLv = undefined;
    // v2 装备：本局重置（背包 + 槽位）
    G.equipState = { bag: [], slots: {} };
    G._equipShop = null;
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
    // 防御：环境界面保底恢复——300ms 后检查卡片是否渲染成功，失败则自动重试一次
    setTimeout(() => {
      const es = $('envScreen');
      if (es && !es.classList.contains('hidden')) {
        const ec = document.querySelectorAll('#envChoices .env-card');
        if (!ec || ec.length === 0) {
          console.warn('[reset] 环境卡片未渲染，自动重试 renderEnv()');
          try { renderEnv(); } catch(e2) { console.error('[reset] 重试也失败:', e2); }
        }
      }
    }, 300);
  }

  /* ---- 拖拽系统（稳健版） ---- */
  let drag = null;
  let eqDrag = null; // v2.4 装备拖拽：背包装备卡拖到干员卡穿戴
  let clickSuppress = false;

  // 在判定落点时临时隐藏幽灵，彻底避免 elementFromPoint 命中幽灵本身
  function elementAt(x, y) {
    const g = (drag && drag.ghost) || (eqDrag && eqDrag.ghost);
    if (g) g.style.display = 'none';
    let el = null;
    try { el = document.elementFromPoint ? document.elementFromPoint(x, y) : null; } catch (e) { el = null; } // jsdom 无此 API，安全兜底
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
    if (cell && !cell.classList.contains('enemy-zone')) {
      cell.classList.add('drop-hover');
      // v2.5 不可部署预提示：商店卡金币不足/人口满无法升星/备战席满无法换位 → 红闪（与 dropOnCell 校验一致）
      try {
        if (drag && drag.from === 'shop') {
          let bad = G.gold < effCost(drag.op);
          if (!bad) {
            if (!cell.classList.contains('filled')) { if (Object.keys(G.board).length >= boardCap() && predictStarGain(drag.op) === 0) bad = true; }
            else if (G.bench.length >= BENCH_CAP && predictStarGain(drag.op) === 0) bad = true;
          }
          if (bad) { cell.classList.remove('drop-hover'); cell.classList.add('drop-bad'); }
        } else if (drag && drag.from !== 'shop' && drag.uid != null && !cell.classList.contains('filled')) {
          if (Object.keys(G.board).length >= boardCap()) { cell.classList.remove('drop-hover'); cell.classList.add('drop-bad'); }
        }
      } catch (e) {}
      return;
    }
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
    // v2.4 装备拖拽：背包装备卡直接拖到干员卡穿戴（优先于干员拖拽）
    const eqCard = e.target.closest('[data-eq-bag]');
    if (eqCard) {
      const bi = parseInt(eqCard.dataset.eqBag, 10);
      const eqId = G.equipState.bag[bi];
      if (!eqId) return;
      eqDrag = { active: false, bagIdx: bi, eqId, startX: e.clientX, startY: e.clientY, ghost: null };
      window.addEventListener('pointermove', onEqPointerMove);
      window.addEventListener('pointerup', onEqPointerUp);
      e.preventDefault();
      return;
    }
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
      if (d.ghost) { d.ghost.remove(); d.ghost = null; }
      if (d.from !== 'shop' && d.uid != null) { clickSuppress = true; selectUnit(d.uid); }
      return;
    }
    clickSuppress = true;
    const tgt = pickTarget(e.clientX, e.clientY);
    // v2.5 拖拽吸附：ghost 飞向目标格中心（或无效落点回弹原位）后再落子，落格涟漪/弹跳在 renderAll 后触发
    const flyTo = function (cb) {
      const g = d.ghost;
      if (!g) { cb(); return; }
      let target = null;
      if (tgt && tgt.type === 'cell') {
        const cell = document.querySelector('.board-cell[data-slot="' + tgt.idx + '"]');
        if (cell) { const r = cell.getBoundingClientRect(); if (r && (r.width || r.height)) target = { x: r.left + r.width / 2 - 39, y: r.top + r.height / 2 - 46 }; }
      } else if (tgt && tgt.type === 'bench') {
        const bench = document.querySelector('#bench');
        if (bench) { const r = bench.getBoundingClientRect(); if (r && (r.width || r.height)) target = { x: r.left + r.width / 2 - 39, y: r.top + r.height / 2 - 46 }; }
      } else if (tgt && tgt.type === 'sell') {
        const sz = document.querySelector('#sellZone');
        if (sz) { const r = sz.getBoundingClientRect(); if (r && (r.width || r.height)) target = { x: r.left + r.width / 2 - 39, y: r.top + r.height / 2 - 46 }; }
      }
      if (!target) {
        const src = d.from === 'shop' ? document.querySelector('.ucard[data-shop="' + d.shopIdx + '"]')
          : document.querySelector('.ucard[data-uid="' + d.uid + '"][data-where="' + d.from + '"]');
        if (src) { const r = src.getBoundingClientRect(); if (r && (r.width || r.height)) target = { x: r.left, y: r.top }; }
      }
      if (!target) { g.remove(); d.ghost = null; cb(); return; }
      g.style.transition = 'left .22s cubic-bezier(.3,.9,.4,1), top .22s cubic-bezier(.3,.9,.4,1), opacity .22s ease';
      g.style.left = target.x + 'px';
      g.style.top = target.y + 'px';
      g.style.opacity = '.3';
      setTimeout(function () { g.remove(); d.ghost = null; cb(); }, 230);
    };
    flyTo(function () {
      if (tgt && tgt.type === 'cell') dropOnCell(d, tgt.idx);
      else if (tgt && tgt.type === 'bench') dropOnBench(d);
      else if (tgt && tgt.type === 'sell' && d.uid != null) sellUnit(d.uid);
      renderAll();
    });
  }

  // —— v2.4 装备拖拽：背包装备卡拖到干员卡穿戴 ——
  function onEqPointerMove(e) {
    if (!eqDrag) return;
    const dx = e.clientX - eqDrag.startX, dy = e.clientY - eqDrag.startY;
    if (!eqDrag.active) {
      if (Math.hypot(dx, dy) < 6) return;
      eqDrag.active = true;
      const card = document.querySelector('[data-eq-bag="' + eqDrag.bagIdx + '"]');
      if (card) { card.classList.add('dragging'); eqDrag.ghost = createGhost(card); }
    }
    if (eqDrag.ghost) {
      eqDrag.ghost.style.left = (e.clientX - 39) + 'px';
      eqDrag.ghost.style.top = (e.clientY - 46) + 'px';
    }
    markEqHover(e.clientX, e.clientY);
  }
  function markEqHover(x, y) {
    clearEqHover();
    const el = elementAt(x, y);
    if (!el) return;
    const uc = el.closest('.ucard[data-uid]');
    if (uc && findUnit(parseInt(uc.dataset.uid, 10))) uc.classList.add('eq-drop-target');
  }
  function clearEqHover() {
    document.querySelectorAll('.eq-drop-target').forEach(e => e.classList.remove('eq-drop-target'));
  }
  function onEqPointerUp(e) {
    window.removeEventListener('pointermove', onEqPointerMove);
    window.removeEventListener('pointerup', onEqPointerUp);
    if (!eqDrag) return;
    const d = eqDrag; eqDrag = null;
    clearEqHover();
    if (d.ghost) { d.ghost.remove(); d.ghost = null; }
    document.querySelectorAll('[data-eq-bag].dragging').forEach(c => c.classList.remove('dragging'));
    // 点击（未拖动）→ 保持原"选中待穿"行为
    if (!d.active) { clickSuppress = true; G._eqPending = d.bagIdx; renderEquipPanel(); return; }
    // 拖动 → 落到干员卡上穿戴（elementAt 优先；jsdom 无布局时回退 e.target）
    clickSuppress = true;
    const el = elementAt(e.clientX, e.clientY) || e.target;
    const uc = el && el.closest('.ucard[data-uid]');
    if (uc) {
      const uid = parseInt(uc.dataset.uid, 10);
      if (findUnit(uid)) { equipToUnit(uid, d.eqId); }
    }
    renderAll();
  }

  function dropOnCell(d, idx) {
    const cellEl = function () { return document.querySelector('.board-cell[data-slot="' + idx + '"]'); };
    const reject = function (msg) { flash(msg); const ce = cellEl(); if (ce) { ce.classList.add('drop-reject'); setTimeout(function () { ce.classList.remove('drop-reject'); }, 450); } FX.shake(120, 4); };
    const okFx = function () { setTimeout(function () { const ce = cellEl(); if (ce) { ce.classList.add('drop-ok'); setTimeout(function () { ce.classList.remove('drop-ok'); }, 600); const r = ce.getBoundingClientRect(); if (r && r.width) FX.ripple(r.left + r.width / 2, r.top + r.height / 2); const uc = ce.querySelector('.ucard'); if (uc) { uc.classList.add('card-settle'); setTimeout(function () { uc.classList.remove('card-settle'); }, 340); } } }, 320); };
    if (!isLeftSlot(idx)) { reject('右侧为敌方站位预览，无法部署'); return; }
    const occU = G.board[idx];
    const curCount = boardCount();

    if (d.from === 'shop') {
      const op = d.op, c = effCost(op);
      if (G.gold < c) { reject('金币不足'); return; }
      if (occU) {
        if (G.bench.length >= BENCH_CAP && predictStarGain(op) === 0) { reject('备战席已满'); return; }
        const old = occU;
        G.board[idx] = { uid: uidc++, op, star: 1 };
        G.bench.push(old);
        G.shop[d.shopIdx] = null; G.gold -= c;
      } else {
        if (curCount >= boardCap()) { reject('人口已满（' + curCount + '/' + boardCap() + '），请升级或下场干员'); return; }
        G.board[idx] = { uid: uidc++, op, star: 1 };
        G.shop[d.shopIdx] = null; G.gold -= c;
      }
    } else if (d.from === 'bench') {
      const u = d.unit;
      if (occU) {
        if (G.bench.length >= BENCH_CAP) { reject('备战席已满'); return; }
        const old = occU;
        delete G.board[idx];
        G.board[idx] = { uid: u.uid, op: u.op, star: u.star };
        G.bench = G.bench.filter(x => x.uid !== u.uid);
        G.bench.push(old);
      } else {
        if (curCount >= boardCap()) { reject('人口已满（' + curCount + '/' + boardCap() + '），请升级或下场干员'); return; }
        G.bench = G.bench.filter(x => x.uid !== u.uid);
        G.board[idx] = { uid: u.uid, op: u.op, star: u.star };
      }
    } else { // from board
      const u = d.unit;
      const srcIdx = slotOf(u.uid);
      if (srcIdx === idx) return;
      if (occU) {
        // 交换：把拖动的 u 放到目标格，目标 o 移到源格
        const o = G.board[idx];
        G.board[idx] = { uid: u.uid, op: u.op, star: u.star };
        G.board[srcIdx] = o;
      } else {
        delete G.board[srcIdx];
        G.board[idx] = { uid: u.uid, op: u.op, star: u.star };
      }
    }
    okFx();
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
        if (cell && !cell.classList.contains('enemy-zone')) {
          if (u) { const from = G.bench.some(x => x.uid === u.uid) ? 'bench' : 'board';
            dropOnCell({ from, uid: u.uid, unit: u, op: u.op, shopIdx: null }, parseInt(cell.dataset.slot, 10)); }
          G.selected = null; renderBoard(); renderTop(); return;
        }
        if (e.target.closest('#bench')) { if (u) dropOnBench({ from: G.bench.some(x => x.uid === u.uid) ? 'bench' : 'board', uid: u.uid, unit: u, op: u.op }); G.selected = null; renderBoard(); renderTop(); return; }
        if (e.target.closest('#sellZone')) { sellUnit(G.selected); G.selected = null; renderBoard(); renderTop(); return; }
        // 点击已选单位本身或空白处：取消选择（装备槽点击放行，走下方卸下逻辑）
        if (!e.target.closest('[data-eq-unequip],[data-eq-sell],[data-eq-bag],[data-eq-shop]') && (e.target.closest('.ucard[data-uid="' + G.selected + '"]') || !e.target.closest('.ucard'))) { selectUnit(G.selected); return; }
      }
      const sc = e.target.closest('[data-shop]');
      if (sc) { const i = parseInt(sc.dataset.shop, 10); buy(i); return; }
      // v2 装备交互：购买商店装备 / 背包选中待穿 / 出售背包装备 / 穿到已选干员
      const eqBuy = e.target.closest('[data-eq-shop]');
      if (eqBuy) { buyEquip(eqBuy.dataset.eqShop); return; }
      const eqSell = e.target.closest('[data-eq-sell]');
      if (eqSell) { sellEquip(parseInt(eqSell.dataset.eqSell, 10)); return; }
      const eqUne = e.target.closest('[data-eq-unequip]');
      if (eqUne) { unequip(eqUne.dataset.eqUnequip, parseInt(eqUne.dataset.eqSlot, 10)); return; }
      const eqBag = e.target.closest('[data-eq-bag]');
      if (eqBag) {
        const bi = parseInt(eqBag.dataset.eqBag, 10);
        if (G._eqPending === bi) { G._eqPending = null; renderEquipPanel(); return; }
        G._eqPending = bi; renderEquipPanel();
        const selUid = G.selected;
        if (selUid != null && findUnit(selUid)) {
          const eqId = G.equipState.bag[bi];
          equipToUnit(selUid, eqId);
        }
        return;
      }
      // 已选干员 + 点击装备卡 → 穿戴（支持点击干员卡后点背包）
      if (G._eqPending != null && e.target.closest('.ucard[data-uid]')) {
        const uid = parseInt(e.target.closest('.ucard[data-uid]').dataset.uid, 10);
        if (findUnit(uid)) { const eqId = G.equipState.bag[G._eqPending]; if (eqId) { equipToUnit(uid, eqId); } return; }
      }
      const uc = e.target.closest('.ucard[data-uid]');
      if (uc) { selectUnit(parseInt(uc.dataset.uid, 10)); return; }
    });
    document.body.addEventListener('keydown', e => {
      if (e.key === 'Escape' && G.selected != null) { selectUnit(G.selected); return; }
      // v2.5 快捷键：1-5 买商店卡 / E 部署选中干员到棋盘 / F 开战（仅非 overlay 且非战斗中）
      if (!$('arena').classList.contains('hidden') && !document.querySelector('.overlay:not(.hidden)')) {
        const k = e.key;
        if (k >= '1' && k <= '5') {
          const i = +k - 1;
          if (G.shop[i]) { buy(i); e.preventDefault(); return; }
        } else if (k === 'e' || k === 'E') {
          if (G.selected == null) { flash('先选中一名干员（点击卡牌）再按 E 部署'); return; }
          const u = findUnit(G.selected);
          if (!u) return;
          if (G.bench.some(x => x.uid === u.uid)) {
            const slot = firstFreeSlot();
            if (slot == null) { flash('棋盘已满或人口已满'); return; }
            dropOnCell({ from: 'bench', uid: u.uid, unit: u, op: u.op, shopIdx: null }, slot);
            G.selected = null; renderBoard(); renderTop();
          } else { flash('该干员已在棋盘上'); }
        } else if (k === 'f' || k === 'F') { onFight(); e.preventDefault(); return; }
      }
      // v2.5 快捷键：1-5 买商店卡 / E 部署选中干员到棋盘 / F 开战（仅非 overlay 且非战斗中）
      if (!$('arena').classList.contains('hidden') && !document.querySelector('.overlay:not(.hidden)')) {
        const k = e.key;
        if (k >= '1' && k <= '5') {
          const i = +k - 1;
          if (G.shop[i]) { buy(i); e.preventDefault(); return; }
        } else if (k === 'e' || k === 'E') {
          if (G.selected == null) { flash('先选中一名干员（点击卡牌）再按 E 部署'); return; }
          const u = findUnit(G.selected);
          if (!u) return;
          if (G.bench.some(x => x.uid === u.uid)) {
            const slot = firstFreeSlot();
            if (slot == null) { flash('棋盘已满或人口已满'); return; }
            dropOnCell({ from: 'bench', uid: u.uid, unit: u, op: u.op, shopIdx: null }, slot);
            G.selected = null; renderBoard(); renderTop();
          } else { flash('该干员已在棋盘上'); }
        } else if (k === 'f' || k === 'F') { onFight(); e.preventDefault(); return; }
      }
      if ((e.key === 'Enter' || e.key === ' ') && G.selected != null) {
        const cell = e.target.closest && e.target.closest('.board-cell');
        if (cell && !cell.classList.contains('enemy-zone')) {
          e.preventDefault();
          const u = findUnit(G.selected);
          if (u) { const from = G.bench.some(x => x.uid === u.uid) ? 'bench' : 'board';
            dropOnCell({ from, uid: u.uid, unit: u, op: u.op, shopIdx: null }, parseInt(cell.dataset.slot, 10)); }
          G.selected = null; renderBoard(); renderTop();
        }
      }
    });
    document.body.addEventListener('pointerdown', onPointerDown);
    const bondsToggle = $('bondsToggle');
    if (bondsToggle) bondsToggle.onclick = () => {
      const bar = $('bondsBar'); if (!bar) return;
      const collapsed = bar.classList.toggle('collapsed');
      bondsToggle.setAttribute('aria-expanded', String(!collapsed));
    };
    $('btnRefresh').onclick = refresh;
    $('btnExp').onclick = buyExp;
    if ($('btnFeedMeat')) $('btnFeedMeat').onclick = () => buyFeed('meat');
    if ($('btnFeedRation')) $('btnFeedRation').onclick = () => buyFeed('ration');
    $('btnFight').onclick = onFight;
    if ($('btnPause')) $('btnPause').onclick = () => {
      G._playPaused = !G._playPaused;
      $('btnPause').textContent = G._playPaused ? '▶ 继续' : '⏸ 暂停';
      if (window.SFX) SFX.play('click');
    };
    if ($('btnReplay')) $('btnReplay').onclick = () => {
      if (!G._lastRes) return;
      if (window.SFX) SFX.play('click');
      G._playPaused = false;
      $('resultScreen').classList.add('hidden');
      $('battleScreen').classList.remove('hidden');
      showBattle(G._lastRes, G._lastAll ? G._lastAll.ally : [], G._lastAll ? G._lastAll.enemy : []);
    };
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
    // P2-2：战利品库入口与返回
    const btnMeta = $('btnMeta');
    if (btnMeta) btnMeta.onclick = () => { $('startScreen').classList.add('hidden'); showMetaScreen(); };
    const btnMetaBack = $('btnMetaBack');
    if (btnMetaBack) btnMetaBack.onclick = () => { $('metaScreen').classList.add('hidden'); $('startScreen').classList.remove('hidden'); };
  }

  /* ---- 存档系统（本地进度续档） ---- */
  const SAVE_KEY = 'rh_chess_save';
  const NODE_ICON = { reward: '🎁', battle: '⚔', elite: '★', boss: '👑', strategy: '💡', encounter: '⚡', market: '🛒', fork: '🔀' };
  const NODE_LABEL = { reward: '补给节点', battle: '普通战', elite: '精英战', boss: 'BOSS 战', strategy: '策略节点', encounter: '遭遇节点', market: '补给市场', fork: '抉择点' };
  // P2-1：分叉节点各选项的说明
  const FORK_DESC = {
    battle: '常规作战，击败敌方编队换取金币与经验。',
    reward: '补给节点，直接获得金币并有概率白嫖干员。',
    strategy: '策略节点，三选一永久全局增益。',
    encounter: '遭遇节点，挑战高难敌队赢取丰厚奖励。',
  };

  // P2-2：Meta 进度货币（跨局成长）。通关 BOSS 获得 💎，解锁永久增益，把纯装饰的 promote 升级成有意义的成长。
  const META_KEY = 'rh_chess_meta';
  const META_UPGRADES = {
    startLevel: { name: '先发棋手', cost: 30, desc: '每局起始等级 +1（更快刷出高费干员）' },
    envPlus:    { name: '资本充裕', cost: 25, desc: '开局环境选择 +1 项（更多运营风格）' },
    rerollPlus: { name: '情报网络', cost: 20, desc: '每回合额外 +1 次免费刷新' },
  };
  function getMeta() {
    try { const m = JSON.parse(localStorage.getItem(META_KEY) || 'null'); if (m && m.unlocks) return m; } catch (e) {}
    return { coins: 0, unlocks: {} };
  }
  function setMeta(m) { try { localStorage.setItem(META_KEY, JSON.stringify(m)); } catch (e) {} }
  function addMetaCoins(n) { const m = getMeta(); m.coins = (m.coins || 0) + n; setMeta(m); return m; }
  function buyMeta(id) {
    const m = getMeta();
    const up = META_UPGRADES[id]; if (!up) return;
    if (m.unlocks[id]) return;
    if ((m.coins || 0) < up.cost) { flash('战利品币不足'); return; }
    m.coins -= up.cost; m.unlocks[id] = true; setMeta(m);
    if (window.SFX) SFX.play('click');
    renderMetaScreen();
  }
  function renderMetaScreen() {
    const m = getMeta();
    const coinsEl = $('metaCoins'); if (coinsEl) coinsEl.textContent = m.coins || 0;
    const wrap = $('metaChoices');
    if (wrap) {
      wrap.innerHTML = Object.keys(META_UPGRADES).map((id, idx) => {
        const up = META_UPGRADES[id];
        const owned = !!m.unlocks[id];
        const can = !owned && (m.coins || 0) >= up.cost;
        return '<div class="env-card tier-gold ' + (owned ? 'owned' : (can ? '' : 'locked')) + '" data-meta="' + id + '" style="animation-delay:' + (idx * 60) + 'ms">' +
          '<h4>' + up.name + (owned ? ' ✓' : '') + '</h4><p>' + up.desc + '</p>' +
          '<div class="mc-cost">' + (owned ? '已解锁' : ('💎 ' + up.cost)) + '</div></div>';
      }).join('');
      wrap.querySelectorAll('.env-card').forEach(c => c.onclick = () => buyMeta(c.dataset.meta));
    }
    const pe = $('metaPromo'); if (pe) pe.textContent = '历史最高晋升：Lv.' + getPromote();
  }
  function showMetaScreen() { renderMetaScreen(); $('metaScreen').classList.remove('hidden'); }

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
        // v2 装备：背包 + 槽位（仅本场持久化，不写 Meta）
        equipState: G.equipState ? { bag: G.equipState.bag || [], slots: G.equipState.slots || {} } : null,
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
    // v2 装备：回读（仅本场；旧存档无字段则初始化空）
    G.equipState = sv.equipState ? { bag: sv.equipState.bag || [], slots: sv.equipState.slots || {} } : { bag: [], slots: {} };
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
    // 防御：旧存档 nodeIdx 可能超出当前节点图（版本更新后 buildNodes 结构变化）。
    // 越界时若直接 G.nodes[sv.nodeIdx].type 会抛 TypeError 中断启动，留下空白 overlay。
    // 处理：视为无效存档 → 清档走新游戏流程（reset 内部会重新 buildNodes 并渲染难度/环境卡）。
    const node = G.nodes[sv.nodeIdx];
    if (!node) { clearSave(); reset(); return; }
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
      if (n.type === 'fork') cls += ' fork'; // v2.5 地图化：抉择点分叉标记
      html += '<div class="' + cls + '"><span class="nf-ico">' + NODE_ICON[n.type] + '</span>' +
        '<span class="nf-num">' + (pIdx + 1) + '</span><span class="nf-tag">' + NODE_LABEL[n.type] + '</span></div>';
      if (pIdx < phaseNodes.length - 1) html += '<span class="nf-link ' + (gi < cur ? 'passed' : '') + '"></span>';
    });
    html += '</div>';
    const nxt = nodes[cur + 1];
    let info = '本阶段进度 ' + (phaseNodes.indexOf(curNode) + 1) + ' / ' + phaseNodes.length + ' · 当前：' + NODE_LABEL[curNode.type];
    if (nxt) {
      if ((nxt.phase || 1) !== curPhase) info += '　|　下一阶段将解锁 ' + (nxt.phase || 1) + ' 阶段节点';
      else info += '　|　下一站：' + NODE_LABEL[nxt.type];
    } else info += '　|　终点：决战 BOSS';
    html += '<div class="nf-info">' + info + '</div>';
    el.innerHTML = html;
  }

  /* ---- 调试钩子（仅浏览器，方便控制台/自动化验证；不影响玩法） ---- */
  if (typeof window !== 'undefined') window.__RH = { FX, G, buy, onFight, simulateBattleGrid, simulateBattle, applyBonds, computeBonds, makeCombatSummon, placeAdjacentSummons, grantSummonExp, summonLevelFromExp, autoPositions, renderAll, renderBonds, showBondModal, showBondBanner, renderNodeFlow, togglePlace, selectUnit, buildNodes, getMeta, addMetaCoins, DEPLOY_PASSIVE, makeCombatUnit, buildRecap, generateEnemyTeam, reset, renderEnv, boardCap, isLeftSlot, boardCount, dropOnCell, dropOnBench, firstFreeSlot, tryCombine, STRATEGY_POOL, STRATEGY_BY_ID, aggregateStrategies, pickDiverseStrategies, showStrategyScreen, renderUnitBar, BONDS, SPECIAL, EQUIP_POOL, EQUIP_BY_ID, equipFor, buyEquip, equipToUnit, unequip, sellEquip, rollEquipShop, maxEquipRarity, renderEquipPanel, showMarketScreen, factionTrackBias, pickShop, skillFor, skillLabelFor };

  /* ---- 启动 ---- */
  buildNodes();
  bind();
  const _sv = loadSave();
  if (_sv) showStartScreen(_sv); else reset();

})(typeof window !== 'undefined' ? window : globalThis);