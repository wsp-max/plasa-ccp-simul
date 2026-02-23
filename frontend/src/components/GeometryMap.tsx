import React, { useMemo } from "react";
import Plot from "react-plotly.js";

type GeometryMapProps = {
  title: string;
  regionId?: number[][];
  x?: number[];
  y?: number[];
  legend?: Record<string, string>;
  colors?: Record<string, string>;
};

const fallbackColor = "#c7c9d1";

const GeometryMap = ({
  title,
  regionId,
  x,
  y,
  legend = {},
  colors = {},
}: GeometryMapProps) => {
  const { colorscale, labelGrid, maxId } = useMemo(() => {
    const flat = regionId?.flat() ?? [];
    const max = flat.length > 0 ? Math.max(...flat) : 0;
    const step = 1 / Math.max(1, max + 1);
    const scale: Array<[number, string]> = [];

    for (let id = 0; id <= max; id += 1) {
      const color = colors[String(id)] ?? fallbackColor;
      const start = id * step;
      const end = (id + 1) * step;
      scale.push([start, color], [end, color]);
    }

    const labels = regionId?.map((row) =>
      row.map((id) => legend[String(id)] ?? `region ${id}`)
    );

    return { colorscale: scale, labelGrid: labels, maxId: max };
  }, [regionId, legend, colors]);

  if (!regionId || regionId.length === 0 || !x || !y) {
    return (
      <div className="plot-placeholder">
        <h3>{title}</h3>
        <p>Not available</p>
      </div>
    );
  }

  return (
    <div className="plot-card">
      <h3>{title}</h3>
      <Plot
        data={[
          {
            z: regionId,
            x,
            y,
            type: "heatmap",
            colorscale,
            zmin: 0,
            zmax: maxId,
            zsmooth: false,
            showscale: false,
            customdata: labelGrid,
            hovertemplate:
              "Region: %{customdata}<br>r: %{x:.2f} mm<br>z: %{y:.2f} mm<extra></extra>",
          },
        ]}
        layout={{
          margin: { l: 58, r: 24, t: 14, b: 56 },
          xaxis: { title: { text: "r (mm)", standoff: 12 }, automargin: true },
          yaxis: { title: { text: "z (mm)", standoff: 12 }, automargin: true },
          autosize: true,
        }}
        style={{ width: "100%", height: "100%" }}
        useResizeHandler
      />
    </div>
  );
};

export default GeometryMap;
