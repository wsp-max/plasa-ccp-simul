import type { GeometryShape } from "../types/geometry";

export type GeometryOverlayPoint = {
  x: number;
  y: number;
  label?: string;
  color?: string;
};

export type ShapePlanarMetrics = {
  width_mm: number;
  height_mm: number;
  area_proxy_mm2: number;
  loss_density_proxy: number | null;
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

const shapeCenterPoint = (shape: GeometryShape): GeometryOverlayPoint => {
  const b = boundsFromShape(shape);
  return {
    x: 0.5 * (b.x0 + b.x1),
    y: 0.5 * (b.y0 + b.y1),
    label: `${shape.tag || shape.label}`,
    color: shape.color,
  };
};

export const buildGeometryPositionPoints = (
  shapes: GeometryShape[],
  selectedId?: string | null
): GeometryOverlayPoint[] => {
  if (!shapes || shapes.length === 0) {
    return [];
  }

  const selected = selectedId ? shapes.find((shape) => shape.id === selectedId) : undefined;
  const target = selected ?? shapes.find((shape) => shape.group !== "chamber");
  if (!target) {
    return [];
  }

  if (target.type === "rect") {
    const x0 = Math.min(target.x0, target.x1);
    const x1 = Math.max(target.x0, target.x1);
    const y0 = Math.min(target.y0, target.y1);
    const y1 = Math.max(target.y0, target.y1);
    return [
      { x: x0, y: y0, label: "P0", color: target.color },
      { x: x1, y: y0, label: "P1", color: target.color },
      { x: x0, y: y1, label: "P2", color: target.color },
      { x: x1, y: y1, label: "P3", color: target.color },
      { x: 0.5 * (x0 + x1), y: 0.5 * (y0 + y1), label: "C", color: target.color },
    ];
  }

  if (target.type === "circle") {
    return [
      { x: target.cx, y: target.cy, label: "C", color: target.color },
      { x: target.cx + target.r, y: target.cy, label: "R", color: target.color },
    ];
  }

  const vertices = target.points.slice(0, 12).map((point, idx) => ({
    x: point.x,
    y: point.y,
    label: `P${idx}`,
    color: target.color,
  }));
  if (vertices.length > 0) {
    return vertices;
  }
  return [shapeCenterPoint(target)];
};

export const buildShapePlanarMetrics = (
  shape: GeometryShape,
  wallLossValue: number
): ShapePlanarMetrics => {
  const b = boundsFromShape(shape);
  const width_mm = Math.max(0, b.x1 - b.x0);
  const height_mm = Math.max(0, b.y1 - b.y0);
  const area_proxy_mm2 = width_mm * height_mm;
  const validLoss = Number.isFinite(wallLossValue) ? Math.max(0, wallLossValue) : 0;
  const loss_density_proxy =
    area_proxy_mm2 > 1e-9 ? validLoss / area_proxy_mm2 : null;
  return {
    width_mm,
    height_mm,
    area_proxy_mm2,
    loss_density_proxy,
  };
};

