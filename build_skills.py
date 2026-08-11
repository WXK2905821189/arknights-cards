# -*- coding: utf-8 -*-
"""
build_skills.py — 把爬到的真实技能(名/描述/技力)映射成游戏可用的 skill 字段
- 取每个干员的签名技（技能3，列表末位；不足则取末位）
- 按 子类 + 描述关键词 解析战斗原型(archetype)
- 生成 effect 参数（按 cost/star 缩放）+ 技力上限(spMax) 归一化
- 写回 data.json 并重新生成 data.js
输出 skill 字段：{ name, type, archetype, desc, spMax, spRegen, effect }
"""
import json, os, re

ROOT = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(ROOT, 'data.json')
DATAJS = os.path.join(ROOT, 'data.js')
RAW = os.path.join(ROOT, 'skills_raw.json')

# 原型中文标（图鉴/战斗里展示用）
ARCH_LABEL = {
    'burst': '爆发', 'aoe': '范围', 'heal': '治疗', 'shield': '护盾',
    'stun': '控制', 'buff': '增益', 'debuff': '削弱', 'summon': '召唤',
    'dot': '持续', 'execute': '处决', 'lifesteal': '吸血',
}

# 子类兜底原型（仅当描述无法判定时使用）
SUBCLASS_DEFAULT = {
    '处决者': 'execute', '收割者': 'aoe', '解放者': 'aoe', '强攻手': 'burst',
    '剑豪': 'burst', '斗士': 'burst', '无畏者': 'burst', '重剑手': 'burst',
    '武者': 'burst', '领主': 'buff', '决斗者': 'burst', '决战者': 'burst',
    '猎手': 'execute', '尖兵': 'burst', '冲锋手': 'burst',
    '扩散术师': 'aoe', '轰击术师': 'aoe', '中坚术师': 'aoe', '阵法术师': 'aoe',
    '本源术师': 'aoe', '链术师': 'aoe', '塑灵术师': 'aoe', '驭械术师': 'aoe',
    '秘术师': 'aoe', '术战者': 'burst', '重射手': 'aoe', '炮手': 'aoe',
    '攻城手': 'aoe', '速射手': 'burst', '神射手': 'execute', '散射手': 'aoe',
    '回环射手': 'aoe', '投掷手': 'aoe',
    '医师': 'heal', '咒愈师': 'heal', '巫役': 'heal', '链愈师': 'heal',
    '群愈师': 'heal', '疗养师': 'heal', '行医': 'heal',
    '哨戒铁卫': 'shield', '守护者': 'shield', '铁卫': 'shield',
    '本源铁卫': 'shield', '不屈者': 'shield', '要塞': 'shield', '驭法铁卫': 'shield',
    '凝滞师': 'stun', '陷阱师': 'stun', '伏击客': 'stun', '削弱者': 'debuff',
    '巡空者': 'aoe', '傀儡师': 'summon', '召唤师': 'summon', '炼金师': 'dot',
    '吟游者': 'buff', '护佑者': 'buff', '策士': 'buff', '执旗手': 'buff',
    '工匠': 'buff', '战术家': 'debuff', '怪杰': 'burst', '行商': 'buff',
    '情报官': 'debuff', '推击手': 'stun', '钩索师': 'stun', '撼地者': 'aoe',
    '守望者': 'stun',
}


def resolve_archetype(sub, desc):
    d = desc or ''
    # 优先级1：治疗友军（明确提到友军/友方回血/治疗）
    if re.search(r'友军|友方', d) and re.search(r'恢复|回复|治疗|生命', d):
        return 'heal'
    # 优先级2：进攻性（攻击强化/伤害/射程/目标数）—— 史尔特尔/能天使等
    if re.search(r'攻击力|造成|对敌人|攻击变为|下次攻击|攻击距离|攻击目标数|伤害', d):
        if re.search(r'所有敌人|范围内所有|范围内敌人|周围所有|群体|溅射|攻击目标数\+[2-9]', d):
            return 'aoe'
        if re.search(r'处决|击倒|斩杀|低于|收割', d):
            return 'execute'
        return 'burst'
    # 优先级3：控制
    if re.search(r'眩晕|停顿|束缚|冻结|迟缓|无法移动', d):
        return 'stun'
    # 优先级4：护盾/防御
    if re.search(r'护盾|防御力提升|最大生命上限|阻挡', d):
        return 'shield'
    # 优先级5：削弱
    if re.search(r'法术伤害\+|受到伤害|防御力-|攻击力-|移动速度|属性削弱|元素', d):
        return 'debuff'
    # 优先级6：召唤
    if '召唤' in d:
        return 'summon'
    # 优先级7：持续伤害
    if re.search(r'灼烧|剧毒|持续伤害|流失|创伤|侵蚀', d):
        return 'dot'
    # 优先级8：增益（自身攻速/全属性，无伤害/无友军治疗）
    if re.search(r'攻击速度|攻速|全属性|属性提升', d):
        return 'buff'
    # 优先级9：自身吸血/恢复
    if re.search(r'恢复所有生命|吸血|击中回复|生命流失', d):
        return 'lifesteal'
    return SUBCLASS_DEFAULT.get(sub, 'burst')


