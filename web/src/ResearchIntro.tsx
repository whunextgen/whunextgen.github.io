import { useId } from 'react';

// 研究介绍的预览：跳过开头的申请书抬头（实验室名、「年度课题预算申请书」、课题名称、申请档次、申请人等）和小标题，
// 直接从研究问题或研究内容的正文起（#141）；展开后仍是全文
const HEAD = /^(.{0,30}(实验室|研究中心|研究院)|.{0,30}(申请书|研究计划及预算申请)|(课题|项目)名称|申请档次|申请人|申请年度|负责人|所在单位|研究方向|(重点|培育|探索|公共)课题[：:]|【.*】$)/;
const TITLE = /^(([一二三四五六七八九十]+、|（[一二三四五六七八九十]+）).{0,20}|.{1,20}[：:])$/;
export function introPreview(text: string) {
  const lines = text.replace(/\r/g, '').split('\n').map((x) => x.trim()).filter(Boolean);
  let i = 0;
  while (i < lines.length - 1 && (HEAD.test(lines[i]) || TITLE.test(lines[i]))) i++;
  const rest = lines.slice(i).join('\n');
  return rest.length >= 20 ? rest : text;
}
export function ResearchIntro({ text }: { text: string }) {
  const id = useId();
  return <details className="research-intro">
    <summary aria-controls={id} aria-label="展开或收起研究介绍">
      <span className="research-intro-preview">{introPreview(text)}</span>
      <span className="research-intro-open">展开研究介绍</span>
      <span className="research-intro-close">收起研究介绍</span>
    </summary>
    <div id={id} className="research-intro-full">{text}</div>
  </details>;
}
