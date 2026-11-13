import { useState } from 'react';
import { useViews, type Me, type RuleLookup } from '../api';
import { Badge, Empty, Loading, can, day } from '../ui';

// 能不能报：提支出之前先查这一类支出能不能报。不带经费卡，所有人都能查；按卡的答复记录只有财务岗和中心负责人看。
const answer = (r: RuleLookup): [string, string, string] =>
  r.disputed ? ['有争议', 'warn', '学校前后答复不一致，提之前先问财务岗。']
    : r.can_yes && r.has_no ? ['能报', 'ok', '不是每一类经费都能报，财务岗核对时会安排到能报的经费上。']
    : r.can_yes ? ['能报', 'ok', '照常提支出申请。']
    : r.has_cond ? ['有条件', 'warn', '满足下面的条件才能报。']
    : r.has_no ? ['不能报', 'bad', '学校答复过不能报，不要先垫钱。']
    : ['还没问过', '', '学校还没有答复过这一类，提之前先问财务岗。'];

export function Ask({ me }: { me: Me }) {
  const { data, error } = useViews<{ rows: RuleLookup[] }>({ rows: ['rule_lookup'] });
  const [kw, setKw] = useState('');
  if (!data) return <Loading error={error} />;
  const rows = data.rows.filter((r) => r.name.includes(kw.trim())).sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
  return (
    <>
      <div className="top"><h2>报销咨询</h2>{can(me, 'read.finance') && <a className="btn ghost" href="#/rules">报销答复记录</a>}</div>
      <p className="lede">花钱之前先在这里查这一类支出能不能报。结论来自学校财务的答复，由财务岗登记；查不到或者有争议的，先问财务岗再花。</p>
      <section className="card">
        <h3>按支出类型查</h3>
        <label className="field" style={{ maxWidth: 320 }}><span>支出类型</span><input value={kw} onChange={(e) => setKw(e.target.value)} placeholder="输入几个字，比如 差旅、接口" /></label>
        {rows.length === 0 ? <Empty>{data.rows.length === 0 ? '还没有登记支出类型。' : '没有叫这个名字的支出类型，换个说法试试，或者直接问财务岗。'}</Empty> : (
          <div className="scroll"><table>
            <thead><tr><th>支出类型</th><th>结论</th><th>说明</th><th>最近答复</th></tr></thead>
            <tbody>{rows.map((r) => { const [text, tone, tip] = answer(r); return (
              <tr key={r.expense_type_id}><td>{r.name}{r.required_path && <span className="sub2">走{r.required_path}</span>}</td>
                <td><Badge tone={tone}>{text}</Badge></td>
                <td className="wrap">{tip}{r.notes && <div className="sub2" style={{ marginLeft: 0 }}>条件：{r.notes}</div>}</td>
                <td>{r.ruled_on ? day(r.ruled_on) : '—'}</td></tr>); })}</tbody>
          </table></div>
        )}
        <p className="hint">能报的，到「支出申请」里从项目的预算行提。钱最后从哪一类经费出由财务岗核对时安排，申请人不用选。</p>
      </section>
    </>
  );
}
