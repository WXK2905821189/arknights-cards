#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""生成《羁绊配置参考表 v2》HTML，供人工检视与调整。
数据源：
  - game.js 的 BONDS（阈值/加成）— 通过 node 直接导出，保证单一事实来源；
  - data.json 的 bonds 字段（各取值卡池人数）。
羁绊规则：上场干员中，同一「轴=值」的去重人数达到阈值即触发档位，
对该值下全部干员按对应效果包叠加。"""
import json, html, subprocess, sys, os

HERE = os.path.dirname(os.path.abspath(__file__))
NODE = r'C:\Users\wxk29\.workbuddy\binaries\node\versions\22.22.2\node.exe'

DATA = json.load(open(os.path.join(HERE, 'data.json'), encoding='utf-8'))
OPS = DATA['operators']

# ---- 从 game.js 导出完整 BONDS / SIGNATURE / SPECIAL（单一事实来源）----
js = (
    "globalThis.__DATA_TEST__=require(" + json.dumps(os.path.join(HERE, 'data.json')) + ");"
    "const G=require(" + json.dumps(os.path.join(HERE, 'game.js')) + ");"
    "console.log(JSON.stringify({BONDS:G.BONDS, SIGNATURE:G.SIGNATURE, SPECIAL:G.SPECIAL}));"
)
out = subprocess.run([NODE, '-e', js], capture_output=True, text=True, encoding='utf-8', cwd=HERE)
if out.returncode != 0:
    sys.stderr.write(out.stderr)
    raise SystemExit('node 导出 BONDS/SIGNATURE/SPECIAL 失败')
_EXPORT = json.loads(out.stdout.strip())
BONDS = _EXPORT['BONDS']
SIGNATURE = _EXPORT.get('SIGNATURE') or {}
SPECIAL = _EXPORT.get('SPECIAL') or {}

# 效果键中文标签与呈现方式
LABEL = {
    'atk': '攻击', 'hp': '生命', 'def': '防御', 'aspd': '攻速', 'crit': '暴击率',
    'magicAmp': '法伤', 'healAmp': '治疗量', 'spInit': '起手技力', 'spRegen': '技力回复',
}
# 倍率型（显示为 +X%）；绝对值型（spInit 显示 +N 技力）；spRegen 显示 ×倍率
MULT_KEYS = {'atk', 'hp', 'def', 'aspd', 'crit', 'magicAmp', 'healAmp'}

# 行为关键字（签名 / 阵营特殊）中文说明
KW_LABEL = {
    'skillAmp': '技能增幅（技能伤害×倍率）', 'trueDmg': '真伤（无视减伤部分）',
    'pierce': '破甲（无视部分防御）', 'defShred': '命中破甲（降低目标防御）',
    'lifesteal': '吸血（伤害回血）', 'slow': '命中减速', 'damageReduction': '受击减伤',
    'counter': '反伤', 'critDmg': '暴伤（暴击额外倍率）',
    'rampHit': '暖机（每次攻击累积攻击）', 'summonBeast': '召唤岁兽',
    'healAura': '急救协议（低血友军回血）', 'burnDoT': '灼烧（持续伤害）',
    'castAmp': '咏唱（施法后攻速+技能增幅）', 'execute': '处决（斩杀低血目标）',
    'guardAura': '协防（相邻友军减伤）', 'globalAspd': '极速（全队攻速）',
    'slowAura': '严冬（敌方减速）', 'shieldPeriodic': '霜护（周期护盾）',
    'spRegenBuff': '源石技艺增幅（技力回复）', 'summonWolf': '养狼（召唤眷属）',
}


def kw_desc(kw, params):
    if not kw:
        return '—'
    base = KW_LABEL.get(kw, kw)
    if params:
        ps = '，'.join('%s=%s' % (k, v) for k, v in params.items())
        return '%s（%s）' % (base, ps)
    return base


def fmt_vals(key, vals):
    if key == 'spInit':
        return ' / '.join('+%d' % v for v in vals) + ' 技力'
    if key == 'spRegen':
        return ' / '.join('×%.2f' % (1 + v) for v in vals) + '（回复）'
    return ' / '.join('+%.0f%%' % (v * 100) for v in vals)


def fmt_single(k, v):
    """格式化单个效果值（用于 SPECIAL.attr 等单值场景）。"""
    if k == 'spInit':
        return '+%d 技力' % v
    if k == 'spRegen':
        return '×%.2f（回复）' % (1 + v)
    return '+%.0f%%' % (v * 100)


def effect_package(cfg):
    """返回该取值的效果包：[(标签, 阶1/2/3字符串), ...]，按主题优先级排序。"""
    order = ['atk', 'hp', 'def', 'aspd', 'crit', 'magicAmp', 'healAmp', 'spInit', 'spRegen']
    pkgs = []
    for k in order:
        if k in cfg and cfg[k]:
            pkgs.append((LABEL[k], fmt_vals(k, cfg[k])))
    return pkgs


def pool_counts(axis):
    cnt = {}
    for op in OPS:
        b = op.get('bonds') or {}
        v = b.get(axis)
        if v:
            cnt[v] = cnt.get(v, 0) + 1
    return cnt


total = len(OPS)
cls_pool = pool_counts('职业')
fac_pool = pool_counts('阵营')

# ---------------- HTML ----------------
P = []
P.append('''<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>羁绊配置参考表 v2 · 罗德岛棋局</title>
<style>
  :root{--bg:#0c0f14;--panel:#121821;--line:#26344a;--ink:#e7eef7;--ink2:#9fb2c8;--gold:#e8b84b;--gold2:#ffe9b0;--green:#5fd08a;--red:#e06b6b}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--ink);font-family:-apple-system,"PingFang SC","Microsoft YaHei",system-ui,sans-serif;padding:28px}
  h1{color:var(--gold2);margin:0 0 4px;font-size:22px}
  .sub{color:var(--ink2);font-size:13px;margin-bottom:14px}
  .legend{font-size:12px;color:var(--ink2);margin:6px 0 22px;line-height:1.7}
  .legend code{background:#1b2430;padding:1px 6px;border-radius:4px;color:var(--gold2)}
  .axis{margin-bottom:30px}
  .axis h2{font-size:17px;color:var(--gold);border-left:4px solid var(--gold);padding-left:10px;margin:0 0 4px}
  .axis .cfg{font-size:12px;color:var(--ink2);margin:0 0 12px}
  table{width:100%;border-collapse:collapse;background:var(--panel);border:1px solid var(--line);border-radius:10px;overflow:hidden}
  th,td{padding:9px 12px;text-align:left;border-bottom:1px solid var(--line);font-size:13px;vertical-align:top}
  th{background:#19222e;color:var(--gold2);font-weight:600}
  tr:last-child td{border-bottom:none}
  td.num{text-align:right;font-variant-numeric:tabular-nums}
  .ok{color:var(--green)} .warn{color:var(--gold)} .bad{color:var(--red)}
  .tag{display:inline-block;background:#1b2430;border:1px solid var(--line);border-radius:999px;padding:1px 9px;font-size:11px;color:var(--ink2);margin:1px 3px 1px 0}
  .summary{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:16px 18px;margin-bottom:26px;font-size:13px;line-height:1.9}
  .summary b{color:var(--gold2)}
  .eff{font-size:12px;line-height:1.6}
  .eff .k{color:var(--gold2)}
  footer{color:var(--ink2);font-size:11px;margin-top:30px}
</style></head><body>
<h1>羁绊配置参考表 v2</h1>''' + '<div class="sub">共 %d 名干员 · 羁绊按「上场去重人数」触发档位，效果包对该值下全部上场干员叠加</div>' % total + '''
<div class="legend">
  <b>如何阅读：</b>「职业轴」每职业一个主题化效果包（先锋=技力流、重装=壁垒、医疗=急救…），阈值统一 <code>2 / 4 / 6</code> 人（阶1/2/3）。
  「阵营轴」已<b>势力主题化</b>（B 任务）：每个势力独立效果包（罗德岛=治疗量/生命、拉特兰=攻击/暴击、莱茵生命=法伤/起手技力、企鹅物流=起手技力/技力回复…），阈值 <code>2 / 3 / 5</code>；
  未在表中列出 / 卡池&lt;3 的势力自动套用<b>通用攻/血（默认）</b>兜底，避免死内容。
  「卡池数」= 全量干员里属于该取值的人数，用于判断羁绊<b>容易凑齐</b>还是<b>稀有</b>。
  说明：部署格上限 9，阶3（6 同职业）属后期集中型构筑；种族轴已并入阵营，不再单列。<b>职业、阵营羁绊、5费签名对同一干员叠加生效</b>。
  另见下方「5费签名羁绊」与「阵营特殊机制（light 版）」两段：签名是单人被动、阵营特殊按最高可达阶位解锁，均为引导玩家玩法的机制。
</div>''')

# ---- 职业轴 ----
# 阶3 阈值可行性（任务 C-1）：须同时满足 卡池数 ≥ 阶3阈值 且 阶3阈值 ≤ 可上场人数上限(BOARD_CAP)
BOARD_CAP = 9   # 部署格上限 = 玩家等级，封顶 9（game.js: G.level 上限、渲染循环 i<9）
P.append('<div class="axis"><h2>职业轴（主题化效果包）</h2>')
P.append('<div class="cfg">阈值 2 / 4 / 6 人 → 阶1 / 阶2 / 阶3；效果为「阶1 / 阶2 / 阶3」三档数值。'
         '阶3 需【去重≥6 且 人口(玩家等级)≥6】，且不得高于可上场人数上限 %d。</div>' % BOARD_CAP)
P.append('<table><thead><tr><th>职业</th><th class="num">卡池数</th><th>阶3 阈值</th><th>阶3 可行性</th><th>主/副效果包（阶1 / 阶2 / 阶3）</th></tr></thead><tbody>')
class_order = ['先锋', '近卫', '重装', '狙击', '术师', '医疗', '辅助', '特种']
for c in class_order:
    cfg = BONDS['职业'][c]
    thr = cfg['thr']
    pool = cls_pool.get(c, 0)
    t3 = thr[-1]
    feasible_pool = pool >= t3
    feasible_cap = t3 <= BOARD_CAP
    feasible = feasible_pool and feasible_cap
    reach = ('✓ 可达（去重≥%d 且 人口≥%d）' % (t3, t3)) if feasible else ('⚠ 卡池不足（%d<%d）' % (pool, t3) if not feasible_pool else '⚠ 超部署上限')
    rc = 'ok' if feasible else 'bad'
    pkgs = effect_package(cfg)
    eff_html = '<div class="eff">' + '；'.join('<span class="k">%s</span> %s' % (k, v) for k, v in pkgs) + '</div>'
    P.append('<tr><td><b>%s</b></td><td class="num %s">%d</td><td class="num">%d</td><td class="num %s">%s</td><td>%s</td></tr>'
             % (c, rc, pool, t3, rc, reach, eff_html))
P.append('</tbody></table></div>')

# 阶3 可行性校验（任务 C-1）：任何职业阶3 不可超过 min(卡池, BOARD_CAP)
_infeasible = []
for c in class_order:
    t3 = BONDS['职业'][c]['thr'][-1]
    pool = cls_pool.get(c, 0)
    if t3 > pool or t3 > BOARD_CAP:
        _infeasible.append((c, t3, pool))
if _infeasible:
    print('⚠ 阶3 不可行职业:', _infeasible)
else:
    print('✓ 全部职业阶3 可行（卡池≥6 且 ≤%d 部署上限）' % BOARD_CAP)

# ---- 阵营轴（势力主题化）----
fac = BONDS['阵营']
def_fac = fac['__default__']
P.append('<div class="axis"><h2>阵营轴（势力主题化效果包）</h2>')
P.append('<div class="cfg">阈值统一 2 / 3 / 5 人 → 阶1 / 阶2 / 阶3。'
         '表中「主题」为定制效果；未在表中 / 卡池&lt;3 的势力自动套用 <b>通用攻/血（默认）</b> 兜底。</div>')
P.append('<table><thead><tr><th>阵营</th><th class="num">卡池数</th><th>类型</th><th>效果包（阶1 / 阶2 / 阶3）</th></tr></thead><tbody>')
for v, c in sorted(fac_pool.items(), key=lambda kv: (-kv[1], kv[0])):
    if c < 2:
        continue
    cfg = fac.get(v) or def_fac            # 主题 or 默认兜底
    themed = (v in fac) and (v != '__default__')
    ttype = '主题' if themed else '默认'
    tcls = 'ok' if themed else 'warn'
    pkgs = effect_package(cfg)
    eff_html = '<div class="eff">' + '；'.join('<span class="k">%s</span> %s' % (k, val) for k, val in pkgs) + '</div>'
    reach = '✓ 可达（≥%d）' % cfg['thr'][-1] if c >= cfg['thr'][-1] else '⚠ 偏紧'
    rc = 'ok' if c >= cfg['thr'][-1] else 'warn'
    P.append('<tr><td><b>%s</b></td><td class="num %s">%d</td><td class="num %s">%s</td><td>%s</td></tr>'
             % (html.escape(str(v)), rc, c, tcls, ttype, eff_html))
P.append('</tbody></table></div>')

# ---- 5费签名羁绊（单人被动，上场即生效）----
P.append('<div class="axis"><h2>5费签名羁绊（单人被动 · 上场即生效）</h2>')
P.append('<div class="cfg">共 %d 名 5费干员，每位一个符合角色的独立签名被动，叠加在职业+阵营羁绊之上，无需凑人数。</div>' % len(SIGNATURE))
P.append('<table><thead><tr><th>干员</th><th class="num">费用</th><th>属性加成</th><th>行为关键字</th></tr></thead><tbody>')
sig_ops = [o for o in OPS if o['stats']['cost'] == 5]
sig_ops.sort(key=lambda o: o['name'])
for o in sig_ops:
    s = SIGNATURE.get(o['name'])
    if not s:
        continue
    aparts = []
    for k, v in (s.get('attr') or {}).items():
        if k in LABEL:
            aparts.append('%s %s' % (LABEL[k], fmt_vals(k, [v])))
    ahtml = '；'.join(aparts) if aparts else '—'
    kw = s.get('kw') or {}
    kwhtml = '；'.join(kw_desc(k, (v if isinstance(v, dict) else None)) for k, v in kw.items()) if kw else '—'
    P.append('<tr><td><b>%s</b></td><td class="num">5</td><td>%s</td><td>%s</td></tr>'
             % (html.escape(o['name']), html.escape(ahtml), html.escape(kwhtml)))
P.append('</tbody></table></div>')

# ---- 阵营特殊机制（light 版）----
P.append('<div class="axis"><h2>阵营特殊机制（light 版 · 按最高可达阶位解锁）</h2>')
P.append('<div class="cfg">每个能成羁绊的阵营一个 capstone：达到 SPECIAL.tier 解锁（池≥5→阶三、池3~4→阶二、池2→阶一）。'
         '与职业/签名羁绊叠加。单干员势力（仅1人）无法成羁绊，暂不另给部署被动（未来 TODO）。</div>')
P.append('<table><thead><tr><th>阵营</th><th class="num">卡池数</th><th class="num">解锁阶</th><th>特殊机制</th></tr></thead><tbody>')
for v, c in sorted(fac_pool.items(), key=lambda kv: (-kv[1], kv[0])):
    sp = SPECIAL.get(v)
    if not sp:
        continue
    tier = sp.get('tier', 1)
    reach = '✓' if c >= (BONDS['阵营'][v]['thr'][tier - 1] if BONDS['阵营'].get(v) else 2) else '—'
    rc = 'ok' if reach == '✓' else 'warn'
    sp_html = kw_desc(sp.get('kw'), sp.get('params'))
    aparts = []
    for k, arr in (sp.get('attr') or {}).items():
        if k in LABEL:
            aparts.append('%s %s' % (LABEL[k], fmt_single(k, arr)))
    if aparts:
        sp_html += '；附加 ' + '、'.join(aparts)
    P.append('<tr><td><b>%s</b></td><td class="num %s">%d</td><td class="num">阶%d</td><td>%s</td></tr>'
             % (html.escape(str(v)), rc, c, tier, html.escape(sp_html)))
P.append('</tbody></table></div>')

P.append('<footer>由 gen_bonds_table.py 生成 · BONDS/SIGNATURE/SPECIAL 取自 game.js（node 直出），卡池数取自 data.json 的 bonds 字段。'
         '调整数值后改 game.js 对应配置即可，本表随之更新。v3：新增 5费签名羁绊 + 阵营特殊机制（light 版）。</footer>')
P.append('</body></html>')

open(os.path.join(HERE, 'bonds_reference.html'), 'w', encoding='utf-8').write('\n'.join(P))
print('written bonds_reference.html')
print('axes:', list(BONDS.keys()))
for ax in BONDS:
    if ax == '职业':
        print('  职业: themes =', list(BONDS[ax].keys()))
    elif ax == '阵营':
        themed = [k for k in BONDS[ax].keys() if k != '__default__']
        print('  阵营: themed(%d) =' % len(themed), themed, '| default:', BONDS[ax]['__default__'])
