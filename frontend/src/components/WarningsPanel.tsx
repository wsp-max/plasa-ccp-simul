import React from "react";

type WarningsPanelProps = {
  warnings?: string[];
};

const WarningsPanel = ({ warnings }: WarningsPanelProps) => {
  if (!warnings || warnings.length === 0) {
    return null;
  }

  const deduped = Array.from(new Set(warnings.filter(Boolean)));

  return (
    <div className="warnings">
      <h4>Warnings</h4>
      <ul>
        {deduped.map((msg, idx) => (
          <li key={`${msg}-${idx}`}>{msg}</li>
        ))}
      </ul>
    </div>
  );
};

export default WarningsPanel;
