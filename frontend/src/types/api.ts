export type Grid = {
  r_mm: number[];
  z_mm: number[];
};

export type ProcessConfig = {
  pressure_Pa: number;
  rf_power_W: number;
  frequency_Hz: number;
  dc_bias_V?: number;
  rf_sources?: PlasmaSourceConfig[];
  dc_bias_regions?: DCBiasRegionConfig[];
};

export type PlasmaSourceConfig = {
  name?: string;
  surface_tag?: string | null;
  rf_power_W: number;
  frequency_Hz: number;
  phase_deg?: number;
};

export type DCBiasRegionConfig = {
  target_tag: string;
  dc_bias_V: number;
};

export type OutputSelectionConfig = {
  efield: boolean;
  ne: boolean;
  volume_loss_density: boolean;
  sheath: boolean;
};

export type OutletSinkConfig = {
  type: "sink";
  surface_tag: string;
  strength: number;
  throttle_percent?: number;
  conductance_lps?: number;
  target_pressure_Pa?: number;
  note?: string;
};

export type InletDirection =
  | "normal_inward"
  | "radial_inward"
  | "radial_outward"
  | "diffuse";

export type InletEmitSide = "left" | "center" | "right";

export type GeometryDomain = {
  r_max_mm: number;
  z_max_mm: number;
  nr: number;
  nz: number;
};

export type RegionLegendValue =
  | "plasma"
  | "solid_wall"
  | "powered_electrode"
  | "ground_electrode"
  | "dielectric";

export type GeometryGridPayload = {
  schema: "mask_v1";
  nr: number;
  nz: number;
  region_id: number[][];
  region_legend: Record<string, RegionLegendValue>;
  tag_mask?: Record<string, boolean[][]>;
};

export type GeometryGridSummary = {
  region_type_counts: Record<string, number>;
  tag_counts?: Record<string, number> | null;
};

export type NeSolverMetadata = {
  method: string;
  mu_e: number;
  D_e: number;
  Te_norm: number;
  k_s_wall: number;
  k_s_powered: number;
  lambda_relax: number;
  ionization_gain?: number;
  bulk_loss?: number;
  converged: boolean;
  iterations: number;
  residual: number;
  fallback_used: boolean;
  warnings: string[];
};

export type InsightSummary = {
  e_on_sheath_mean?: number | null;
  e_on_sheath_min?: number | null;
  e_on_sheath_max?: number | null;
  ne_on_sheath_mean?: number | null;
  ne_on_sheath_min?: number | null;
  ne_on_sheath_max?: number | null;
  thickness_mean_mm?: number | null;
  thickness_min_mm?: number | null;
  thickness_max_mm?: number | null;
};

export type FieldGrid = {
  E_mag?: number[][];
  ne?: number[][];
  volume_loss_density?: number[][];
  emission?: number[][];
};

export type SheathMetrics = {
  z_mm_by_r: number[];
  electrode_z_mm_by_r?: number[];
  thickness_mm_by_r?: number[];
  thickness_mean_mm?: number;
  thickness_min_mm?: number;
  thickness_max_mm?: number;
  z_mean_mm?: number;
  z_min_mm?: number;
  z_max_mm?: number;
  warnings?: string[];
};

export type VizCurves = {
  r_mm: number[];
  sheath_z_mm_by_r: number[];
  sheath_thickness_mm_by_r?: number[];
  delta_sheath_z_mm_by_r?: number[];
  delta_sheath_thickness_mm_by_r?: number[];
  warnings?: string[];
};

export type IonProxyCurves = {
  ion_energy_proxy_rel_by_r?: number[];
  ion_flux_proxy_rel_by_r?: number[];
  Te_eV_used?: number;
  Mi_amu_used?: number;
  warnings?: string[];
};

export type SheathInsights = {
  r_mm: number[];
  sheath_z_mm_by_r: number[];
  sheath_thickness_mm_by_r?: number[];
  E_on_sheath_by_r?: number[];
  ne_on_sheath_by_r?: number[];
  summary: InsightSummary;
  warnings?: string[];
};

export type SimulationMetadata = {
  request_id: string;
  eta: number;
  geometry: {
    domain: GeometryDomain;
    tags?: string[];
    grid?: GeometryGridPayload;
  };
  process: ProcessConfig;
  grid_summary?: GeometryGridSummary;
  ne_solver?: NeSolverMetadata;
};

export type Compare = {
  enabled: boolean;
  delta_fields?: FieldGrid;
  delta_sheath_thickness_mm?: number;
  delta_sheath_metrics?: SheathMetrics;
  delta_insights?: SheathInsights;
  delta_ion_proxy?: IonProxyCurves;
};

export type SimulationResult = {
  metadata?: SimulationMetadata;
  grid?: Grid;
  fields?: FieldGrid;
  sheath_metrics?: SheathMetrics;
  insights?: SheathInsights;
  viz?: VizCurves;
  ion_proxy?: IonProxyCurves;
  compare?: Compare;
};

export type SimulationResponse = {
  request_id: string;
  stored: boolean;
  size_bytes?: number;
  result?: SimulationResult | null;
  result_url?: string | null;
};

export type CompareCheckoutSessionCreateRequest = {
  success_url: string;
  cancel_url: string;
};

export type CompareCheckoutSessionCreateResponse = {
  checkout_url: string;
  checkout_session_id: string;
};

export type CompareCheckoutConfirmRequest = {
  checkout_session_id: string;
};

export type CompareAccessStatus = {
  enabled: boolean;
  status: string;
  customer_email?: string | null;
  current_period_end?: string | null;
  message?: string | null;
};

export type AuthUser = {
  id: number;
  email: string;
  role: "user" | "admin";
  compare_access_enabled: boolean;
  compare_access_granted: boolean;
  compare_access_expires_at?: string | null;
  stripe_subscription_status?: string | null;
  created_at: string;
  updated_at: string;
};

export type AuthSessionResponse = {
  user: AuthUser;
};

export type AdminUser = AuthUser & {
  stripe_customer_id?: string | null;
  stripe_subscription_id?: string | null;
};

export type AdminUsersResponse = {
  users: AdminUser[];
};

export type SimulationRequestPayload = {
  meta: { request_id?: string };
  geometry: {
    axisymmetric: boolean;
    coordinate_system: string;
    domain: { r_max_mm: number; z_max_mm: number; nr: number; nz: number };
    tags?: string[];
    grid: {
      schema: "mask_v1";
      nr: number;
      nz: number;
      region_id: number[][];
      region_legend: Record<string, RegionLegendValue>;
      tag_mask?: Record<string, boolean[][]>;
    };
  };
  process: {
    pressure_Pa: number;
    rf_power_W: number;
    frequency_Hz: number;
    dc_bias_V?: number;
    rf_sources?: PlasmaSourceConfig[];
    dc_bias_regions?: DCBiasRegionConfig[];
  };
  gas: { mixture: { species: string; fraction: number }[] };
  flow_boundary: {
    inlet: {
      type: "surface";
      surface_tag: string;
      uniform: boolean;
      total_flow_sccm: number;
      direction?: InletDirection;
      emit_side?: InletEmitSide;
      active_width_percent?: number;
    };
    outlet?: OutletSinkConfig;
    outlets?: OutletSinkConfig[];
    wall_temperature_K?: number;
  };
  material: {
    default: { epsilon_r: number; wall_loss_e: number };
    regions: { target_tag: string; epsilon_r?: number; wall_loss_e?: number }[];
  };
  impedance: { delta_percent: number };
  baseline: { enabled: boolean; baseline_id?: string };
  outputs?: OutputSelectionConfig;
};
