export type GeometryTool = "select" | "rect" | "circle" | "polyline" | "chamber";

export type GeometryRole =
  | "plasma"
  | "solid_wall"
  | "powered_electrode"
  | "ground_electrode"
  | "dielectric"
  | "wafer"
  | "chamber_wall"
  | "showerhead"
  | "pumping_port";

export type GeometryGroup = "structure" | "chamber";

export type GeometryPoint = {
  x: number;
  y: number;
};

export type GeometryMaterial = {
  enabled: boolean;
  epsilon_r: number;
  wall_loss_e: number;
};

type GeometryShapeBase = {
  id: string;
  tag: string;
  label: string;
  color: string;
  strokeWidth: number;
  group: GeometryGroup;
  role: GeometryRole;
  material: GeometryMaterial;
};

export type RectShape = GeometryShapeBase & {
  type: "rect";
  x0: number;
  y0: number;
  x1: number;
  y1: number;
};

export type CircleShape = GeometryShapeBase & {
  type: "circle";
  cx: number;
  cy: number;
  r: number;
};

export type PolygonShape = GeometryShapeBase & {
  type: "polygon";
  points: GeometryPoint[];
};

export type LineShape = GeometryShapeBase & {
  type: "line";
  points: GeometryPoint[];
};

export type GeometryShape = RectShape | CircleShape | PolygonShape | LineShape;
