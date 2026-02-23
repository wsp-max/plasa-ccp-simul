import type { InletEmitSide } from "../components/SidebarControls";
import type { GeometryShape } from "../types/geometry";

const clamp = (value: number, min: number, max: number) =>
  Math.max(min, Math.min(max, value));

const shapeBounds = (shape: GeometryShape) => {
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

export const buildInletIndicatorShape = (
  shapes: GeometryShape[],
  surfaceTag: string,
  emitSide: InletEmitSide,
  activeWidthPercent: number
): GeometryShape | null => {
  const inletShape =
    shapes.find((shape) => shape.tag === surfaceTag && shape.type !== "line") ??
    shapes.find((shape) => shape.role === "showerhead" && shape.type !== "line");
  if (!inletShape) {
    return null;
  }
  const bounds = shapeBounds(inletShape);
  const width = Math.max(bounds.x1 - bounds.x0, 1e-6);
  const height = Math.max(bounds.y1 - bounds.y0, 1e-6);

  const widthFraction = clamp(activeWidthPercent / 100, 0.05, 1.0);
  const segmentWidth = width * widthFraction;
  const maxStart = bounds.x1 - segmentWidth;
  let start = bounds.x0;
  if (emitSide === "center") {
    start = bounds.x0 + 0.5 * (width - segmentWidth);
  } else if (emitSide === "right") {
    start = maxStart;
  }
  const end = clamp(start + segmentWidth, bounds.x0, bounds.x1);
  // Draw on the showerhead emitting face (toward plasma side), not the center line.
  const y = bounds.y0 + 0.08 * height;

  return {
    id: `inlet-indicator-${surfaceTag}`,
    tag: `inlet_indicator_${surfaceTag}`,
    label: "Gas Inlet Zone",
    color: "#ff9f1c",
    strokeWidth: 0.9,
    group: "structure",
    role: "showerhead",
    type: "line",
    points: [
      { x: start, y },
      { x: end, y },
    ],
    material: {
      enabled: false,
      epsilon_r: 1,
      wall_loss_e: 0,
    },
  };
};
