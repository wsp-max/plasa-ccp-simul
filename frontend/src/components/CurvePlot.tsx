import React from "react";
import Plot from "react-plotly.js";

export type CurveSeries = {
  x: number[];
  y: number[];
  name?: string;
  color?: string;
};

type CurvePlotProps = {
  title: string;
  series?: CurveSeries[];
  yLabel?: string;
};

const CurvePlot = ({ title, series, yLabel }: CurvePlotProps) => {
  if (!series || series.length === 0) {
    return (
      <div className="plot-placeholder">
        <h3>{title}</h3>
        <p>Not available</p>
      </div>
    );
  }

  return (
    <div className="plot-card small">
      <h3>{title}</h3>
      <Plot
        data={series.map((curve) => ({
          x: curve.x,
          y: curve.y,
          name: curve.name,
          mode: "lines",
          line: { color: curve.color || "#4c8dff" },
        }))}
        layout={{
          margin: { l: 60, r: 28, t: 30, b: 60 },
          xaxis: { title: { text: "r (mm)", standoff: 12 }, automargin: true },
          yaxis: { title: { text: yLabel || "", standoff: 12 }, automargin: true },
          legend: { orientation: "h", yanchor: "bottom", y: 1.02, xanchor: "left", x: 0 },
          autosize: true,
        }}
        config={{ responsive: true, displaylogo: false }}
        style={{ width: "100%", height: "100%" }}
        useResizeHandler
      />
    </div>
  );
};

export default CurvePlot;
