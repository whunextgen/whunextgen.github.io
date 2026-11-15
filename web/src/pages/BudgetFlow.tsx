import { type BudgetModule, type BudgetPlan, type BudgetSource, type BudgetTier, type BudgetYear, type TierPick } from '../api';
import { day, num } from '../ui';
import { Stages } from '../tree';

const wan = (x: number) => `${(x / 1e4).toFixed(Math.abs(x) >= 1e6 || x % 1e4 === 0 ? 0 : 1)} 万`;

// 年度预算的流程：测算总预算 › 直接确定金额的课题 › 编档次 › 批准方案 › 立项与延续申请 › 评定 › 下达执行 › 年度决算。
// 「总预算与档次」和「预算编制」两页共用。金额只给财务岗和中心负责人看（staff）。
export function flowState(y: BudgetYear, plan: BudgetPlan | undefined, modules: BudgetModule[], tiers: BudgetTier[], picks: TierPick[]) {
  const published = !!plan?.published, total = num(plan?.total ?? 0);
  const undecided = picks.filter((k) => !k.decided_tier_id && !k.rejected).length;
  const at = y.stage === 'closed' ? 9 : y.stage === 'issued' ? 8 : y.stage !== 'declare' ? 7
    : published ? (picks.length > 0 ? 6 : 5) : tiers.length > 0 ? 4 : modules.length > 0 ? 3 : total > 0 ? 2 : 1;
  const text = y.stage === 'closed' ? '已决算' : y.stage === 'issued' ? '已下达，执行中' : y.stage !== 'declare' ? '评定完成，待下达到经费卡'
    : !published ? '预算方案编制中' : picks.length === 0 ? '方案已批准，课题申请中' : undecided > 0 ? '课题申请与评定中' : '评定结果已录入，待确认评定完成';
  return { published, total, undecided, at, text };
}

export function BudgetFlow({ y, staff, plan, sources, modules, tiers, picks }: { y: BudgetYear; staff: boolean; plan: BudgetPlan | undefined; sources: BudgetSource[]; modules: BudgetModule[]; tiers: BudgetTier[]; picks: TierPick[] }) {
  const { published, total, undecided, at } = flowState(y, plan, modules, tiers, picks);
  const modSum = modules.reduce((t, m) => t + num(m.amount), 0);
  return (
    <Stages path="测算总预算 › 直接确定金额的课题 › 编档次 › 批准方案 › 立项与延续申请 › 评定 › 下达执行 › 年度决算" at={at} items={[
      { nm: '测算总预算', ds: '财务岗按各项目可用经费测算', v: staff ? wan(total) : '—', f: staff ? `${sources.length} 个项目计入` : '' },
      { nm: '直接确定金额', ds: '中心公共开支等课题，不参加评定', v: staff ? wan(modSum) : '—', f: staff ? `${modules.length} 个课题` : '' },
      { nm: '编档次', ds: '每档金额、名额、限制', v: `${tiers.length} 档`, f: tiers.length ? `名额 ${tiers.reduce((t, x) => t + x.slots, 0)} 个` : '' },
      { nm: '批准方案', ds: '中心负责人批准后公布', v: published ? '已批准' : '未批准', f: plan?.plan_at ? day(plan.plan_at) : '' },
      { nm: '立项与延续', ds: '课题选档并提交明细', v: `${picks.length} 个课题`, f: published ? `申报截止 ${day(y.due_date)}` : '方案批准后开始' },
      { nm: '评定', ds: '联席会议决定，助理录入', v: picks.length ? `${picks.length - undecided} / ${picks.length}` : '—', f: undecided > 0 ? `${undecided} 个待评定` : '' },
      { nm: '下达执行', ds: '档次即上限，明细即预算行', v: ['fixed', 'issued', 'closed'].includes(y.stage) ? (y.stage === 'fixed' ? '待下达' : '已下达') : '—', f: '' },
      { nm: '年度决算', ds: '年末复盘', v: y.stage === 'closed' ? '已决算' : '—', f: '' },
    ]} />
  );
}
