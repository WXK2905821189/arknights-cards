# -*- coding: utf-8 -*-
"""
crawl_skills.py — 从 prts.wiki 批量抓取 136 六星干员的真实技能数据
- 走 MediaWiki API (action=parse&prop=wikitext)，需带浏览器 UA（否则 403）
- 解析 {{技能2}} 模板块，提取技能1/2/3 的名称、类型、技力消耗、满级描述
- 清洗 wiki 语法（{{color}} / {{*}} / {{+}} / [[链接]] 等）
- 增量写入 skills_raw.json（每抓一页都落盘，防中断丢失）
"""
import json, os, re, time, urllib.request, ssl, urllib.parse

ROOT = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(ROOT, 'data.json')
OUT = os.path.join(ROOT, 'skills_raw.json')

HDR = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
                  '(KHTML, like Gecko) Chrome/124.0 Safari/537.36',
    'Accept-Language': 'zh-CN,zh;q=0.9',
}
CTX = ssl.create_default_context()
CTX.check_hostname = False
CTX.verify_mode = ssl.CERT_NONE


def fetch_wikitext(page):
    url = ('https://prts.wiki/api.php?action=parse&page=' + urllib.parse.quote(page)
           + '&prop=wikitext&format=json&formatversion=2')
    for attempt in range(3):
        try:
            req = urllib.request.Request(url, headers=HDR)
            r = urllib.request.urlopen(req, timeout=25, context=CTX)
            j = json.loads(r.read())
            if 'parse' in j and 'wikitext' in j['parse']:
                return j['parse']['wikitext']
            if 'error' in j:
                # 可能页面不存在
                return None
        except Exception as e:
            if attempt == 2:
                print('  [fetch ERR]', page, type(e).__name__, e)
            time.sleep(1.5)
    return None


def clean_text(s):
    if not s:
        return ''
    # <br> 换行 -> 空格
    s = re.sub(r'<br\s*/?>', ' ', s)
    # 递归展开嵌套模板：先把最内层 {{...}} 处理
    prev = None
    while prev != s:
        prev = s
        # {{color|#xxxxxx|TEXT}} -> TEXT ; {{color|TEXT}} -> TEXT
        s = re.sub(r'\{\{color\|[^|]*\|([^}]*)\}\}', r'\1', s)
        s = re.sub(r'\{\{color\|([^}]*)\}\}', r'\1', s)
        # {{*|BASE|MOD}} 与 {{+|BASE|MOD}} -> BASE（正常显示基值）
        s = re.sub(r'\{\{\*\|([^|]*)\|[^}]*\}\}', r'\1', s)
        s = re.sub(r'\{\{\+\|([^|]*)\|[^}]*\}\}', r'\1', s)
        s = re.sub(r'\{\{\*\|([^}]*)\}\}', r'\1', s)
        s = re.sub(r'\{\{\+\|([^}]*)\}\}', r'\1', s)
        # 其他未知模板 {{x|...|...}} -> 取最后一个参数（通常最关键的展示值）
        s = re.sub(r'\{\{[^|{}]*\|([^}]*)\}\}', r'\1', s)
        s = re.sub(r'\{\{([^|{}]*)\}\}', r'\1', s)
    # [[链接|显示]] 或 [[链接]] -> 显示/链接
    s = re.sub(r'\[\[(?:[^|\]]*\|)?([^\]]*)\]\]', r'\1', s)
    s = re.sub(r'\{\{!\}\}', '|', s)
    # PRTS 机制标签残留：<ba.xyz> / ba.xxx
    s = re.sub(r'<ba\.[^>]*>', '', s)
    s = re.sub(r'ba\.[a-zA-Z]+', '', s)
    # PRTS 内联模板残留：|原文=... |原因=... |name=...
    s = re.sub(r'\|(?:原文|原因|name)=[^|\s<]*', '', s)
    s = re.sub(r'<ref[^>]*>.*?</ref>', '', s, flags=re.S)
    s = re.sub(r'<ref[^>]*/>', '', s)
    s = re.sub(r"'''", '', s)
    s = re.sub(r'&nbsp;', ' ', s)
    # 清理残留的孤立 |（非合法标点）
    s = re.sub(r'\|', '', s)
    s = re.sub(r'\s+', ' ', s)
    return s.strip()


