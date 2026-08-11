# -*- coding: utf-8 -*-
"""
gen_stats.py — 给 136 张六星干员生成自走棋数值地基
- cost:   1-5 费用档（按职业定位强度，全为六星故不表示稀有度）
- stats:  hp / atk / def / spd(攻速) / range(射程) / dmgType
- traits: 特性标签（治疗/法术/远程物理/近战物理/控场/召唤/护盾/爆发/增益/回费）
- bonds:  羁绊标签 {职业, 种族, 阵营}
输出：更新 data.json 并重新生成内联 data.js（__DATA）
"""
import json, os

ROOT = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(ROOT, 'data.json')
DATAJS = os.path.join(ROOT, 'data.js')

# ---------- 职业基线（cost=3 时的数值） ----------
# role 仅用于说明；spd 越高攻速越快；range: 1=近战 2/3=远程
CLASS_PROFILE = {
    '先锋':  dict(hp=620, atk=72,  def_=35, spd=62, range=1, role='前期/回费'),
    '近卫':  dict(hp=560, atk=96,  def_=40, spd=70, range=1, role='近战物理输出'),
    '重装':  dict(hp=1050,atk=46,  def_=95, spd=40, range=1, role='前排坦克'),
    '狙击':  dict(hp=460, atk=92,  def_=25, spd=76, range=3, role='远程物理输出'),
    '术师':  dict(hp=430, atk=104, def_=20, spd=60, range=2, role='法术输出'),
    '医疗':  dict(hp=470, atk=58,  def_=25, spd=55, range=2, role='治疗'),
    '辅助':  dict(hp=490, atk=52,  def_=25, spd=50, range=2, role='增益/控场'),
    '特种':  dict(hp=520, atk=82,  def_=35, spd=66, range=1, role='位移/控场'),
}

# 职业基础费用 + 确定性偏移 -> 1-5 档
CLASS_BASE_COST = {
    '先锋': 2, '重装': 2, '医疗': 2, '辅助': 2,
    '近卫': 3, '狙击': 3, '术师': 3, '特种': 3,
}

# 费用倍率（cost 1->5 越强）
COST_MULT = [0.85, 0.95, 1.05, 1.18, 1.32]

# 旗舰carry -> 强制 5 费（仅在数据集中存在的才生效，收紧到真正旗舰以维持稀有度）
FLAGSHIP_5 = {
    '史尔特尔','灰烬','水月','令','玛恩纳','澄闪','锏','薇薇安娜','泥岩','棘刺',
    '山','煌','推进之王','能天使','缪尔赛思',
}

# 阵营归并（affiliation -> 阵营家族）
FACTION_MAP = {
    '罗德岛': '罗德岛', '罗德岛-精英干员': '罗德岛',
    '炎': '炎', '炎-岁': '炎',
    '炎-龙门': '龙门', '龙门近卫局': '龙门',
    '维多利亚': '维多利亚',
    '莱茵生命': '莱茵生命',
    '叙拉古': '叙拉古',
    '拉特兰': '拉特兰',
    '莱塔尼亚': '莱塔尼亚',
    '深海猎人': '深海猎人',
    '巴别塔': '巴别塔',
    '企鹅物流': '企鹅物流', '彩虹小队': '企鹅物流',
    '喀兰贸易': '喀兰贸易',
    '格拉斯哥帮': '格拉斯哥帮',
    '哥伦比亚': '哥伦比亚',
    '卡西米尔': '卡西米尔',
    '谢拉格': '谢拉格', '红松骑士团': '谢拉格',
    '伊比利亚': '伊比利亚',
    '乌萨斯': '乌萨斯', '乌萨斯学生自治团': '乌萨斯',
    '萨尔贡': '萨尔贡',
    '东': '东',
    '雷姆必拓': '雷姆必拓',
    '使徒': '使徒',
    '鲤氏侦探事务所': '鲤氏侦探事务所',
    '塔拉': '塔拉',
}


def fnv1a(s: str) -> int:
    """确定性字符串哈希 -> 0/1/2"""
    h = 0xcbf29ce484222325
    for b in s.encode('utf-8'):
        h ^= b
        h = (h * 0x100000001b3) & 0xffffffffffffffff
    return h % 3


