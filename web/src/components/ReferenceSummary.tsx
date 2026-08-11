import type { Source } from "../api";
import { referenceSections } from "../chat";

type Props = {
  sources: Source[];
  active?: boolean;
};

/** 回答前後で同じ位置と密度を保ち、資料カードの出入りによるレイアウト変化を防ぐ。 */
export function ReferenceSummary({ sources, active = false }: Props) {
  const sections = referenceSections(sources);
  if (sections.length === 0) return null;

  return (
    <p className={`answer-reference${active ? " is-active" : ""}`} aria-live={active ? "polite" : undefined}>
      <span className="citation-mark" aria-hidden="true" />
      <span><strong>{active ? "参照中" : "参照"}</strong>：{sections.join("／")}</span>
    </p>
  );
}
