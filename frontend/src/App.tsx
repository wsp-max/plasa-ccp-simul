import React, { useEffect, useMemo, useRef, useState } from "react";
import type {
  AdminUser,
  AdminUsersResponse,
  AuthSessionResponse,
  AuthUser,
  CompareAccessStatus,
  CompareCheckoutConfirmRequest,
  CompareCheckoutSessionCreateRequest,
  CompareCheckoutSessionCreateResponse,
  GeometryGridPayload,
  IonProxyCurves,
  PlasmaSourceConfig,
  SimulationRequestPayload,
  SimulationResponse,
  SimulationResult,
  VizCurves,
} from "./types/api";
import SidebarControls, {
  DCBiasRegionState,
  InletEmitSide,
  InletDirection,
  PlasmaSourceState,
  PumpPortState,
  SidebarState,
} from "./components/SidebarControls";
import FieldHeatmap from "./components/FieldHeatmap";
import GeometryEditor from "./components/GeometryEditor";
import CurvePlot, { CurveSeries } from "./components/CurvePlot";
import WarningsPanel from "./components/WarningsPanel";
import GeometryMap from "./components/GeometryMap";
import GeometryPreview from "./components/GeometryPreview";
import TheoryPage from "./components/TheoryPage";
import ComparePage from "./components/ComparePage";
import PlasmaViewPanel from "./components/PlasmaViewPanel";
import UserGuidePanel from "./components/UserGuidePanel";
import AuthPanel from "./components/AuthPanel";
import AdminPage from "./components/AdminPage";
import type { GeometryShape } from "./types/geometry";
import { buildLayerStackExampleShapes, buildPecvd300mmShapes } from "./utils/geometryPresets";
import { buildInletIndicatorShape } from "./utils/inletIndicator";
import { buildLegacyCompatiblePayload, shouldRetryWithLegacyOutlet } from "./utils/requestCompat";
import {
  buildVolumeLossDensityResultRows,
} from "./utils/volumeLossDensityResults";
import {
  buildLogColorbarTicks,
  buildLogScaledGrid,
  getFiniteMinMax,
  getPositiveMinMax,
} from "./utils/logScale";

const API_BASE_DEFAULT = import.meta.env.VITE_API_BASE || "/api";
const TORR_TO_PA = 133.322;
const COMPARE_CHECKOUT_SESSION_STORAGE_KEY = "plasmaccp_compare_checkout_session_id";

const PAGE_CONFIG = [
  { key: "simulator", label: "Simulator", hash: "#/" },
  { key: "theory", label: "Theory", hash: "#/theory" },
  { key: "compare", label: "Compare", hash: "#/compare" },
  { key: "admin", label: "Admin", hash: "#/admin" },
] as const;
type PageKey = (typeof PAGE_CONFIG)[number]["key"];

const SITE_BASE_URL = "https://plasmaccp.com";
const SEO_BY_PAGE: Record<PageKey, { title: string; description: string; keywords: string }> = {
  simulator: {
    title: "PlasmaCCP | 2D RF CCP Simulator",
    description:
      "Run a 2D axisymmetric RF CCP plasma simulator with editable geometry, E-Field/ne/Power Absorption Density maps, and sheath trends.",
    keywords:
      "RF CCP simulator, plasma simulation, axisymmetric plasma, E-field map, electron density, power absorption density",
  },
  theory: {
    title: "PlasmaCCP Theory | RF CCP Model Overview",
    description:
      "Review the theory and assumptions behind PlasmaCCP, including field coupling, sheath proxy behavior, and power absorption density interpretation.",
    keywords:
      "RF CCP theory, plasma model assumptions, sheath model, power absorption density theory",
  },
  compare: {
    title: "PlasmaCCP Compare | A/B Plasma Trend Analysis",
    description:
      "Compare Case A and Case B side-by-side with synchronized legends, geometry deltas, and field/result differences for RF CCP process tuning.",
    keywords:
      "plasma compare tool, A/B RF CCP compare, geometry delta, plasma trend analysis, process tuning",
  },
  admin: {
    title: "PlasmaCCP Admin | User and Billing Access",
    description:
      "Manage user accounts, roles, and Compare feature access status for the PlasmaCCP workspace.",
    keywords:
      "plasmaccp admin, user management, billing access, compare access",
  },
};

type SiteInfoKey = "guide" | "about" | "contact" | "privacy" | "terms";

const SITE_INFO_CONTENT: Record<
  SiteInfoKey,
  { title: string; subtitle: string; body: string[] }
> = {
  about: {
    title: "About PlasmaCCP",
    subtitle: "Trend-focused RF CCP simulator for fast process-side iteration.",
    body: [
      "This workspace is designed for trend comparison of geometry, gas mix, pump settings, and RF conditions in axisymmetric CCP reactors.",
      "Outputs are simplified proxy fields for rapid engineering decisions, not certified absolute metrology values.",
      "For detailed absolute plasma analysis and production sign-off, use qualified commercial plasma simulation software.",
      "Use Compare mode to copy Case A into Case B, then perturb one or two knobs and review delta behavior.",
    ],
  },
  guide: {
    title: "User Guide",
    subtitle: "Quick onboarding flow for first-time users.",
    body: [],
  },
  contact: {
    title: "Contact",
    subtitle: "Questions, bug reports, and collaboration requests.",
    body: [
      "For technical issues, include request ID, screenshot, and parameter set used in Simulator/Compare.",
      "For feature requests, provide expected workflow and decision point where the current UI blocks you.",
      "Primary email contact: toughguy0424@gmail.com",
      "Response target is best-effort; critical production issues should include urgency and impact.",
    ],
  },
  privacy: {
    title: "Privacy",
    subtitle: "Data handling notice (updated: February 9, 2026).",
    body: [
      "Simulation inputs and generated results may be logged for stability, debugging, and quality improvement.",
      "Do not upload confidential fab identifiers, customer names, or IP-sensitive process notes.",
      "Operational logs are retained only as needed for service reliability and incident response.",
    ],
  },
  terms: {
    title: "Terms",
    subtitle: "Usage scope and limitations.",
    body: [
      "This simulator provides engineering guidance signals and comparative trends only.",
      "Detailed or certifiable plasma simulation results should be validated with commercial-grade tools and chamber metrology.",
      "You are responsible for validating production settings with qualified process and equipment controls.",
      "Service behavior, limits, and APIs may evolve without prior notice to support reliability and security.",
    ],
  },
};

const TAB_CONFIG = [
  { key: "overview", label: "Overview" },
  { key: "geometry", label: "Geometry" },
  { key: "efield", label: "E-Field" },
  { key: "density", label: "Density" },
  { key: "volume_loss_density", label: "Power Absorption Density" },
  { key: "plasma_view", label: "Plasma View" },
  { key: "diagnostics", label: "Diagnostics" },
] as const;
type TabKey = (typeof TAB_CONFIG)[number]["key"];

const QUICK_START_TAB_KEYS: TabKey[] = ["overview"];
const SETUP_TAB_KEYS: TabKey[] = ["geometry"];
const RESULT_TAB_KEYS: TabKey[] = ["efield", "density", "volume_loss_density", "plasma_view", "diagnostics"];

type SimulatorViewLayerKey = "efield" | "ne" | "volumeLossDensity" | "sheath";

const SIMULATOR_VIEW_LAYER_OPTIONS: { key: SimulatorViewLayerKey; label: string }[] = [
  { key: "efield", label: "E-Field" },
  { key: "ne", label: "ne" },
  { key: "volumeLossDensity", label: "Power Absorption Density" },
  { key: "sheath", label: "Sheath" },
];

const REGION_LEGEND = {
  "0": "plasma",
  "1": "solid_wall",
  "2": "powered_electrode",
  "3": "ground_electrode",
  "4": "dielectric",
} as const;

const REGION_LABEL: Record<string, string> = {
  plasma: "Plasma",
  solid_wall: "Solid Wall",
  powered_electrode: "RF Electrode",
  ground_electrode: "Ground Electrode",
  dielectric: "Dielectric",
};

const REGION_COLOR = {
  "0": "#66a6b8",
  "1": "#6b7280",
  "2": "#eb7c00",
  "3": "#2a9d8f",
  "4": "#7c77b9",
};

const ROLE_TO_REGION_ID = {
  plasma: 0,
  solid_wall: 1,
  chamber_wall: 1,
  powered_electrode: 2,
  ground_electrode: 3,
  wafer: 3,
  dielectric: 4,
  showerhead: 4,
  pumping_port: 1,
} as const;

const DEFAULT_PECVD_DOMAIN = { r_max_mm: 390.0, z_max_mm: 180.0, nr: 144, nz: 176 };

const DEFAULT_PLASMA_SOURCES: PlasmaSourceState[] = [
  {
    id: "src-1",
    name: "CVD RF",
    surface_tag: "powered_electrode_surface",
    rf_power_W: 500.0,
    frequency_Hz: 13_560_000.0,
    phase_deg: 0.0,
  },
];

const DEFAULT_PUMP_PORTS: PumpPortState[] = [
  {
    id: "pump-1",
    surface_tag: "bottom_pump",
    strength: 1.0,
    throttle_percent: 100.0,
    conductance_lps: 220.0,
    target_pressure_Pa: 8.0,
    note: "Main bottom throttle valve",
  },
];

const DEFAULT_FORM: SidebarState = {
  r_max_mm: DEFAULT_PECVD_DOMAIN.r_max_mm,
  z_max_mm: DEFAULT_PECVD_DOMAIN.z_max_mm,
  nr: DEFAULT_PECVD_DOMAIN.nr,
  nz: DEFAULT_PECVD_DOMAIN.nz,
  drawTool: "select",
  snapToGrid: true,
  snapStepMm: 0.5,
  showGeometryOverlay: true,
  geometryOverlayOpacity: 0.2,
  baselineEnabled: true,
  pressure_Torr: 5.0,
  rf_power_W: 500.0,
  frequency_Hz: 13_560_000.0,
  dc_bias_V: 0.0,
  plasmaSources: DEFAULT_PLASMA_SOURCES,
  dcBiasRegions: [],
  gasComponents: [
    { id: "gas-1", species: "Ar", flow_sccm: 5000.0 },
    { id: "gas-2", species: "SiH4", flow_sccm: 200.0 },
  ],
  inletSurfaceTag: "showerhead",
  inletDirection: "normal_inward",
  inletEmitSide: "center",
  inletActiveWidthPercent: 28,
  pumpPorts: DEFAULT_PUMP_PORTS,
  epsilon_r: 4.0,
  wall_loss_e: 0.2,
  impedanceDelta: 5.0,
};

const buildDefaultForm = (): SidebarState => ({
  ...DEFAULT_FORM,
  gasComponents: DEFAULT_FORM.gasComponents.map((gas) => ({ ...gas })),
  plasmaSources: DEFAULT_FORM.plasmaSources.map((source) => ({ ...source })),
  pumpPorts: DEFAULT_FORM.pumpPorts.map((port) => ({ ...port })),
});

const GEOMETRY_TAGS = [
  "showerhead",
  "bottom_pump",
  "powered_electrode_surface",
  "dielectric_block",
  "ground_stage",
  "chamber",
  "plasma",
  "solid_wall",
  "powered_electrode",
  "ground_electrode",
  "dielectric",
];

const readPageFromHash = (): PageKey => {
  const hash = window.location.hash.toLowerCase();
  if (hash.includes("admin")) {
    return "admin";
  }
  if (hash.includes("theory")) {
    return "theory";
  }
  if (hash.includes("compare")) {
    return "compare";
  }
  return "simulator";
};

const normalizeResultUrl = (resultUrl: string) => {
  if (resultUrl.startsWith("http://") || resultUrl.startsWith("https://")) {
    return resultUrl;
  }
  const base = API_BASE_DEFAULT.replace(/\/$/, "");
  if (resultUrl.startsWith("/")) {
    return `${base}${resultUrl}`;
  }
  return `${base}/${resultUrl}`;
};

const buildCompareSuccessUrl = () => {
  const { origin, pathname } = window.location;
  return `${origin}${pathname}?compare_checkout_session_id={CHECKOUT_SESSION_ID}#/compare`;
};

const buildCompareCancelUrl = () => {
  const { origin, pathname } = window.location;
  return `${origin}${pathname}#/compare`;
};

const stripCheckoutSessionParamFromUrl = () => {
  const url = new URL(window.location.href);
  if (!url.searchParams.has("compare_checkout_session_id")) {
    return;
  }
  url.searchParams.delete("compare_checkout_session_id");
  window.history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
};

const formatNumber = (value: number | undefined | null, digits = 3) => {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return "-";
  }
  return value.toFixed(digits);
};

const formatLossDensity = (value: number | undefined | null) => {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return "-";
  }
  return value.toExponential(3);
};

const buildAxis = (max: number, count: number) => {
  if (count <= 1) {
    return [0];
  }
  const step = max / (count - 1);
  return Array.from({ length: count }, (_, idx) => idx * step);
};

