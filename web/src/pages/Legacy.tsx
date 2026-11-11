import { Fragment, useState } from 'react';
import { useViews, type LegacyAdjust, type LegacyLedger, type LegacyMsItem, type LegacyMsSub, type LegacyRecord, type LegacyResReq, type LegacySource } from '../api';
import { Badge, Empty, Loading, money, num } from '../ui';

// 旧门户的数据：新系统里有对应位置的已经转成正式数据，其余的原样保留，在这里只读查看。
const bj = (v: string | null) => (v ? new Date(new Date(v).getTime() + 8 * 3600e3).toISOString().slice(0, 10) : '—');
const TONE: Record<string, string> = { 已通过: 'ok', 部分通过: 'ok', 已完成: 'ok', 已分发: 'ok', 待审核: 'warn', 待审批: 'warn', 待验收: 'warn', 已打回: 'bad', 已驳回: 'bad' };
const St = ({ s }: { s: string | null }) => <Badge tone={TONE[s ?? ''] ?? ''}>{s || '—'}</Badge>;
const amt = (v: string | null) => (v == null ? '—' : money(v));

export function LegacyMs() {
  const { data } = useViews<{ subs: LegacyMsSub[]; items: LegacyMsItem[] }>({ subs: ['legacy_ms_submission'], items: ['legacy_ms_item'] });
  const [open, setOpen] = useState('');
  if (!data || data.subs.length === 0) return null;
  const subs = [...data.subs].sort((a, b) => (b.submitted_at ?? '').localeCompare(a.submitted_at ?? ''));
  const passed = data.items.filter((i) => i.status === '已通过').reduce((s, i) => s + num(i.approved ?? i.requested), 0);
  const waiting = data.items.filter((i) => i.status === '待审核');
  return (
    <section className="card">
      <h3>旧门户的晨星预算</h3>
      <p className="hint">旧门户里按预算表逐行申报、逐行审核的记录，共 {subs.length} 次提交、{data.items.length} 行明细，已通过 {money(passed)}。
        这些是历史记录，不计入上面的额度。{waiting.length > 0 && `其中 ${waiting.length} 行（${money(waiting.reduce((s, i) => s + num(i.requested), 0))}）在旧门户里还没审，需要的话在新系统里重新提交支出申请。`}</p>
      <div className="scroll"><table>
        <thead><tr><th>提交时间</th><th>负责人</th><th>文件</th><th className="r">申报</th><th className="r">通过</th><th className="r">待审</th><th>状态</th><th /></tr></thead>
        <tbody>{subs.map((s) => { const items = data.items.filter((i) => i.submission_id === s.id).sort((a, b) => num(a.row_no) - num(b.row_no) || num(a.serial) - num(b.serial)); return (
          <Fragment key={s.id}>
            <tr><td>{bj(s.submitted_at)}</td><td>{s.leader_name}</td><td className="wrap">{s.file_name || '—'}{s.comment && <div className="sub2">{s.comment}</div>}</td>
              <td className="r">{amt(s.total)}</td><td className="r">{amt(s.approved)}</td><td className="r">{amt(s.pending)}</td><td><St s={s.status} /></td>
              <td><div className="acts"><button className="sm ghost" aria-pressed={open === s.id} onClick={() => setOpen(open === s.id ? '' : s.id)}>{items.length} 行</button></div></td></tr>
            {open === s.id && items.map((i) => (
              <tr key={i.id} className="subrow"><td>{i.serial || ''}</td><td colSpan={2} className="wrap">{i.expense_type || '—'}{i.parent_category && <span className="sub2"> {i.parent_category}</span>}
                {(i.note || i.comment) && <div className="sub2">{[i.note, i.comment && `财务意见：${i.comment}`].filter(Boolean).join('；')}</div>}</td>
                <td className="r">{amt(i.requested)}</td><td className="r">{i.status === '已通过' ? amt(i.approved ?? i.requested) : '—'}</td>
                <td className="r">{i.quantity != null && i.unit_amount != null ? `${num(i.quantity)} × ${money(i.unit_amount)}` : ''}</td><td><St s={i.status} /></td><td /></tr>
            ))}
          </Fragment>); })}</tbody>
      </table></div>
    </section>
  );
}