def sp_max_of(sp_cost):
    if not sp_cost:
        return 14
    # AK 技力 2~90 -> 游戏 8~30（越低越频繁）
    return max(8, min(30, round(sp_cost / 3) + 6))


def effect_for(arch, cost, star):
    """按原型+cost+star 生成效果参数（系数随 cost/star 放大）"""
    tier = cost  # 1..5
    sm = {1: 1, 2: 1.8, 3: 3.2}[star]
    # 基础系数随费用档
    k = 0.8 + 0.12 * tier
    if arch == 'burst':
        return {'mult': round(2.2 * k, 2), 'target': 'nearest'}
    if arch == 'aoe':
        return {'mult': round(1.3 * k, 2), 'target': 'all'}
    if arch == 'heal':
        return {'mult': round(3.0 * k, 2), 'target': 'lowest'}
    if arch == 'shield':
        return {'mult': round(4.0 * k, 2), 'target': 'self'}
    if arch == 'stun':
        return {'dur': round(1.0 + 0.1 * tier, 2), 'target': 'nearest'}
    if arch == 'buff':
        return {'atk': round(0.35 + 0.05 * tier, 2),
                'spd': round(0.25 + 0.04 * tier, 2), 'dur': 5, 'target': 'allies'}
    if arch == 'debuff':
        return {'def': round(0.35 + 0.05 * tier, 2),
                'dur': 5, 'target': 'all'}
    if arch == 'summon':
        return {'mult': round(0.9 * k, 2), 'dur': 8, 'target': 'self'}
    if arch == 'dot':
        return {'mult': round(0.5 * k, 2), 'dur': 3, 'target': 'nearest'}
    if arch == 'execute':
        return {'mult': round(2.0 * k, 2), 'thresh': 0.35, 'target': 'nearest'}
    if arch == 'lifesteal':
        return {'mult': round(1.5 * k, 2), 'leech': 0.5, 'target': 'nearest'}
    return {'mult': 2.0, 'target': 'nearest'}


def main():
    data = json.load(open(DATA, encoding='utf-8'))
    raw = json.load(open(RAW, encoding='utf-8')) if os.path.exists(RAW) else {}
    ops = data['operators']

    miss = 0
    for o in ops:
        nm = o['name']
        rec = raw.get(nm, {})
        skills = rec.get('skills', [])
        sub = o.get('subclass', '') or ''
        cost = o['stats']['cost']
        star = 1  # 基础形态；升星由游戏内处理

        if skills:
            sig = skills[-1]  # 签名技（技能3）
            name = sig['name']
            desc = sig['desc']
            sp_cost = sig.get('sp_cost')
            stype = sig.get('type', '')
        else:
            # 兜底：爬取失败，用子类生成
            miss += 1
            name = sub + '协议'
            desc = '（数据缺失，已按子类生成基础技能）'
            sp_cost = None
            stype = ''

        arch = resolve_archetype(sub, desc)
        eff = effect_for(arch, cost, star)
        o['skill'] = {
            'name': name,
            'type': stype,
            'archetype': arch,
            'archLabel': ARCH_LABEL.get(arch, arch),
            'desc': desc,
            'spMax': sp_max_of(sp_cost),
            'spRegen': round(1.0 + 0.05 * cost, 2),  # 费用越高回技力略快
            'effect': eff,
        }
        # 备用：保留全部 3 个技能名（图鉴可展示）
        o['skillsAll'] = [{'name': s['name'], 'type': s.get('type', ''),
                           'desc': s.get('desc', '')} for s in skills]

    # 写回
    json.dump(data, open(DATA, 'w', encoding='utf-8'), ensure_ascii=False,
              separators=(',', ':'))
    with open(DATAJS, 'w', encoding='utf-8') as f:
        f.write('// auto-generated from data.json — 切勿手动编辑\n')
        f.write('const __DATA = ')
        json.dump(data, f, ensure_ascii=False, separators=(',', ':'))
        f.write(';\n')

    from collections import Counter
    arch_dist = Counter(o['skill']['archetype'] for o in ops)
    print('OK 写入 skill 字段:', len(ops), '其中爬取缺失兜底:', miss)
    print('原型分布:', dict(arch_dist.most_common()))
    # 抽查
    for nm in ['史尔特尔', '塞雷娅', '能天使', 'W']:
        o = next(x for x in ops if x['name'] == nm)
        print(f"  {nm}: {o['skill']['name']} [{o['skill']['archLabel']}] spMax={o['skill']['spMax']} eff={o['skill']['effect']}")


if __name__ == '__main__':
    main()