const shapeContainsPoint = (shape: GeometryShape, r: number, z: number) => {
  if (shape.type === "rect") {
    const x0 = Math.min(shape.x0, shape.x1);
    const x1 = Math.max(shape.x0, shape.x1);
    const y0 = Math.min(shape.y0, shape.y1);
    const y1 = Math.max(shape.y0, shape.y1);
    return r >= x0 && r <= x1 && z >= y0 && z <= y1;
  }
  if (shape.type === "circle") {
    const dx = r - shape.cx;
    const dz = z - shape.cy;
    return dx * dx + dz * dz <= shape.r * shape.r;
  }
  if (shape.type === "polygon") {
    let inside = false;
    for (let i = 0, j = shape.points.length - 1; i < shape.points.length; j = i++) {
      const xi = shape.points[i].x;
      const yi = shape.points[i].y;
      const xj = shape.points[j].x;
      const yj = shape.points[j].y;
      const intersects = yi > z !== yj > z && r < ((xj - xi) * (z - yi)) / (yj - yi) + xi;
      if (intersects) {
        inside = !inside;
      }
    }
    return inside;
  }
  return false;
};

const pointToSegmentDistance = (
  px: number,
  py: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number
) => {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const len2 = dx * dx + dy * dy;
  if (len2 <= 1e-12) {
    return Math.hypot(px - x0, py - y0);
  }
  const t = Math.max(0, Math.min(1, ((px - x0) * dx + (py - y0) * dy) / len2));
  const cx = x0 + t * dx;
  const cy = y0 + t * dy;
  return Math.hypot(px - cx, py - cy);
};

const lineContainsPoint = (
  points: { x: number; y: number }[],
  r: number,
  z: number,
  tolerance: number
) => {
  if (points.length < 2) {
    return false;
  }
  for (let idx = 1; idx < points.length; idx += 1) {
    const a = points[idx - 1];
    const b = points[idx];
    if (pointToSegmentDistance(r, z, a.x, a.y, b.x, b.y) <= tolerance) {
      return true;
    }
  }
  return false;
};

const buildShapeMasks = (shapes: GeometryShape[], rAxis: number[], zAxis: number[]) => {
  const masks: Record<string, boolean[][]> = {};
  const dr = rAxis.length > 1 ? Math.abs(rAxis[1] - rAxis[0]) : 1;
  const dz = zAxis.length > 1 ? Math.abs(zAxis[1] - zAxis[0]) : 1;
  const lineTolerance = Math.max(0.35, 0.6 * Math.min(dr, dz));
  shapes.forEach((shape) => {
    if (shape.type === "line") {
      masks[shape.tag] = zAxis.map((z) =>
        rAxis.map((r) => lineContainsPoint(shape.points, r, z, lineTolerance))
      );
      return;
    }
    if (shape.type === "polygon" && shape.points.length < 3) {
      return;
    }
    masks[shape.tag] = zAxis.map((z) => rAxis.map((r) => shapeContainsPoint(shape, r, z)));
  });
  return masks;
};

const rolePriority = (role: GeometryShape["role"]) => {
  if (role === "powered_electrode") return 5;
  if (role === "ground_electrode" || role === "wafer") return 4;
  if (role === "dielectric" || role === "showerhead") return 3;
  if (role === "solid_wall" || role === "chamber_wall" || role === "pumping_port") return 2;
  return 1;
};

const buildRegionGrid = (
  domain: { r_max_mm: number; z_max_mm: number; nr: number; nz: number },
  shapes: GeometryShape[]
): GeometryGridPayload => {
  const rAxis = buildAxis(domain.r_max_mm, domain.nr);
  const zAxis = buildAxis(domain.z_max_mm, domain.nz);
  const masks = buildShapeMasks(shapes, rAxis, zAxis);
  const chamberShape = shapes.filter((shape) => shape.group === "chamber").slice(-1)[0];
  const chamberMask = chamberShape ? masks[chamberShape.tag] : null;
  const wallRegion = ROLE_TO_REGION_ID.ground_electrode;

  if (chamberMask) {
    Object.entries(masks).forEach(([tag, mask]) => {
      if (chamberShape && tag === chamberShape.tag) {
        return;
      }
      for (let k = 0; k < domain.nz; k += 1) {
        for (let j = 0; j < domain.nr; j += 1) {
          mask[k][j] = mask[k][j] && chamberMask[k][j];
        }
      }
    });
  }

  const region = zAxis.map((_, k) =>
    rAxis.map((__, j) => (chamberMask ? (chamberMask[k][j] ? ROLE_TO_REGION_ID.plasma : wallRegion) : ROLE_TO_REGION_ID.plasma))
  );

  for (let k = 0; k < domain.nz; k += 1) {
    region[k][0] = wallRegion;
    region[k][domain.nr - 1] = wallRegion;
  }
  for (let j = 0; j < domain.nr; j += 1) {
    region[0][j] = wallRegion;
    region[domain.nz - 1][j] = wallRegion;
  }

  const priority = [...shapes].sort((a, b) => {
    const pa = rolePriority(a.role);
    const pb = rolePriority(b.role);
    return pa - pb;
  });

  priority.forEach((shape) => {
    if (shape.group === "chamber" || shape.type === "line") {
      return;
    }
    const mask = masks[shape.tag];
    if (!mask) {
      return;
    }
    const value = ROLE_TO_REGION_ID[shape.role];
    for (let k = 0; k < domain.nz; k += 1) {
      for (let j = 0; j < domain.nr; j += 1) {
        if (chamberMask && !chamberMask[k][j]) {
          continue;
        }
        if (mask[k][j]) {
          region[k][j] = value;
        }
      }
    }
  });

  return {
    schema: "mask_v1",
    nr: domain.nr,
    nz: domain.nz,
    region_id: region,
    region_legend: REGION_LEGEND,
    tag_mask: masks,
  };
};

const buildGasMixture = (components: SidebarState["gasComponents"]) => {
  const merged = new Map<string, number>();
  components.forEach((component) => {
    const flow = Number.isFinite(component.flow_sccm) ? component.flow_sccm : 0;
    merged.set(component.species, (merged.get(component.species) ?? 0) + Math.max(0, flow));
  });
  const rows = Array.from(merged.entries()).filter(([, flow]) => flow > 0);
  if (rows.length === 0) {
    const fallback = components[0]?.species ?? "Ar";
    return { mixture: [{ species: fallback, fraction: 1.0 }], totalFlow: 0 };
  }
  const totalFlow = rows.reduce((sum, [, flow]) => sum + flow, 0);
  return {
    mixture: rows.map(([species, flow]) => ({ species, fraction: flow / totalFlow })),
    totalFlow,
  };
};

const derivePoweredSurfaceTags = (shapes: GeometryShape[]) =>
  Array.from(
    new Set(
      shapes
        .filter((shape) => shape.group !== "chamber")
        .filter((shape) => shape.type !== "line")
        .filter((shape) => shape.role === "powered_electrode")
        .map((shape) => shape.tag.trim())
        .filter((tag) => tag.length > 0)
    )
  ).sort((a, b) => a.localeCompare(b));

const derivePumpSurfaceTags = (shapes: GeometryShape[]) => {
  const tags = shapes
    .filter((shape) => shape.group !== "chamber")
    .filter((shape) => shape.tag.trim().length > 0)
    .filter(
      (shape) =>
        shape.role === "pumping_port" ||
        shape.tag.toLowerCase().includes("pump") ||
        shape.label.toLowerCase().includes("pump")
    )
    .map((shape) => shape.tag.trim());

  return Array.from(new Set(["bottom_pump", ...tags])).sort((a, b) =>
    a.localeCompare(b)
  );
};

const deriveInletSurfaceTags = (shapes: GeometryShape[]) => {
  const tags = shapes
    .filter((shape) => shape.group !== "chamber")
    .filter((shape) => shape.tag.trim().length > 0)
    .filter(
      (shape) =>
        shape.role === "showerhead" ||
        shape.tag.toLowerCase().includes("shower") ||
        shape.tag.toLowerCase().includes("inlet") ||
        shape.tag.toLowerCase().includes("gas") ||
        shape.label.toLowerCase().includes("shower") ||
        shape.label.toLowerCase().includes("inlet") ||
        shape.label.toLowerCase().includes("gas")
    )
    .map((shape) => shape.tag.trim());

  return Array.from(new Set(["showerhead", ...tags])).sort((a, b) =>
    a.localeCompare(b)
  );
};

const deriveDcBiasTargetTags = (shapes: GeometryShape[]) => {
  const tags = shapes
    .filter((shape) => shape.group !== "chamber")
    .filter((shape) => shape.tag.trim().length > 0)
    .filter((shape) => shape.type !== "line")
    .map((shape) => shape.tag.trim());
  return Array.from(new Set(tags)).sort((a, b) => a.localeCompare(b));
};

const normalizeInletSurfaceTag = (
  currentTag: string,
  inletTags: string[]
) => {
  const requested = currentTag.trim();
  if (inletTags.length === 0) {
    return requested || "showerhead";
  }
  if (requested && inletTags.includes(requested)) {
    return requested;
  }
  return inletTags[0];
};

const normalizeInletDirection = (value: InletDirection): InletDirection => {
  const allowed: InletDirection[] = [
    "normal_inward",
    "radial_inward",
    "radial_outward",
    "diffuse",
  ];
  return allowed.includes(value) ? value : "normal_inward";
};

const normalizeInletEmitSide = (value: InletEmitSide): InletEmitSide => {
  const allowed: InletEmitSide[] = ["left", "center", "right"];
  return allowed.includes(value) ? value : "center";
};

const normalizeInletActiveWidthPercent = (value: number) => {
  if (!Number.isFinite(value)) {
    return 28;
  }
  return Math.max(5, Math.min(100, value));
};

const normalizePlasmaSources = (
  sources: PlasmaSourceState[],
  poweredSurfaceTags: string[],
  fallbackPowerW: number,
  fallbackFrequencyHz: number
): PlasmaSourceState[] => {
  const fallbackTag = poweredSurfaceTags[0] ?? "powered_electrode_surface";
  const normalized = sources.slice(0, 3).map((source, idx) => {
    const requestedTag = source.surface_tag?.trim() ?? "";
    const surfaceTag =
      poweredSurfaceTags.length > 0
        ? poweredSurfaceTags.includes(requestedTag)
          ? requestedTag
          : fallbackTag
        : requestedTag;
    return {
      id: source.id || `src-${idx + 1}`,
      name: source.name?.trim() || `Source ${idx + 1}`,
      surface_tag: surfaceTag,
      rf_power_W: Math.max(0, Number.isFinite(source.rf_power_W) ? source.rf_power_W : 0),
      frequency_Hz: Math.max(
        1,
        Number.isFinite(source.frequency_Hz) ? source.frequency_Hz : fallbackFrequencyHz
      ),
      phase_deg: Math.max(
        -360,
        Math.min(360, Number.isFinite(source.phase_deg) ? source.phase_deg : 0)
      ),
    };
  });

  if (normalized.length > 0) {
    return normalized;
  }

  return [
    {
      id: "src-1",
      name: "Source 1",
      surface_tag: fallbackTag,
      rf_power_W: Math.max(0, fallbackPowerW),
      frequency_Hz: Math.max(1, fallbackFrequencyHz),
      phase_deg: 0,
    },
  ];
};

const summarizePlasmaSources = (sources: PlasmaSourceState[]) => {
  if (sources.length === 0) {
    return {
      totalPowerW: 0,
      effectiveFrequencyHz: 13_560_000,
    };
  }
  const totalPowerW = sources.reduce((sum, source) => sum + Math.max(0, source.rf_power_W), 0);
  if (totalPowerW > 0) {
    const weightedFrequency =
      sources.reduce(
        (sum, source) =>
          sum + Math.max(0, source.rf_power_W) * Math.max(1, source.frequency_Hz),
        0
      ) / totalPowerW;
    return { totalPowerW, effectiveFrequencyHz: weightedFrequency };
  }
  const avgFrequencyHz =
    sources.reduce((sum, source) => sum + Math.max(1, source.frequency_Hz), 0) / sources.length;
  return { totalPowerW, effectiveFrequencyHz: avgFrequencyHz };
};

const normalizePumpPorts = (
  ports: PumpPortState[],
  pumpTags: string[]
): PumpPortState[] => {
  const fallbackTag = pumpTags[0] ?? "bottom_pump";
  const normalized = ports.slice(0, 4).map((port, idx) => {
    const requestedTag = port.surface_tag?.trim() ?? "";
    const surfaceTag =
      pumpTags.length > 0
        ? pumpTags.includes(requestedTag)
          ? requestedTag
          : fallbackTag
        : requestedTag || fallbackTag;
    return {
      id: port.id || `pump-${idx + 1}`,
      surface_tag: surfaceTag,
      strength: Math.max(0, Number.isFinite(port.strength) ? port.strength : 1.0),
      throttle_percent: Math.max(
        0,
        Math.min(100, Number.isFinite(port.throttle_percent) ? port.throttle_percent : 100.0)
      ),
      conductance_lps: Math.max(
        0,
        Number.isFinite(port.conductance_lps) ? port.conductance_lps : 220.0
      ),
      target_pressure_Pa: Math.max(
        0,
        Number.isFinite(port.target_pressure_Pa) ? port.target_pressure_Pa : 8.0
      ),
      note: port.note?.trim() ?? "",
    };
  });

  if (normalized.length > 0) {
    return normalized;
  }

  return [
    {
      id: "pump-1",
      surface_tag: fallbackTag,
      strength: 1.0,
      throttle_percent: 100.0,
      conductance_lps: 220.0,
      target_pressure_Pa: 8.0,
      note: "",
    },
  ];
};