def find_blocks(wt):
    """返回所有 {{技能...}} 模板块的原始文本列表（按出现顺序）"""
    blocks = []
    i = 0
    n = len(wt)
    while True:
        start = wt.find('{{技能', i)
        if start == -1:
            break
        # 从 start 找匹配的右括号
        depth = 0
        j = start
        while j < n:
            if wt[j] == '{' and j + 1 < n and wt[j + 1] == '{':
                depth += 1
                j += 2
            elif wt[j] == '}' and j + 1 < n and wt[j + 1] == '}':
                depth -= 1
                j += 2
                if depth == 0:
                    blocks.append(wt[start:j])
                    break
            else:
                j += 1
        else:
            break
        i = j
    return blocks


def parse_block(block):
    """从单个技能模板块解析字段 dict"""
    f = {}
    # 逐行 |key=value
    for line in block.split('\n'):
        line = line.strip()
        if not line.startswith('|'):
            continue
        line = line[1:]
        if '=' not in line:
            continue
        k, v = line.split('=', 1)
        f[k.strip()] = v.strip()
    return f


def best_desc(f):
    """取最高等级描述：专精3 > 7 > 6 > ... > 1"""
    for key in ['技能专精3描述', '技能7描述', '技能6描述', '技能5描述',
                '技能4描述', '技能3描述', '技能2描述', '技能1描述']:
        if f.get(key):
            return clean_text(f[key])
    return ''


def best_cost(f):
    for key in ['技能专精3消耗', '技能7消耗', '技能6消耗', '技能5消耗',
                '技能4消耗', '技能3消耗', '技能2消耗', '技能1消耗']:
        v = f.get(key)
        if v:
            try:
                return int(float(v))
            except ValueError:
                continue
    return None


def best_init(f):
    for key in ['技能专精3初始', '技能7初始', '技能6初始', '技能5初始',
                '技能4初始', '技能3初始', '技能2初始', '技能1初始']:
        v = f.get(key)
        if v:
            try:
                return int(float(v))
            except ValueError:
                continue
    return 0


def parse_skills(wt):
    blocks = find_blocks(wt)
    skills = []
    for b in blocks:
        f = parse_block(b)
        name = f.get('技能名', '')
        if not name:
            continue
        t1 = f.get('技能类型1', '')
        t2 = f.get('技能类型2', '')
        skills.append({
            'name': name,
            'type': (t1 + ('/' + t2 if t2 else '')).strip('/'),
            'sp_init': best_init(f),
            'sp_cost': best_cost(f),
            'desc': best_desc(f),
        })
    return skills


def main():
    data = json.load(open(SRC, encoding='utf-8'))
    names = [o['name'] for o in data['operators']]

    # 增量读取已有结果
    if os.path.exists(OUT):
        raw = json.load(open(OUT, encoding='utf-8'))
        print('已有缓存:', len(raw), '条')
    else:
        raw = {}

    done = 0
    fail = []
    for i, name in enumerate(names):
        if name in raw and raw[name].get('skills'):
            continue
        wt = fetch_wikitext(name)
        if not wt:
            fail.append(name)
            print(f'[{i + 1}/{len(names)}] ✗ {name} (无页面)')
            continue
        skills = parse_skills(wt)
        if not skills:
            fail.append(name)
            print(f'[{i + 1}/{len(names)}] ✗ {name} (无技能块)')
            raw[name] = {'skills': [], 'error': 'no_skill_block'}
        else:
            raw[name] = {'skills': skills}
            print(f'[{i + 1}/{len(names)}] ✓ {name}: ' +
                  ' / '.join(s['name'] for s in skills))
        done += 1
        # 每 5 页落盘一次
        if done % 5 == 0:
            json.dump(raw, open(OUT, 'w', encoding='utf-8'),
                      ensure_ascii=False, indent=1)
        time.sleep(0.4)  # 限速，友好于服务端

    json.dump(raw, open(OUT, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
    print('\n完成。成功', len(names) - len(fail), '/', len(names),
          '失败', len(fail))
    if fail:
        print('失败列表:', fail)


if __name__ == '__main__':
    main()
