import { useEffect, useState } from 'react';
import { apiMeta, createToken, rpc, useViews, type ApiMeta, type Me } from '../api';
import { ActionDialog, Badge, Empty, Loading, can, day, type Field } from '../ui';

interface ApiToken { id: string; user_id: string; user_name: string; name: string; tail: string; can_write: boolean; created_at: string; expires_at: string; last_used_at: string | null; calls: number; revoked_at: string | null; mine: boolean; live: boolean }
interface ApiCall { id: number; token_name: string; user_name: string; action: string; ok: boolean; error: string | null; at: string; mine: boolean }
interface Act { title: string; hint?: string; label: string; fields: Field[]; danger?: boolean; run: (v: Record<string, string>) => Promise<unknown> }

// 智能体接入：后台的全部视图和操作经 MCP 接口开放。成员给自己的智能体建访问令牌，智能体以本人的身份查数据、办业务。
// 令牌的权限就是本人的权限；默认只读，要办理业务须建可写的令牌。明文只在创建时显示一次。
export function Agent({ me }: { me: Me }) {
  const { data, error, reload } = useViews<{ tokens: ApiToken[]; calls: ApiCall[] }>({ tokens: ['api_token'], calls: ['api_call'] });
  const [act, setAct] = useState<Act | null>(null);
  const [fresh, setFresh] = useState<string | null>(null);
  const [meta, setMeta] = useState<ApiMeta | null>(null);
  const [kw, setKw] = useState('');
  useEffect(() => { apiMeta().then(setMeta).catch(() => setMeta(null)); }, []);
  if (!data) return <Loading error={error} />;
  const admin = can(me, 'user.manage'), url = `${location.origin}/mcp`;
  const tokens = [...data.tokens].sort((a, b) => Number(b.mine) - Number(a.mine) || Number(b.live) - Number(a.live) || b.created_at.localeCompare(a.created_at));
  const time = (v: string | null) => (v ? v.slice(0, 16).replace('T', ' ') : '—');
  const createAct: Act = {
    title: '新建访问令牌', label: '生成',
    hint: '令牌交给本人的智能体使用，智能体凭它以本人的身份访问中台，能看到和能办的事与本人相同。只读的令牌只能查数据；可写的令牌可以提交申请、登记等，会改动数据，请只交给可信的智能体。令牌只在生成后显示一次，请当场保存；丢了就停用重建。每人最多同时持有 5 个有效令牌。',
    fields: [{ name: 'name', label: '用途（例如：本人的 Claude）' },
      { name: 'write', label: '权限', options: [['false', '只读：只能查数据'], ['true', '可写：可以办理业务']], value: 'false' },
      { name: 'days', label: '有效期', options: [['30', '30 天'], ['90', '90 天'], ['365', '一年']], value: '90' }],
    run: async (v) => { setFresh(await createToken(v.name, v.write === 'true', Number(v.days))); } };
  return (
    <>
      <div className="top"><h2>智能体接入</h2><div className="acts"><a className="btn ghost" href="#/agent" onClick={(e) => { e.preventDefault(); document.getElementById('api-doc')?.scrollIntoView({ behavior: 'smooth' }); }}>接口文档</a><button onClick={() => setAct(createAct)}>新建访问令牌</button></div></div>
      <p className="lede">中台后台的全部视图和操作经 MCP 接口开放。给本人的智能体建一个访问令牌，它就能以本人的身份查数据、办业务；各项权限和业务检查照常生效，经令牌做的每一次操作都留记录。</p>

      {fresh && (
        <section className="card">
          <h3>新令牌 <span className="h3sub">只显示这一次，请当场保存</span></h3>
          <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all', userSelect: 'all' }}>{fresh}</pre>
          <div className="actions" style={{ justifyContent: 'flex-start' }}>
            <button className="sm" onClick={() => navigator.clipboard?.writeText(fresh)}>复制</button>
            <button className="sm ghost" onClick={() => setFresh(null)}>已保存，关闭</button></div>
        </section>
      )}

      <section className="card">
        <h3>接入方法</h3>
        <p className="hint">接口地址：<code>{url}</code>。协议为 MCP（Streamable HTTP），请求头带 <code>Authorization: Bearer 令牌</code>。</p>
        <p className="hint">在 Claude Code 中接入：</p>
        <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{`claude mcp add --transport http clain ${url} --header "Authorization: Bearer 令牌"`}</pre>
        <p className="hint">接口提供五个工具：whoami（确认身份）、list_views 和 read_view（查数据）、list_actions 和 call_action（办理业务）。密钥的保存和取用不经此接口开放。</p>
      </section>

      <section className="card">
        <h3>访问令牌 <span className="h3sub">{admin ? '全部成员的令牌' : '本人的令牌'}</span></h3>
        {tokens.length === 0 ? <Empty>尚未建立访问令牌。</Empty> : (
          <div className="scroll"><table>
            <thead><tr><th>用途</th>{admin && <th>持有人</th>}<th>权限</th><th>末四位</th><th>建立</th><th>到期</th><th>最近使用</th><th className="r">调用次数</th><th>状态</th><th /></tr></thead>
            <tbody>{tokens.map((t) => (
              <tr key={t.id} style={t.live ? undefined : { opacity: .55 }}><td className="wrap">{t.name}</td>{admin && <td>{t.user_name}{t.mine && <span className="sub2">本人</span>}</td>}
                <td>{t.can_write ? <Badge tone="warn">可写</Badge> : <Badge>只读</Badge>}</td><td><code>…{t.tail}</code></td><td>{day(t.created_at)}</td><td>{day(t.expires_at)}</td><td>{time(t.last_used_at)}</td><td className="r">{t.calls}</td>
                <td>{t.revoked_at ? <Badge tone="bad">已停用</Badge> : t.live ? <Badge tone="ok">有效</Badge> : <Badge>已过期</Badge>}</td>
                <td className="r">{t.live && <button className="sm ghost danger" onClick={() => setAct({ title: `停用令牌：${t.name}`, label: '停用', danger: true, fields: [], hint: '停用后使用这个令牌的智能体立即不能再访问，不可恢复。', run: () => rpc('revoke_api_token', { id: t.id }) })}>停用</button>}</td></tr>))}</tbody>
          </table></div>
        )}
      </section>

      <section className="card">
        <h3>操作记录 <span className="h3sub">经令牌办理的业务，成功和失败都记；查数据不记</span></h3>
        {data.calls.length === 0 ? <Empty>暂无记录。</Empty> : (
          <div className="scroll"><table>
            <thead><tr><th>时间</th>{admin && <th>持有人</th>}<th>令牌</th><th>操作</th><th>结果</th></tr></thead>
            <tbody>{data.calls.slice(0, 100).map((c) => (
              <tr key={c.id}><td>{time(c.at)}</td>{admin && <td>{c.user_name}</td>}<td>{c.token_name}</td><td><code>{c.action}</code></td>
                <td className="wrap">{c.ok ? <Badge tone="ok">成功</Badge> : <><Badge tone="bad">未办成</Badge>{c.error && <div className="sub2" style={{ marginLeft: 0 }}>{c.error}</div>}</>}</td></tr>))}</tbody>
          </table></div>
        )}
      </section>

      <section className="card" id="api-doc">
        <h3>接口文档 <span className="h3sub">五个工具 · {meta ? `${meta.views.length} 个视图 · ${meta.actions.length} 个操作` : '读取中'}</span></h3>
        <p className="hint">智能体接入后先调 whoami 确认身份；查数据用 list_views 找到视图，再用 read_view 读；办业务用 list_actions 找到操作和参数，再用 call_action 调。视图只能读到本人有权看到的行；操作以本人的身份执行，办不成时返回原因。同一份说明也放在飞书知识库「CLAIN 知识库 › 首页 › 中台 MCP 接口说明」。</p>
        <div className="scroll"><table>
          <thead><tr><th style={{ width: '16%' }}>工具</th><th>用途</th><th style={{ width: '34%' }}>参数</th></tr></thead>
          <tbody>
            {(meta?.tools ?? []).map((t) => <tr key={t.name}><td><code>{t.name}</code></td><td className="wrap">{t.description}</td>
              <td className="wrap"><code>{({ whoami: '无', list_views: 'keyword（可省略）', read_view: 'view，filters（可省略），limit（可省略）', list_actions: 'keyword（可省略）', call_action: 'action，args' } as Record<string, string>)[t.name] ?? ''}</code></td></tr>)}
          </tbody>
        </table></div>
        <p className="hint">示例：读本人能看到的课题，<code>{'read_view {"view": "project", "filters": {"active": "true"}, "limit": 50}'}</code>；登记本期时间去向，<code>{'call_action {"action": "save_time_log", "args": {"period": "2026-11-16", "items": [{"project_id": "…", "percent": 60}]}}'}</code>。</p>
        <p className="hint">参数类型：uuid 填对象的 id，date 填 2026-11-16 这样的日期，numeric 和 int 填数，boolean 填 true 或 false，jsonb 填对象或数组，text 填文字。不需要的参数可以不传。</p>
        {meta && <>
          <div className="actions" style={{ justifyContent: 'flex-start' }}><input placeholder="按名称筛选视图和操作" value={kw} onChange={(e) => setKw(e.target.value.trim().toLowerCase())} style={{ maxWidth: 280 }} /></div>
          <details open={!!kw}><summary>视图 {meta.views.filter((v) => v.view.includes(kw)).length} 个（只读）</summary>
            <div className="scroll"><table><thead><tr><th style={{ width: '22%' }}>视图</th><th>列:类型</th></tr></thead>
              <tbody>{meta.views.filter((v) => v.view.includes(kw)).map((v) => <tr key={v.view}><td><code>{v.view}</code></td><td className="wrap"><span className="sub2" style={{ marginLeft: 0 }}>{v.columns.join('，')}</span></td></tr>)}</tbody></table></div></details>
          <details open={!!kw}><summary>操作 {meta.actions.filter((x) => x.action.includes(kw)).length} 个（会改动数据，需要可写的令牌）</summary>
            <div className="scroll"><table><thead><tr><th style={{ width: '28%' }}>操作</th><th>参数:类型</th></tr></thead>
              <tbody>{meta.actions.filter((x) => x.action.includes(kw)).map((x) => <tr key={x.action}><td><code>{x.action}</code></td><td className="wrap"><span className="sub2" style={{ marginLeft: 0 }}>{x.params.join('，') || '无'}</span></td></tr>)}</tbody></table></div></details>
        </>}
      </section>

      {act && <ActionDialog title={act.title} hint={act.hint} fields={act.fields} danger={act.danger} submitLabel={act.label}
        onSubmit={(v) => act.run(v).then(reload)} onClose={() => setAct(null)} />}
    </>
  );
}