export function LegacyAdjustList({ cardId }: { cardId: string }) {
  const { data } = useViews<{ rows: LegacyAdjust[] }>({ rows: ['legacy_budget_adjust', { card_id: cardId }] }, cardId);
  if (!data || data.rows.length === 0) return null;
  return (
    <section className="card">
      <h3>旧门户的预算调整记录</h3>
      <p className="hint">这张卡在旧门户里做过的预算调整，仅供查阅；现行预算以上面的预算表为准。</p>
      <div className="scroll"><table>
        <thead><tr><th>时间</th><th>科目</th><th className="r">调整前</th><th className="r">调整后</th><th>原因</th></tr></thead>
        <tbody>{[...data.rows].sort((a, b) => (a.adjusted_at ?? '').localeCompare(b.adjusted_at ?? '')).map((r) => (
          <tr key={r.id}><td>{bj(r.adjusted_at)}</td><td>{r.subject_name}</td><td className="r">{amt(r.previous)}</td><td className="r">{amt(r.amount)}</td><td className="wrap">{r.reason ?? '—'}</td></tr>
        ))}</tbody>
      </table></div>
    </section>
  );
}

export function LegacyResource() {
  const { data } = useViews<{ reqs: LegacyResReq[]; ledger: LegacyLedger[] }>({ reqs: ['legacy_resource_request'], ledger: ['legacy_quota_ledger'] });
  if (!data || (data.reqs.length === 0 && data.ledger.length === 0)) return null;
  return (
    <>
      {data.reqs.length > 0 && (
        <section className="card">
          <h3>旧门户的资源申请</h3>
          <p className="hint">旧门户里提交的接口额度、账号等申请，共 {data.reqs.length} 条，仅供查阅。</p>
          <div className="scroll"><table>
            <thead><tr><th>时间</th><th>申请人</th><th>资源</th><th>用途</th><th className="r">金额</th><th>状态</th></tr></thead>
            <tbody>{[...data.reqs].sort((a, b) => (b.applied_at ?? '').localeCompare(a.applied_at ?? '')).map((r) => (
              <tr key={r.id}><td>{bj(r.applied_at)}</td><td>{r.applicant}</td><td>{r.resource || '—'}{r.kind && <div className="sub2">{r.kind}</div>}</td>
                <td className="wrap">{[r.project, r.purpose].filter(Boolean).join('：') || '—'}
                  {(r.usage || r.period || r.comment) && <div className="sub2">{[r.usage, r.period && `期限 ${r.period}`, r.comment].filter(Boolean).join('；')}</div>}</td>
                <td className="r">{amt(r.amount)}</td><td><St s={r.status} /></td></tr>
            ))}</tbody>
          </table></div>
        </section>
      )}
      {data.ledger.length > 0 && (
        <section className="card">
          <h3>旧门户的额度台账</h3>
          <div className="scroll"><table>
            <thead><tr><th>使用人</th><th>资源</th><th>项目</th><th>周期</th><th className="r">总额度</th><th className="r">已用</th><th className="r">剩余</th><th>有效期</th></tr></thead>
            <tbody>{data.ledger.map((r) => (
              <tr key={r.id}><td>{r.user_name}</td><td>{r.resource || '—'}</td><td>{r.project ?? '—'}</td><td>{r.period ?? '—'}</td>
                <td className="r">{amt(r.total)}</td><td className="r">{amt(r.used)}</td><td className="r">{amt(r.remaining)}</td><td>{r.valid_to && /^\d{12,14}$/.test(r.valid_to) ? bj(new Date(Number(r.valid_to)).toISOString()) : r.valid_to ?? '—'}</td></tr>
            ))}</tbody>
          </table></div>
        </section>
      )}
    </>
  );
}

