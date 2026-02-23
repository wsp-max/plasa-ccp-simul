import React, { useMemo } from "react";
import Plot from "react-plotly.js";
import type { GeometryShape } from "../types/geometry";
import type { GeometryOverlayPoint } from "../utils/geometryOverlayPoints";

type OverlayCurve = {
  x: number[];
  y: number[];
  name?: string;
  color?: string;
  width?: number;
  dash?: "solid" | "dot" | "dash" | "longdash" | "dashdot" | "longdashdot";
};

type OverlayBand = {
  x: number[];
  yTop: number[];
  yBottom: number[];
  name?: string;
  fillColor?: string;
};

type FieldHeatmapProps = {
  title: string;
  z2d?: number[][];
  x?: number[];
  y?: number[];
  colorscale?: string;
  renderMode?: "isoband" | "contour" | "heatmap";
  overlayShapes?: GeometryShape[];
  overlayOpacity?: number;
  showColorScale?: boolean;
  colorbarTitle?: string;
  colorbarTickVals?: number[];
  colorbarTickText?: string[];
  zMin?: number;
  zMax?: number;
  xRange?: [number, number];
  yRange?: [number, number];
  plotRevision?: number | string;
  overlayCurves?: OverlayCurve[];
  overlayBands?: OverlayBand[];
  overlayPoints?: GeometryOverlayPoint[];
};

