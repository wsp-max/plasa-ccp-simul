import React, { useMemo, useState } from "react";

type GuideLang = "en" | "ko" | "ja";

const GUIDE_CONTENT: Record<
  GuideLang,
  {
    title: string;
    intro: string;
    steps: string[];
    quickTipsTitle: string;
    quickTips: string[];
  }
> = {
  en: {
    title: "User Guide (Quick Start)",
    intro:
      "Recommended flow for first-time users. Start from default case, then tune geometry and process parameters.",
    steps: [
      "Step 1. Run baseline once in Overview to confirm server and legend ranges.",
      "Step 2. Open Geometry and edit chamber/electrodes/dielectrics/pump tags.",
      "Step 3. Set process knobs in sidebar (Pressure, RF, DC, Gas, Inlet, Pump), then run again.",
      "Step 4. Inspect E-Field, ne, and Power Absorption Density maps (log-scale).",
      "Step 5. Move to Compare, copy A to B, change one or two knobs, and read delta maps/tables.",
    ],
    quickTipsTitle: "Quick Tips",
    quickTips: [
      "Keep geometry tags meaningful (e.g., showerhead, bottom_pump, powered_electrode_surface).",
      "Power Absorption Density is a relative per-volume absorbed-power proxy.",
      "Use View Filters to request only needed layers and reduce runtime.",
    ],
  },
  ko: {
    title: "사용자 가이드 (빠른 시작)",
    intro:
      "처음 사용하는 경우 권장 순서입니다. 기본 케이스를 먼저 돌린 뒤 Geometry/공정 파라미터를 조정하세요.",
    steps: [
      "1단계. Overview에서 기본 조건으로 1회 실행해 서버/범례 범위를 확인합니다.",
      "2단계. Geometry 탭에서 챔버/전극/유전체/펌프 태그를 편집합니다.",
      "3단계. 사이드바에서 Pressure, RF, DC, Gas, Inlet, Pump를 조정 후 재실행합니다.",
      "4단계. E-Field, ne, Power Absorption Density(로그 스케일) 지도를 확인합니다.",
      "5단계. Compare에서 A를 B로 복사 후 1~2개 파라미터만 변경해 Delta를 확인합니다.",
    ],
    quickTipsTitle: "빠른 팁",
    quickTips: [
      "Geometry 태그는 의미 있게 유지하세요 (예: showerhead, bottom_pump, powered_electrode_surface).",
      "Power Absorption Density는 단위부피당 흡수 전력의 상대 proxy입니다.",
      "View Filters에서 필요한 레이어만 선택하면 연산 시간을 줄일 수 있습니다.",
    ],
  },
  ja: {
    title: "ユーザーガイド（クイックスタート）",
    intro:
      "初回利用向けの推奨フローです。まず既定ケースを実行し、その後 Geometry/プロセス条件を調整してください。",
    steps: [
      "Step 1. Overview でベースラインを1回実行し、サーバー状態と凡例レンジを確認します。",
      "Step 2. Geometry でチャンバー/電極/誘電体/ポンプのタグを編集します。",
      "Step 3. サイドバーで Pressure, RF, DC, Gas, Inlet, Pump を調整して再実行します。",
      "Step 4. E-Field, ne, Power Absorption Density（対数スケール）を確認します。",
      "Step 5. Compare で A を B にコピーし、1〜2個の条件変更で Delta を確認します。",
    ],
    quickTipsTitle: "クイックヒント",
    quickTips: [
      "Geometry タグは意味のある名前を維持してください。",
      "Power Absorption Density は単位体積あたり吸収電力の相対 proxy です。",
      "View Filters で必要なレイヤーだけを選ぶと計算時間を削減できます。",
    ],
  },
};

const LANG_LABELS: Record<GuideLang, string> = {
  en: "English",
  ko: "한국어",
  ja: "日本語",
};

const UserGuidePanel = () => {
  const [lang, setLang] = useState<GuideLang>("ko");
  const content = useMemo(() => GUIDE_CONTENT[lang], [lang]);

  return (
    <div className="guide-panel">
      <div className="guide-lang-tabs" role="tablist" aria-label="Guide Language">
        {(Object.keys(LANG_LABELS) as GuideLang[]).map((key) => (
          <button
            key={`guide-lang-${key}`}
            type="button"
            className={`guide-lang-tab ${lang === key ? "active" : ""}`}
            onClick={() => setLang(key)}
          >
            {LANG_LABELS[key]}
          </button>
        ))}
      </div>
      <section className="guide-section">
        <h4>{content.title}</h4>
        <p>{content.intro}</p>
        <ol className="guide-step-list">
          {content.steps.map((step) => (
            <li key={`${lang}-${step}`}>{step}</li>
          ))}
        </ol>
      </section>
      <section className="guide-section guide-note-box">
        <h4>{content.quickTipsTitle}</h4>
        <ul>
          {content.quickTips.map((tip) => (
            <li key={`${lang}-${tip}`}>{tip}</li>
          ))}
        </ul>
      </section>
    </div>
  );
};

export default UserGuidePanel;
