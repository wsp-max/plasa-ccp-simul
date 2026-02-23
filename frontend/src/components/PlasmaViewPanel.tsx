import React, { useEffect, useMemo, useState } from "react";
import Plot from "react-plotly.js";
import type { FieldGrid, Grid } from "../types/api";

type PlasmaViewPanelProps = {
  grid?: Grid;
  fields?: FieldGrid;
};

const clampIndex = (value: number, max: number) => Math.max(0, Math.min(value, max));

const sampleIndices = (length: number, maxPoints: number) => {
  if (length <= maxPoints) {
    return Array.from({ length }, (_, idx) => idx);
  }
  const step = (length - 1) / Math.max(1, maxPoints - 1);
  const indices: number[] = [];
  let last = -1;
  for (let i = 0; i < maxPoints; i += 1) {
    const idx = Math.min(length - 1, Math.round(i * step));
    if (idx !== last) {
      indices.push(idx);
      last = idx;
    }
  }
  if (indices[indices.length - 1] !== length - 1) {
    indices.push(length - 1);
  }
  return indices;
};

const quantile = (values: number[], q: number) => {
  if (values.length === 0) {
    return null;
  }
  if (values.length === 1) {
    return values[0];
  }
  const index = (values.length - 1) * q;
  const lo = Math.floor(index);
  const hi = Math.ceil(index);
  if (lo === hi) {
    return values[lo];
  }
  const weight = index - lo;
  return values[lo] * (1 - weight) + values[hi] * weight;
};

const normalize = (values: number[]) => {
  const finite = values.filter((value) => Number.isFinite(value));
  if (finite.length === 0) {
    return values.map(() => 0);
  }
  const maxValue = Math.max(...finite.map((value) => Math.abs(value)));
  if (maxValue <= 1e-12) {
    return values.map(() => 0);
  }
  return values.map((value) => value / maxValue);
};

