#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""从干员卡 bundle 抽取资源并解析 MD -> data.json"""
import zipfile, json, os, re, shutil

SRC_ZIP = r'D:/干员卡_bundle_20260809.zip'
OUT_DIR = r'D:/arknights/arknights-cards'
ASSETS_DIR = os.path.join(OUT_DIR, 'assets')

CLASS_ORDER = ['先锋', '近卫', '重装', '狙击', '术师', '医疗', '辅助', '特种']

def parse_md(text):
    lines = text.split('\n')
    title = None
    table = {}
    sections = {}
    cur = None
    in_table = False
    for ln in lines:
        s = ln.strip()
        if s.startswith('# ') and title is None:
            title = s[2:].strip()
            continue
        if s.startswith('|') and '字段' in s:
            in_table = True
            continue
        if in_table:
            if s.startswith('|'):
                cells = [c.strip() for c in s.strip('|').split('|')]
                if len(cells) >= 2 and cells[0] not in ('字段', '---', ''):
                    table[cells[0]] = cells[1]
                continue
            else:
                in_table = False
        if s.startswith('## '):
            cur = s[3:].strip()
            sections.setdefault(cur, [])
            continue
        if cur is not None:
            sections[cur].append(ln)
    return title, table, sections

def parse_kv_block(lines):
    out = {}
    for ln in lines:
        m = re.match(r'^-?\s*\*\*(.+?)\*\*[:：]\s*(.*)$', ln.strip())
        if m:
            out[m.group(1)] = m.group(2).strip()
    return out

def parse_prose(lines):
    buf = []
    for ln in lines:
        s = ln.strip()
        if not s:
            continue
        s = re.sub(r'^#+\s*', '', s)
        s = re.sub(r'\*\*(.+?)\*\*', r'\1', s)
        s = re.sub(r'!\[.*?\]\(.*?\)', '', s)
        if s:
            buf.append(s)
    return '\n'.join(buf).strip()

def main():
    os.makedirs(ASSETS_DIR, exist_ok=True)
    z = zipfile.ZipFile(SRC_ZIP)
    names = z.namelist()

    # 1) 抽取图片
    copied = 0
    for n in names:
        if n.startswith('干员卡/assets/') and n.lower().endswith('.png'):
            fn = os.path.basename(n)
            with open(os.path.join(ASSETS_DIR, fn), 'wb') as f:
                f.write(z.read(n))
            copied += 1
    print(f'assets copied: {copied}')

    # 2) 解析 MD
    ops = []
    for n in names:
        m = re.match(r'干员卡/([^/]+)/([^/]+)\.md$', n)
        if not m:
            continue
        cls, code = m.group(1), m.group(2)
        text = z.read(n).decode('utf-8')
        title, table, sections = parse_md(text)

        rarity_raw = table.get('稀有度', '★6')
        rarity = 6
        mm = re.search(r'(\d+)', rarity_raw)
        if mm:
            rarity = int(mm.group(1))

        profile = parse_kv_block(sections.get('基础档案', []))
        lines = parse_kv_block(sections.get('台词', []))
        intro = parse_prose(sections.get('简介', []))

        avatar = f'assets/{code}_头像.png'
        art = f'assets/{code}_立绘.png'

        op = {
            'id': code,
            'name': table.get('代号', code),
            'en': table.get('英文名', ''),
            'class': cls,
            'subclass': table.get('子职业', ''),
            'rarity': rarity,
            'race': table.get('种族', ''),
            'region': table.get('国家·地区', ''),
            'origin': table.get('出身', ''),
            'affiliation': table.get('所属', ''),
            'profile': profile,
            'intro': intro,
            'lines': lines,
            'avatar': avatar,
            'art': art,
            'stats': {}  # 预留：后续玩法版本填充
        }
        ops.append(op)

    # 排序：按 CLASS_ORDER，再按代号
    def cls_idx(c):
        return CLASS_ORDER.index(c) if c in CLASS_ORDER else 99
    ops.sort(key=lambda o: (cls_idx(o['class']), o['name']))

    data = {
        'meta': {
            'total': len(ops),
            'source': 'PRTS Wiki (个人/同好圈非商业使用)',
            'classes': CLASS_ORDER,
            'built': '2026-08-10'
        },
        'operators': ops
    }
    out_path = os.path.join(OUT_DIR, 'data.json')
    with open(out_path, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, indent=2)

    # 统计
    from collections import Counter
    cnt = Counter(o['class'] for o in ops)
    print(f'operators parsed: {len(ops)}')
    print('by class:', dict(cnt))
    missing_art = [o['id'] for o in ops if not os.path.exists(os.path.join(OUT_DIR, o['art']))]
    missing_ava = [o['id'] for o in ops if not os.path.exists(os.path.join(OUT_DIR, o['avatar']))]
    print('missing art:', missing_art)
    print('missing avatar:', missing_ava)

if __name__ == '__main__':
    main()
