import type { GeometryShape } from "../types/geometry";
import { buildShapePlanarMetrics } from "./geometryOverlayPoints";

export type VolumeLossDensityRow = {
  id: string;
  tag: string;
  label: string;
  role: string;
  color: string;
  materialEnabled: boolean;
  areaProxyMm2: number;
  volumeLossDensityProxy: number | null;
  centerX: number;
  centerY: number;
};

export type VolumeLossDensityLabel = {
  x: number;
  y: number;
  text: string;
  color?: string;
};

const boundsFromShape = (shape: GeometryShape) => {
  if (shape.type === "rect") {
    return {
      x0: Math.min(shape.x0, shape.x1),
      x1: Math.max(shape.x0, shape.x1),
      y0: Math.min(shape.y0, shape.y1),
      y1: Math.max(shape.y0, shape.y1),
    };
  }
  if (shape.type === "circle") {
    return {
      x0: shape.cx - shape.r,
      x1: shape.cx + shape.r,
      y0: shape.cy - shape.r,
      y1: shape.cy + shape.r,
    };
  }
  const xs = shape.points.map((point) => point.x);
  const ys = shape.points.map((point) => point.y);
  return {
    x0: Math.min(...xs),
    x1: Math.max(...xs),
    y0: Math.min(...ys),
    y1: Math.max(...ys),
  };
};

const toCenter = (shape: GeometryShape) => {
  const b = boundsFromShape(shape);
  return {
    x: 0.5 * (b.x0 + b.x1),
    y: 0.5 * (b.y0 + b.y1),
  };
};

export const buildVolumeLossDensityRows = (
  shapes: GeometryShape[]
): VolumeLossDensityRow[] => {
  return shapes
    .filter((shape) => shape.group !== "chamber")
    .map((shape) => {
      const metrics = buildShapePlanarMetrics(shape, shape.material.wall_loss_e);
      const center = toCenter(shape);
      const density =
        shape.material.enabled &&
        metrics.loss_density_proxy !== null &&
        Number.isFinite(metrics.loss_density_proxy)
          ? metrics.loss_density_proxy
          : null;
      return {
        id: shape.id,
        tag: shape.tag,
        label: shape.label,
        role: shape.role,
        color: shape.color,
        materialEnabled: shape.material.enabled,
        areaProxyMm2: metrics.area_proxy_mm2,
        volumeLossDensityProxy: density,
        centerX: center.x,
        centerY: center.y,
      };
    })
    .sort((a, b) => a.tag.localeCompare(b.tag));
};

export const buildVolumeLossDensityLabels = (
  rows: VolumeLossDensityRow[]
): VolumeLossDensityLabel[] => {
  return rows
    .filter(
      (row) =>
        row.volumeLossDensityProxy !== null &&
        Number.isFinite(row.volumeLossDensityProxy)
    )
    .map((row) => ({
      x: row.centerX,
      y: row.centerY,
      text: `${row.tag} ${row.volumeLossDensityProxy!.toExponential(2)}`,
      color: row.color,
    }));
};