const FieldHeatmap = ({
  title,
  z2d,
  x,
  y,
  colorscale = "Viridis",
  renderMode = "isoband",
  overlayShapes,
  overlayOpacity = 0.2,
  showColorScale = true,
  colorbarTitle = "",
  colorbarTickVals,
  colorbarTickText,
  zMin,
  zMax,
  xRange,
  yRange,
  plotRevision,
  overlayCurves,
  overlayBands,
  overlayPoints,
}: FieldHeatmapProps) => {
  if (!z2d || z2d.length === 0 || !x || !y) {
    return (
      <div className="plot-placeholder">
        <h3>{title}</h3>
        <p>Not available</p>
      </div>
    );
  }

  const plotShapes = useMemo(() => {
    if (!overlayShapes || overlayShapes.length === 0) {
      return [];
    }
    return overlayShapes.map((shape) => {
      const isChamber = shape.group === "chamber";
      const opacity = overlayOpacity * (isChamber ? 0.5 : 1);
      const strokeMm = shape.strokeWidth ?? 0.8;
      const lineWidth = Math.max(0.7, Number((strokeMm * 1.15).toFixed(2)));
      if (shape.type === "rect") {
        const x0 = Math.min(shape.x0, shape.x1);
        const x1 = Math.max(shape.x0, shape.x1);
        const y0 = Math.min(shape.y0, shape.y1);
        const y1 = Math.max(shape.y0, shape.y1);
        return {
          type: "rect",
          x0,
          x1,
          y0,
          y1,
          line: { color: shape.color, width: lineWidth, dash: isChamber ? "dash" : undefined },
          fillcolor: shape.color,
          opacity,
          layer: "above",
        };
      }
      if (shape.type === "circle") {
        return {
          type: "circle",
          x0: shape.cx - shape.r,
          x1: shape.cx + shape.r,
          y0: shape.cy - shape.r,
          y1: shape.cy + shape.r,
          line: { color: shape.color, width: lineWidth, dash: isChamber ? "dash" : undefined },
          fillcolor: shape.color,
          opacity,
          layer: "above",
        };
      }
      if (shape.type === "polygon") {
        const path = `M ${shape.points.map((point) => `${point.x},${point.y}`).join(" L ")} Z`;
        return {
          type: "path",
          path,
          line: { color: shape.color, width: lineWidth, dash: isChamber ? "dash" : undefined },
          fillcolor: shape.color,
          opacity,
          layer: "above",
        };
      }
      const path = `M ${shape.points.map((point) => `${point.x},${point.y}`).join(" L ")}`;
      return {
        type: "path",
        path,
        line: { color: shape.color, width: lineWidth, dash: isChamber ? "dash" : undefined },
        fillcolor: "rgba(0,0,0,0)",
        opacity,
        layer: "above",
      };
    });
  }, [overlayOpacity, overlayShapes]);

  const useColorRange =
    Number.isFinite(zMin) &&
    Number.isFinite(zMax) &&
    (zMax as number) > (zMin as number);

  const useRange = (range?: [number, number]) => {
    if (!range) {
      return undefined;
    }
    const [a, b] = range;
    if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a) {
      return undefined;
    }
    return [a, b] as [number, number];
  };

  const safeXRange = useRange(xRange);
  const safeYRange = useRange(yRange);

  const traces = useMemo(() => {
    const colorRange = useColorRange
      ? { zmin: zMin as number, zmax: zMax as number }
      : {};
    const hasCustomColorbarTicks =
      Array.isArray(colorbarTickVals) &&
      Array.isArray(colorbarTickText) &&
      colorbarTickVals.length > 1 &&
      colorbarTickVals.length === colorbarTickText.length;
    const colorBar = showColorScale
      ? {
          thickness: 28,
          len: 0.84,
          x: 1.04,
          xpad: 8,
          y: 0.5,
          outlinewidth: 0.8,
          tickfont: { size: 12 },
          title: { text: colorbarTitle },
          ...(hasCustomColorbarTicks
            ? { tickmode: "array", tickvals: colorbarTickVals, ticktext: colorbarTickText }
            : {}),
        }
      : undefined;
    let base: any[] = [];

    if (renderMode === "contour") {
      base = [
        {
          z: z2d,
          x,
          y,
          type: "contour",
          colorscale,
          contours: { coloring: "lines", showlabels: false },
          line: { width: 1 },
          showscale: showColorScale,
          colorbar: colorBar,
          ...colorRange,
        },
      ];
    } else if (renderMode === "isoband") {
      base = [
        {
          z: z2d,
          x,
          y,
          type: "heatmap",
          colorscale,
          zsmooth: "best",
          showscale: showColorScale,
          colorbar: colorBar,
          ...colorRange,
        },
        {
          z: z2d,
          x,
          y,
          type: "contour",
          showscale: false,
          ncontours: 24,
          contours: { coloring: "none", showlabels: false },
          line: { width: 0.55, color: "rgba(14, 29, 40, 0.24)" },
          ...colorRange,
        },
      ];
    } else {
      base = [
        {
          z: z2d,
          x,
          y,
          type: "heatmap",
          colorscale,
          zsmooth: "best",
          showscale: showColorScale,
          colorbar: colorBar,
          ...colorRange,
        },
      ];
    }

    const validBands = (overlayBands ?? []).filter(
      (band) =>
        band.x.length > 1 &&
        band.yTop.length === band.x.length &&
        band.yBottom.length === band.x.length
    );

    const bandTraces = validBands.flatMap((band, idx) => [
      {
        type: "scatter",
        mode: "lines",
        x: band.x,
        y: band.yTop,
        line: { width: 0, color: "rgba(0,0,0,0)" },
        hoverinfo: "skip",
        showlegend: false,
        name: `${band.name ?? `Band ${idx + 1}`} top`,
      },
      {
        type: "scatter",
        mode: "lines",
        x: band.x,
        y: band.yBottom,
        fill: "tonexty",
        fillcolor: band.fillColor ?? "rgba(239, 71, 111, 0.15)",
        line: { width: 0, color: "rgba(0,0,0,0)" },
        hoverinfo: "skip",
        showlegend: false,
        name: band.name ?? `Band ${idx + 1}`,
      },
    ]);

    const validCurves = (overlayCurves ?? []).filter(
      (curve) => curve.x.length > 1 && curve.y.length === curve.x.length
    );

    const curveTraces = validCurves.map((curve, idx) => ({
      type: "scatter",
      mode: "lines",
      x: curve.x,
      y: curve.y,
      name: curve.name ?? `Overlay ${idx + 1}`,
      line: {
        color: curve.color ?? "#ef476f",
        width: curve.width ?? 2,
        dash: curve.dash ?? "solid",
      },
      showlegend: false,
    }));

    const validPoints = (overlayPoints ?? []).filter(
      (point) =>
        Number.isFinite(point.x) &&
        Number.isFinite(point.y)
    );
    const pointTrace =
      validPoints.length > 0
        ? [
            {
              type: "scatter",
              mode: "markers+text",
              x: validPoints.map((point) => point.x),
              y: validPoints.map((point) => point.y),
              text: validPoints.map((point) => point.label ?? ""),
              textposition: "top center",
              textfont: { size: 10, color: "#0a4a66" },
              marker: {
                size: 8,
                color: validPoints.map((point) => point.color ?? "#0a4a66"),
                line: { color: "#ffffff", width: 1 },
                symbol: "circle",
              },
              hovertemplate:
                "%{text}<br>r=%{x:.2f} mm<br>z=%{y:.2f} mm<extra></extra>",
              showlegend: false,
            },
          ]
        : [];

    return [...base, ...bandTraces, ...curveTraces, ...pointTrace];
  }, [
    colorscale,
    overlayBands,
    overlayCurves,
    overlayPoints,
    renderMode,
    showColorScale,
    colorbarTitle,
    colorbarTickText,
    colorbarTickVals,
    useColorRange,
    x,
    y,
    z2d,
    zMax,
    zMin,
  ]);

  const stableRevision =
    plotRevision ?? `${title}:${x.length}x${y.length}:${z2d.length}x${z2d[0]?.length ?? 0}`;

  return (
    <div className="plot-card">
      <h3>{title}</h3>
      <Plot
        key={String(stableRevision)}
        data={traces as any}
        layout={{
          margin: { l: 64, r: 96, t: 18, b: 62 },
          xaxis: safeXRange
            ? { title: { text: "r (mm)", standoff: 12 }, range: safeXRange, automargin: true }
            : { title: { text: "r (mm)", standoff: 12 }, automargin: true },
          yaxis: safeYRange
            ? { title: { text: "z (mm)", standoff: 12 }, range: safeYRange, automargin: true }
            : { title: { text: "z (mm)", standoff: 12 }, automargin: true },
          shapes: plotShapes,
          uirevision: String(stableRevision),
          autosize: true,
        }}
        config={{
          responsive: true,
          displaylogo: false,
        }}
        style={{ width: "100%", height: "100%" }}
        useResizeHandler
      />
    </div>
  );
};

export default FieldHeatmap;
