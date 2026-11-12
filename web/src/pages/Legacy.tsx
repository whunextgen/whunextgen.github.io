import { Fragment, useState } from 'react';
import { useViews, type LegacyAdjust, type LegacyLedger, type LegacyMsItem, type LegacyMsSub, type LegacyRecon, type LegacyRecord, type LegacyResReq, type LegacySource } from '../api';
import { Badge, Empty, Loading, money, num } from '../ui';

// 旧门户的数据：新系统里有对应位置的已经转成正式数据，其余的原样保留，在这里只读查看。
const bj = (v: string | null) => (v ? new Date(new Date(v).getTime() + 8 * 3600e3).toISOString().slice(0, 10) : '—');
const TONE: Record<string, string> = { 已通过: 'ok', 部分通过: 'ok', 已完成: 'ok', 已分发: 'ok', 待审核: 'warn', 待审批: 'warn', 待验收: 'warn', 已打回: 'bad', 已驳回: 'bad' };
const St = ({ s }: { s: string | null }) => <Badge tone={TONE[s ?? ''] ?? ''}>{s || '—'}</Badge>;
const amt = (v: string | null) => (v == null ? '—' : money(v));

// 旧门户的晨星预算：每次提交的数字都按明细逐行加出来，申报 = 通过 + 待审 + 未通过，和上面对账表里的几行是同一批数
function MsTable({ subs, items }: { subs: LegacyMsSub[]; items: LegacyMsItem[] }) {
  const [open, setOpen] = useState('');
  const sum = (rows: LegacyMsItem[], st?: (s: string) => boolean) => rows.filter((i) => !st || st(i.status)).reduce((s, i) => s + num(i.requested), 0);
  const isOk = (s: string) => s === '已通过', isWait = (s: string) => s === '待审核', isOff = (s: string) => !isOk(s) && !isWait(s);
  const sorted = [...subs].sort((a, b) => (b.submitted_at ?? '').localeCompare(a.submitted_at ?? ''));
  const known = items.filter((i) => subs.some((s) => s.id === i.submission_id));
  return (
    <div>
      <h4 className="subhd">晨星预算提交 <span className="sub2">{subs.length} 次 · {known.length} 行明细</span></h4>
      <div className="scroll"><table>
        <thead><tr><th>提交时间</th><th>负责人</th><th>文件</th><th className="r">申报</th><th className="r">通过</th><th className="r">待审</th><th className="r">未通过</th><th>状态</th><th /></tr></thead>
        <tbody>{sorted.map((s) => { const rows = items.filter((i) => i.submission_id === s.id).sort((a, b) => num(a.row_no) - num(b.row_no) || num(a.serial) - num(b.serial));
          const req = sum(rows), file = s.total == null ? null : num(s.total); return (
          <Fragment key={s.id}>
            <tr><td>{bj(s.submitted_at)}</td><td>{s.leader_name}</td><td className="wrap">{s.file_name || '—'}
                {file != null && Math.abs(file - req) > 0.005 && <div className="sub2">预算表合计 {money(file)}，进入审核的是其中 {rows.length} 行</div>}
                {s.comment && <div className="sub2">{s.comment}</div>}</td>
              <td className="r">{money(req)}</td><td className="r">{money(sum(rows, isOk))}</td><td className="r">{money(sum(rows, isWait))}</td><td className="r">{money(sum(rows, isOff))}</td><td><St s={s.status} /></td>
              <td><div className="acts"><button className="sm ghost" aria-pressed={open === s.id} onClick={() => setOpen(open === s.id ? '' : s.id)}>{rows.length} 行</button></div></td></tr>
            {open === s.id && rows.map((i) => (
              <tr key={i.id} className="subrow"><td>{i.serial || ''}</td><td colSpan={2} className="wrap">{i.expense_type || '—'}{i.parent_category && <span className="sub2"> {i.parent_category}</span>}
                {(i.note || i.comment) && <div className="sub2">{[i.note, i.comment && `财务意见：${i.comment}`].filter(Boolean).join('；')}</div>}</td>
                <td className="r">{amt(i.requested)}</td><td className="r">{isOk(i.status) ? amt(i.requested) : '—'}</td><td className="r">{isWait(i.status) ? amt(i.requested) : '—'}</td>
                <td className="r">{isOff(i.status) ? amt(i.requested) : '—'}</td><td><St s={i.status} /></td>
                <td className="sub2">{i.quantity != null && i.unit_amount != null ? `${num(i.quantity)} × ${money(i.unit_amount)}` : ''}</td></tr>
            ))}
          </Fragment>); })}</tbody>
        <tfoot><tr><td colSpan={3}>合计</td><td className="r">{money(sum(known))}</td><td className="r">{money(sum(known, isOk))}</td><td className="r">{money(sum(known, isWait))}</td><td className="r">{money(sum(known, isOff))}</td><td colSpan={2} /></tr></tfoot>
      </table></div>
    </div>
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

function ResReqTable({ reqs }: { reqs: LegacyResReq[] }) {
  return (
    <div>
      <h4 className="subhd">资源申请 <span className="sub2">{reqs.length} 条 · 接口额度、账号等</span></h4>
      <div className="scroll"><table>
        <thead><tr><th>时间</th><th>申请人</th><th>资源</th><th>用途</th><th className="r">金额</th><th>状态</th></tr></thead>
        <tbody>{[...reqs].sort((a, b) => (b.applied_at ?? '').localeCompare(a.applied_at ?? '')).map((r) => (
          <tr key={r.id}><td>{bj(r.applied_at)}</td><td>{r.applicant}</td><td>{r.resource || '—'}{r.kind && <div className="sub2">{r.kind}</div>}</td>
            <td className="wrap">{[r.project, r.purpose].filter(Boolean).join('：') || '—'}
              {(r.usage || r.period || r.comment) && <div className="sub2">{[r.usage, r.period && `期限 ${r.period}`, r.comment].filter(Boolean).join('；')}</div>}</td>
            <td className="r">{amt(r.amount)}</td><td><St s={r.status} /></td></tr>
        ))}</tbody>
        <tfoot><tr><td colSpan={4}>合计</td><td className="r">{money(reqs.reduce((s, r) => s + num(r.amount), 0))}</td><td /></tr></tfoot>
      </table></div>
    </div>
  );
}

function LedgerTable({ ledger }: { ledger: LegacyLedger[] }) {
  const tot = (k: 'total' | 'used' | 'remaining') => money(ledger.reduce((s, r) => s + num(r[k]), 0));
  return (
    <div>
      <h4 className="subhd">额度台账 <span className="sub2">{ledger.length} 条 · 按周期发给个人的接口额度</span></h4>
      <div className="scroll"><table>
        <thead><tr><th>使用人</th><th>资源</th><th>项目</th><th>周期</th><th className="r">总额度</th><th className="r">已用</th><th className="r">剩余</th><th>有效期</th></tr></thead>
        <tbody>{ledger.map((r) => (
          <tr key={r.id}><td>{r.user_name}</td><td>{r.resource || '—'}</td><td>{r.project ?? '—'}</td><td>{r.period ?? '—'}</td>
            <td className="r">{amt(r.total)}</td><td className="r">{amt(r.used)}</td><td className="r">{amt(r.remaining)}</td><td>{r.valid_to && /^\d{12,14}$/.test(r.valid_to) ? bj(new Date(Number(r.valid_to)).toISOString()) : r.valid_to ?? '—'}</td></tr>
        ))}</tbody>
        <tfoot><tr><td colSpan={4}>合计</td><td className="r">{tot('total')}</td><td className="r">{tot('used')}</td><td className="r">{tot('remaining')}</td><td /></tr></tfoot>
      </table></div>
    </div>
  );
}

// ---------- 原始记录 ----------
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

// 旧门户的记录统一放在这一页，按新系统的五步归类：预算、申请、承诺、入账、结清，再加资源和存档。
// 财务岗和中心负责人看到每一类的对账（旧门户多少、转入多少、新系统现有多少）；其他人只看到自己的申请和额度。
const STEPS: [number, string, string][] = [
  [1, '预算', '经费项目、科目、预算和考核节点'], [2, '申请', '旧门户里提交过的申请，没走到批准的'], [3, '承诺', '批准了但没有入账的'],
  [4, '入账', '学校已入账的支出'], [5, '结清', ''], [6, '资源', '资产和接口额度'], [7, '存档', '新系统里没有对应位置的原件'],
];
const cnt = (n: number | null, a: string | null) => (n == null ? '—' : <>{n} 条{a != null && <span className="sub2"> · {money(a)}</span>}</>);

export function History({ staff }: { staff: boolean }) {
  const { data, error } = useViews<{ recon: LegacyRecon[]; sources: LegacySource[]; subs: LegacyMsSub[]; items: LegacyMsItem[]; reqs: LegacyResReq[]; ledger: LegacyLedger[] }>({
    recon: ['legacy_recon'], sources: ['legacy_source'], subs: ['legacy_ms_submission'], items: ['legacy_ms_item'], reqs: ['legacy_resource_request'], ledger: ['legacy_quota_ledger'] });
  const [src, setSrc] = useState<{ step: number; source: string; title: string } | null>(null);
  const [files, setFiles] = useState(false);
  if (!data) return <Loading error={error} />;
  const recon = [...data.recon].sort((a, b) => a.step - b.step || a.sort - b.sort);
  const moved = recon.filter((r) => r.in_n != null), bad = moved.filter((r) => !r.ok);
  const total = recon.reduce((s, r) => s + r.old_n, 0), all = recon[0]?.all_n ?? 0;
  const attach = data.sources.filter((s) => !s.source.startsWith('entity:') && s.name !== '资源申请表' && s.name !== '额度台账表').sort((a, b) => a.name.localeCompare(b.name, 'zh'));
  const pick = (step: number, source: string, title: string) => setSrc(src?.source === source && src.step === step ? null : { step, source, title });
  const extra = (step: number) => (step === 2 ? (data.subs.length > 0 || data.reqs.length > 0) : step === 6 ? data.ledger.length > 0 : false);
  const nothing = recon.length === 0 && !extra(2) && !extra(6);

  return (
    <>
      <div className="top"><h2>旧门户记录</h2></div>
      <p className="lede">旧门户的数据按新系统的五步归类，只读。{staff ? '每一类都列出旧门户里有多少、转入新系统多少、新系统里现在实际有多少，三个数现算现比。' : '这里是你在旧门户里提交过的申请和领到的额度。'}</p>
      {staff && recon.length > 0 && (
        <div className="tiles">
          <div className="tile"><div className="k">旧门户记录</div><div className="v">{all}</div><div className="f">{total === all ? `各类相加 ${total} 条，一条不少` : `各类相加 ${total} 条，差 ${all - total} 条`}</div></div>
          <div className="tile"><div className="k">转入新系统</div><div className="v">{moved.reduce((s, r) => s + (r.in_n ?? 0), 0)}</div><div className="f">{moved.length} 类，继续使用</div></div>
          <div className="tile"><div className="k">只存档</div><div className="v">{all - moved.reduce((s, r) => s + (r.in_n ?? 0), 0)}</div><div className="f">原样保留，只读</div></div>
          <div className="tile"><div className="k">核对结果</div><div className={`v${bad.length > 0 || total !== all ? ' bad' : ''}`}>{bad.length > 0 ? `${bad.length} 类对不上` : '全部一致'}</div><div className="f">转入的 {moved.length} 类逐类比对</div></div>
        </div>
      )}
      {nothing && <Empty>没有旧门户记录。</Empty>}
      {STEPS.map(([step, name, desc]) => { const rows = recon.filter((r) => r.step === step);
        if (rows.length === 0 && !extra(step) && !(staff && step === 5 && recon.length > 0)) return null; return (
        <Fragment key={step}>
          <section className="card">
            <h3>{name}{desc && <span className="sub2 h3sub">{desc}</span>}</h3>
            <div className="stack">
              {step === 5 && <Empty>旧门户没有结清记录。经费卡的结清从新系统开始做。</Empty>}
              {rows.length > 0 && (
                <div className="scroll"><table className="recon">
                  <thead><tr><th>数据</th><th>旧门户</th><th>转入新系统</th><th>新系统现有</th><th>核对</th><th /></tr></thead>
                  <tbody>{rows.map((r) => (
                    <tr key={r.key}><td className="wrap">{r.label}{r.note && <div className="sub2">{r.note}</div>}</td>
                      <td>{cnt(r.old_n, r.old_amt)}</td>
                      <td>{r.in_n == null ? <span className="sub2">只存档</span> : <>{cnt(r.in_n, r.in_amt)}{r.place && <div className="sub2">→ {r.place}</div>}</>}</td>
                      <td>{r.in_n == null ? '—' : cnt(r.new_n ?? 0, r.new_amt)}</td>
                      <td>{r.in_n == null ? '' : <Badge tone={r.ok ? 'ok' : 'bad'}>{r.ok ? '一致' : '对不上'}</Badge>}</td>
                      <td><div className="acts">
                        {r.source && <button className="sm ghost" aria-pressed={src?.source === r.source && src.step === step} onClick={() => pick(step, r.source!, r.label)}>原始记录</button>}
                        {r.key === 'attach' && <button className="sm ghost" aria-pressed={files} onClick={() => setFiles(!files)}>{attach.length} 张表</button>}
                      </div></td></tr>
                  ))}</tbody>
                </table></div>
              )}
              {step === 7 && files && (
                <div className="scroll"><table>
                  <thead><tr><th>附件表格</th><th className="r">行数</th><th /></tr></thead>
                  <tbody>{attach.map((s) => (
                    <tr key={s.source}><td className="wrap">{s.name}</td><td className="r">{s.n}</td>
                      <td><div className="acts"><button className="sm ghost" aria-pressed={src?.source === s.source} onClick={() => pick(7, s.source, s.name)}>原始记录</button></div></td></tr>
                  ))}</tbody>
                </table></div>
              )}
              {step === 2 && data.subs.length > 0 && <MsTable subs={data.subs} items={data.items} />}
              {step === 2 && data.reqs.length > 0 && <ResReqTable reqs={data.reqs} />}
              {step === 6 && data.ledger.length > 0 && <LedgerTable ledger={data.ledger} />}
            </div>
          </section>
          {src?.step === step && <LegacyRows key={src.source} source={src.source} title={src.title} />}
        </Fragment>); })}
    </>
  );
}
