import type { GeometryRole } from "../types/geometry";

export type MaterialPreset = {
  id: string;
  label: string;
  epsilon_r: number;
  wall_loss_e: number;
  roles: GeometryRole[];
};

export const CCP_MATERIAL_PRESETS: MaterialPreset[] = [
  {
    id: "sio2",
    label: "SiO2",
    epsilon_r: 3.9,
    wall_loss_e: 0.16,
    roles: ["dielectric", "solid_wall", "showerhead", "chamber_wall"],
  },
  {
    id: "al2o3",
    label: "Al2O3 (Alumina)",
    epsilon_r: 9.6,
    wall_loss_e: 0.1,
    roles: ["dielectric", "solid_wall", "showerhead", "chamber_wall"],
  },
  {
    id: "aln",
    label: "AlN",
    epsilon_r: 8.8,
    wall_loss_e: 0.08,
    roles: ["dielectric", "solid_wall", "showerhead", "chamber_wall"],
  },
  {
    id: "quartz",
    label: "Quartz",
    epsilon_r: 3.8,
    wall_loss_e: 0.14,
    roles: ["dielectric", "solid_wall", "showerhead"],
  },
  {
    id: "silicon",
    label: "Silicon",
    epsilon_r: 11.7,
    wall_loss_e: 0.12,
    roles: ["dielectric", "ground_electrode", "wafer"],
  },
  {
    id: "al",
    label: "Al",
    epsilon_r: 1.0,
    wall_loss_e: 0.03,
    roles: ["powered_electrode", "ground_electrode", "solid_wall", "wafer", "chamber_wall", "pumping_port"],
  },
  {
    id: "copper",
    label: "Copper",
    epsilon_r: 1.0,
    wall_loss_e: 0.025,
    roles: ["powered_electrode", "ground_electrode", "solid_wall", "wafer", "chamber_wall", "pumping_port"],
  },
  {
    id: "ss316",
    label: "SS316",
    epsilon_r: 1.0,
    wall_loss_e: 0.05,
    roles: ["powered_electrode", "ground_electrode", "solid_wall", "chamber_wall", "pumping_port"],
  },
  {
    id: "tin",
    label: "TiN",
    epsilon_r: 1.0,
    wall_loss_e: 0.04,
    roles: ["powered_electrode", "ground_electrode", "solid_wall", "wafer", "chamber_wall"],
  },
];

const isClose = (a: number, b: number, eps = 1e-3) => Math.abs(a - b) <= eps;

export const findMaterialPresetId = (
  epsilon_r: number,
  wall_loss_e: number,
  role: GeometryRole
) => {
  const preset = CCP_MATERIAL_PRESETS.find(
    (item) =>
      item.roles.includes(role) &&
      isClose(item.epsilon_r, epsilon_r) &&
      isClose(item.wall_loss_e, wall_loss_e)
  );
  return preset?.id ?? "custom";
};
