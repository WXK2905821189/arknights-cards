// resonance.js —— 阵营"跨阵营呼应（Narrative Resonance）"的机器可读数据
// 配套文档：阵营呼应关系设计参考（Narrative Resonance）.md
// 设计意图：机制层 23 个阵营 SPECIAL 目前是孤岛。本文件把世界观中真实的
//          血缘/地缘/宿敌/同源关系整理成可结算的"呼应对"，让系统设计师
//          在 computeBonds 之后用 computeResonance 二次结算，给玩家"发现感"。
//
// 接入方式（系统设计师）：
//   1) game.js 里 `const RESONANCE = require('./resonance.js')` 或 <script> 引入。
//   2) 在 computeBonds 得到 activeFactions 后调用：
//        const reso = RESONANCE.compute(activeFactions, units);
//      返回 [{a,b,type,flavor,bonus}]，bonus 描述对各阵营单位的 kw 溢出/解锁。
//   3) renderBonds 展示呼应提示："当 X 与 Y 同场，触发：……"。
//
// 关键约定：
//   - a / b 必须是 data.json 中 bonds['阵营'] 白名单键（与 bonds_flavor.js 一致）。
//   - type 决定结算方式（见下方 TYPE_DESC），全部复用机制层已有 kw，不发明新概念。
//   - flavor 为游戏内展示文案（叙事层），非台词，可自由润色。
//   - confidence: 'verified' 确证 / 'thematic' 主题 / 'gap' 缺口（缺父键）。

