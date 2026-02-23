import type { GeometryShape } from "../types/geometry";

type Domain = { r_max_mm: number; z_max_mm: number };

const defaultMaterial = (enabled: boolean, epsilon = 4.0, wallLoss = 0.2) => ({
  enabled,
  epsilon_r: epsilon,
  wall_loss_e: wallLoss,
});

const flipZ = (z: number, domain: Domain) => domain.z_max_mm - z;

const toBottomOriginShapes = (shapes: GeometryShape[], domain: Domain): GeometryShape[] =>
  shapes.map((shape) => {
    if (shape.type === "rect") {
      return {
        ...shape,
        y0: flipZ(shape.y0, domain),
        y1: flipZ(shape.y1, domain),
      };
    }
    if (shape.type === "circle") {
      return {
        ...shape,
        cy: flipZ(shape.cy, domain),
      };
    }
    return {
      ...shape,
      points: shape.points.map((point) => ({
        x: point.x,
        y: flipZ(point.y, domain),
      })),
    };
  });

export const buildPecvd300mmShapes = (
  domain: Domain,
  options?: {
    waferDiameterMm?: number;
    electrodeGapMm?: number;
  }
): GeometryShape[] => {
  // Literature-inspired 300 mm PECVD parallel-plate style baseline geometry.
  // This is a trend-oriented template (not a certified hardware CAD).
  const waferDiameterMm = Math.max(120, options?.waferDiameterMm ?? 300);
  const electrodeGapMm = Math.max(1, options?.electrodeGapMm ?? 5);

  const marginR = Math.max(22.0, domain.r_max_mm * 0.072);
  const chamberTop = Math.max(12.0, domain.z_max_mm * 0.082);
  const chamberBottom = domain.z_max_mm - Math.max(12.0, domain.z_max_mm * 0.082);
  const chamberLeft = marginR;
  const chamberRight = domain.r_max_mm - marginR;
  const centerX = domain.r_max_mm * 0.5;

  const chamberWidth = chamberRight - chamberLeft;
  const waferWidth = Math.min(waferDiameterMm, chamberWidth * 0.84);
  const stageWidth = Math.min(waferWidth * 1.04, chamberWidth * 0.86);
  const rfWidth = Math.min(waferWidth * 1.10, chamberWidth * 0.90);

  const stageLeft = centerX - stageWidth * 0.5;
  const stageRight = centerX + stageWidth * 0.5;
  const rfLeft = centerX - rfWidth * 0.5;
  const rfRight = centerX + rfWidth * 0.5;

  const stackCenterY = chamberTop + (chamberBottom - chamberTop) * 0.50;
  const stageTop = stackCenterY + Math.max(6.8, domain.z_max_mm * 0.046);
  const stageBottom = stageTop + Math.max(5.2, domain.z_max_mm * 0.032);

  const plasmaGap = Math.max(8.0, Math.min(22.0, electrodeGapMm * 2.0 + 6.0));
  const poweredBottom = stageTop - plasmaGap;
  const poweredTop = poweredBottom - Math.max(1.8, domain.z_max_mm * 0.010);

  const dielectricBottom = poweredTop - Math.max(0.6, domain.z_max_mm * 0.004);
  const dielectricTop = dielectricBottom - Math.max(2.2, domain.z_max_mm * 0.014);

  const showerheadBottom = dielectricTop - Math.max(0.8, domain.z_max_mm * 0.005);
  const showerheadTop = showerheadBottom - Math.max(7.6, domain.z_max_mm * 0.050);

  const postWidth = Math.max(1.8, domain.r_max_mm * 0.0048);
  const postBottom = Math.min(chamberBottom - 2.6, stageBottom + domain.z_max_mm * 0.22);

  return toBottomOriginShapes([
    {
      id: "shape-chamber",
      tag: "chamber",
      label: "Chamber",
      color: "#66a6b8",
      strokeWidth: 0.36,
      group: "chamber",
      role: "plasma",
      type: "polygon",
      points: [
        { x: chamberLeft, y: chamberTop },
        { x: chamberRight, y: chamberTop },
        { x: chamberRight, y: chamberBottom },
        { x: chamberLeft, y: chamberBottom },
      ],
      material: defaultMaterial(false),
    },
    {
      id: "shape-showerhead",
      tag: "showerhead",
      label: "Showerhead Dielectric",
      color: "#4da1de",
      strokeWidth: 0.34,
      group: "structure",
      role: "showerhead",
      type: "rect",
      x0: stageLeft,
      y0: showerheadTop,
      x1: stageRight,
      y1: showerheadBottom,
      material: defaultMaterial(true, 3.9, 0.12),
    },
    {
      id: "shape-dielectric-window",
      tag: "dielectric_block",
      label: "Dielectric Window",
      color: "#8b69c8",
      strokeWidth: 0.32,
      group: "structure",
      role: "dielectric",
      type: "rect",
      x0: rfLeft,
      y0: dielectricTop,
      x1: rfRight,
      y1: dielectricBottom,
      material: defaultMaterial(true, 4.2, 0.16),
    },
    {
      id: "shape-rf-top",
      tag: "powered_electrode_surface",
      label: "RF Electrode",
      color: "#9a4fd1",
      strokeWidth: 0.34,
      group: "structure",
      role: "powered_electrode",
      type: "rect",
      x0: rfLeft,
      y0: poweredTop,
      x1: rfRight,
      y1: poweredBottom,
      material: defaultMaterial(false),
    },
    {
      id: "shape-ground-bottom",
      tag: "ground_stage",
      label: "Ground Stage",
      color: "#9ca8a0",
      strokeWidth: 0.36,
      group: "structure",
      role: "ground_electrode",
      type: "rect",
      x0: stageLeft,
      y0: stageTop,
      x1: stageRight,
      y1: stageBottom,
      material: defaultMaterial(false),
    },
    {
      id: "shape-feed-post",
      tag: "feed_post",
      label: "Feed Post",
      color: "#d6b396",
      strokeWidth: 0.3,
      group: "structure",
      role: "solid_wall",
      type: "rect",
      x0: centerX - postWidth * 0.5,
      y0: stageBottom,
      x1: centerX + postWidth * 0.5,
      y1: postBottom,
      material: defaultMaterial(false),
    },
    {
      id: "shape-bottom-pump-line",
      tag: "bottom_pump",
      label: "Bottom Pump Slot",
      color: "#5f7387",
      strokeWidth: 0.44,
      group: "structure",
      role: "pumping_port",
      type: "line",
      points: [
        { x: centerX - stageWidth * 0.12, y: chamberBottom - 1.1 },
        { x: centerX + stageWidth * 0.12, y: chamberBottom - 1.1 },
      ],
      material: defaultMaterial(false),
    },
  ], domain);
};

