import { useId } from 'react';

/** Native disclosure keeps long introductions readable by touch and keyboard. */
export function ResearchIntro({ text }: { text: string }) {
  const id = useId();
  return <details className="research-intro">
    <summary aria-controls={id} aria-label="展开或收起研究介绍">
      <span className="research-intro-preview">{text}</span>
      <span className="research-intro-open">展开研究介绍</span>
      <span className="research-intro-close">收起研究介绍</span>
    </summary>
    <div id={id} className="research-intro-full">{text}</div>
  </details>;
}
