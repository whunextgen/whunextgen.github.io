#!/usr/bin/env python3
"""只读导出旧门户的飞书多维表格。

  python3 scripts/export_feishu.py <输出目录>

只发 GET 请求，不改飞书里的任何数据。导出内容含密钥和个人信息：输出目录必须在仓库之外，
脚本只打印表名和行数，不打印字段内容。应用凭据从环境变量 FEISHU_APP_ID / FEISHU_APP_SECRET
读取，没有时从 ~/.openclaw/openclaw.json 的 channels.feishu 读取。
"""
import json, os, sys, time
import urllib.parse as q
import urllib.request as u

APP = os.environ.get('FEISHU_BITABLE_APP') or sys.exit('请设置 FEISHU_BITABLE_APP（旧门户多维表格的 app token）')
B = 'https://open.feishu.cn/open-apis'
REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def creds():
    if os.environ.get('FEISHU_APP_ID'):
        return os.environ['FEISHU_APP_ID'], os.environ['FEISHU_APP_SECRET']
    c = json.load(open(os.path.expanduser('~/.openclaw/openclaw.json')))['channels']['feishu']
    return c['appId'], c['appSecret']


def call(path, tok=None, body=None):
    h = {'Content-Type': 'application/json; charset=utf-8'}
    if tok:
        h['Authorization'] = 'Bearer ' + tok
    for attempt in range(5):
        try:
            r = json.load(u.urlopen(u.Request(B + path, data=json.dumps(body).encode() if body else None, headers=h), timeout=60))
        except u.HTTPError as e:
            r = json.load(e)
        if r.get('code') in (1254290, 1254291, 99991400):   # 限流，稍后重试
            time.sleep(1 + attempt)
            continue
        return r
    return r


def pages(path, tok, size):
    token = ''
    while True:
        sep = '&' if '?' in path else '?'
        r = call(f'{path}{sep}page_size={size}' + (f'&page_token={q.quote(token)}' if token else ''), tok)
        if r.get('code') != 0:
            sys.exit(f"读取失败 {path.split('?')[0]}: code {r.get('code')}")
        d = r.get('data') or {}
        yield from d.get('items') or []
        if not d.get('has_more'):
            return
        token = d['page_token']


def main():
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    out = os.path.abspath(sys.argv[1])
    if os.path.commonpath([out, REPO]) == REPO:
        sys.exit('输出目录不能在仓库里')
    os.makedirs(out, mode=0o700, exist_ok=True)
    app_id, secret = creds()
    r = call('/auth/v3/tenant_access_token/internal', body={'app_id': app_id, 'app_secret': secret})
    if r.get('code') != 0:
        sys.exit(f"取令牌失败: code {r.get('code')}")
    tok = r['tenant_access_token']
    index = []
    for t in pages(f'/bitable/v1/apps/{APP}/tables', tok, 100):
        tid, name = t['table_id'], t['name']
        fields = list(pages(f'/bitable/v1/apps/{APP}/tables/{tid}/fields', tok, 100))
        records = list(pages(f'/bitable/v1/apps/{APP}/tables/{tid}/records', tok, 500))
        path = os.path.join(out, tid + '.json')
        with open(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), 'w') as f:
            json.dump({'table_id': tid, 'name': name, 'fields': fields, 'records': records}, f, ensure_ascii=False)
        index.append({'table_id': tid, 'name': name, 'fields': len(fields), 'records': len(records)})
        print(f'{tid}  {len(records):>5} 行  {len(fields):>3} 列  {name}')
    with open(os.path.join(out, 'index.json'), 'w') as f:
        json.dump({'app': APP, 'exported_at': time.strftime('%Y-%m-%dT%H:%M:%S%z'), 'tables': index}, f, ensure_ascii=False, indent=1)
    print(f'共 {len(index)} 张表，{sum(t["records"] for t in index)} 行 → {out}')


if __name__ == '__main__':
    main()