export const buildLayerStackExampleShapes = (domain: Domain): GeometryShape[] => {
  const marginR = Math.max(2.0, domain.r_max_mm * 0.08);
  const chamberTop = Math.max(4.0, domain.z_max_mm * 0.18);
  const chamberBottom = domain.z_max_mm - Math.max(4.0, domain.z_max_mm * 0.12);
  const chamberLeft = marginR;
  const chamberRight = domain.r_max_mm - marginR;
  const centerX = domain.r_max_mm * 0.5;
  const stackWidth = (chamberRight - chamberLeft) * 0.92;
  const stackLeft = centerX - stackWidth * 0.5;
  const stackRight = centerX + stackWidth * 0.5;
  const stackCenterY = chamberTop + (chamberBottom - chamberTop) * 0.48;

  const showerheadTop = stackCenterY - 8.2;
  const showerheadBottom = stackCenterY - 4.0;
  const dielectricTop = stackCenterY - 3.2;
  const dielectricBottom = stackCenterY - 1.8;
  const poweredTop = stackCenterY - 1.7;
  const poweredBottom = stackCenterY - 0.2;
  const stageTop = stackCenterY - 0.1;
  const stageBottom = stackCenterY + 4.8;
  const postWidth = Math.max(1.1, domain.r_max_mm * 0.02);
  const postBottom = Math.min(domain.z_max_mm - 1.2, stageBottom + domain.z_max_mm * 0.22);

  return toBottomOriginShapes([
    {
      id: "shape-chamber",
      tag: "chamber",
      label: "Chamber",
      color: "#66a6b8",
      strokeWidth: 0.36,
      group: "chamber",
      role: "plasma",
      type: "polygon",
      points: [
        { x: chamberLeft, y: chamberTop },
        { x: chamberRight, y: chamberTop },
        { x: chamberRight, y: chamberBottom },
        { x: chamberLeft, y: chamberBottom },
      ],
      material: defaultMaterial(false),
    },
    {
      id: "shape-showerhead",
      tag: "showerhead",
      label: "Showerhead Dielectric",
      color: "#4da1de",
      strokeWidth: 0.34,
      group: "structure",
      role: "showerhead",
      type: "rect",
      x0: stackLeft,
      y0: showerheadTop,
      x1: stackRight,
      y1: showerheadBottom,
      material: defaultMaterial(true, 3.9, 0.12),
    },
    {
      id: "shape-dielectric-window",
      tag: "dielectric_block",
      label: "Dielectric Window",
      color: "#8b69c8",
      strokeWidth: 0.32,
      group: "structure",
      role: "dielectric",
      type: "rect",
      x0: stackLeft - 1.2,
      y0: dielectricTop,
      x1: stackRight + 1.2,
      y1: dielectricBottom,
      material: defaultMaterial(true, 4.25, 0.16),
    },
    {
      id: "shape-rf-top",
      tag: "powered_electrode_surface",
      label: "RF Electrode",
      color: "#9a4fd1",
      strokeWidth: 0.34,
      group: "structure",
      role: "powered_electrode",
      type: "rect",
      x0: stackLeft - 2.0,
      y0: poweredTop,
      x1: stackRight + 2.0,
      y1: poweredBottom,
      material: defaultMaterial(false),
    },
    {
      id: "shape-ground-bottom",
      tag: "ground_stage",
      label: "Ground Stage",
      color: "#9ca8a0",
      strokeWidth: 0.36,
      group: "structure",
      role: "ground_electrode",
      type: "rect",
      x0: stackLeft,
      y0: stageTop,
      x1: stackRight,
      y1: stageBottom,
      material: defaultMaterial(false),
    },
    {
      id: "shape-feed-post",
      tag: "feed_post",
      label: "Feed Post",
      color: "#d6b396",
      strokeWidth: 0.3,
      group: "structure",
      role: "solid_wall",
      type: "rect",
      x0: centerX - postWidth * 0.5,
      y0: stageBottom,
      x1: centerX + postWidth * 0.5,
      y1: postBottom,
      material: defaultMaterial(false),
    },
    {
      id: "shape-bottom-pump-line",
      tag: "bottom_pump",
      label: "Bottom Pump Slot",
      color: "#5f7387",
      strokeWidth: 0.44,
      group: "structure",
      role: "pumping_port",
      type: "line",
      points: [
        { x: centerX - stackWidth * 0.12, y: chamberBottom - 0.9 },
        { x: centerX + stackWidth * 0.12, y: chamberBottom - 0.9 },
      ],
      material: defaultMaterial(false),
    },
  ], domain);
};