const RESONANCE = {
  // ============ 呼应类型说明 ============
  TYPE_DESC: {
    sameOrigin:   '同源/隶属：两阵营本是一家，互相溢出少量 kw 红利',
    mirror:       '镜像：帝国-属地逻辑的反转（一方已独立），解锁"不屈"纯增益',
    inheritance:  '传承：前身子阵营在场，母/继子阵营获得传承加成',
    ecosystem:    '生态圈：三方同场触发"全家福"强化（需三者皆在场）',
    sharedEnemy:  '共敌：共同敌人（如海嗣）在场时叠加穿透',
    tension:      '张力：刻意不协同，保留冲突感；可选单向"庇护"',
    origin:       '出身：流亡者回归母阵营语境，获得对应加成',
    bridge:       '桥梁：桥梁阵营把自身 kw 溢出到地缘/历史相连的帝国',
    neighbor:     '地缘：邻国贸易/合作小增益',
    territory:    '属地：属地组织在本阵营羁绊激活时获得"本地人"加成',
    behemoth:     '巨兽：两国皆与巨兽神明共处，隐藏彩蛋共鸣',
    theme:        '主题：叙事基调层面的圣战/骑士同源，可选弱联动',
    missingParent:'缺口：游戏缺父键，需新增阵营键才能落地'
  },

  // ============ 创作推演角标（护 lore 红线） ============
  // confidence==='thematic' 的 pair（拉特兰⊕卡西米尔、炎⊕谢拉格 等）是叙事设计师
  // 基于世界观联想的"假如"彩蛋，并非《明日方舟》官方已确认的史实关系。给它们打上
  // 此角标，玩家可在弹窗明确区分"已证实呼应（verified）"与"创作推演（thematic）"。
  // 红线：切勿将 thematic 误标为 verified —— 那会伪造官方设定。
  CREATIVE_BADGE: {
    label: '创作推演',
    note: '本呼应为叙事设计师基于世界观联想的「假如」彩蛋，并非《明日方舟》官方已确认的史实关系，仅作风味惊喜，不改变任何客观设定。'
  },

  // ============ 呼应对（映射到游戏 23 阵营键） ============
  PAIRS: [
    // —— A 组：同源 / 隶属 ——
    { a: '炎', b: '龙门', type: 'sameOrigin', confidence: 'verified',
      flavor: '龙门是炎国下辖的移动城邦，魏彦吾治下的自治之地。同处一张棋盘，便是一家人——只是这一个，走得稍远了些。',
      bonus: '炎 units 获得少量 guardAura 护持；龙门 units 获得少量 burnDoT 渗透；仅炎在场时龙门 cap 完全解锁（自治张力）。' },
    { a: '维多利亚', b: '塔拉', type: 'mirror', confidence: 'verified',
      flavor: '塔拉王国名义仍属维多利亚，实则早已独立自治。与龙门恰成镜像：一个留下，一个离开——同一道题，两种答案。',
      bonus: '双方获得"不屈"防御增益（纯增益，无来源），叙事：不再被帝国定义。' },
    { a: '谢拉格', b: '喀兰贸易', type: 'sameOrigin', confidence: 'verified',
      flavor: '喀兰贸易是谢拉格唯一的对外窗口，银灰家族执掌。家国一体：商团即国家的手与嘴。',
      bonus: '喀兰 atkBuff 溢出到谢拉格 units；谢拉格 shieldPeriodic 庇护喀兰 units。' },
    { a: '巴别塔', b: '罗德岛', type: 'inheritance', confidence: 'verified',
      flavor: '巴别塔是罗德岛的前身，凯尔希一脉相承。前人的旗，后人接着扛。',
      bonus: '巴别塔（defBuff）在场时，罗德岛（healAura）units 额外获得"传承"防御加成。' },
    { a: '莱塔尼亚', b: '叙拉古', type: 'mirror', confidence: 'verified',
      flavor: '叙拉古曾是莱塔尼亚辖下的一方大区，因城邦纷争独立而出。源石技艺的回响仍从帝都飘来——只是这一次，狼听懂了，帝国却假装没听见。',
      bonus: '叙拉古（summonWolf）units 获得莱塔尼亚 castAmp 层溢出（狼附带法术回声）；莱塔尼亚因失地获得"帝国余响"spRegen（可选）；与 A2/D1 平行（前属地独立）。' },
    { a: '维多利亚', b: '雷姆必拓', type: 'mirror', confidence: 'verified',
      flavor: '雷姆必拓曾是维多利亚的属地，如今是企业国家，矿脉之下还压着旧日的宗主权。开采铠甲下的矿脉——每一镐都带着一点"不再属于谁"的骄傲。',
      bonus: '雷姆必拓（damageReduction）units 获得维多利亚 pierce 层溢出（"开采铠甲下的矿脉"）；维多利亚在场时雷姆必拓单位击杀返还少量金币（"矿产变现"，呼应企业国家·矿产丰富）；与 A2/D1 平行（前属地/企业国家）。' },

    // —— B 组：罗德岛生态圈 ——
    { a: '巴别塔', b: '使徒', type: 'ecosystem', confidence: 'verified', third: '罗德岛',
      flavor: '巴别塔（凯尔希）、使徒（闪灵·夜莺·临光）、罗德岛（阿米娅）——这艘船记得每一个来过的人。',
      bonus: '三者同场时，罗德岛 units 的 healAura 大幅强化（传承+援手双重），解锁隐藏描述。' },

    // —— C 组：共敌 / 共源 ——
    { a: '伊比利亚', b: '深海猎人', type: 'sharedEnemy', confidence: 'verified',
      flavor: '一个沉入海底，一个从海底杀出，敌人却是同一个——海嗣。海潮宿命，殊途同归。',
      bonus: '同场时伊比利亚 magicAmp 与深海猎人 pierce 叠加为"穿透潮汐"；敌方带"海嗣"标签额外增伤。' },
    { a: '乌萨斯', b: '罗德岛', type: 'tension', confidence: 'verified',
      flavor: '一个以压迫感染者立国，一个以救治感染者立身。把加害者的故乡与受害者的庇护所摆在一起，是这艘船最尖锐的命题。',
      bonus: '刻意不协同（无加成）；可选：罗德岛 units 在乌萨斯在场时获得额外治疗（"庇护"），作为对冲突的回应。' },
    { a: '使徒', b: '卡西米尔', type: 'origin', confidence: 'verified',
      flavor: '临光曾被卡西米尔封为"耀骑士"，因反对商业化与矿石病被迫离乡。卡西米尔赶走的骑士，成了行走泰拉的医者。',
      bonus: '使徒（hpBuff）+卡西米尔（trueDmg）同场，临光系 units 获得"耀骑士归来"加成（真伤+援护）。' },

    // —— D 组：地缘 / 历史 / 主题 ——
    { a: '哥伦比亚', b: '维多利亚', type: 'mirror', confidence: 'verified',
      flavor: '哥伦比亚本是维多利亚开拓区，独立战争后离家。与塔拉平行，只是这一回，孩子真的走了。',
      bonus: '复用 mirror 逻辑；哥伦比亚（critDmg）自带"独立"锋芒，维多利亚对其无加成。' },
    { a: '莱茵生命', b: '维多利亚', type: 'bridge', confidence: 'verified',
      flavor: '莱茵生命横跨两帝国的研究机构，一家实验室连着曾经母子的两个强权。',
      bonus: '莱茵（spRegenBuff）在场时，若维多利亚在场则其 units 也获得 spRegen（桥梁）。' },
    { a: '莱茵生命', b: '哥伦比亚', type: 'bridge', confidence: 'verified',
      flavor: '莱茵生命与哥伦比亚亦有科研合作，资本的新风与雪境的仪器在此交汇。',
      bonus: '同上，莱茵在场且哥伦比亚在场时，哥伦比亚 units 获得 spRegen（桥梁）。' },
    { a: '谢拉格', b: '哥伦比亚', type: 'neighbor', confidence: 'verified',
      flavor: '谢拉格西邻哥伦比亚，自由国的资本曾数度叩响雪境之门。',
      bonus: '谢拉格 atkBuff 经喀兰溢出 + 哥伦比亚同场，获得"贸易窗口"小增益。' },
    { a: '谢拉格', b: '维多利亚', type: 'neighbor', confidence: 'verified',
      flavor: '谢拉格东接维多利亚；开斯特公爵的舰队曾以"军演"为名逼近圣山。雪境以炮口为邻。',
      bonus: '维多利亚在场时谢拉格获得"戒备"防御（shieldPeriodic 强化），叙事"以雪御炮"。' },
    { a: '谢拉格', b: '卡西米尔', type: 'neighbor', confidence: 'verified',
      flavor: '谢拉格北接卡西米尔，曾有骑士踏雪而来。北境骑士链的一环。',
      bonus: '与拉特兰-卡西米尔共同构成北境骑士脉络，同场给少量协同。' },
    { a: '拉特兰', b: '卡西米尔', type: 'theme', confidence: 'thematic', creative: true,
      flavor: '教宗骑士的铳与卡西米尔竞技骑士的枪，隔着泰拉击了个掌——都为"骑士"二字活过。',
      bonus: '可选主题联动：双方暴击系获得"圣战同源"小加成，不强求。' },
    { a: '鲤氏侦探事务所', b: '龙门', type: 'territory', confidence: 'verified',
      flavor: '鲤氏侦探事务所驻地龙门，老鲤的行踪从不出这座城。灰色地带的"万事屋"，本就是龙门的一部分。',
      bonus: '鲤氏（critBuff）units 在龙门（guardAura）羁绊激活时获得"本地人"属地强化。' },
    { a: '企鹅物流', b: '龙门', type: 'territory', confidence: 'verified',
      flavor: '企鹅物流的营业部就开在龙门的街角，送货路线绕着近卫局的岗哨画圈。龙门姓炎，企鹅物流便也姓了炎——只是这一支，把快递箱当盾牌使。',
      bonus: '企鹅物流（globalAspd）units 在龙门（guardAura）羁绊激活时获得"主场物流网络"（相邻协防溢出 + 全局攻速强化龙门 units）；与 D7 鲤氏同为龙门属地，凑齐 炎+龙门+(企鹅物流/鲤氏) 即点亮炎文化圈。' },
    { a: '炎', b: '谢拉格', type: 'behemoth', confidence: 'thematic', creative: true,
      flavor: '炎封印岁兽于京畿地下，谢拉格供奉巨兽耶拉冈德为国家之王。两国皆与古老之物同眠——这或许才是它们真正的共鸣。',
      bonus: '隐藏彩蛋：双方同场解锁"巨兽之佑"（burnDoT 点燃 + shieldPeriodic 护体），仅 capstone 触发。' },

    // —— E 组：父键状态修正 ——
    // 注：阿戈尔、卡兹戴尔 现已在游戏 data.json 中成为真实阵营键（阿戈尔=浊心斯卡蒂 池=1；
    //     卡兹戴尔=泥岩+赫德雷 池=2，二人均 origin=卡兹戴尔 的萨卡兹），故原"缺口"两条均已闭环，
    //     落地为 origin 呼应（verified）。如未来再发现缺失父键，在此追加 missingParent/gap 条目。
    { a: '深海猎人', b: '阿戈尔', type: 'origin', confidence: 'verified',
      flavor: '深海猎人的剑指向阿戈尔的指令，水月也自那片深海。母海与离岸的刃——他们本就是同一片蓝的两面。',
      bonus: '阿戈尔（浊心斯卡蒂）在场时，深海猎人 units 获得"母海回响"：magicAmp 微增 + 对"海嗣"标签额外穿透（复用 pierce）。' },
    { a: '使徒', b: '卡兹戴尔', type: 'origin', confidence: 'verified',
      flavor: '使徒的闪灵、夜莺皆为萨卡兹，巴别塔亦由萨卡兹王特蕾西娅建立——使徒的血脉，本就来自卡兹戴尔。离开故土的萨卡兹，与留在故土的萨卡兹，终在棋盘上重逢。',
      bonus: '使徒（hpBuff）与卡兹戴尔（defBuff）同场，双方获得"同源之血"加成（生命+防御，萨卡兹血脉相护）；卡兹戴尔 units 额外获得吸血（lifesteal），呼应"以血还血"。' }
  ],

  // ============ 真实战斗加成表（P1 落地用） ============
  // 键 = pair 的 a+'|'+b，必须与 PAIRS 对应；值 = 阵营 -> {BOND_KEYS 乘数类 kw: 占位值}。
  // 设计约束（守平衡红线）：
  //   1) 仅复用 BOND_KEYS 乘数类（atk/hp/def/aspd/crit/magicAmp/healAmp/spRegen）；
  //      行为型 kw（pierce/trueDmg/damageReduction 等）已迁至下方 SPECIAL_EFF（② 深接入 SPECIAL 关键字）。
  //   2) 数值为保守占位 [PLACEHOLDER]，须经蒙特卡洛 + 试玩标定后方可上调。
  //   3) 乌萨斯⊕罗德岛（tension，刻意不协同）不在此表 → 不生效，模态显示"暂未接入"。
  //      （使徒⊕卡兹戴尔 原为 gap，已随卡兹戴尔补键闭环，现为 verified 真实加成。）
  EFF: {
    '炎|龙门':          { '炎': { def: 0.06 }, '龙门': { atk: 0.06 } },
    '维多利亚|塔拉':     { '维多利亚': { def: 0.05 }, '塔拉': { def: 0.05 } },
    '谢拉格|喀兰贸易':   { '谢拉格': { atk: 0.06 }, '喀兰贸易': { def: 0.06 } },
    '巴别塔|罗德岛':     { '罗德岛': { def: 0.06 } },
    '巴别塔|使徒':       { '罗德岛': { healAmp: 0.08 } }, // ecosystem，需 third=罗德岛 同场（compute 已校验）
    '伊比利亚|深海猎人':  { '伊比利亚': { magicAmp: 0.06 }, '深海猎人': { crit: 0.06 } },
    '使徒|卡西米尔':     { '使徒': { hp: 0.06 }, '卡西米尔': { crit: 0.06 } },
    '使徒|卡兹戴尔':     { '使徒': { hp: 0.06 }, '卡兹戴尔': { def: 0.06 } }, // 同源之血：萨卡兹血脉相护
    '哥伦比亚|维多利亚':  { '哥伦比亚': { crit: 0.06 } },
    '莱茵生命|维多利亚':  { '维多利亚': { spRegen: 0.06 } },
    '莱茵生命|哥伦比亚':  { '哥伦比亚': { spRegen: 0.06 } },
    '谢拉格|哥伦比亚':    { '谢拉格': { atk: 0.05 }, '哥伦比亚': { atk: 0.05 } },
    '谢拉格|维多利亚':    { '谢拉格': { def: 0.06 } },
    '谢拉格|卡西米尔':    { '谢拉格': { crit: 0.05 }, '卡西米尔': { crit: 0.05 } },
    '拉特兰|卡西米尔':    { '拉特兰': { crit: 0.05 }, '卡西米尔': { crit: 0.05 } },
    '鲤氏侦探事务所|龙门': { '鲤氏侦探事务所': { crit: 0.06 } },
    '炎|谢拉格':         { '炎': { atk: 0.06 }, '谢拉格': { def: 0.06 } },
    '深海猎人|阿戈尔':    { '阿戈尔': { magicAmp: 0.06 }, '深海猎人': { crit: 0.06 } }
    // 乌萨斯|罗德岛（tension）故意不在此表
  },

  // ============ 行为型呼应（② 深接入 SPECIAL 关键字） ============
  // 复用 makeCombatUnit 已消费的"单位属性 kw 家族"（pierce/defShred/trueDmg/critDmg/
  // damageReduction/rampHit/spRegenBuff/skillAmp/lifesteal/slow/counter）。这些 kw 在
  // dealDamage/step 中以单位属性方式被读取（u.pierce/u.defShred/...），不与阵营 specialKw 单槽冲突。
  // 关键约定：用 += 叠加（沿用 skillAmp 加法 precedent），确保呼应加成叠在阵营 special 之上，
  //       而非被 Math.max 吞掉（如 深海猎人 阵营 pierce 0.25 > 呼应 0.12 时 Math.max 会让呼应归零）。
  // 数值 [PLACEHOLDER]，须经蒙特卡洛 + 试玩标定后方可上调；扩表即可加新呼应行为。
  // 红线：burnDoT/healAura/guardAura/shieldPeriodic/slowAura/execute/castAmp/summonWolf/globalAspd
  //       aura 型（guardAura/healAura/shieldPeriodic/castAmp/burnDoT/slowAura/execute/globalAspd/summonWolf）
  //       现已随 specialKw 多槽化改造（u.specialKw 改为数组）开放——呼应注入的 aura 与阵营 special 共存于同一单位。
  // factions: 受该行为 kw 影响的阵营（须为 a/b 之一或两者）；label: 战斗机制命名；
  // src: 参数镜像来源阵营（取 SPECIAL[src].params 作单一真相源，[PLACEHOLDER] 待标定）；
  //      若不填 src 而填 params，则以 params 为准（便于单独调参）。
  SPECIAL_EFF: {
    '伊比利亚|深海猎人': { kw: 'pierce', params: { value: 0.12 }, factions: ['伊比利亚', '深海猎人'], label: '穿透潮汐' },
    '炎|谢拉格':         { kw: 'damageReduction', params: { value: 0.10 }, factions: ['炎', '谢拉格'], label: '巨兽之佑' },
    '使徒|卡西米尔':     { kw: 'trueDmg', params: { value: 0.10 }, factions: ['使徒'], label: '耀骑士归来' },
    '使徒|卡兹戴尔':     { kw: 'lifesteal', params: { value: 0.10 }, factions: ['使徒', '卡兹戴尔'], label: '同源之血' },
    '维多利亚|雷姆必拓':  { kw: 'pierce', params: { value: 0.10 }, factions: ['雷姆必拓'], label: '开采铠甲下的矿脉' }
  },

  // ============ 行为型呼应 · aura 多槽型（specialKw 多槽化改造后开放） ============
  // 接收方阵营自身已有/将有 faction specialKw，呼应再以独立槽位追加一个行为 kw（两者共存）。
  // 参数优先用 entry.params；填入 src 则镜像 SPECIAL[src].params（单一真相源，随阵营 capstone 数值联动）。
  // scale（默认 1）：回声强度系数。设计原则「跨阵营回声应弱于原生 capstone」——故默认 0.6，
  //   令回声明确从属于原生机制又留有可感知空间；经蒙特卡洛标定（满强度 swing ≤3% win，已确认不超模），
  //   0.6 为保守安全值，最终数值仍待试玩复核（改这一行即可整体/逐条微调）。
  // 数值 [PLACEHOLDER]，须蒙特卡洛 + 试玩标定。
  SPECIAL_EFF_AURA: {
    '谢拉格|喀兰贸易':      { kw: 'shieldPeriodic', src: '谢拉格', factions: ['喀兰贸易'], scale: 0.6, label: '北境互助' },
    '莱塔尼亚|叙拉古':      { kw: 'castAmp',       src: '莱塔尼亚', factions: ['叙拉古'], scale: 0.6, label: '同源咏唱' },
    '鲤氏侦探事务所|龙门':   { kw: 'guardAura',     src: '龙门', factions: ['鲤氏侦探事务所'], scale: 0.6, label: '属地庇佑' },
    '企鹅物流|龙门':         { kw: 'guardAura',     src: '龙门', factions: ['企鹅物流'], scale: 0.6, label: '主场物流网络' },
    // v3.0 共鸣深化：炎|龙门 bonus 承诺落地——龙门 units 获得灼烧渗透（burnDoT 溅射）
    '炎|龙门':              { kw: 'burnDoT',       src: '炎', factions: ['龙门'], scale: 0.6, label: '炎流渗透' }
  },

  // ============ 计算入口 ============
  // activeFactions: Set/Array of 阵营键; units: 战斗单位数组（含 .faction）
  // 返回触发列表；ecosystem 需 third 同场才触发。
  compute(activeFactions, units) {
    const active = activeFactions instanceof Set ? activeFactions : new Set(activeFactions);
    const out = [];
    for (const p of this.PAIRS) {
      if (!active.has(p.a) || !active.has(p.b)) continue;
      if (p.type === 'ecosystem' && p.third && !active.has(p.third)) continue;
      out.push(p);
    }
    return out;
  }
};

// 浏览器 / Node 双环境导出
if (typeof module !== 'undefined' && module.exports) {
  module.exports = RESONANCE;
}
if (typeof window !== 'undefined') {
  window.RESONANCE = RESONANCE;
}
