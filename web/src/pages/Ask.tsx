import { useState } from 'react';
import { useViews, type Me, type RuleLookup } from '../api';
import { Badge, Empty, Loading, can, day } from '../ui';

// 能不能报：提支出之前先查这一类支出能不能报。不带经费卡，所有人都能查；按卡的答复记录只有财务岗和中心负责人看。
const answer = (r: RuleLookup): [string, string, string] =>
  r.disputed ? ['有争议', 'warn', '学校前后答复不一致，提交前请先咨询财务岗。']
    : r.can_yes && r.has_no ? ['可报销', 'ok', '并非各类经费均可报销，财务岗核对时安排至可报销的经费。']
    : r.can_yes ? ['可报销', 'ok', '按常规提交支出申请。']
    : r.has_cond ? ['有条件报销', 'warn', '满足下列条件方可报销。']
    : r.has_no ? ['不可报销', 'bad', '学校已答复不可报销，请勿先行垫付。']
    : ['尚未咨询', '', '学校尚未答复该类支出，提交前请先咨询财务岗。'];

export function Ask({ me }: { me: Me }) {
  const { data, error } = useViews<{ rows: RuleLookup[] }>({ rows: ['rule_lookup'] });
  const [kw, setKw] = useState('');
  if (!data) return <Loading error={error} />;
  const rows = data.rows.filter((r) => r.name.includes(kw.trim())).sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
  return (
    <>
      <div className="top"><h2>报销咨询</h2>{can(me, 'read.finance') && <a className="btn ghost" href="#/rules">报销答复记录</a>}</div>
      <p className="lede">支出前请先在此查询该类支出可否报销。结论来自学校财务的答复，由财务岗登记；未查到或有争议的，先咨询财务岗再支出。</p>
      <section className="card">
        <h3>按支出类型查询</h3>
        <label className="field" style={{ maxWidth: 320 }}><span>支出类型</span><input value={kw} onChange={(e) => setKw(e.target.value)} placeholder="输入关键词，例如：差旅、接口" /></label>
        {rows.length === 0 ? <Empty>{data.rows.length === 0 ? '暂无已登记的支出类型。' : '未找到相符的支出类型，请更换关键词，或直接咨询财务岗。'}</Empty> : (
          <div className="scroll"><table>
            <thead><tr><th>支出类型</th><th>结论</th><th>说明</th><th>最近答复</th></tr></thead>
            <tbody>{rows.map((r) => { const [text, tone, tip] = answer(r); return (
              <tr key={r.expense_type_id}><td>{r.name}{r.required_path && <span className="sub2">采用{r.required_path}</span>}</td>
                <td><Badge tone={tone}>{text}</Badge></td>
                <td className="wrap">{tip}{r.notes && <div className="sub2" style={{ marginLeft: 0 }}>条件：{r.notes}</div>}</td>
                <td>{r.ruled_on ? day(r.ruled_on) : '—'}</td></tr>); })}</tbody>
          </table></div>
        )}
        <p className="hint">可报销的，在「支出申请」中从项目预算行提交。最终列支的经费类别由财务岗核对时安排，申请人无需选择。</p>
      </section>
    </>
  );
}