const normalizeDcBiasRegions = (
  regions: DCBiasRegionState[],
  availableTags: string[]
): DCBiasRegionState[] => {
  if (availableTags.length === 0) {
    return [];
  }
  const fallbackTag = availableTags[0];
  return regions
    .slice(0, 16)
    .map((row, idx) => {
      const requestedTag = row.target_tag?.trim() ?? "";
      const target_tag = availableTags.includes(requestedTag)
        ? requestedTag
        : fallbackTag;
      return {
        id: row.id || `dc-bias-${idx + 1}`,
        target_tag,
        dc_bias_V: Math.max(
          -5000,
          Math.min(5000, Number.isFinite(row.dc_bias_V) ? row.dc_bias_V : 0)
        ),
      };
    })
    .filter((row, index, arr) => arr.findIndex((item) => item.id === row.id) === index);
};

const toOutletConfig = (port: PumpPortState) => ({
  type: "sink" as const,
  surface_tag: port.surface_tag,
  strength: port.strength,
  throttle_percent: port.throttle_percent,
  conductance_lps: port.conductance_lps,
  target_pressure_Pa: port.target_pressure_Pa,
  note: port.note || undefined,
});

const toProcessRfSources = (sources: PlasmaSourceState[]): PlasmaSourceConfig[] =>
  sources.map((source) => ({
    name: source.name,
    surface_tag: source.surface_tag || undefined,
    rf_power_W: source.rf_power_W,
    frequency_Hz: source.frequency_Hz,
    phase_deg: source.phase_deg,
  }));

const toProcessDcBiasRegions = (rows: DCBiasRegionState[]) =>
  rows
    .filter((row) => row.target_tag.trim().length > 0)
    .map((row) => ({
      target_tag: row.target_tag,
      dc_bias_V: row.dc_bias_V,
    }));

type OutputSelectionState = {
  efield: boolean;
  ne: boolean;
  volumeLossDensity: boolean;
  sheath: boolean;
};

const buildRequestPayload = (
  state: SidebarState,
  shapes: GeometryShape[],
  outputs?: OutputSelectionState
): SimulationRequestPayload => {
  const domain = { r_max_mm: state.r_max_mm, z_max_mm: state.z_max_mm, nr: state.nr, nz: state.nz };
  const grid = buildRegionGrid(domain, shapes);
  const materialRegions = shapes
    .filter((shape) => shape.group !== "chamber")
    .filter((shape) => shape.type !== "line")
    .filter((shape) => shape.material.enabled)
    .map((shape) => ({
      target_tag: shape.tag,
      epsilon_r: shape.material.epsilon_r,
      wall_loss_e: shape.material.wall_loss_e,
    }));
  const { mixture, totalFlow } = buildGasMixture(state.gasComponents);
  const poweredSurfaceTags = derivePoweredSurfaceTags(shapes);
  const plasmaSources = normalizePlasmaSources(
    state.plasmaSources,
    poweredSurfaceTags,
    state.rf_power_W,
    state.frequency_Hz
  );
  const pumpTags = derivePumpSurfaceTags(shapes);
  const pumpPorts = normalizePumpPorts(state.pumpPorts, pumpTags);
  const dcBiasTags = deriveDcBiasTargetTags(shapes);
  const dcBiasRegions = normalizeDcBiasRegions(state.dcBiasRegions, dcBiasTags);
  const processDcBiasRegions = toProcessDcBiasRegions(dcBiasRegions).filter(
    (row) => Math.abs(row.dc_bias_V) > 1e-9
  );
  const sourceSummary = summarizePlasmaSources(plasmaSources);
  const tags = Array.from(new Set([...GEOMETRY_TAGS, ...shapes.map((shape) => shape.tag)]));
  const outletConfigs = pumpPorts.map(toOutletConfig);
  const outlet = outletConfigs.length <= 1 ? outletConfigs[0] : undefined;
  const outlets = outletConfigs.length > 1 ? outletConfigs : undefined;

  return {
    meta: { request_id: `ui-${Date.now()}` },
    geometry: { axisymmetric: true, coordinate_system: "r-z", domain, tags, grid },
    process: {
      pressure_Pa: state.pressure_Torr * TORR_TO_PA,
      rf_power_W: sourceSummary.totalPowerW,
      frequency_Hz: sourceSummary.effectiveFrequencyHz,
      dc_bias_V: state.dc_bias_V,
      rf_sources: toProcessRfSources(plasmaSources),
      dc_bias_regions: processDcBiasRegions.length > 0 ? processDcBiasRegions : undefined,
    },
    gas: { mixture },
    flow_boundary: {
      inlet: {
        type: "surface",
        surface_tag: state.inletSurfaceTag,
        uniform: true,
        total_flow_sccm: totalFlow,
        direction: state.inletDirection,
        emit_side: state.inletEmitSide,
        active_width_percent: state.inletActiveWidthPercent,
      },
      outlet,
      outlets,
      wall_temperature_K: 300.0,
    },
    material: { default: { epsilon_r: state.epsilon_r, wall_loss_e: state.wall_loss_e }, regions: materialRegions },
    impedance: { delta_percent: state.impedanceDelta },
    baseline: { enabled: state.baselineEnabled },
    outputs: outputs
      ? {
          efield: outputs.efield,
          ne: outputs.ne,
          volume_loss_density: outputs.volumeLossDensity,
          sheath: outputs.sheath,
        }
      : undefined,
  };
};

const buildOverlay = (base?: number[], delta?: number[]) => {
  if (!base || base.length === 0) {
    return { overlay: [] as number[][], deltaCurve: undefined as number[] | undefined };
  }
  if (delta && delta.length === base.length) {
    return { overlay: [base, base.map((value, idx) => value + delta[idx])], deltaCurve: delta };
  }
  return { overlay: [base], deltaCurve: undefined };
};

const toSeries = (x: number[] | undefined, overlay: number[][], names: string[], colors: string[]): CurveSeries[] =>
  !x || x.length === 0
    ? []
    : overlay
        .map((y, idx) => ({ x, y, name: names[idx] || `Series ${idx + 1}`, color: colors[idx] }))
        .filter((curve) => curve.y.length === x.length);

const toDeltaSeries = (x: number[] | undefined, delta?: number[], label = "Delta", color = "#f18f01"): CurveSeries[] =>
  !x || !delta || delta.length !== x.length ? [] : [{ x, y: delta, name: label, color }];

const gatherWarnings = (viz?: VizCurves, ion?: IonProxyCurves, deltaIon?: IonProxyCurves, extra?: string[]) => [
  ...(viz?.warnings || []),
  ...(ion?.warnings || []),
  ...(deltaIon?.warnings || []),
  ...(extra || []),
];

const flattenFinite = (grid?: number[][]) => grid?.flat().filter((v) => Number.isFinite(v)) ?? [];

const quantile = (sortedValues: number[], q: number) => {
  if (sortedValues.length === 0) {
    return null;
  }
  if (sortedValues.length === 1) {
    return sortedValues[0];
  }
  const pos = (sortedValues.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) {
    return sortedValues[lo];
  }
  const w = pos - lo;
  return sortedValues[lo] * (1 - w) + sortedValues[hi] * w;
};

const getSimulatorColorRange = (grid?: number[][], fallbackMax = 1.0) => {
  const values = flattenFinite(grid).filter((value) => value >= 0);
  if (values.length === 0) {
    return { zMin: 0, zMax: fallbackMax };
  }
  const sorted = [...values].sort((a, b) => a - b);
  const p995 = quantile(sorted, 0.995);
  const peak = sorted[sorted.length - 1];
  const maxValue = Math.max(1e-9, p995 ?? peak ?? fallbackMax);
  return { zMin: 0, zMax: maxValue };
};

const cloneShapes = (shapes: GeometryShape[]) =>
  shapes.map((shape) =>
    shape.type === "rect"
      ? { ...shape, material: { ...shape.material } }
      : shape.type === "circle"
        ? { ...shape, material: { ...shape.material } }
        : { ...shape, points: shape.points.map((point) => ({ ...point })), material: { ...shape.material } }
  );

const cloneSidebarState = (state: SidebarState): SidebarState => ({
  ...state,
  gasComponents: state.gasComponents.map((gas) => ({ ...gas })),
  plasmaSources: state.plasmaSources.map((source) => ({ ...source })),
  dcBiasRegions: state.dcBiasRegions.map((region) => ({ ...region })),
  pumpPorts: state.pumpPorts.map((port) => ({ ...port })),
});

const buildTopRfExampleShapes = (domain: { r_max_mm: number; z_max_mm: number }): GeometryShape[] => {
  const marginR = Math.max(1.8, domain.r_max_mm * 0.032);
  const marginZ = Math.max(1.8, domain.z_max_mm * 0.03);
  const width = domain.r_max_mm - marginR * 2;
  const height = domain.z_max_mm - marginZ * 2;
  const topShelfY = marginZ + height * 0.14;
  const rfTopY = topShelfY + 3.2;
  const rfBottomY = topShelfY + 8.8;
  const stageTopY = marginZ + height * 0.74;
  const stageBottomY = stageTopY + 8.8;
  const chamberTop = marginZ + 2.2;
  const chamberBottom = domain.z_max_mm - marginZ - 2.2;
  const chamberLeft = marginR + 1.2;
  const chamberRight = domain.r_max_mm - marginR - 1.2;
  const midX = domain.r_max_mm * 0.5;

  return [
    {
      id: "shape-chamber",
      tag: "chamber",
      label: "Chamber",
      color: "#66a6b8",
      strokeWidth: 0.55,
      group: "chamber",
      role: "plasma",
      type: "polygon",
      points: [
        { x: chamberLeft + 3.0, y: chamberTop },
        { x: chamberRight - 3.0, y: chamberTop },
        { x: chamberRight, y: chamberTop + 5.8 },
        { x: chamberRight, y: chamberBottom - 5.8 },
        { x: chamberRight - 3.0, y: chamberBottom },
        { x: chamberLeft + 3.0, y: chamberBottom },
        { x: chamberLeft, y: chamberBottom - 5.8 },
        { x: chamberLeft, y: chamberTop + 5.8 },
      ],
      material: { enabled: false, epsilon_r: 4.0, wall_loss_e: 0.2 },
    },
    {
      id: "shape-showerhead",
      tag: "showerhead",
      label: "Showerhead Dielectric",
      color: "#8b9db5",
      strokeWidth: 0.58,
      group: "structure",
      role: "showerhead",
      type: "polygon",
      points: [
        { x: marginR + width * 0.18, y: topShelfY - 5.2 },
        { x: marginR + width * 0.82, y: topShelfY - 5.2 },
        { x: marginR + width * 0.78, y: topShelfY + 1.4 },
        { x: marginR + width * 0.22, y: topShelfY + 1.4 },
      ],
      material: { enabled: true, epsilon_r: 3.9, wall_loss_e: 0.12 },
    },
    {
      id: "shape-rf-top",
      tag: "powered_electrode_surface",
      label: "Top RF Electrode",
      color: "#eb7c00",
      strokeWidth: 0.62,
      group: "structure",
      role: "powered_electrode",
      type: "polygon",
      points: [
        { x: marginR + width * 0.14, y: rfTopY },
        { x: marginR + width * 0.86, y: rfTopY },
        { x: marginR + width * 0.82, y: rfBottomY },
        { x: marginR + width * 0.18, y: rfBottomY },
      ],
      material: { enabled: false, epsilon_r: 4.0, wall_loss_e: 0.2 },
    },
    {
      id: "shape-focus-ring",
      tag: "dielectric_focus_ring",
      label: "Dielectric Focus Ring",
      color: "#7c77b9",
      strokeWidth: 0.58,
      group: "structure",
      role: "dielectric",
      type: "circle",
      cx: midX,
      cy: rfBottomY + 8.8,
      r: width * 0.09,
      material: { enabled: true, epsilon_r: 4.25, wall_loss_e: 0.15 },
    },
    {
      id: "shape-ground-bottom",
      tag: "ground_stage",
      label: "Ground Stage",
      color: "#2a9d8f",
      strokeWidth: 0.62,
      group: "structure",
      role: "ground_electrode",
      type: "polygon",
      points: [
        { x: marginR + width * 0.2, y: stageTopY },
        { x: marginR + width * 0.8, y: stageTopY },
        { x: marginR + width * 0.84, y: stageBottomY },
        { x: marginR + width * 0.16, y: stageBottomY },
      ],
      material: { enabled: false, epsilon_r: 4.0, wall_loss_e: 0.2 },
    },
    {
      id: "shape-side-dielectric",
      tag: "dielectric_block",
      label: "Side Dielectric Liner",
      color: "#7c77b9",
      strokeWidth: 0.58,
      group: "structure",
      role: "dielectric",
      type: "polygon",
      points: [
        { x: domain.r_max_mm - marginR - width * 0.095, y: marginZ + 10 },
        { x: domain.r_max_mm - marginR - width * 0.02, y: marginZ + 12.5 },
        { x: domain.r_max_mm - marginR - width * 0.02, y: domain.z_max_mm - marginZ - 11.5 },
        { x: domain.r_max_mm - marginR - width * 0.095, y: domain.z_max_mm - marginZ - 9.5 },
      ],
      material: { enabled: true, epsilon_r: 4.2, wall_loss_e: 0.16 },
    },
    {
      id: "shape-side-shield",
      tag: "ground_side_shield",
      label: "Ground Side Shield",
      color: "#2a9d8f",
      strokeWidth: 0.56,
      group: "structure",
      role: "ground_electrode",
      type: "rect",
      x0: marginR + width * 0.035,
      y0: marginZ + 13,
      x1: marginR + width * 0.07,
      y1: domain.z_max_mm - marginZ - 13,
      material: { enabled: false, epsilon_r: 4.0, wall_loss_e: 0.2 },
    },
    {
      id: "shape-bottom-pump-line",
      tag: "bottom_pump",
      label: "Bottom Pump Slot",
      color: "#5f7387",
      strokeWidth: 0.68,
      group: "structure",
      role: "pumping_port",
      type: "line",
      points: [
        { x: marginR + width * 0.33, y: domain.z_max_mm - marginZ - 2.35 },
        { x: marginR + width * 0.67, y: domain.z_max_mm - marginZ - 2.35 },
      ],
      material: { enabled: false, epsilon_r: 4.0, wall_loss_e: 0.2 },
    },
  ];
};