def derive_traits(cls: str, sub: str) -> list:
    t = []
    if cls == '医疗':
        t.append('治疗')
    if '召唤' in sub:
        t.append('召唤')
    if any(k in sub for k in ['凝滞', '陷阱', '伏击', '控', '诡异']):
        t.append('控场')
    if any(k in sub for k in ['术', '法', '巫', '秘']):
        t.append('法术')
    if any(k in sub for k in ['射', '炮', '弓', '狙', '投掷']):
        t.append('远程物理')
    if any(k in sub for k in ['铁卫', '守护', '要塞', '不屈', '本源铁卫']):
        t.append('护盾')
    if any(k in sub for k in ['处决', '收割', '爆发', '解放', '强攻']):
        t.append('爆发')
    if any(k in sub for k in ['吟游', '阵法', '增益', '策士', '工匠']):
        t.append('增益')
    if cls == '先锋':
        t.append('回费')
    if cls == '重装' and '护盾' not in t:
        t.append('护盾')
    # 兜底伤害类型标签
    if not any(k in t for k in ['治疗', '法术', '远程物理']):
        if cls in ('近卫', '特种', '先锋'):
            t.append('近战物理')
    if cls == '狙击' and '远程物理' not in t:
        t.append('远程物理')
    if cls == '术师' and '法术' not in t:
        t.append('法术')
    return t


def dmg_type(cls: str, traits: list) -> str:
    if '治疗' in traits:
        return 'heal'
    if '法术' in traits:
        return 'magic'
    if cls in ('狙击', '术师') or '远程物理' in traits:
        return 'phys'
    return 'phys'


def main():
    with open(SRC, encoding='utf-8') as f:
        data = json.load(f)
    ops = data['operators']

    used_flagship = []
    # 每个职业内按代号排序后轮转 -1/0/+1 偏移，保证 1/2/3 档均匀
    by_class = {}
    for i, o in enumerate(ops):
        by_class.setdefault(o['class'], []).append(i)
    rank_in_class = {}
    for cls, idxs in by_class.items():
        idxs_sorted = sorted(idxs, key=lambda i: ops[i]['name'])
        for r, i in enumerate(idxs_sorted):
            rank_in_class[i] = r

    for i, o in enumerate(ops):
        cls = o['class']
        sub = o.get('subclass', '') or ''
        prof = CLASS_PROFILE[cls]
        base = CLASS_BASE_COST[cls]

        # 费用
        if o['name'] in FLAGSHIP_5:
            cost = 5
            used_flagship.append(o['name'])
        else:
            off = [-1, 0, 1][rank_in_class[i] % 3]
            cost = max(1, min(5, base + off))

        mult = COST_MULT[cost - 1]
        hp = round(prof['hp'] * mult)
        atk = round(prof['atk'] * mult)
        deff = round(prof['def_'] * mult)
        spd = prof['spd']
        rng = prof['range']

        traits = derive_traits(cls, sub)
        dt = dmg_type(cls, traits)
        race = o.get('race', '') or '未知'
        if race in ('未公开', '未知', ''):
            race = '未知来源'
        aff = o.get('affiliation', '') or '无阵营'
        faction = FACTION_MAP.get(aff, aff if aff != '无阵营' else '独立')

        o['stats'] = {
            'cost': cost,
            'hp': hp,
            'atk': atk,
            'def': deff,
            'spd': spd,
            'range': rng,
            'dmgType': dt,
        }
        o['traits'] = traits
        o['bonds'] = {
            '职业': cls,
            '种族': race,
            '阵营': faction,
        }
        o['role'] = prof['role']

    # 写回 data.json
    with open(SRC, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, separators=(',', ':'))

    # 重新生成内联 data.js
    with open(DATAJS, 'w', encoding='utf-8') as f:
        f.write('// auto-generated from data.json — 切勿手动编辑\n')
        f.write('const __DATA = ')
        json.dump(data, f, ensure_ascii=False, separators=(',', ':'))
        f.write(';\n')

    # 验证分布
    from collections import Counter
    print('OK total:', len(ops))
    print('cost dist:', dict(sorted(Counter(o['stats']['cost'] for o in ops).items())))
    print('class dist:', dict(Counter(o['class'] for o in ops)))
    print('faction families:', len(set(o['bonds']['阵营'] for o in ops)))
    print('race groups:', len(set(o['bonds']['种族'] for o in ops)))
    print('flagship matched (5cost):', len(used_flagship), '/', len(FLAGSHIP_5))
    miss = FLAGSHIP_5 - set(used_flagship)
    if miss:
        print('  (未命中数据集的旗舰名):', sorted(miss))


if __name__ == '__main__':
    main()