// ---------- 全部旧数据的目录 ----------
const TYPE: Record<string, [string, string]> = {
  funding_project: ['经费项目', '已转为经费卡'], category: ['科目', '已转为科目模板'], budget: ['预算', '生效的已转为预算，作废的仅存档'],
  expense: ['支出', '已转为已入账的支出'], milestone: ['考核节点', '已转为经费卡的考核节点'], asset_catalog_item: ['资产目录', '已转为资源'],
  asset_ledger: ['资产发放台账', '已转为资源的分配记录'], api_resource_pool: ['接口资源池', '已转为资源'],
  morningstar_budget_submission: ['晨星预算提交', '在晨星额度页查看'], morningstar_budget_item: ['晨星预算明细', '在晨星额度页查看'],
  budget_adjustment: ['预算调整', '在经费卡页查看'], asset_request: ['资产申请', '仅存档'], priority_rule: ['经费卡优先规则', '仅存档'],
};
const KEY: Record<string, string> = {
  id: '编号', name: '名称', status: '状态', leader_name: '负责人', amount: '金额', total_amount: '合计', approved_amount: '通过金额', requested_amount: '申报金额',
  pending_amount: '待审金额', rejected_amount: '驳回金额', submitted_at: '提交时间', created_at: '创建时间', updated_at: '更新时间', file_name: '文件名',
  finance_comment: '财务意见', note: '备注', quantity: '数量', unit: '单位', spec: '规格', category: '类别', location: '存放地', project_id: '项目编号',
  project_name: '项目', project_number: '经费卡号', category_name: '科目', category_id: '科目编号', expense_type: '支出类型', parent_category: '上级科目',
  unit_amount: '单价', serial: '序号', reason: '原因', version: '版本', action: '动作', asset_name: '资产', catalog_id: '目录编号', target_date: '目标日期',
  target_amount: '目标金额', purpose: '用途', items: '明细', bundle: '套装', submission_id: '提交编号', year: '年度', provider: '服务商', model: '模型',
  currency: '币种', purchased_amount: '已购金额', balance_amount: '余额', allocated_amount: '已分配', previous_amount: '调整前', adjusted_at: '调整时间',
  stock_quantity: '库存', stock_available: '可用库存', asset_nature: '资产性质', standard_quantity: '标准数量', standard_unit_price: '标准单价',
  start_date: '开始日期', end_date: '结束日期', voided_at: '作废时间', priority: '优先级', description: '说明', procurement: '采购', row_number: '行号',
};
const show = (v: unknown) => { const s = v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v); return s.length > 80 ? `${s.slice(0, 80)}…` : s; };

export function LegacyArchive() {
  const { data, error } = useViews<{ sources: LegacySource[] }>({ sources: ['legacy_source'] });
  const [src, setSrc] = useState('');
  if (!data) return <Loading error={error} />;
  const label = (s: LegacySource) => (s.source.startsWith('entity:') ? TYPE[s.name]?.[0] ?? s.name : s.name);
  const where = (s: LegacySource) => (s.source.startsWith('entity:') ? TYPE[s.name]?.[1] ?? '仅存档'
    : s.name === '资源申请表' || s.name === '额度台账表' ? '在资源页查看' : '仅存档');
  const rows = [...data.sources].sort((a, b) => Number(b.source.startsWith('entity:')) - Number(a.source.startsWith('entity:')) || label(a).localeCompare(label(b), 'zh'));
  return (
    <>
      <section className="card">
        <h3>旧门户数据</h3>
        <p className="hint">旧门户的全部数据都保留在这里，共 {rows.reduce((s, r) => s + r.n, 0)} 条。新系统里有对应位置的已经转成正式数据，其余的原样存档、只读。
          用户已转为正式用户，不在此重复；接口密钥和访问码没有导入。</p>
        {rows.length === 0 ? <Empty>没有旧门户数据。</Empty> : (
          <div className="scroll"><table>
            <thead><tr><th>数据</th><th className="r">条数</th><th>在新系统里的位置</th><th /></tr></thead>
            <tbody>{rows.map((s) => (
              <tr key={s.source}><td>{label(s)}</td><td className="r">{s.n}</td><td>{where(s)}</td>
                <td><div className="acts"><button className="sm ghost" aria-pressed={src === s.source} onClick={() => setSrc(src === s.source ? '' : s.source)}>查看原始记录</button></div></td></tr>
            ))}</tbody>
          </table></div>
        )}
      </section>
      {src && <LegacyRows key={src} source={src} title={label(rows.find((r) => r.source === src)!)} />}
    </>
  );
}

function LegacyRows({ source, title }: { source: string; title: string }) {
  const { data, error } = useViews<{ rows: LegacyRecord[] }>({ rows: ['legacy_record', { source }] }, source);
  if (!data) return <section className="card"><Loading error={error} /></section>;
  const keys = [...new Set(data.rows.slice(0, 100).flatMap((r) => Object.keys(r.data ?? {})))].filter((k) => !/_id$|^id$|_key|token/.test(k) || k === 'leader_id').slice(0, 14);
  const entity = source.startsWith('entity:');
  return (
    <section className="card">
      <h3>{title}：原始记录 {data.rows.length} 条</h3>
      <div className="scroll"><table>
        <thead><tr>{entity && <th>状态</th>}{keys.map((k) => <th key={k}>{KEY[k] ?? k}</th>)}</tr></thead>
        <tbody>{data.rows.slice(0, 500).map((r) => (
          <tr key={r.record_id}>{entity && <td>{r.status ?? '—'}</td>}{keys.map((k) => <td key={k} className="wrap">{show(r.data?.[k])}</td>)}</tr>
        ))}</tbody>
      </table></div>
      {data.rows.length > 500 && <p className="hint">只显示前 500 条。</p>}
    </section>
  );
}