const App = () => {
  const [page, setPage] = useState<PageKey>(() => readPageFromHash());
  const [siteInfoKey, setSiteInfoKey] = useState<SiteInfoKey | null>(null);
  const [activeTab, setActiveTab] = useState<TabKey>("overview");
  const [fieldRenderMode, setFieldRenderMode] = useState<"isoband" | "contour">("isoband");
  const [colorScaleMode, setColorScaleMode] = useState<"log" | "linear">("linear");
  const [simViewLayers, setSimViewLayers] = useState<Record<SimulatorViewLayerKey, boolean>>({
    efield: true,
    ne: true,
    volumeLossDensity: true,
    sheath: true,
  });
  const [isRunning, setIsRunning] = useState(false);
  const [compareRunning, setCompareRunning] = useState(false);
  const [authUser, setAuthUser] = useState<AuthUser | null>(null);
  const [authLoading, setAuthLoading] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [adminUsers, setAdminUsers] = useState<AdminUser[]>([]);
  const [adminLoading, setAdminLoading] = useState(false);
  const [adminError, setAdminError] = useState<string | null>(null);
  const [compareAccess, setCompareAccess] = useState<CompareAccessStatus | null>(null);
  const [compareBillingLoading, setCompareBillingLoading] = useState(false);
  const [compareCheckoutLoading, setCompareCheckoutLoading] = useState(false);
  const [compareBillingError, setCompareBillingError] = useState<string | null>(null);
  const simulatorAbortRef = useRef<AbortController | null>(null);
  const [result, setResult] = useState<SimulationResult | null>(null);
  const [responseMeta, setResponseMeta] = useState<SimulationResponse | null>(null);
  const [apiError, setApiError] = useState<string | null>(null);
  const [formState, setFormState] = useState<SidebarState>(() => buildDefaultForm());
  const [geometryShapes, setGeometryShapes] = useState<GeometryShape[]>(() =>
    buildPecvd300mmShapes(DEFAULT_PECVD_DOMAIN, { waferDiameterMm: 300, electrodeGapMm: 5 })
  );
  const [selectedShapeId, setSelectedShapeId] = useState<string | null>("shape-rf-top");
  const [lastGeometryShapes, setLastGeometryShapes] = useState<GeometryShape[] | null>(null);
  const showEField = simViewLayers.efield;
  const showNe = simViewLayers.ne;
  const showVolumeLossDensity = simViewLayers.volumeLossDensity;
  const showSheath = simViewLayers.sheath;
  const rfSurfaceTagOptions = useMemo(() => derivePoweredSurfaceTags(geometryShapes), [geometryShapes]);
  const inletSurfaceTagOptions = useMemo(
    () => deriveInletSurfaceTags(geometryShapes),
    [geometryShapes]
  );
  const pumpSurfaceTagOptions = useMemo(() => derivePumpSurfaceTags(geometryShapes), [geometryShapes]);
  const dcBiasTagOptions = useMemo(() => deriveDcBiasTargetTags(geometryShapes), [geometryShapes]);

  useEffect(() => {
    const onHashChange = () => setPage(readPageFromHash());
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  const readErrorDetail = (body: unknown, fallback: string) => {
    if (body && typeof body === "object" && "detail" in body && typeof body.detail === "string") {
      return body.detail;
    }
    return fallback;
  };

  const refreshAuthUser = async (options?: { suppressError?: boolean }) => {
    setAuthLoading(true);
    if (!options?.suppressError) {
      setAuthError(null);
    }
    try {
      const response = await fetch(`${API_BASE_DEFAULT}/auth/me`, {
        credentials: "include",
      });
      if (response.status === 401) {
        setAuthUser(null);
        return null;
      }
      const body = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(readErrorDetail(body, `Auth check failed (${response.status}).`));
      }
      const session = body as AuthSessionResponse;
      setAuthUser(session.user);
      return session.user;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to load auth session.";
      if (!options?.suppressError) {
        setAuthError(message);
      }
      return null;
    } finally {
      setAuthLoading(false);
    }
  };

  const handleAuthLogin = async (email: string, password: string) => {
    setAuthLoading(true);
    setAuthError(null);
    try {
      const response = await fetch(`${API_BASE_DEFAULT}/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ email, password }),
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(readErrorDetail(body, `Login failed (${response.status}).`));
      }
      const session = body as AuthSessionResponse;
      setAuthUser(session.user);
      setCompareBillingError(null);
      setCompareAccess(null);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Login failed.";
      setAuthError(message);
    } finally {
      setAuthLoading(false);
    }
  };

  const handleAuthRegister = async (email: string, password: string) => {
    setAuthLoading(true);
    setAuthError(null);
    try {
      const response = await fetch(`${API_BASE_DEFAULT}/auth/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ email, password }),
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(readErrorDetail(body, `Register failed (${response.status}).`));
      }
      const session = body as AuthSessionResponse;
      setAuthUser(session.user);
      setCompareBillingError(null);
      setCompareAccess(null);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Register failed.";
      setAuthError(message);
    } finally {
      setAuthLoading(false);
    }
  };

  const handleAuthLogout = async () => {
    setAuthLoading(true);
    setAuthError(null);
    try {
      await fetch(`${API_BASE_DEFAULT}/auth/logout`, {
        method: "POST",
        credentials: "include",
      });
      setAuthUser(null);
      setCompareAccess(null);
      setAdminUsers([]);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Logout failed.";
      setAuthError(message);
    } finally {
      setAuthLoading(false);
    }
  };

  const loadCompareAccessStatus = async (options?: { suppressError?: boolean }) => {
    if (!authUser) {
      setCompareAccess(null);
      return null;
    }
    setCompareBillingLoading(true);
    if (!options?.suppressError) {
      setCompareBillingError(null);
    }
    try {
      const response = await fetch(`${API_BASE_DEFAULT}/billing/compare/access`, {
        credentials: "include",
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) {
        if (response.status === 401) {
          setAuthUser(null);
        }
        throw new Error(readErrorDetail(body, `Compare status check failed (${response.status}).`));
      }
      const next = body as CompareAccessStatus;
      setCompareAccess(next);
      void refreshAuthUser({ suppressError: true });
      return next;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to verify Compare status.";
      if (!options?.suppressError) {
        setCompareBillingError(message);
      }
      return null;
    } finally {
      setCompareBillingLoading(false);
    }
  };

  const confirmCompareCheckout = async (
    checkoutSessionId: string,
    options?: { suppressError?: boolean }
  ) => {
    const trimmed = checkoutSessionId.trim();
    if (!trimmed) {
      return null;
    }
    if (!authUser) {
      if (!options?.suppressError) {
        setCompareBillingError("Login is required before verifying payment.");
      }
      return null;
    }
    setCompareBillingLoading(true);
    if (!options?.suppressError) {
      setCompareBillingError(null);
    }
    try {
      const payload: CompareCheckoutConfirmRequest = { checkout_session_id: trimmed };
      const response = await fetch(`${API_BASE_DEFAULT}/billing/compare/confirm`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(payload),
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(readErrorDetail(body, `Checkout verify failed (${response.status}).`));
      }
      const next = body as CompareAccessStatus;
      setCompareAccess(next);
      if (next.enabled) {
        localStorage.removeItem(COMPARE_CHECKOUT_SESSION_STORAGE_KEY);
      }
      await refreshAuthUser({ suppressError: true });
      return next;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to confirm checkout.";
      if (!options?.suppressError) {
        setCompareBillingError(message);
      }
      return null;
    } finally {
      setCompareBillingLoading(false);
    }
  };

  const verifySavedCompareAccess = async () => {
    const savedSessionId = localStorage.getItem(COMPARE_CHECKOUT_SESSION_STORAGE_KEY);
    if (!savedSessionId) {
      setCompareBillingError("No checkout session found. Start checkout first.");
      return null;
    }
    return confirmCompareCheckout(savedSessionId);
  };

  const startCompareCheckout = async () => {
    if (!authUser) {
      setCompareBillingError("Login is required before starting checkout.");
      return;
    }
    setCompareCheckoutLoading(true);
    setCompareBillingError(null);
    try {
      const payload: CompareCheckoutSessionCreateRequest = {
        success_url: buildCompareSuccessUrl(),
        cancel_url: buildCompareCancelUrl(),
      };
      const response = await fetch(`${API_BASE_DEFAULT}/billing/compare/checkout-session`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(payload),
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(readErrorDetail(body, `Compare checkout creation failed (${response.status}).`));
      }
      const result = body as CompareCheckoutSessionCreateResponse;
      if (!result.checkout_url || !result.checkout_session_id) {
        throw new Error("Stripe checkout response is missing required fields.");
      }
      localStorage.setItem(COMPARE_CHECKOUT_SESSION_STORAGE_KEY, result.checkout_session_id);
      window.location.href = result.checkout_url;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to start Compare checkout.";
      setCompareBillingError(message);
    } finally {
      setCompareCheckoutLoading(false);
    }
  };

  const fetchAdminUsers = async (options?: { suppressError?: boolean }) => {
    if (authUser?.role !== "admin") {
      setAdminUsers([]);
      return;
    }
    setAdminLoading(true);
    if (!options?.suppressError) {
      setAdminError(null);
    }
    try {
      const response = await fetch(`${API_BASE_DEFAULT}/admin/users`, {
        credentials: "include",
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(readErrorDetail(body, `Admin users load failed (${response.status}).`));
      }
      const data = body as AdminUsersResponse;
      setAdminUsers(data.users || []);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to load admin users.";
      if (!options?.suppressError) {
        setAdminError(message);
      }
    } finally {
      setAdminLoading(false);
    }
  };

  const updateAdminUser = async (
    userId: number,
    payload: { role?: "user" | "admin"; compare_access_enabled?: boolean; compare_access_expires_at?: string }
  ) => {
    setAdminLoading(true);
    setAdminError(null);
    try {
      const response = await fetch(`${API_BASE_DEFAULT}/admin/users/${userId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(payload),
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(readErrorDetail(body, `User update failed (${response.status}).`));
      }
      const updated = body as AdminUser;
      setAdminUsers((prev) => prev.map((item) => (item.id === updated.id ? updated : item)));
      if (authUser && updated.id === authUser.id) {
        await refreshAuthUser({ suppressError: true });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to update user.";
      setAdminError(message);
    } finally {
      setAdminLoading(false);
    }
  };

  useEffect(() => {
    const url = new URL(window.location.href);
    const sessionFromUrl = url.searchParams.get("compare_checkout_session_id")?.trim() ?? "";
    if (sessionFromUrl) {
      localStorage.setItem(COMPARE_CHECKOUT_SESSION_STORAGE_KEY, sessionFromUrl);
      stripCheckoutSessionParamFromUrl();
    }
    void refreshAuthUser({ suppressError: true });
  }, []);

  useEffect(() => {
    if (!authUser) {
      setCompareAccess(null);
      return;
    }
    const savedSessionId = localStorage.getItem(COMPARE_CHECKOUT_SESSION_STORAGE_KEY);
    if (savedSessionId) {
      void confirmCompareCheckout(savedSessionId, { suppressError: true });
      return;
    }
    void loadCompareAccessStatus({ suppressError: true });
  }, [authUser?.id]);

  useEffect(() => {
    if (page === "admin" && authUser?.role === "admin") {
      void fetchAdminUsers({ suppressError: true });
    }
  }, [page, authUser?.role]);

  useEffect(() => {
    const seo = SEO_BY_PAGE[page];
    const pageHash = PAGE_CONFIG.find((item) => item.key === page)?.hash ?? "#/";
    const pageUrl = pageHash === "#/" ? `${SITE_BASE_URL}/` : `${SITE_BASE_URL}/${pageHash}`;

    const upsertMeta = (attr: "name" | "property", key: string, content: string) => {
      let node = document.head.querySelector(`meta[${attr}="${key}"]`) as HTMLMetaElement | null;
      if (!node) {
        node = document.createElement("meta");
        node.setAttribute(attr, key);
        document.head.appendChild(node);
      }
      node.setAttribute("content", content);
    };

    document.title = seo.title;
    upsertMeta("name", "description", seo.description);
    upsertMeta("name", "keywords", seo.keywords);
    upsertMeta("property", "og:title", seo.title);
    upsertMeta("property", "og:description", seo.description);
    upsertMeta("property", "og:url", pageUrl);
    upsertMeta("name", "twitter:title", seo.title);
    upsertMeta("name", "twitter:description", seo.description);

    const canonical = document.head.querySelector('link[rel="canonical"]') as HTMLLinkElement | null;
    if (canonical) {
      canonical.href = `${SITE_BASE_URL}/`;
    }

    const ldId = "seo-page-jsonld";
    const payload = {
      "@context": "https://schema.org",
      "@type": "WebPage",
      name: seo.title,
      description: seo.description,
      url: pageUrl,
      isPartOf: {
        "@type": "WebSite",
        name: "PlasmaCCP",
        url: `${SITE_BASE_URL}/`,
      },
    };
    let ldNode = document.getElementById(ldId) as HTMLScriptElement | null;
    if (!ldNode) {
      ldNode = document.createElement("script");
      ldNode.id = ldId;
      ldNode.type = "application/ld+json";
      document.head.appendChild(ldNode);
    }
    ldNode.text = JSON.stringify(payload);
  }, [page]);

  useEffect(() => {
    if (!siteInfoKey) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setSiteInfoKey(null);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [siteInfoKey]);

  useEffect(() => {
    setFormState((prev) => {
      const normalizedSources = normalizePlasmaSources(
        prev.plasmaSources,
        rfSurfaceTagOptions,
        prev.rf_power_W,
        prev.frequency_Hz
      );
      const normalizedPumpPorts = normalizePumpPorts(prev.pumpPorts, pumpSurfaceTagOptions);
      const normalizedInletSurfaceTag = normalizeInletSurfaceTag(
        prev.inletSurfaceTag,
        inletSurfaceTagOptions
      );
      const normalizedInletDirection = normalizeInletDirection(prev.inletDirection);
      const normalizedInletEmitSide = normalizeInletEmitSide(prev.inletEmitSide);
      const normalizedInletActiveWidthPercent = normalizeInletActiveWidthPercent(
        prev.inletActiveWidthPercent
      );
      const normalizedDcBiasRegions = normalizeDcBiasRegions(
        prev.dcBiasRegions,
        dcBiasTagOptions
      );
      const unchanged =
        prev.plasmaSources.length === normalizedSources.length &&
        prev.plasmaSources.every((source, idx) => {
          const next = normalizedSources[idx];
          return (
            source.id === next.id &&
            source.name === next.name &&
            source.surface_tag === next.surface_tag &&
            source.rf_power_W === next.rf_power_W &&
            source.frequency_Hz === next.frequency_Hz &&
            source.phase_deg === next.phase_deg
          );
        }) &&
        prev.pumpPorts.length === normalizedPumpPorts.length &&
        prev.pumpPorts.every((port, idx) => {
          const next = normalizedPumpPorts[idx];
          return (
            port.id === next.id &&
            port.surface_tag === next.surface_tag &&
            port.strength === next.strength &&
            port.throttle_percent === next.throttle_percent &&
            port.conductance_lps === next.conductance_lps &&
            port.target_pressure_Pa === next.target_pressure_Pa &&
            port.note === next.note
          );
        }) &&
        prev.dcBiasRegions.length === normalizedDcBiasRegions.length &&
        prev.dcBiasRegions.every((row, idx) => {
          const next = normalizedDcBiasRegions[idx];
          return (
            row.id === next.id &&
            row.target_tag === next.target_tag &&
            row.dc_bias_V === next.dc_bias_V
          );
        }) &&
        prev.inletSurfaceTag === normalizedInletSurfaceTag &&
        prev.inletDirection === normalizedInletDirection &&
        prev.inletEmitSide === normalizedInletEmitSide &&
        prev.inletActiveWidthPercent === normalizedInletActiveWidthPercent;
      if (unchanged) {
        return prev;
      }
      const sourceSummary = summarizePlasmaSources(normalizedSources);
      return {
        ...prev,
        plasmaSources: normalizedSources,
        inletSurfaceTag: normalizedInletSurfaceTag,
        inletDirection: normalizedInletDirection,
        inletEmitSide: normalizedInletEmitSide,
        inletActiveWidthPercent: normalizedInletActiveWidthPercent,
        pumpPorts: normalizedPumpPorts,
        dcBiasRegions: normalizedDcBiasRegions,
        rf_power_W: sourceSummary.totalPowerW,
        frequency_Hz: sourceSummary.effectiveFrequencyHz,
      };
    });
  }, [dcBiasTagOptions, inletSurfaceTagOptions, pumpSurfaceTagOptions, rfSurfaceTagOptions]);

  const goPage = (next: PageKey) => {
    if (next === "admin" && authUser?.role !== "admin") {
      const simulatorConf = PAGE_CONFIG.find((item) => item.key === "simulator");
      if (simulatorConf && window.location.hash !== simulatorConf.hash) {
        window.location.hash = simulatorConf.hash;
      }
      setPage("simulator");
      return;
    }
    const conf = PAGE_CONFIG.find((item) => item.key === next);
    if (conf && window.location.hash !== conf.hash) {
      window.location.hash = conf.hash;
    }
    setPage(next);
  };
  const goHome = () => {
    goPage("simulator");
    setActiveTab("overview");
    setSiteInfoKey(null);
  };

  useEffect(() => {
    if (page === "admin" && authUser?.role !== "admin") {
      goPage("simulator");
    }
  }, [page, authUser?.role]);

  const loadTopRfExample = () => {
    setFormState(buildDefaultForm());
    setGeometryShapes(buildPecvd300mmShapes(DEFAULT_PECVD_DOMAIN, { waferDiameterMm: 300, electrodeGapMm: 5 }));
    setSelectedShapeId("shape-rf-top");
    setLastGeometryShapes(null);
    setResult(null);
    setResponseMeta(null);
    setApiError(null);
    setActiveTab("overview");
  };
  const loadLayerStackExample = () => {
    setFormState(buildDefaultForm());
    setGeometryShapes(buildLayerStackExampleShapes(DEFAULT_PECVD_DOMAIN));
    setSelectedShapeId("shape-rf-top");
    setLastGeometryShapes(null);
    setResult(null);
    setResponseMeta(null);
    setApiError(null);
    setActiveTab("overview");
  };

  const handleAbortSimulator = () => {
    if (simulatorAbortRef.current) {
      simulatorAbortRef.current.abort();
      simulatorAbortRef.current = null;
    }
  };

  const handleRun = async (payload: SimulationRequestPayload) => {
    if (isRunning) {
      handleAbortSimulator();
      return;
    }

    const controller = new AbortController();
    simulatorAbortRef.current = controller;
    setIsRunning(true);
    setApiError(null);
    try {
      setLastGeometryShapes(geometryShapes.map((shape) => ({ ...shape, material: { ...shape.material } })));
      const postSimulation = (requestPayload: SimulationRequestPayload) =>
        fetch(`${API_BASE_DEFAULT}/simulate?mode=poisson_v1`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(requestPayload),
          signal: controller.signal,
        });
      let response = await postSimulation(payload);
      if (!response.ok) {
        const msg = await response.text();
        if (shouldRetryWithLegacyOutlet(response.status, msg)) {
          response = await postSimulation(buildLegacyCompatiblePayload(payload));
        } else {
          setApiError(`HTTP ${response.status}: ${msg || response.statusText || "Request failed"}`);
          setResult(null);
          return;
        }
      }
      if (!response.ok) {
        const msg = await response.text();
        setApiError(`HTTP ${response.status}: ${msg || response.statusText || "Request failed"}`);
        setResult(null);
        return;
      }
      const data = (await response.json()) as SimulationResponse;
      setResponseMeta(data);
      if (data.stored && data.result_url) {
        const stored = await fetch(normalizeResultUrl(data.result_url), {
          signal: controller.signal,
        });
        if (!stored.ok) {
          const msg = await stored.text();
          setApiError(`HTTP ${stored.status}: ${msg || stored.statusText || "Failed to load stored result"}`);
          setResult(null);
          return;
        }
        setResult((await stored.json()) as SimulationResult);
      } else {
        setResult(data.result ?? null);
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        setApiError("Simulation aborted by user.");
        return;
      }
      setApiError(error instanceof Error ? error.message : "Simulation failed");
      setResult(null);
    } finally {
      if (simulatorAbortRef.current === controller) {
        simulatorAbortRef.current = null;
      }
      setIsRunning(false);
    }
  };

  useEffect(
    () => () => {
      if (simulatorAbortRef.current) {
        simulatorAbortRef.current.abort();
        simulatorAbortRef.current = null;
      }
    },
    []
  );

  const payloadPreview = useMemo(
    () => buildRequestPayload(formState, geometryShapes, simViewLayers),
    [formState, geometryShapes, simViewLayers]
  );
  const grid = result?.grid;
  const fields = result?.fields;
  const viz = result?.viz;
  const ionProxy = result?.ion_proxy;
  const compare = result?.compare;
  const sheathMetrics = result?.sheath_metrics;
  const insights = result?.insights;
  const metadata = result?.metadata;
  const rAxis = viz?.r_mm || grid?.r_mm;

  const regionGrid = (metadata?.geometry.grid ?? payloadPreview.geometry.grid) as GeometryGridPayload;
  const regionDomain = metadata?.geometry.domain ?? payloadPreview.geometry.domain;
  const regionXAxis = useMemo(() => buildAxis(regionDomain.r_max_mm, regionGrid.nr ?? regionDomain.nr), [regionDomain, regionGrid]);
  const regionYAxis = useMemo(() => buildAxis(regionDomain.z_max_mm, regionGrid.nz ?? regionDomain.nz), [regionDomain, regionGrid]);
  const regionLegend = regionGrid?.region_legend ?? REGION_LEGEND;
  const regionLabelMap = useMemo(() => {
    const labels: Record<string, string> = {};
    Object.entries(regionLegend).forEach(([id, value]) => {
      labels[id] = REGION_LABEL[value] || value;
    });
    return labels;
  }, [regionLegend]);

  const thicknessOverlay = buildOverlay(viz?.sheath_thickness_mm_by_r, viz?.delta_sheath_thickness_mm_by_r);
  const sheathOverlay = buildOverlay(viz?.sheath_z_mm_by_r, viz?.delta_sheath_z_mm_by_r);
  const ionEnergyOverlay = buildOverlay(ionProxy?.ion_energy_proxy_rel_by_r, compare?.delta_ion_proxy?.ion_energy_proxy_rel_by_r);
  const ionFluxOverlay = buildOverlay(ionProxy?.ion_flux_proxy_rel_by_r, compare?.delta_ion_proxy?.ion_flux_proxy_rel_by_r);
  const eSheathOverlay = buildOverlay(insights?.E_on_sheath_by_r, compare?.delta_insights?.E_on_sheath_by_r);
  const neSheathOverlay = buildOverlay(insights?.ne_on_sheath_by_r, compare?.delta_insights?.ne_on_sheath_by_r);

  const sheathGeometrySeries = useMemo<CurveSeries[]>(() => {
    if (!rAxis || !sheathMetrics?.z_mm_by_r || sheathMetrics.z_mm_by_r.length !== rAxis.length) {
      return [];
    }
    const curves: CurveSeries[] = [
      { x: rAxis, y: sheathMetrics.z_mm_by_r, name: "Sheath z", color: "#118ab2" },
    ];
    if (sheathMetrics.electrode_z_mm_by_r && sheathMetrics.electrode_z_mm_by_r.length === rAxis.length) {
      curves.push({
        x: rAxis,
        y: sheathMetrics.electrode_z_mm_by_r,
        name: "Electrode z",
        color: "#ef8a12",
      });
      curves.push({
        x: rAxis,
        y: sheathMetrics.z_mm_by_r.map((z, idx) => Math.abs(z - sheathMetrics.electrode_z_mm_by_r![idx])),
        name: "Thickness (|dz|)",
        color: "#ef476f",
      });
    }
    return curves;
  }, [rAxis, sheathMetrics]);

  const warnings = useMemo(
    () =>
      gatherWarnings(
        viz,
        ionProxy,
        compare?.delta_ion_proxy,
        [...(insights?.warnings || []), ...(compare?.delta_insights?.warnings || []), ...(metadata?.ne_solver?.warnings || [])]
      ),
    [compare, insights, ionProxy, metadata, viz]
  );

  const overlayShapes = formState.showGeometryOverlay ? lastGeometryShapes ?? geometryShapes : [];
  const inletIndicatorShape = useMemo(
    () =>
      buildInletIndicatorShape(
        overlayShapes,
        formState.inletSurfaceTag,
        formState.inletEmitSide,
        formState.inletActiveWidthPercent
      ),
    [
      formState.inletActiveWidthPercent,
      formState.inletEmitSide,
      formState.inletSurfaceTag,
      overlayShapes,
    ]
  );
  const editorInletIndicatorShape = useMemo(
    () =>
      buildInletIndicatorShape(
        geometryShapes,
        formState.inletSurfaceTag,
        formState.inletEmitSide,
        formState.inletActiveWidthPercent
      ),
    [
      formState.inletActiveWidthPercent,
      formState.inletEmitSide,
      formState.inletSurfaceTag,
      geometryShapes,
    ]
  );
  const overlayShapesWithInlet = useMemo(
    () => (inletIndicatorShape ? [...overlayShapes, inletIndicatorShape] : overlayShapes),
    [inletIndicatorShape, overlayShapes]
  );
  const simulatorELinearRange = useMemo(() => getFiniteMinMax(fields?.E_mag), [fields?.E_mag]);
  const simulatorELogMapped = useMemo(
    () => buildLogScaledGrid(fields?.E_mag, getPositiveMinMax(fields?.E_mag), { nonPositive: "min" }),
    [fields?.E_mag]
  );
  const simulatorEColorTicks = useMemo(
    () =>
      colorScaleMode === "log"
        ? buildLogColorbarTicks(
            simulatorELogMapped.logMin,
            simulatorELogMapped.logMax,
            simulatorELogMapped.rawMin,
            simulatorELogMapped.rawMax
          )
        : undefined,
    [
      colorScaleMode,
      simulatorELogMapped.logMax,
      simulatorELogMapped.logMin,
      simulatorELogMapped.rawMax,
      simulatorELogMapped.rawMin,
    ]
  );
  const simulatorNeLinearRange = useMemo(() => getFiniteMinMax(fields?.ne), [fields?.ne]);
  const simulatorNeLogMapped = useMemo(
    () => buildLogScaledGrid(fields?.ne, getPositiveMinMax(fields?.ne), { nonPositive: "min" }),
    [fields?.ne]
  );
  const simulatorNeColorTicks = useMemo(
    () =>
      colorScaleMode === "log"
        ? buildLogColorbarTicks(
            simulatorNeLogMapped.logMin,
            simulatorNeLogMapped.logMax,
            simulatorNeLogMapped.rawMin,
            simulatorNeLogMapped.rawMax
          )
        : undefined,
    [
      colorScaleMode,
      simulatorNeLogMapped.logMax,
      simulatorNeLogMapped.logMin,
      simulatorNeLogMapped.rawMax,
      simulatorNeLogMapped.rawMin,
    ]
  );
  const simulatorVldLog = useMemo(
    () => buildLogScaledGrid(fields?.volume_loss_density),
    [fields?.volume_loss_density]
  );
  const simulatorVldLinearRange = useMemo(
    () => getFiniteMinMax(fields?.volume_loss_density),
    [fields?.volume_loss_density]
  );
  const simulatorVldColorTicks = useMemo(
    () =>
      buildLogColorbarTicks(
        simulatorVldLog.logMin,
        simulatorVldLog.logMax,
        simulatorVldLog.rawMin,
        simulatorVldLog.rawMax
      ),
    [simulatorVldLog.logMax, simulatorVldLog.logMin, simulatorVldLog.rawMax, simulatorVldLog.rawMin]
  );
  const resultTagMask = useMemo(
    () => metadata?.geometry?.grid?.tag_mask ?? payloadPreview.geometry.grid.tag_mask,
    [metadata?.geometry?.grid?.tag_mask, payloadPreview.geometry.grid.tag_mask]
  );
  const volumeLossRows = useMemo(
    () =>
      showVolumeLossDensity
        ? buildVolumeLossDensityResultRows(
            fields?.volume_loss_density,
            resultTagMask,
            geometryShapes,
            grid?.r_mm,
            grid?.z_mm
          )
        : [],
    [
      fields?.volume_loss_density,
      geometryShapes,
      grid?.r_mm,
      grid?.z_mm,
      resultTagMask,
      showVolumeLossDensity,
    ]
  );
  const filteredFieldsForPlasmaView = useMemo(
    () =>
      fields
        ? {
            ...fields,
            E_mag: showEField ? fields.E_mag : undefined,
            ne: showNe ? fields.ne : undefined,
          }
        : fields,
    [fields, showEField, showNe]
  );
  const compareAccessEnabled =
    authUser?.compare_access_enabled === true || compareAccess?.enabled === true;
  const compareCurrentPeriodEndText = useMemo(() => {
    if (!compareAccess?.current_period_end) {
      return null;
    }
    const parsed = new Date(compareAccess.current_period_end);
    if (Number.isNaN(parsed.getTime())) {
      return null;
    }
    return parsed.toLocaleString();
  }, [compareAccess?.current_period_end]);
  const globalRunning = isRunning || compareRunning;
  const eStats = useMemo(() => {
    const values = flattenFinite(fields?.E_mag);
    if (!values.length) return { min: null, max: null, mean: null };
    return { min: Math.min(...values), max: Math.max(...values), mean: values.reduce((a, b) => a + b, 0) / values.length };
  }, [fields?.E_mag]);
  const neStats = useMemo(() => {
    const values = flattenFinite(fields?.ne);
    if (!values.length) return { min: null, max: null, mean: null };
    return { min: Math.min(...values), max: Math.max(...values), mean: values.reduce((a, b) => a + b, 0) / values.length };
  }, [fields?.ne]);
  const vldStats = useMemo(() => {
    const values = flattenFinite(fields?.volume_loss_density);
    if (!values.length) return { min: null, max: null, mean: null };
    return {
      min: Math.min(...values),
      max: Math.max(...values),
      mean: values.reduce((a, b) => a + b, 0) / values.length,
    };
  }, [fields?.volume_loss_density]);

  const shapeSummary = useMemo(() => {
    const structureCount = geometryShapes.filter((shape) => shape.group !== "chamber").length;
    const dielectricCount = geometryShapes.filter((shape) => shape.group !== "chamber" && shape.role === "dielectric").length;
    const poweredCount = geometryShapes.filter((shape) => shape.group !== "chamber" && shape.role === "powered_electrode").length;
    return { structureCount, dielectricCount, poweredCount };
  }, [geometryShapes]);
  const showFieldModeToggle =
    (activeTab === "overview" ||
      activeTab === "efield" ||
      activeTab === "density" ||
      activeTab === "volume_loss_density") &&
    (showEField || showNe || showVolumeLossDensity);
  const visiblePageConfig = useMemo(
    () => PAGE_CONFIG.filter((item) => item.key !== "admin" || authUser?.role === "admin"),
    [authUser?.role]
  );
  const activeSiteInfo = siteInfoKey ? SITE_INFO_CONTENT[siteInfoKey] : null;

  return (
    <div className="app-shell">
      {page === "simulator" ? (
        <SidebarControls
          state={formState}
          onChange={(next) => setFormState((prev) => ({ ...prev, ...next }))}
          onRun={handleRun}
          onAbort={handleAbortSimulator}
          buildPayload={(state) => buildRequestPayload(state, geometryShapes, simViewLayers)}
          isRunning={isRunning}
          onLoadExample={loadTopRfExample}
          onLoadLayerStack={loadLayerStackExample}
          onOpenTheory={() => goPage("theory")}
          onOpenCompare={() => goPage("compare")}
          onGoHome={goHome}
          rfSurfaceTagOptions={rfSurfaceTagOptions}
          dcBiasTagOptions={dcBiasTagOptions}
          inletSurfaceTagOptions={inletSurfaceTagOptions}
          pumpSurfaceTagOptions={pumpSurfaceTagOptions}
        />
      ) : (
        <aside className="sidebar sidebar-compact">
          <div className="sidebar-header">
            <h1>
              <button type="button" className="app-title-link sidebar-title-link" onClick={goHome}>
                2D RF CCP Chamber Simulator
              </button>
            </h1>
            <p>
              {page === "compare"
                ? "Compare controls are edited inside Case A/B cards."
                : page === "admin"
                  ? "Admin page is dedicated to account and billing access management."
                  : "Theory page hides simulator controls to avoid duplicate inputs."}
            </p>
          </div>
          <section>
            <h2>Workspace</h2>
            <div className="quick-actions">
              {visiblePageConfig.map((item) => (
                <button
                  key={`compact-${item.key}`}
                  type="button"
                  className={`chip-button ${page === item.key ? "chip-primary" : ""}`}
                  onClick={() => goPage(item.key)}
                >
                  {item.key === "compare" && !compareAccessEnabled ? "Compare ($5/mo)" : item.label}
                </button>
              ))}
            </div>
            <p className="section-note">
              To prevent overlap, detailed process tuning is only available in each active page panel.
            </p>
          </section>
          <section>
            <h2>Quick Actions</h2>
            <div className="quick-actions">
              <button type="button" className="chip-button" onClick={loadTopRfExample}>
                Load 300mm CCP Baseline
              </button>
              <button type="button" className="chip-button" onClick={loadLayerStackExample}>
                Load Layer Stack
              </button>
            </div>
            <p className="section-note">
              {page === "compare"
                ? "Use Case A/B parameter cards for process, gas, and pump setup."
                : page === "admin"
                  ? "Admin tasks are account-level and do not use simulation controls."
                  : "Return to Simulator for full geometry/process controls."}
            </p>
          </section>
          <button type="button" className="run-button" onClick={() => goPage("simulator")}>
            Back to Simulator
          </button>
        </aside>
      )}

      <main className="main-panel">
        <header className="main-header">
          <div>
            <h2>
              <button type="button" className="app-title-link" onClick={goHome}>
                2D RF CCP Chamber Simulator
              </button>
            </h2>
            <p>300 mm wafer CCP baseline loaded on startup for direct trend comparison.</p>
            <p className="header-disclaimer">
              Detailed absolute plasma results should be validated with commercial simulation software.
            </p>
          </div>
          <nav className="page-tabs" aria-label="Page Tabs">
            {visiblePageConfig.map((item) => (
              <button
                key={item.key}
                type="button"
                className={`page-tab-button ${page === item.key ? "active" : ""}`}
                onClick={() => goPage(item.key)}
              >
                {item.key === "compare" && !compareAccessEnabled ? "Compare ($5/mo)" : item.label}
              </button>
            ))}
          </nav>
          <div className="header-meta-links" aria-label="Site links">
            <button type="button" className="mini-link-button" onClick={() => setSiteInfoKey("guide")}>
              Guide
            </button>
            <button type="button" className="mini-link-button" onClick={() => setSiteInfoKey("about")}>
              About
            </button>
            <button type="button" className="mini-link-button" onClick={() => setSiteInfoKey("contact")}>
              Contact
            </button>
            <button type="button" className="mini-link-button" onClick={() => setSiteInfoKey("privacy")}>
              Privacy
            </button>
            <button type="button" className="mini-link-button" onClick={() => setSiteInfoKey("terms")}>
              Terms
            </button>
          </div>
          <div className="status-strip">
            <div className={`status-chip status-chip-state ${globalRunning ? "running" : "idle"}`}>
              {globalRunning ? "Running" : "Idle"}
            </div>
            <div
              className="status-chip status-chip-id"
              title={responseMeta?.request_id ? `ID ${responseMeta.request_id}` : "No Request"}
            >
              {responseMeta?.request_id ? `ID ${responseMeta.request_id}` : "No Request"}
            </div>
            {page === "simulator" ? (
              <button
                type="button"
                className={`ghost-button header-run-button ${isRunning ? "abort" : ""}`}
                onClick={() =>
                  isRunning ? handleAbortSimulator() : handleRun(payloadPreview)
                }
                disabled={compareRunning}
              >
                {isRunning ? "Abort Simulator Run" : "Run Simulator"}
              </button>
            ) : null}
          </div>
        </header>

        <section className="auth-strip">
          <AuthPanel
            user={authUser}
            loading={authLoading}
            error={authError}
            onLogin={handleAuthLogin}
            onRegister={handleAuthRegister}
            onLogout={handleAuthLogout}
          />
        </section>

        {page === "theory" ? (
          <TheoryPage onBackToSimulator={() => goPage("simulator")} />
        ) : page === "admin" ? (
          authUser?.role === "admin" ? (
            <AdminPage
              users={adminUsers}
              loading={adminLoading}
              error={adminError}
              currentUserId={authUser?.id ?? null}
              onRefresh={() => fetchAdminUsers()}
              onUpdateUser={updateAdminUser}
            />
          ) : (
            <section className="compare-paywall">
              <article className="compare-paywall-card">
                <h3>Admin Access Required</h3>
                <p>Only admin users can access this page.</p>
              </article>
            </section>
          )
        ) : page === "compare" ? (
          compareAccessEnabled ? (
            <ComparePage
              seedForm={formState}
              seedShapes={geometryShapes}
              onBackToSimulator={() => goPage("simulator")}
              buildPayload={(state, shapes) => buildRequestPayload(state, shapes)}
              onRunningChange={setCompareRunning}
            />
          ) : (
            <section className="compare-paywall">
              <article className="compare-paywall-card">
                <h3>Compare Access ($5/month)</h3>
                {!authUser ? (
                  <p>Login first, then start subscription checkout.</p>
                ) : (
                  <p>Compare page is available after active monthly subscription.</p>
                )}
                <div className="compare-paywall-actions">
                  <button
                    type="button"
                    className="run-button"
                    onClick={startCompareCheckout}
                    disabled={!authUser || compareCheckoutLoading || compareBillingLoading}
                  >
                    {compareCheckoutLoading ? "Opening Checkout..." : "Subscribe Compare - $5 / month"}
                  </button>
                  <button
                    type="button"
                    className="ghost-button"
                    onClick={() => void verifySavedCompareAccess()}
                    disabled={!authUser || compareCheckoutLoading || compareBillingLoading}
                  >
                    {compareBillingLoading ? "Verifying..." : "I already paid, verify access"}
                  </button>
                  <button
                    type="button"
                    className="ghost-button"
                    onClick={() => void loadCompareAccessStatus()}
                    disabled={!authUser || compareCheckoutLoading || compareBillingLoading}
                  >
                    Refresh status
                  </button>
                </div>
                {compareAccess?.status ? (
                  <div className="compare-paywall-status">
                    <strong>Status:</strong> {compareAccess.status}
                    {compareCurrentPeriodEndText ? (
                      <span> | Current period end (local): {compareCurrentPeriodEndText}</span>
                    ) : null}
                  </div>
                ) : null}
                {compareBillingError ? <p className="status-error">Error: {compareBillingError}</p> : null}
              </article>
            </section>
          )
        ) : (
          <>
            <section className="summary-grid">
              <article className="summary-card">
                <h4>Process</h4>
                <div>{formatNumber(formState.pressure_Torr, 3)} Torr</div>
                <div>{formatNumber(formState.rf_power_W, 1)} W</div>
                <div>{(formState.frequency_Hz / 1_000_000).toFixed(2)} MHz</div>
                <div>DC {formatNumber(formState.dc_bias_V, 1)} V</div>
                <div>Sources {formState.plasmaSources.length}</div>
              </article>
              <article className="summary-card compact-metrics">
                <h4>Electric Field</h4>
                <div>Mean {formatNumber(eStats.mean)}</div>
                <div>Max {formatNumber(eStats.max)}</div>
                <div>Min {formatNumber(eStats.min)}</div>
              </article>
              <article className="summary-card compact-metrics">
                <h4>Electron Density</h4>
                <div>Mean {formatNumber(neStats.mean)}</div>
                <div>Max {formatNumber(neStats.max)}</div>
                <div>Min {formatNumber(neStats.min)}</div>
              </article>
              <article className="summary-card compact-metrics">
                <h4>Power Absorption Density</h4>
                <div>
                  Mean {formatLossDensity(vldStats.mean)}
                  <span className="metric-unit"> rel W/mm^3</span>
                </div>
                <div>
                  Max {formatLossDensity(vldStats.max)}
                  <span className="metric-unit"> rel W/mm^3</span>
                </div>
                <div>
                  Min {formatLossDensity(vldStats.min)}
                  <span className="metric-unit"> rel W/mm^3</span>
                </div>
              </article>
              <article className="summary-card">
                <h4>Geometry</h4>
                <div>Structure {shapeSummary.structureCount}</div>
                <div>Dielectric {shapeSummary.dielectricCount}</div>
                <div>Powered {shapeSummary.poweredCount}</div>
              </article>
              <article className="summary-card">
                <h4>Solver</h4>
                <div>eta {formatNumber(metadata?.eta, 3)}</div>
                <div>iter {metadata?.ne_solver?.iterations ?? "-"}</div>
                <div>res {formatNumber(metadata?.ne_solver?.residual, 6)}</div>
              </article>
            </section>

            <section className="view-layer-panel simulator-view-layer-panel">
              <div className="view-layer-head">
                <h3>Simulator View Filters (Multi-select)</h3>
                <p>
                  Select what to render: E-Field, ne, Power Absorption Density, Sheath.
                  Only selected layers are requested from backend during Simulator runs.
                </p>
              </div>
              <div className="view-layer-grid">
                {SIMULATOR_VIEW_LAYER_OPTIONS.map((option) => (
                  <label key={`sim-layer-${option.key}`} className="view-layer-chip">
                    <input
                      type="checkbox"
                      checked={simViewLayers[option.key]}
                      onChange={(event) =>
                        setSimViewLayers((prev) => ({
                          ...prev,
                          [option.key]: event.target.checked,
                        }))
                      }
                    />
                    <span>{option.label}</span>
                  </label>
                ))}
              </div>
            </section>

            <section className="workflow-panel">
              <div className="workflow-head">
                <h3>Recommended Workflow</h3>
                <p>Quick run -&gt; Geometry setup -&gt; Result analysis (minimal clicks).</p>
              </div>
              <div className="workflow-actions">
                <button
                  type="button"
                  className={`chip-button ${activeTab === "overview" ? "chip-primary" : ""}`}
                  onClick={() => setActiveTab("overview")}
                >
                  1. Quick Run (Overview)
                </button>
                <button
                  type="button"
                  className={`chip-button ${activeTab === "geometry" ? "chip-primary" : ""}`}
                  onClick={() => setActiveTab("geometry")}
                >
                  2. Geometry Setup
                </button>
                <button
                  type="button"
                  className={`chip-button ${activeTab !== "overview" && activeTab !== "geometry" ? "chip-primary" : ""}`}
                  onClick={() => setActiveTab("efield")}
                >
                  3. Analyze Results
                </button>
              </div>
            </section>

            <header className="tabs simulator-tabs">
              <div className="sim-tab-group">
                <span className="sim-tab-group-label">Quick Start</span>
                {TAB_CONFIG.filter((tab) => QUICK_START_TAB_KEYS.includes(tab.key)).map((tab) => (
                  <button key={tab.key} className={tab.key === activeTab ? "active" : ""} onClick={() => setActiveTab(tab.key)} type="button">
                    {tab.label}
                  </button>
                ))}
              </div>
              <div className="sim-tab-group">
                <span className="sim-tab-group-label">Setup</span>
                {TAB_CONFIG.filter((tab) => SETUP_TAB_KEYS.includes(tab.key)).map((tab) => (
                  <button key={tab.key} className={tab.key === activeTab ? "active" : ""} onClick={() => setActiveTab(tab.key)} type="button">
                    {tab.label}
                  </button>
                ))}
              </div>
              <div className="sim-tab-group">
                <span className="sim-tab-group-label">Results</span>
                {TAB_CONFIG.filter((tab) => RESULT_TAB_KEYS.includes(tab.key)).map((tab) => (
                  <button key={tab.key} className={tab.key === activeTab ? "active" : ""} onClick={() => setActiveTab(tab.key)} type="button">
                    {tab.label}
                  </button>
                ))}
              </div>
              {showFieldModeToggle ? (
                <div className="field-mode-toggle" role="group" aria-label="Field render mode">
                  <button
                    type="button"
                    className={fieldRenderMode === "isoband" ? "active" : ""}
                    onClick={() => setFieldRenderMode("isoband")}
                  >
                    Iso+Contour
                  </button>
                  <button
                    type="button"
                    className={fieldRenderMode === "contour" ? "active" : ""}
                    onClick={() => setFieldRenderMode("contour")}
                  >
                    Contour only
                  </button>
                  <button
                    type="button"
                    className={colorScaleMode === "log" ? "active" : ""}
                    onClick={() => setColorScaleMode("log")}
                  >
                    Log Scale
                  </button>
                  <button
                    type="button"
                    className={colorScaleMode === "linear" ? "active" : ""}
                    onClick={() => setColorScaleMode("linear")}
                  >
                    Linear
                  </button>
                </div>
              ) : null}
            </header>

            <section className="panel-content">
              {activeTab === "overview" && (
                <div className="tab-grid simulator-overview-grid">
                  {showEField ? (
                    <FieldHeatmap
                      title="|E| IsoBand Map"
                      z2d={colorScaleMode === "log" ? simulatorELogMapped.grid : fields?.E_mag}
                      x={grid?.r_mm}
                      y={grid?.z_mm}
                      renderMode={fieldRenderMode}
                      overlayShapes={overlayShapesWithInlet}
                      overlayOpacity={formState.geometryOverlayOpacity}
                      zMin={colorScaleMode === "log" ? simulatorELogMapped.logMin : simulatorELinearRange?.min}
                      zMax={colorScaleMode === "log" ? simulatorELogMapped.logMax : simulatorELinearRange?.max}
                      colorbarTitle={colorScaleMode === "log" ? "|E| (log)" : "|E|"}
                      colorbarTickVals={simulatorEColorTicks?.tickVals}
                      colorbarTickText={simulatorEColorTicks?.tickText}
                    />
                  ) : (
                    <div className="plot-placeholder">
                      <h3>|E| IsoBand Map</h3>
                      <p>E-Field layer is disabled in Simulator View Filters.</p>
                    </div>
                  )}
                  {showNe ? (
                    <FieldHeatmap
                      title="Electron Density IsoBand Map"
                      z2d={colorScaleMode === "log" ? simulatorNeLogMapped.grid : fields?.ne}
                      x={grid?.r_mm}
                      y={grid?.z_mm}
                      colorscale="Cividis"
                      renderMode={fieldRenderMode}
                      overlayShapes={overlayShapesWithInlet}
                      overlayOpacity={formState.geometryOverlayOpacity}
                      zMin={colorScaleMode === "log" ? simulatorNeLogMapped.logMin : simulatorNeLinearRange?.min}
                      zMax={colorScaleMode === "log" ? simulatorNeLogMapped.logMax : simulatorNeLinearRange?.max}
                      colorbarTitle={colorScaleMode === "log" ? "ne (log)" : "ne"}
                      colorbarTickVals={simulatorNeColorTicks?.tickVals}
                      colorbarTickText={simulatorNeColorTicks?.tickText}
                    />
                  ) : (
                    <div className="plot-placeholder">
                      <h3>Electron Density IsoBand Map</h3>
                      <p>ne layer is disabled in Simulator View Filters.</p>
                    </div>
                  )}
                  <GeometryPreview
                    title="Geometry Snapshot (Read-only)"
                    domain={{ r_max_mm: formState.r_max_mm, z_max_mm: formState.z_max_mm }}
                    shapes={geometryShapes}
                    annotationShapes={editorInletIndicatorShape ? [editorInletIndicatorShape] : []}
                  />
                  {showVolumeLossDensity ? (
                    <FieldHeatmap
                      title="Power Absorption Density IsoBand Map (Min-Max Log Scale)"
                      z2d={colorScaleMode === "log" ? simulatorVldLog.grid : fields?.volume_loss_density}
                      x={grid?.r_mm}
                      y={grid?.z_mm}
                      colorscale="Plasma"
                      renderMode={fieldRenderMode}
                      overlayShapes={overlayShapesWithInlet}
                      overlayOpacity={formState.geometryOverlayOpacity}
                      zMin={colorScaleMode === "log" ? simulatorVldLog.logMin : simulatorVldLinearRange?.min}
                      zMax={colorScaleMode === "log" ? simulatorVldLog.logMax : simulatorVldLinearRange?.max}
                      colorbarTitle={colorScaleMode === "log" ? "PAD (rel W/mm^3, log)" : "PAD (rel W/mm^3)"}
                      colorbarTickVals={colorScaleMode === "log" ? simulatorVldColorTicks?.tickVals : undefined}
                      colorbarTickText={colorScaleMode === "log" ? simulatorVldColorTicks?.tickText : undefined}
                    />
                  ) : (
                    <div className="plot-placeholder">
                      <h3>Power Absorption Density IsoBand Map</h3>
                      <p>Power Absorption Density layer is disabled in Simulator View Filters.</p>
                    </div>
                  )}
                  {showSheath ? (
                    <div className="curve-stack">
                      <CurvePlot title="Sheath Boundary z(r)" series={toSeries(rAxis, sheathOverlay.overlay, ["Baseline", "Perturbed"], ["#118ab2", "#ef476f"])} yLabel="z (mm)" />
                      <CurvePlot title="Sheath Thickness" series={toSeries(rAxis, thicknessOverlay.overlay, ["Baseline", "Perturbed"], ["#073b4c", "#f78c6b"])} yLabel="|z_sheath(r) - z_electrode(r)| (mm)" />
                    </div>
                  ) : (
                    <div className="meta-card layer-disabled-card">
                      <h4>Sheath</h4>
                      <p>Sheath layer is disabled in Simulator View Filters.</p>
                    </div>
                  )}
                </div>
              )}

              {activeTab === "geometry" && (
                <div className="tab-grid geometry-layout">
                  <GeometryEditor
                    domain={{ r_max_mm: formState.r_max_mm, z_max_mm: formState.z_max_mm }}
                    tool={formState.drawTool}
                    onToolChange={(nextTool) => setFormState((prev) => ({ ...prev, drawTool: nextTool }))}
                    shapes={geometryShapes}
                    annotationShapes={editorInletIndicatorShape ? [editorInletIndicatorShape] : []}
                    selectedId={selectedShapeId}
                    onSelect={setSelectedShapeId}
                    onShapesChange={setGeometryShapes}
                    defaultMaterial={{ epsilon_r: formState.epsilon_r, wall_loss_e: formState.wall_loss_e }}
                    snapToGrid={formState.snapToGrid}
                    snapStepMm={formState.snapStepMm}
                  />
                  <div className="geometry-side">
                    <GeometryMap title="Region Assignment Preview" regionId={regionGrid?.region_id} x={regionXAxis} y={regionYAxis} legend={regionLabelMap} colors={REGION_COLOR} />
                    <div className="meta-card">
                      <h4>Grid Summary</h4>
                      {metadata?.grid_summary?.region_type_counts ? (
                        <ul className="meta-list">
                          {Object.entries(metadata.grid_summary.region_type_counts).map(([key, value]) => (
                            <li key={key}>
                              <span>{REGION_LABEL[key] || key}</span>
                              <strong>{value}</strong>
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <p>Run simulation to calculate region cell counts.</p>
                      )}
                    </div>
                    {showSheath ? (
                      <>
                        <CurvePlot title="Electrode/Sheath Linked View" series={sheathGeometrySeries} yLabel="z or thickness (mm)" />
                        <div className="meta-card">
                          <h4>Sheath Thickness Check</h4>
                          {sheathMetrics?.thickness_mm_by_r ? (
                            <ul className="meta-list">
                              <li>
                                <span>Mean</span>
                                <strong>{formatNumber(sheathMetrics.thickness_mean_mm, 3)} mm</strong>
                              </li>
                              <li>
                                <span>Min</span>
                                <strong>{formatNumber(sheathMetrics.thickness_min_mm, 3)} mm</strong>
                              </li>
                              <li>
                                <span>Max</span>
                                <strong>{formatNumber(sheathMetrics.thickness_max_mm, 3)} mm</strong>
                              </li>
                              <li>
                                <span>Method</span>
                                <strong>|sheath_z - electrode_z|</strong>
                              </li>
                            </ul>
                          ) : (
                            <p>Run simulation to inspect sheath and electrode-coupled thickness.</p>
                          )}
                          <WarningsPanel warnings={sheathMetrics?.warnings} />
                        </div>
                      </>
                    ) : (
                      <div className="meta-card layer-disabled-card">
                        <h4>Sheath</h4>
                        <p>Sheath layer is disabled in Simulator View Filters.</p>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {activeTab === "efield" && (
                <div className="tab-grid simulator-map-grid">
                  {showEField ? (
                    <FieldHeatmap
                      title="|E| (E_mag)"
                      z2d={colorScaleMode === "log" ? simulatorELogMapped.grid : fields?.E_mag}
                      x={grid?.r_mm}
                      y={grid?.z_mm}
                      renderMode={fieldRenderMode}
                      overlayShapes={overlayShapesWithInlet}
                      overlayOpacity={formState.geometryOverlayOpacity}
                      zMin={colorScaleMode === "log" ? simulatorELogMapped.logMin : simulatorELinearRange?.min}
                      zMax={colorScaleMode === "log" ? simulatorELogMapped.logMax : simulatorELinearRange?.max}
                      colorbarTitle={colorScaleMode === "log" ? "|E| (log)" : "|E|"}
                      colorbarTickVals={simulatorEColorTicks?.tickVals}
                      colorbarTickText={simulatorEColorTicks?.tickText}
                    />
                  ) : (
                    <div className="plot-placeholder">
                      <h3>|E| (E_mag)</h3>
                      <p>E-Field layer is disabled in Simulator View Filters.</p>
                    </div>
                  )}
                  <div className="curve-stack">
                    {showEField ? (
                      <>
                        <CurvePlot title="E on Sheath" series={toSeries(rAxis, eSheathOverlay.overlay, ["Baseline", "Perturbed"], ["#073b4c", "#f18f01"])} yLabel="|E| (arb.)" />
                        <CurvePlot title="Delta E on Sheath" series={toDeltaSeries(rAxis, eSheathOverlay.deltaCurve, "Delta E", "#ef476f")} yLabel="Delta |E|" />
                      </>
                    ) : (
                      <div className="meta-card layer-disabled-card">
                        <h4>E-Field Curves</h4>
                        <p>E-Field layer is disabled in Simulator View Filters.</p>
                      </div>
                    )}
                    {showSheath ? (
                      <CurvePlot title="Sheath Thickness" series={toSeries(rAxis, thicknessOverlay.overlay, ["Baseline", "Perturbed"], ["#118ab2", "#ef476f"])} yLabel="|z_sheath(r) - z_electrode(r)| (mm)" />
                    ) : (
                      <div className="meta-card layer-disabled-card">
                        <h4>Sheath Thickness</h4>
                        <p>Sheath layer is disabled in Simulator View Filters.</p>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {activeTab === "density" && (
                <div className="tab-grid simulator-map-grid">
                  {showNe ? (
                    <FieldHeatmap
                      title="Electron Density (ne)"
                      z2d={colorScaleMode === "log" ? simulatorNeLogMapped.grid : fields?.ne}
                      x={grid?.r_mm}
                      y={grid?.z_mm}
                      colorscale="Cividis"
                      renderMode={fieldRenderMode}
                      overlayShapes={overlayShapesWithInlet}
                      overlayOpacity={formState.geometryOverlayOpacity}
                      zMin={colorScaleMode === "log" ? simulatorNeLogMapped.logMin : simulatorNeLinearRange?.min}
                      zMax={colorScaleMode === "log" ? simulatorNeLogMapped.logMax : simulatorNeLinearRange?.max}
                      colorbarTitle={colorScaleMode === "log" ? "ne (log)" : "ne"}
                      colorbarTickVals={simulatorNeColorTicks?.tickVals}
                      colorbarTickText={simulatorNeColorTicks?.tickText}
                    />
                  ) : (
                    <div className="plot-placeholder">
                      <h3>Electron Density (ne)</h3>
                      <p>ne layer is disabled in Simulator View Filters.</p>
                    </div>
                  )}
                  <div className="curve-stack">
                    {showNe ? (
                      <>
                        <CurvePlot title="ne on Sheath" series={toSeries(rAxis, neSheathOverlay.overlay, ["Baseline", "Perturbed"], ["#2a9d8f", "#f18f01"])} yLabel="ne (norm)" />
                        <CurvePlot title="Ion Flux Proxy" series={toSeries(rAxis, ionFluxOverlay.overlay, ["Baseline", "Perturbed"], ["#118ab2", "#ef476f"])} yLabel="Flux (rel)" />
                        <CurvePlot title="Delta Ion Flux" series={toDeltaSeries(rAxis, ionFluxOverlay.deltaCurve, "Delta Flux", "#f18f01")} yLabel="Delta Flux" />
                      </>
                    ) : (
                      <div className="meta-card layer-disabled-card">
                        <h4>Density Curves</h4>
                        <p>ne layer is disabled in Simulator View Filters.</p>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {activeTab === "volume_loss_density" && (
                <div className="tab-grid simulator-map-grid">
                  {showVolumeLossDensity ? (
                    <FieldHeatmap
                      title="Power Absorption Density (Min-Max Log Scale)"
                      z2d={colorScaleMode === "log" ? simulatorVldLog.grid : fields?.volume_loss_density}
                      x={grid?.r_mm}
                      y={grid?.z_mm}
                      colorscale="Plasma"
                      renderMode={fieldRenderMode}
                      overlayShapes={overlayShapesWithInlet}
                      overlayOpacity={formState.geometryOverlayOpacity}
                      zMin={colorScaleMode === "log" ? simulatorVldLog.logMin : simulatorVldLinearRange?.min}
                      zMax={colorScaleMode === "log" ? simulatorVldLog.logMax : simulatorVldLinearRange?.max}
                      colorbarTitle={colorScaleMode === "log" ? "PAD (rel W/mm^3, log)" : "PAD (rel W/mm^3)"}
                      colorbarTickVals={colorScaleMode === "log" ? simulatorVldColorTicks?.tickVals : undefined}
                      colorbarTickText={colorScaleMode === "log" ? simulatorVldColorTicks?.tickText : undefined}
                    />
                  ) : (
                    <div className="plot-placeholder">
                      <h3>Power Absorption Density</h3>
                      <p>Power Absorption Density layer is disabled in Simulator View Filters.</p>
                    </div>
                  )}
                  <div className="curve-stack">
                    {showVolumeLossDensity ? (
                      <div className="meta-card simulator-loss-density-card">
                        <h4>Part Power Absorption Density (Result)</h4>
                        <p className="compare-note">
                          Log scale range: {formatLossDensity(simulatorVldLog.rawMin ?? null)} ~{" "}
                          {formatLossDensity(simulatorVldLog.rawMax ?? null)}
                        </p>
                        <div className="compare-loss-density-table">
                          <table>
                            <thead>
                              <tr>
                                <th>Part (tag)</th>
                                <th>Role</th>
                                <th>Cells</th>
                                <th>Volume (mm^3)</th>
                                <th>Mean</th>
                                <th>Max</th>
                                <th>Absorbed P (rel)</th>
                              </tr>
                            </thead>
                            <tbody>
                              {volumeLossRows.length === 0 ? (
                                <tr>
                                  <td colSpan={7}>Run simulation to view power absorption density.</td>
                                </tr>
                              ) : (
                                volumeLossRows.map((row) => (
                                  <tr key={`sim-vld-result-${row.tag}`}>
                                    <td>{row.label} ({row.tag})</td>
                                    <td>{row.role}</td>
                                    <td>{row.cells}</td>
                                    <td>{formatNumber(row.volume_mm3, 3)}</td>
                                    <td>{formatLossDensity(row.mean)}</td>
                                    <td>{formatLossDensity(row.max)}</td>
                                    <td>{formatLossDensity(row.absorbedPowerRel)}</td>
                                  </tr>
                                ))
                              )}
                            </tbody>
                          </table>
                        </div>
                      </div>
                    ) : (
                      <div className="meta-card layer-disabled-card">
                        <h4>Power Absorption Density</h4>
                        <p>Power Absorption Density layer is disabled in Simulator View Filters.</p>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {activeTab === "plasma_view" && (
                <div className="tab-grid plasma-view-tab">
                  {!showEField && !showNe ? (
                    <div className="plot-placeholder">
                      <h3>Plasma View</h3>
                      <p>E-Field and ne layers are disabled in Simulator View Filters.</p>
                    </div>
                  ) : (
                    <PlasmaViewPanel grid={grid} fields={filteredFieldsForPlasmaView} />
                  )}
                </div>
              )}

              {activeTab === "diagnostics" && (
                <div className="tab-grid diagnostics-grid">
                  <div className="curve-stack">
                    <CurvePlot title="Ion Energy Proxy" series={toSeries(rAxis, ionEnergyOverlay.overlay, ["Baseline", "Perturbed"], ["#073b4c", "#ef476f"])} yLabel="Energy (rel)" />
                    {showSheath ? (
                      <>
                        <CurvePlot title="Delta Sheath z" series={toDeltaSeries(rAxis, sheathOverlay.deltaCurve, "Delta Sheath z", "#f18f01")} yLabel="Delta z (mm)" />
                        <CurvePlot title="Delta Thickness" series={toDeltaSeries(rAxis, thicknessOverlay.deltaCurve, "Delta Thickness", "#f18f01")} yLabel="Delta Thickness (mm)" />
                      </>
                    ) : (
                      <div className="meta-card layer-disabled-card">
                        <h4>Sheath Diagnostics</h4>
                        <p>Sheath layer is disabled in Simulator View Filters.</p>
                      </div>
                    )}
                  </div>
                  <div className="meta-card">
                    <h4>Solver Diagnostics</h4>
                    <ul className="meta-list">
                      <li><span>Method</span><strong>{metadata?.ne_solver?.method ?? "-"}</strong></li>
                      <li><span>Converged</span><strong>{metadata?.ne_solver?.converged ? "Yes" : "No"}</strong></li>
                      <li><span>Iterations</span><strong>{metadata?.ne_solver?.iterations ?? "-"}</strong></li>
                      <li><span>Residual</span><strong>{formatNumber(metadata?.ne_solver?.residual, 6)}</strong></li>
                      <li><span>Fallback</span><strong>{metadata?.ne_solver?.fallback_used ? "Yes" : "No"}</strong></li>
                      <li><span>Ionization gain</span><strong>{formatNumber(metadata?.ne_solver?.ionization_gain, 4)}</strong></li>
                      <li><span>Bulk loss</span><strong>{formatNumber(metadata?.ne_solver?.bulk_loss, 4)}</strong></li>
                      <li><span>Te used (eV)</span><strong>{formatNumber(ionProxy?.Te_eV_used, 3)}</strong></li>
                      <li><span>Mi used (amu)</span><strong>{formatNumber(ionProxy?.Mi_amu_used, 2)}</strong></li>
                    </ul>
                    <WarningsPanel warnings={warnings} />
                  </div>
                </div>
              )}
            </section>
          </>
        )}

        <footer className="site-meta-footer">
          <div className="site-meta-brand">
            <strong>plasmaccp.com</strong>
            <span>RF CCP trend simulation workspace</span>
          </div>
          <div className="site-meta-links">
            <button type="button" className="mini-link-button" onClick={() => setSiteInfoKey("guide")}>
              Guide
            </button>
            <button type="button" className="mini-link-button" onClick={() => setSiteInfoKey("about")}>
              About
            </button>
            <button type="button" className="mini-link-button" onClick={() => setSiteInfoKey("contact")}>
              Contact
            </button>
            <button type="button" className="mini-link-button" onClick={() => setSiteInfoKey("privacy")}>
              Privacy
            </button>
            <button type="button" className="mini-link-button" onClick={() => setSiteInfoKey("terms")}>
              Terms
            </button>
            <a className="mini-link-anchor" href="mailto:toughguy0424@gmail.com">
              Email
            </a>
          </div>
        </footer>

        <footer className="status-bar">
          {apiError ? (
            <span className="status-error">Error: {apiError}</span>
          ) : responseMeta?.request_id ? (
            <span>Request ID: {responseMeta.request_id} | Response size: {responseMeta.size_bytes ?? "-"} bytes</span>
          ) : (
            <span>No simulation results yet. The 300 mm CCP baseline preset is ready to run.</span>
          )}
        </footer>

        {activeSiteInfo ? (
          <div
            className="site-info-modal-backdrop"
            role="presentation"
            onClick={() => setSiteInfoKey(null)}
          >
            <article
              className="site-info-modal"
              role="dialog"
              aria-modal="true"
              aria-labelledby="site-info-title"
              onClick={(event) => event.stopPropagation()}
            >
              <header className="site-info-modal-head">
                <h3 id="site-info-title">{activeSiteInfo.title}</h3>
                <button type="button" className="ghost-button" onClick={() => setSiteInfoKey(null)}>
                  Close
                </button>
              </header>
              {siteInfoKey === "guide" ? (
                <UserGuidePanel />
              ) : (
                <>
                  <p className="site-info-subtitle">{activeSiteInfo.subtitle}</p>
                  {activeSiteInfo.body.map((paragraph, idx) => (
                    <p key={`${siteInfoKey}-${idx}`}>{paragraph}</p>
                  ))}
                  <p className="site-info-contact">
                    Contact: <a href="mailto:toughguy0424@gmail.com">toughguy0424@gmail.com</a>
                  </p>
                </>
              )}
            </article>
          </div>
        ) : null}
      </main>
    </div>
  );
};

export default App;