const PlasmaViewPanel = ({ grid, fields }: PlasmaViewPanelProps) => {
  const rAxis = grid?.r_mm ?? [];
  const zAxis = grid?.z_mm ?? [];
  const hasE = Boolean(fields?.E_mag && fields.E_mag.length > 0 && rAxis.length > 1 && zAxis.length > 1);
  const hasNe = Boolean(fields?.ne && fields.ne.length > 0 && rAxis.length > 1 && zAxis.length > 1);
  const maxZIndex = Math.max(0, zAxis.length - 1);
  const [zIndex, setZIndex] = useState(0);

  useEffect(() => {
    setZIndex((prev) => clampIndex(prev, maxZIndex));
  }, [maxZIndex]);

  const eSurface = useMemo(() => {
    if (!hasE || !fields?.E_mag) {
      return null;
    }
    const rowIdx = sampleIndices(Math.min(zAxis.length, fields.E_mag.length), 70);
    const colIdx = sampleIndices(rAxis.length, 90);
    return {
      x: colIdx.map((idx) => rAxis[idx]),
      y: rowIdx.map((idx) => zAxis[idx]),
      z: rowIdx.map((ri) => colIdx.map((ci) => fields.E_mag?.[ri]?.[ci] ?? 0)),
    };
  }, [fields?.E_mag, hasE, rAxis, zAxis]);

  const neSurface = useMemo(() => {
    if (!hasNe || !fields?.ne) {
      return null;
    }
    const rowIdx = sampleIndices(Math.min(zAxis.length, fields.ne.length), 70);
    const colIdx = sampleIndices(rAxis.length, 90);
    return {
      x: colIdx.map((idx) => rAxis[idx]),
      y: rowIdx.map((idx) => zAxis[idx]),
      z: rowIdx.map((ri) => colIdx.map((ci) => fields.ne?.[ri]?.[ci] ?? 0)),
    };
  }, [fields?.ne, hasNe, rAxis, zAxis]);

  const eSliceRaw = useMemo(() => {
    if (!hasE || !fields?.E_mag) {
      return [];
    }
    const idx = clampIndex(zIndex, fields.E_mag.length - 1);
    return fields.E_mag[idx] ?? [];
  }, [fields?.E_mag, hasE, zIndex]);

  const neSliceRaw = useMemo(() => {
    if (!hasNe || !fields?.ne) {
      return [];
    }
    const idx = clampIndex(zIndex, fields.ne.length - 1);
    return fields.ne[idx] ?? [];
  }, [fields?.ne, hasNe, zIndex]);

  const eSlice = useMemo(() => normalize(eSliceRaw), [eSliceRaw]);
  const neSlice = useMemo(() => normalize(neSliceRaw), [neSliceRaw]);

  const bands = useMemo(() => {
    const buildBands = (matrix?: number[][]) => {
      if (!matrix || matrix.length === 0) {
        return null;
      }
      const width = Math.min(rAxis.length, matrix[0]?.length ?? 0);
      const p10: number[] = [];
      const p50: number[] = [];
      const p90: number[] = [];
      for (let col = 0; col < width; col += 1) {
        const column = matrix
          .map((row) => row[col])
          .filter((value): value is number => Number.isFinite(value))
          .sort((a, b) => a - b);
        p10.push(quantile(column, 0.1) ?? 0);
        p50.push(quantile(column, 0.5) ?? 0);
        p90.push(quantile(column, 0.9) ?? 0);
      }
      return {
        x: rAxis.slice(0, width),
        p10: normalize(p10),
        p50: normalize(p50),
        p90: normalize(p90),
      };
    };
    return {
      e: buildBands(fields?.E_mag),
      ne: buildBands(fields?.ne),
    };
  }, [fields?.E_mag, fields?.ne, rAxis]);

  if (!hasE && !hasNe) {
    return (
      <div className="plot-placeholder">
        <h3>Plasma View</h3>
        <p>Run simulation to open alternate plasma visualization.</p>
      </div>
    );
  }

  return (
    <div className="plasma-view-panel">
      <div className="plasma-view-controls">
        <label htmlFor="plasma-z-slice">z slice for radial profile (mm)</label>
        <input
          id="plasma-z-slice"
          type="range"
          min={0}
          max={maxZIndex}
          value={zIndex}
          onChange={(event) => setZIndex(Number(event.target.value))}
          disabled={maxZIndex <= 0}
        />
        <span>{zAxis[zIndex]?.toFixed(2) ?? "-"} mm</span>
        <span className="plasma-view-note">3D surfaces are downsampled for faster rendering.</span>
      </div>

      <div className="plasma-view-grid">
        <div className="plot-card">
          <h3>|E| 3D Surface</h3>
          {eSurface ? (
            <Plot
              data={[
                {
                  type: "surface",
                  x: eSurface.x,
                  y: eSurface.y,
                  z: eSurface.z,
                  colorscale: "Viridis",
                  showscale: true,
                },
              ]}
              layout={{
                margin: { l: 8, r: 8, t: 10, b: 8 },
                scene: {
                  xaxis: { title: "r (mm)", automargin: true },
                  yaxis: { title: "z (mm)", automargin: true },
                  zaxis: { title: "|E| (arb.)" },
                  camera: { eye: { x: 1.5, y: 1.2, z: 0.9 } },
                },
                autosize: true,
              }}
              style={{ width: "100%", height: "100%" }}
              useResizeHandler
            />
          ) : (
            <p className="plasma-view-empty">|E| not available.</p>
          )}
        </div>

        <div className="plot-card">
          <h3>ne 3D Surface</h3>
          {neSurface ? (
            <Plot
              data={[
                {
                  type: "surface",
                  x: neSurface.x,
                  y: neSurface.y,
                  z: neSurface.z,
                  colorscale: "Cividis",
                  showscale: true,
                },
              ]}
              layout={{
                margin: { l: 8, r: 8, t: 10, b: 8 },
                scene: {
                  xaxis: { title: "r (mm)", automargin: true },
                  yaxis: { title: "z (mm)", automargin: true },
                  zaxis: { title: "ne (norm)" },
                  camera: { eye: { x: 1.5, y: 1.2, z: 0.9 } },
                },
                autosize: true,
              }}
              style={{ width: "100%", height: "100%" }}
              useResizeHandler
            />
          ) : (
            <p className="plasma-view-empty">ne not available.</p>
          )}
        </div>

        <div className="plot-card small">
          <h3>Radial Slice at z = {zAxis[zIndex]?.toFixed(2) ?? "-"} mm</h3>
          <Plot
            data={[
              {
                x: rAxis.slice(0, eSlice.length),
                y: eSlice,
                name: "|E| norm",
                mode: "lines",
                line: { color: "#118ab2", width: 2 },
              },
              {
                x: rAxis.slice(0, neSlice.length),
                y: neSlice,
                name: "ne norm",
                mode: "lines",
                line: { color: "#ef476f", width: 2, dash: "dash" },
              },
            ]}
            layout={{
              margin: { l: 58, r: 24, t: 10, b: 56 },
              xaxis: { title: { text: "r (mm)", standoff: 12 }, automargin: true },
              yaxis: { title: { text: "normalized value", standoff: 12 }, range: [0, 1.05], automargin: true },
              legend: { orientation: "h" },
              autosize: true,
            }}
            style={{ width: "100%", height: "100%" }}
            useResizeHandler
          />
        </div>

        <div className="plot-card small">
          <h3>Radial Percentile Band (z stack)</h3>
          <Plot
            data={[
              ...(bands.e
                ? [
                    {
                      x: bands.e.x,
                      y: bands.e.p90,
                      mode: "lines",
                      line: { width: 0, color: "rgba(17, 138, 178, 0)" },
                      name: "E p90",
                      hoverinfo: "skip",
                    },
                    {
                      x: bands.e.x,
                      y: bands.e.p10,
                      mode: "lines",
                      fill: "tonexty",
                      fillcolor: "rgba(17, 138, 178, 0.18)",
                      line: { width: 0, color: "rgba(17, 138, 178, 0)" },
                      name: "E p10-p90",
                    },
                    {
                      x: bands.e.x,
                      y: bands.e.p50,
                      mode: "lines",
                      line: { color: "#118ab2", width: 2 },
                      name: "E p50",
                    },
                  ]
                : []),
              ...(bands.ne
                ? [
                    {
                      x: bands.ne.x,
                      y: bands.ne.p50,
                      mode: "lines",
                      line: { color: "#ef476f", width: 2, dash: "dash" },
                      name: "ne p50",
                    },
                  ]
                : []),
            ]}
            layout={{
              margin: { l: 58, r: 24, t: 10, b: 56 },
              xaxis: { title: { text: "r (mm)", standoff: 12 }, automargin: true },
              yaxis: { title: { text: "normalized percentile", standoff: 12 }, range: [0, 1.05], automargin: true },
              legend: { orientation: "h" },
              autosize: true,
            }}
            style={{ width: "100%", height: "100%" }}
            useResizeHandler
          />
        </div>
      </div>
    </div>
  );
};

export default PlasmaViewPanel;
