import React, { useEffect, useMemo, useRef, useState } from "react";
import type {
  DCBiasRegionState,
  InletDirection,
  InletEmitSide,
  SidebarState,
} from "./SidebarControls";
import GeometryEditor from "./GeometryEditor";
import type { GeometryShape } from "../types/geometry";
import type {
  SimulationRequestPayload,
  SimulationResponse,
  SimulationResult,
} from "../types/api";
import FieldHeatmap from "./FieldHeatmap";
import CurvePlot, { CurveSeries } from "./CurvePlot";
import WarningsPanel from "./WarningsPanel";
import { buildLayerStackExampleShapes } from "../utils/geometryPresets";
import { buildInletIndicatorShape } from "../utils/inletIndicator";
import { buildLegacyCompatiblePayload, shouldRetryWithLegacyOutlet } from "../utils/requestCompat";
import NumberInput from "./NumberInput";
import {
  buildVolumeLossDensityCompareRows,
  buildVolumeLossDensityResultRows,
} from "../utils/volumeLossDensityResults";
import {
  buildLogColorbarTicks,
  buildLogScaledGrid,
  getFiniteMinMax,
  getPositiveMinMax,
} from "../utils/logScale";

type ComparePageProps = {
  seedForm: SidebarState;
  seedShapes: GeometryShape[];
  onBackToSimulator: () => void;
  onRunningChange?: (running: boolean) => void;
  buildPayload: (
    state: SidebarState,
    shapes: GeometryShape[]
  ) => SimulationRequestPayload;
};

const REF_E_RANGE: [number, number] = [0, 0.3];
const REF_NE_RANGE: [number, number] = [0, 1.0];

type ShapeDiffItem = {
  tag: string;
  label: string;
  reason: "added" | "removed" | "updated";
};

type ParameterRow = {
  label: string;
  left: string;
  right: string;
  changed: boolean;
};

type ResultMetricRow = {
  label: string;
  left: string;
  right: string;
  delta: string;
  changed: boolean;
};

type DeltaField = {
  x?: number[];
  y?: number[];
  z?: number[][];
  note?: string;
};

type ViewLayerKey = "efield" | "ne" | "volumeLossDensity" | "sheath";
type SharedControlPanelKey = "mesh" | "inlet" | "pump" | "dcBias" | "resultCurves";

const VIEW_LAYER_OPTIONS: { key: ViewLayerKey; label: string }[] = [
  { key: "efield", label: "E-Field" },
  { key: "ne", label: "ne" },
  { key: "volumeLossDensity", label: "Power Absorption Density" },
  { key: "sheath", label: "Sheath" },
];

const isNumberClose = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) <= eps;

const cloneSidebarState = (state: SidebarState): SidebarState => ({
  ...state,
  gasComponents: state.gasComponents.map((gas) => ({ ...gas })),
  plasmaSources: state.plasmaSources.map((source) => ({ ...source })),
  dcBiasRegions: state.dcBiasRegions.map((row) => ({ ...row })),
  pumpPorts: state.pumpPorts.map((port) => ({ ...port })),
});

const cloneShapes = (shapes: GeometryShape[]) =>
  shapes.map((shape) =>
    shape.type === "rect"
      ? { ...shape, material: { ...shape.material } }
      : shape.type === "circle"
        ? { ...shape, material: { ...shape.material } }
        : { ...shape, points: shape.points.map((point) => ({ ...point })), material: { ...shape.material } }
  );

const normalizeShape = (shape: GeometryShape) => {
  const base = {
    tag: shape.tag,
    label: shape.label,
    type: shape.type,
    role: shape.role,
    group: shape.group,
    strokeWidth: Number(shape.strokeWidth.toFixed(3)),
    color: shape.color,
    material: {
      enabled: shape.material.enabled,
      epsilon_r: Number(shape.material.epsilon_r.toFixed(4)),
      wall_loss_e: Number(shape.material.wall_loss_e.toFixed(4)),
    },
  };
  if (shape.type === "rect") {
    return {
      ...base,
      x0: Number(shape.x0.toFixed(3)),
      y0: Number(shape.y0.toFixed(3)),
      x1: Number(shape.x1.toFixed(3)),
      y1: Number(shape.y1.toFixed(3)),
    };
  }
  if (shape.type === "circle") {
    return {
      ...base,
      cx: Number(shape.cx.toFixed(3)),
      cy: Number(shape.cy.toFixed(3)),
      r: Number(shape.r.toFixed(3)),
    };
  }
  return {
    ...base,
    points: shape.points.map((point) => ({ x: Number(point.x.toFixed(3)), y: Number(point.y.toFixed(3)) })),
  };
};

const shapeSignature = (shape: GeometryShape) => JSON.stringify(normalizeShape(shape));

const gasSummary = (form: SidebarState) =>
  form.gasComponents
    .map((row) => `${row.species}:${row.flow_sccm.toFixed(2)}`)
    .join(", ");

const totalGasFlow = (form: SidebarState) =>
  form.gasComponents.reduce((sum, row) => sum + Math.max(0, row.flow_sccm), 0);

const rfSourceSummary = (form: SidebarState) =>
  form.plasmaSources
    .map((source, index) => {
      const tag = source.surface_tag || "auto";
      const freqMHz = (source.frequency_Hz / 1_000_000).toFixed(2);
      return `S${index + 1} ${tag}\nP=${source.rf_power_W.toFixed(1)}W, f=${freqMHz}MHz, phi=${source.phase_deg.toFixed(0)}deg`;
    })
    .join("\n");

const pumpSummary = (form: SidebarState) =>
  form.pumpPorts
    .map((port, index) => {
      return `P${index + 1} ${port.surface_tag}\nx${port.strength.toFixed(2)}, thr=${port.throttle_percent.toFixed(
        1
      )}%, C=${port.conductance_lps.toFixed(1)}L/s, Pt=${port.target_pressure_Pa.toFixed(1)}Pa`;
    })
    .join("\n");

const inletSummary = (form: SidebarState) =>
  `${form.inletSurfaceTag} | ${form.inletDirection} | side ${form.inletEmitSide} | width ${form.inletActiveWidthPercent.toFixed(0)}%`;

const firstPumpPort = (form: SidebarState) => form.pumpPorts[0];

const ensureFirstPumpPort = (form: SidebarState): SidebarState => {
  if (form.pumpPorts.length > 0) {
    return form;
  }
  return {
    ...form,
    pumpPorts: [
      {
        id: `pump-${Date.now()}`,
        surface_tag: "bottom_pump",
        strength: 1.0,
        throttle_percent: 100.0,
        conductance_lps: 220.0,
        target_pressure_Pa: 8.0,
        note: "",
      },
    ],
  };
};

const clampFinite = (value: number, fallback: number, min?: number, max?: number) => {
  const safe = Number.isFinite(value) ? value : fallback;
  const lo = min ?? -Infinity;
  const hi = max ?? Infinity;
  return Math.max(lo, Math.min(hi, safe));
};

const makeDcBiasId = (side: "left" | "right") =>
  `cmp-${side}-dc-${Date.now()}-${Math.floor(Math.random() * 1000)}`;

const makeDcBiasRegion = (
  side: "left" | "right",
  index: number,
  patch: Partial<DCBiasRegionState> = {}
): DCBiasRegionState => ({
  id: patch.id || `${side}-dc-bias-${index + 1}`,
  target_tag: patch.target_tag || "",
  dc_bias_V: Number.isFinite(patch.dc_bias_V) ? patch.dc_bias_V : 0,
});

const normalizeDcBiasRows = (
  rows: DCBiasRegionState[],
  availableTags: string[],
  side: "left" | "right"
) => {
  if (availableTags.length === 0) {
    return [] as DCBiasRegionState[];
  }
  const fallbackTag = availableTags[0];
  const normalized = rows
    .slice(0, 16)
    .map((row, idx) => {
      const requestedTag = row.target_tag?.trim() ?? "";
      return {
        id: row.id || `${side}-dc-bias-${idx + 1}`,
        target_tag: availableTags.includes(requestedTag) ? requestedTag : fallbackTag,
        dc_bias_V: clampFinite(row.dc_bias_V, 0, -5000, 5000),
      };
    })
    .filter((row, idx, arr) => arr.findIndex((item) => item.id === row.id) === idx);
  return normalized;
};

const toOutputSelectionPayload = (layers: Record<ViewLayerKey, boolean>) => ({
  efield: Boolean(layers.efield),
  ne: Boolean(layers.ne),
  volume_loss_density: Boolean(layers.volumeLossDensity),
  sheath: Boolean(layers.sheath),
});

const buildPrimarySource = (
  form: SidebarState,
  patch?: Partial<SidebarState["plasmaSources"][number]>
) => {
  const seed = form.plasmaSources[0];
  const candidate = {
    id: seed?.id || "cmp-src-1",
    name: seed?.name || "Primary RF",
    surface_tag: (seed?.surface_tag || "powered_electrode_surface").trim() || "powered_electrode_surface",
    rf_power_W: seed?.rf_power_W ?? form.rf_power_W,
    frequency_Hz: seed?.frequency_Hz ?? form.frequency_Hz,
    phase_deg: seed?.phase_deg ?? 0,
    ...patch,
  };
  return {
    ...candidate,
    surface_tag: (candidate.surface_tag || "powered_electrode_surface").trim() || "powered_electrode_surface",
    rf_power_W: clampFinite(candidate.rf_power_W, form.rf_power_W, 0),
    frequency_Hz: clampFinite(candidate.frequency_Hz, form.frequency_Hz, 1),
    phase_deg: clampFinite(candidate.phase_deg, 0, -360, 360),
  };
};

const normalizeCompareForm = (state: SidebarState): SidebarState => {
  const cloned = cloneSidebarState(state);
  const primary = buildPrimarySource(cloned);
  return {
    ...cloned,
    plasmaSources: [primary],
    rf_power_W: primary.rf_power_W,
    frequency_Hz: primary.frequency_Hz,
  };
};

const API_BASE_DEFAULT = import.meta.env.VITE_API_BASE || "/api";
const MESH_LIMITS = {
  nrMin: 16,
  nrMax: 224,
  nzMin: 16,
  nzMax: 256,
};
const GAS_OPTIONS = [
  { value: "Ar", label: "Argon (Ar)" },
  { value: "O2", label: "Oxygen (O2)" },
  { value: "N2", label: "Nitrogen (N2)" },
  { value: "SiH4", label: "Silane (SiH4)" },
  { value: "N2O", label: "Nitrous Oxide (N2O)" },
  { value: "NH3", label: "Ammonia (NH3)" },
  { value: "H2", label: "Hydrogen (H2)" },
  { value: "He", label: "Helium (He)" },
];

const INLET_DIRECTION_OPTIONS: { value: InletDirection; label: string }[] = [
  { value: "normal_inward", label: "Normal Downward" },
  { value: "radial_inward", label: "Radial Inward" },
  { value: "radial_outward", label: "Radial Outward" },
  { value: "diffuse", label: "Diffuse" },
];

const INLET_SIDE_OPTIONS: { value: InletEmitSide; label: string }[] = [
  { value: "left", label: "Left Side" },
  { value: "center", label: "Center Side" },
  { value: "right", label: "Right Side" },
];

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

const fetchSimulationResult = async (
  payload: SimulationRequestPayload,
  signal?: AbortSignal
): Promise<{ result: SimulationResult | null; error: string | null; aborted?: boolean }> => {
  try {
    const postSimulation = (requestPayload: SimulationRequestPayload) =>
      fetch(`${API_BASE_DEFAULT}/simulate?mode=poisson_v1`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestPayload),
        signal,
      });
    let response = await postSimulation(payload);
    if (!response.ok) {
      const msg = await response.text();
      if (shouldRetryWithLegacyOutlet(response.status, msg)) {
        response = await postSimulation(buildLegacyCompatiblePayload(payload));
      } else {
        return {
          result: null,
          error: `HTTP ${response.status}: ${msg || response.statusText || "Request failed"}`,
        };
      }
    }
    if (!response.ok) {
      const msg = await response.text();
      return {
        result: null,
        error: `HTTP ${response.status}: ${msg || response.statusText || "Request failed"}`,
      };
    }
    const data = (await response.json()) as SimulationResponse;
    if (data.stored && data.result_url) {
      const stored = await fetch(normalizeResultUrl(data.result_url), { signal });
      if (!stored.ok) {
        const msg = await stored.text();
        return {
          result: null,
          error: `HTTP ${stored.status}: ${msg || stored.statusText || "Failed to load stored result"}`,
        };
      }
      return { result: (await stored.json()) as SimulationResult, error: null };
    }
    return { result: data.result ?? null, error: null };
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      return {
        result: null,
        error: "Simulation aborted by user.",
        aborted: true,
      };
    }
    return {
      result: null,
      error: error instanceof Error ? error.message : "Simulation failed",
    };
  }
};

const mean = (values?: number[]) => {
  if (!values || values.length === 0) {
    return null;
  }
  const finite = values.filter((value) => Number.isFinite(value));
  if (finite.length === 0) {
    return null;
  }
  return finite.reduce((sum, value) => sum + value, 0) / finite.length;
};

const formatNumber = (value: number | null | undefined, digits = 3) => {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return "-";
  }
  return value.toFixed(digits);
};

const formatLossDensity = (value: number | null | undefined) => {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return "-";
  }
  return value.toExponential(3);
};

const flattenFiniteGrid = (grid?: number[][]) =>
  grid?.flat().filter((value) => Number.isFinite(value)) ?? [];

const getSharedColorRange = (left?: number[][], right?: number[][]) => {
  const values = [...flattenFiniteGrid(left), ...flattenFiniteGrid(right)];
  if (values.length === 0) {
    return { zMin: undefined, zMax: undefined };
  }
  const zMin = Math.min(...values);
  const zMaxRaw = Math.max(...values);
  const zMax = zMaxRaw > zMin ? zMaxRaw : zMin + 1e-9;
  return { zMin, zMax };
};

const getAxisMax = (axis?: number[]) => {
  if (!axis || axis.length === 0) {
    return undefined;
  }
  const max = axis[axis.length - 1];
  return Number.isFinite(max) ? max : undefined;
};

const getSharedAxisRange = (
  leftAxis: number[] | undefined,
  rightAxis: number[] | undefined,
  fallbackMax: number
) => {
  const candidates = [getAxisMax(leftAxis), getAxisMax(rightAxis), fallbackMax].filter(
    (value): value is number => Number.isFinite(value) && value > 0
  );
  if (candidates.length === 0) {
    return undefined;
  }
  return [0, Math.max(...candidates)] as [number, number];
};

const areAxesClose = (left?: number[], right?: number[], eps = 1e-6) => {
  if (!left || !right || left.length !== right.length) {
    return false;
  }
  return left.every((value, idx) => Math.abs(value - right[idx]) <= eps);
};

const isGridShapeValid = (grid: number[][], x: number[], y: number[]) =>
  grid.length === y.length && grid.every((row) => row.length === x.length);

const getBracket = (axis: number[], value: number) => {
  const n = axis.length;
  if (n < 2) {
    return null;
  }
  if (value <= axis[0]) {
    return { i0: 0, i1: 1, t: 0 };
  }
  if (value >= axis[n - 1]) {
    return { i0: n - 2, i1: n - 1, t: 1 };
  }
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (axis[mid] <= value) {
      lo = mid;
    } else {
      hi = mid;
    }
  }
  const span = axis[hi] - axis[lo];
  const t = span > 0 ? (value - axis[lo]) / span : 0;
  return { i0: lo, i1: hi, t };
};

const bilinearSample = (
  grid: number[][],
  xAxis: number[],
  yAxis: number[],
  x: number,
  y: number
) => {
  const bx = getBracket(xAxis, x);
  const by = getBracket(yAxis, y);
  if (!bx || !by) {
    return null;
  }
  const v00 = grid[by.i0]?.[bx.i0];
  const v10 = grid[by.i0]?.[bx.i1];
  const v01 = grid[by.i1]?.[bx.i0];
  const v11 = grid[by.i1]?.[bx.i1];
  if (![v00, v10, v01, v11].every((value) => Number.isFinite(value))) {
    return null;
  }
  const vx0 = (v00 as number) * (1 - bx.t) + (v10 as number) * bx.t;
  const vx1 = (v01 as number) * (1 - bx.t) + (v11 as number) * bx.t;
  return vx0 * (1 - by.t) + vx1 * by.t;
};

const buildOverlapAxis = (left?: number[], right?: number[]) => {
  if (!left || !right || left.length < 2 || right.length < 2) {
    return undefined;
  }
  const min = Math.max(left[0], right[0]);
  const max = Math.min(left[left.length - 1], right[right.length - 1]);
  if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) {
    return undefined;
  }
  const target = Math.max(40, Math.min(180, Math.min(left.length, right.length)));
  const step = (max - min) / Math.max(1, target - 1);
  return Array.from({ length: target }, (_, idx) => min + idx * step);
};

const buildDeltaField = (
  leftGrid?: number[][],
  leftX?: number[],
  leftY?: number[],
  rightGrid?: number[][],
  rightX?: number[],
  rightY?: number[]
): DeltaField => {
  if (!leftGrid || !leftX || !leftY || !rightGrid || !rightX || !rightY) {
    return { note: "Run both Case A and Case B to generate delta maps." };
  }

  const directComparable =
    isGridShapeValid(leftGrid, leftX, leftY) &&
    isGridShapeValid(rightGrid, rightX, rightY) &&
    leftGrid.length === rightGrid.length &&
    leftGrid[0]?.length === rightGrid[0]?.length &&
    areAxesClose(leftX, rightX) &&
    areAxesClose(leftY, rightY);

  if (directComparable) {
    const z = rightGrid.map((row, k) =>
      row.map((value, j) => {
        const leftValue = leftGrid[k]?.[j];
        if (!Number.isFinite(value) || !Number.isFinite(leftValue)) {
          return Number.NaN;
        }
        return value - (leftValue as number);
      })
    );
    return { x: rightX, y: rightY, z, note: "Direct delta on same mesh/domain." };
  }

  const x = buildOverlapAxis(leftX, rightX);
  const y = buildOverlapAxis(leftY, rightY);
  if (!x || !y) {
    return {
      note:
        "Delta map unavailable because Case A and B domains do not overlap enough for interpolation.",
    };
  }

  const z = y.map((yValue) =>
    x.map((xValue) => {
      const rightValue = bilinearSample(rightGrid, rightX, rightY, xValue, yValue);
      const leftValue = bilinearSample(leftGrid, leftX, leftY, xValue, yValue);
      if (!Number.isFinite(rightValue) || !Number.isFinite(leftValue)) {
        return Number.NaN;
      }
      return (rightValue as number) - (leftValue as number);
    })
  );
  return {
    x,
    y,
    z,
    note: "Interpolated delta on overlap region (mesh/domain were different).",
  };
};

const getReferenceScale = (grid?: number[][]) => {
  const values = flattenFiniteGrid(grid).map((value) => Math.abs(value));
  if (values.length === 0) {
    return 1.0;
  }
  const max = Math.max(...values);
  return max > 1e-12 ? max : 1.0;
};

const normalizeDeltaFieldByReference = (
  delta: DeltaField,
  referenceGrid?: number[][],
  referenceLabel = "Case A max"
): DeltaField => {
  if (!delta.z || delta.z.length === 0) {
    return delta;
  }
  const scale = getReferenceScale(referenceGrid);
  const z = delta.z.map((row) =>
    row.map((value) => {
      if (!Number.isFinite(value)) {
        return Number.NaN;
      }
      const normalized = value / scale;
      return Math.max(-1, Math.min(1, normalized));
    })
  );
  const priorNote = delta.note ? `${delta.note} ` : "";
  return {
    ...delta,
    z,
    note: `${priorNote}| normalized by ${referenceLabel} (${scale.toExponential(3)}), clipped to [-1, 1].`,
  };
};

const dedupe = (rows: (string | undefined)[]) =>
  Array.from(new Set(rows.filter((row): row is string => Boolean(row))));

const ComparePage = ({
  seedForm,
  seedShapes,
  onBackToSimulator,
  onRunningChange,
  buildPayload,
}: ComparePageProps) => {
  const [leftForm, setLeftForm] = useState<SidebarState>(() => normalizeCompareForm(seedForm));
  const [rightForm, setRightForm] = useState<SidebarState>(() => normalizeCompareForm(seedForm));
  const [leftShapes, setLeftShapes] = useState<GeometryShape[]>(() => cloneShapes(seedShapes));
  const [rightShapes, setRightShapes] = useState<GeometryShape[]>(() => cloneShapes(seedShapes));
  const [leftSelectedId, setLeftSelectedId] = useState<string | null>(null);
  const [rightSelectedId, setRightSelectedId] = useState<string | null>(null);
  const [leftResult, setLeftResult] = useState<SimulationResult | null>(null);
  const [rightResult, setRightResult] = useState<SimulationResult | null>(null);
  const [leftError, setLeftError] = useState<string | null>(null);
  const [rightError, setRightError] = useState<string | null>(null);
  const [leftRunning, setLeftRunning] = useState(false);
  const [rightRunning, setRightRunning] = useState(false);
  const [fieldRenderMode, setFieldRenderMode] = useState<"isoband" | "contour">("isoband");
  const [colorScaleMode, setColorScaleMode] = useState<"log" | "linear">("linear");
  const [legendMode, setLegendMode] = useState<"fixed" | "auto_shared">("auto_shared");
  const [legendEMax, setLegendEMax] = useState(REF_E_RANGE[1]);
  const [legendNeMax, setLegendNeMax] = useState(REF_NE_RANGE[1]);
  const [viewLayers, setViewLayers] = useState<Record<ViewLayerKey, boolean>>({
    efield: true,
    ne: true,
    volumeLossDensity: true,
    sheath: true,
  });
  const [deltaPanels, setDeltaPanels] = useState({
    parameter: false,
    geometry: false,
    result: false,
  });
  const [sharedControlPanels, setSharedControlPanels] = useState<Record<SharedControlPanelKey, boolean>>({
    mesh: false,
    inlet: false,
    pump: false,
    dcBias: false,
    resultCurves: false,
  });
  const leftAbortRef = useRef<AbortController | null>(null);
  const rightAbortRef = useRef<AbortController | null>(null);
  const runBothAbortRef = useRef(false);

  const handleSharedPanelToggle =
    (panel: SharedControlPanelKey) => (event: React.SyntheticEvent<HTMLDetailsElement>) => {
      const nextOpen = event.currentTarget.open;
      setSharedControlPanels((prev) =>
        prev[panel] === nextOpen ? prev : { ...prev, [panel]: nextOpen }
      );
    };

  const setSharedPanelOpen = (panel: SharedControlPanelKey, open: boolean) => {
    setSharedControlPanels((prev) => (prev[panel] === open ? prev : { ...prev, [panel]: open }));
  };

  const expandCasePanelsForGeometryEdit = () => {
    setSharedControlPanels((prev) => ({
      ...prev,
      mesh: true,
      inlet: true,
      pump: true,
    }));
  };

  const getPumpTagOptions = (shapes: GeometryShape[], currentTag?: string) => {
    const tags = Array.from(
      new Set(
        shapes
          .filter((shape) => shape.group !== "chamber")
          .filter((shape) => shape.tag.trim().length > 0)
          .filter(
            (shape) =>
              shape.role === "pumping_port" ||
              shape.tag.toLowerCase().includes("pump") ||
              shape.label.toLowerCase().includes("pump")
          )
          .map((shape) => shape.tag.trim())
      )
    );
    const ordered = Array.from(new Set(["bottom_pump", ...tags])).sort((a, b) =>
      a.localeCompare(b)
    );
    if (currentTag && !ordered.includes(currentTag)) {
      return [currentTag, ...ordered];
    }
    return ordered;
  };

  const getInletTagOptions = (shapes: GeometryShape[], currentTag?: string) => {
    const tags = Array.from(
      new Set(
        shapes
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
          .map((shape) => shape.tag.trim())
      )
    );
    const ordered = Array.from(new Set(["showerhead", ...tags])).sort((a, b) =>
      a.localeCompare(b)
    );
    if (currentTag && !ordered.includes(currentTag)) {
      return [currentTag, ...ordered];
    }
    return ordered;
  };

  const getRfSourceTagOptions = (shapes: GeometryShape[]) =>
    Array.from(
      new Set(
        shapes
          .filter((shape) => shape.group !== "chamber")
          .filter((shape) => shape.type !== "line")
          .filter((shape) => shape.tag.trim().length > 0)
          .filter(
            (shape) =>
              shape.role === "powered_electrode" ||
              shape.tag.toLowerCase().includes("rf") ||
              shape.tag.toLowerCase().includes("powered") ||
              shape.tag.toLowerCase().includes("source") ||
              shape.label.toLowerCase().includes("rf") ||
              shape.label.toLowerCase().includes("source")
          )
          .map((shape) => shape.tag.trim())
      )
    ).sort((a, b) => a.localeCompare(b));

  const getDcBiasTagOptions = (shapes: GeometryShape[]) =>
    Array.from(
      new Set(
        shapes
          .filter((shape) => shape.group !== "chamber")
          .filter((shape) => shape.type !== "line")
          .filter((shape) => shape.tag.trim().length > 0)
          .map((shape) => shape.tag.trim())
      )
    ).sort((a, b) => a.localeCompare(b));

  const updateLeftPump = (patch: Partial<SidebarState["pumpPorts"][number]>) => {
    setLeftForm((prev) => {
      const ensured = ensureFirstPumpPort(prev);
      const [first, ...rest] = ensured.pumpPorts;
      return { ...ensured, pumpPorts: [{ ...first, ...patch }, ...rest] };
    });
  };

  const updateRightPump = (patch: Partial<SidebarState["pumpPorts"][number]>) => {
    setRightForm((prev) => {
      const ensured = ensureFirstPumpPort(prev);
      const [first, ...rest] = ensured.pumpPorts;
      return { ...ensured, pumpPorts: [{ ...first, ...patch }, ...rest] };
    });
  };

  const updateLeftPrimarySource = (
    patch: Partial<SidebarState["plasmaSources"][number]>
  ) => {
    setLeftForm((prev) => {
      const primary = buildPrimarySource(prev, patch);
      return {
        ...prev,
        plasmaSources: [primary],
        rf_power_W: primary.rf_power_W,
        frequency_Hz: primary.frequency_Hz,
      };
    });
  };

  const updateRightPrimarySource = (
    patch: Partial<SidebarState["plasmaSources"][number]>
  ) => {
    setRightForm((prev) => {
      const primary = buildPrimarySource(prev, patch);
      return {
        ...prev,
        plasmaSources: [primary],
        rf_power_W: primary.rf_power_W,
        frequency_Hz: primary.frequency_Hz,
      };
    });
  };

  const makeGasId = (side: "left" | "right") =>
    `cmp-${side}-gas-${Date.now()}-${Math.floor(Math.random() * 1000)}`;

  const updateLeftGas = (id: string, patch: Partial<SidebarState["gasComponents"][number]>) => {
    setLeftForm((prev) => ({
      ...prev,
      gasComponents: prev.gasComponents.map((row) =>
        row.id === id ? { ...row, ...patch } : row
      ),
    }));
  };

  const updateRightGas = (id: string, patch: Partial<SidebarState["gasComponents"][number]>) => {
    setRightForm((prev) => ({
      ...prev,
      gasComponents: prev.gasComponents.map((row) =>
        row.id === id ? { ...row, ...patch } : row
      ),
    }));
  };

  const addLeftGas = () => {
    setLeftForm((prev) => {
      const used = new Set(prev.gasComponents.map((row) => row.species));
      const next = GAS_OPTIONS.find((opt) => !used.has(opt.value))?.value ?? "Ar";
      return {
        ...prev,
        gasComponents: [
          ...prev.gasComponents,
          { id: makeGasId("left"), species: next, flow_sccm: 5.0 },
        ],
      };
    });
  };

  const addRightGas = () => {
    setRightForm((prev) => {
      const used = new Set(prev.gasComponents.map((row) => row.species));
      const next = GAS_OPTIONS.find((opt) => !used.has(opt.value))?.value ?? "Ar";
      return {
        ...prev,
        gasComponents: [
          ...prev.gasComponents,
          { id: makeGasId("right"), species: next, flow_sccm: 5.0 },
        ],
      };
    });
  };

  const removeLeftGas = (id: string) => {
    setLeftForm((prev) => {
      if (prev.gasComponents.length <= 1) {
        return prev;
      }
      return { ...prev, gasComponents: prev.gasComponents.filter((row) => row.id !== id) };
    });
  };

  const removeRightGas = (id: string) => {
    setRightForm((prev) => {
      if (prev.gasComponents.length <= 1) {
        return prev;
      }
      return { ...prev, gasComponents: prev.gasComponents.filter((row) => row.id !== id) };
    });
  };

  const updateLeftDcBiasRegion = (id: string, patch: Partial<DCBiasRegionState>) => {
    setLeftForm((prev) => ({
      ...prev,
      dcBiasRegions: prev.dcBiasRegions.map((row) =>
        row.id === id
          ? {
              ...row,
              ...patch,
              dc_bias_V: patch.dc_bias_V !== undefined
                ? clampFinite(patch.dc_bias_V, row.dc_bias_V, -5000, 5000)
                : row.dc_bias_V,
            }
          : row
      ),
    }));
  };

  const updateRightDcBiasRegion = (id: string, patch: Partial<DCBiasRegionState>) => {
    setRightForm((prev) => ({
      ...prev,
      dcBiasRegions: prev.dcBiasRegions.map((row) =>
        row.id === id
          ? {
              ...row,
              ...patch,
              dc_bias_V: patch.dc_bias_V !== undefined
                ? clampFinite(patch.dc_bias_V, row.dc_bias_V, -5000, 5000)
                : row.dc_bias_V,
            }
          : row
      ),
    }));
  };

  const addLeftDcBiasRegion = () => {
    setLeftForm((prev) => {
      if (prev.dcBiasRegions.length >= 16) {
        return prev;
      }
      const usedTags = new Set(prev.dcBiasRegions.map((row) => row.target_tag));
      const nextTag =
        leftDcBiasTagOptions.find((tag) => !usedTags.has(tag)) ??
        leftDcBiasTagOptions[0] ??
        "";
      return {
        ...prev,
        dcBiasRegions: [
          ...prev.dcBiasRegions,
          makeDcBiasRegion("left", prev.dcBiasRegions.length, {
            id: makeDcBiasId("left"),
            target_tag: nextTag,
          }),
        ],
      };
    });
  };

  const addRightDcBiasRegion = () => {
    setRightForm((prev) => {
      if (prev.dcBiasRegions.length >= 16) {
        return prev;
      }
      const usedTags = new Set(prev.dcBiasRegions.map((row) => row.target_tag));
      const nextTag =
        rightDcBiasTagOptions.find((tag) => !usedTags.has(tag)) ??
        rightDcBiasTagOptions[0] ??
        "";
      return {
        ...prev,
        dcBiasRegions: [
          ...prev.dcBiasRegions,
          makeDcBiasRegion("right", prev.dcBiasRegions.length, {
            id: makeDcBiasId("right"),
            target_tag: nextTag,
          }),
        ],
      };
    });
  };

  const removeLeftDcBiasRegion = (id: string) => {
    setLeftForm((prev) => ({
      ...prev,
      dcBiasRegions: prev.dcBiasRegions.filter((row) => row.id !== id),
    }));
  };

  const removeRightDcBiasRegion = (id: string) => {
    setRightForm((prev) => ({
      ...prev,
      dcBiasRegions: prev.dcBiasRegions.filter((row) => row.id !== id),
    }));
  };

  const buildComparePayloadForRun = (
    form: SidebarState,
    shapes: GeometryShape[]
  ): SimulationRequestPayload => {
    const payload = buildPayload(form, shapes);
    return {
      ...payload,
      outputs: toOutputSelectionPayload(viewLayers),
    };
  };

  const abortCase = (side: "left" | "right") => {
    if (side === "left") {
      runBothAbortRef.current = true;
      if (leftAbortRef.current) {
        leftAbortRef.current.abort();
        leftAbortRef.current = null;
      }
      return;
    }
    runBothAbortRef.current = true;
    if (rightAbortRef.current) {
      rightAbortRef.current.abort();
      rightAbortRef.current = null;
    }
  };

  const abortAllCases = () => {
    runBothAbortRef.current = true;
    if (leftAbortRef.current) {
      leftAbortRef.current.abort();
      leftAbortRef.current = null;
    }
    if (rightAbortRef.current) {
      rightAbortRef.current.abort();
      rightAbortRef.current = null;
    }
  };

  const runCase = async (side: "left" | "right") => {
    if (side === "left") {
      if (leftRunning) {
        abortCase("left");
        return;
      }
      runBothAbortRef.current = false;
      const controller = new AbortController();
      leftAbortRef.current = controller;
      setLeftRunning(true);
      setLeftError(null);
      const payload = buildComparePayloadForRun(leftForm, leftShapes);
      const { result, error, aborted } = await fetchSimulationResult(payload, controller.signal);
      if (leftAbortRef.current === controller) {
        leftAbortRef.current = null;
      }
      if (!aborted) {
        setLeftResult(result);
      }
      setLeftError(error);
      setLeftRunning(false);
      return;
    }

    if (rightRunning) {
      abortCase("right");
      return;
    }
    runBothAbortRef.current = false;
    const controller = new AbortController();
    rightAbortRef.current = controller;
    setRightRunning(true);
    setRightError(null);
    const payload = buildComparePayloadForRun(rightForm, rightShapes);
    const { result, error, aborted } = await fetchSimulationResult(payload, controller.signal);
    if (rightAbortRef.current === controller) {
      rightAbortRef.current = null;
    }
    if (!aborted) {
      setRightResult(result);
    }
    setRightError(error);
    setRightRunning(false);
  };

  const runBoth = async () => {
    if (leftRunning || rightRunning) {
      abortAllCases();
      return;
    }
    runBothAbortRef.current = false;
    // Run sequentially to reduce CPU contention and timeout risk on single-node backend.
    await runCase("left");
    if (runBothAbortRef.current) {
      return;
    }
    await runCase("right");
  };

  useEffect(() => {
    onRunningChange?.(leftRunning || rightRunning);
  }, [leftRunning, onRunningChange, rightRunning]);

  useEffect(
    () => () => {
      if (leftAbortRef.current) {
        leftAbortRef.current.abort();
        leftAbortRef.current = null;
      }
      if (rightAbortRef.current) {
        rightAbortRef.current.abort();
        rightAbortRef.current = null;
      }
      onRunningChange?.(false);
    },
    [onRunningChange]
  );

  const copyLeftToRight = (options?: { includeGeometry?: boolean }) => {
    const includeGeometry = options?.includeGeometry ?? true;
    setRightForm(normalizeCompareForm(leftForm));
    if (includeGeometry) {
      setRightShapes(cloneShapes(leftShapes));
    }
    setRightResult(null);
    setRightError(null);
    setRightSelectedId(null);
  };

  const leftPump = firstPumpPort(leftForm);
  const rightPump = firstPumpPort(rightForm);
  const leftPumpTagOptions = useMemo(
    () => getPumpTagOptions(leftShapes, leftPump?.surface_tag),
    [leftPump?.surface_tag, leftShapes]
  );
  const rightPumpTagOptions = useMemo(
    () => getPumpTagOptions(rightShapes, rightPump?.surface_tag),
    [rightPump?.surface_tag, rightShapes]
  );
  const leftInletTagOptions = useMemo(
    () => getInletTagOptions(leftShapes, leftForm.inletSurfaceTag),
    [leftForm.inletSurfaceTag, leftShapes]
  );
  const rightInletTagOptions = useMemo(
    () => getInletTagOptions(rightShapes, rightForm.inletSurfaceTag),
    [rightForm.inletSurfaceTag, rightShapes]
  );
  const leftRfSourceTagOptions = useMemo(
    () => getRfSourceTagOptions(leftShapes),
    [leftShapes]
  );
  const rightRfSourceTagOptions = useMemo(
    () => getRfSourceTagOptions(rightShapes),
    [rightShapes]
  );
  const leftDcBiasTagOptions = useMemo(
    () => getDcBiasTagOptions(leftShapes),
    [leftShapes]
  );
  const rightDcBiasTagOptions = useMemo(
    () => getDcBiasTagOptions(rightShapes),
    [rightShapes]
  );
  const showLeftRfSourceControls = leftRfSourceTagOptions.length > 0;
  const showRightRfSourceControls = rightRfSourceTagOptions.length > 0;

  useEffect(() => {
    if (leftRfSourceTagOptions.length === 0) {
      return;
    }
    setLeftForm((prev) => {
      const primary = buildPrimarySource(prev);
      if (leftRfSourceTagOptions.includes(primary.surface_tag)) {
        return prev;
      }
      const aligned = buildPrimarySource(prev, {
        surface_tag: leftRfSourceTagOptions[0],
      });
      return {
        ...prev,
        plasmaSources: [aligned],
        rf_power_W: aligned.rf_power_W,
        frequency_Hz: aligned.frequency_Hz,
      };
    });
  }, [leftRfSourceTagOptions]);

  useEffect(() => {
    if (rightRfSourceTagOptions.length === 0) {
      return;
    }
    setRightForm((prev) => {
      const primary = buildPrimarySource(prev);
      if (rightRfSourceTagOptions.includes(primary.surface_tag)) {
        return prev;
      }
      const aligned = buildPrimarySource(prev, {
        surface_tag: rightRfSourceTagOptions[0],
      });
      return {
        ...prev,
        plasmaSources: [aligned],
        rf_power_W: aligned.rf_power_W,
        frequency_Hz: aligned.frequency_Hz,
      };
    });
  }, [rightRfSourceTagOptions]);

  useEffect(() => {
    setLeftForm((prev) => {
      const normalized = normalizeDcBiasRows(prev.dcBiasRegions, leftDcBiasTagOptions, "left");
      if (
        prev.dcBiasRegions.length === normalized.length &&
        prev.dcBiasRegions.every((row, idx) => {
          const next = normalized[idx];
          return (
            next &&
            row.id === next.id &&
            row.target_tag === next.target_tag &&
            isNumberClose(row.dc_bias_V, next.dc_bias_V)
          );
        })
      ) {
        return prev;
      }
      return {
        ...prev,
        dcBiasRegions: normalized,
      };
    });
  }, [leftDcBiasTagOptions]);

  useEffect(() => {
    setRightForm((prev) => {
      const normalized = normalizeDcBiasRows(prev.dcBiasRegions, rightDcBiasTagOptions, "right");
      if (
        prev.dcBiasRegions.length === normalized.length &&
        prev.dcBiasRegions.every((row, idx) => {
          const next = normalized[idx];
          return (
            next &&
            row.id === next.id &&
            row.target_tag === next.target_tag &&
            isNumberClose(row.dc_bias_V, next.dc_bias_V)
          );
        })
      ) {
        return prev;
      }
      return {
        ...prev,
        dcBiasRegions: normalized,
      };
    });
  }, [rightDcBiasTagOptions]);

  const parameterRows = useMemo<ParameterRow[]>(() => {
    const rows: ParameterRow[] = [
      {
        label: "Domain r_max (mm)",
        left: leftForm.r_max_mm.toFixed(2),
        right: rightForm.r_max_mm.toFixed(2),
        changed: !isNumberClose(leftForm.r_max_mm, rightForm.r_max_mm),
      },
      {
        label: "Domain z_max (mm)",
        left: leftForm.z_max_mm.toFixed(2),
        right: rightForm.z_max_mm.toFixed(2),
        changed: !isNumberClose(leftForm.z_max_mm, rightForm.z_max_mm),
      },
      {
        label: "Mesh (nr x nz)",
        left: `${leftForm.nr} x ${leftForm.nz}`,
        right: `${rightForm.nr} x ${rightForm.nz}`,
        changed: leftForm.nr !== rightForm.nr || leftForm.nz !== rightForm.nz,
      },
      {
        label: "Pressure (Torr)",
        left: leftForm.pressure_Torr.toFixed(3),
        right: rightForm.pressure_Torr.toFixed(3),
        changed: !isNumberClose(leftForm.pressure_Torr, rightForm.pressure_Torr),
      },
      {
        label: "RF Power (W)",
        left: leftForm.rf_power_W.toFixed(2),
        right: rightForm.rf_power_W.toFixed(2),
        changed: !isNumberClose(leftForm.rf_power_W, rightForm.rf_power_W),
      },
      {
        label: "Frequency (Hz)",
        left: leftForm.frequency_Hz.toFixed(0),
        right: rightForm.frequency_Hz.toFixed(0),
        changed: !isNumberClose(leftForm.frequency_Hz, rightForm.frequency_Hz),
      },
      {
        label: "DC Bias (V)",
        left: leftForm.dc_bias_V.toFixed(1),
        right: rightForm.dc_bias_V.toFixed(1),
        changed: !isNumberClose(leftForm.dc_bias_V, rightForm.dc_bias_V),
      },
      {
        label: "RF Sources",
        left: rfSourceSummary(leftForm),
        right: rfSourceSummary(rightForm),
        changed: rfSourceSummary(leftForm) !== rfSourceSummary(rightForm),
      },
      {
        label: "DC Bias by Geometry",
        left:
          leftForm.dcBiasRegions.length === 0
            ? "-"
            : leftForm.dcBiasRegions
                .map((row) => `${row.target_tag}:${row.dc_bias_V.toFixed(1)}V`)
                .join("\n"),
        right:
          rightForm.dcBiasRegions.length === 0
            ? "-"
            : rightForm.dcBiasRegions
                .map((row) => `${row.target_tag}:${row.dc_bias_V.toFixed(1)}V`)
                .join("\n"),
        changed:
          leftForm.dcBiasRegions
            .map((row) => `${row.target_tag}:${row.dc_bias_V.toFixed(3)}`)
            .join("|") !==
          rightForm.dcBiasRegions
            .map((row) => `${row.target_tag}:${row.dc_bias_V.toFixed(3)}`)
            .join("|"),
      },
      {
        label: "Gas Mixture",
        left: gasSummary(leftForm),
        right: gasSummary(rightForm),
        changed: gasSummary(leftForm) !== gasSummary(rightForm),
      },
      {
        label: "Total Gas Flow (sccm)",
        left: totalGasFlow(leftForm).toFixed(2),
        right: totalGasFlow(rightForm).toFixed(2),
        changed: !isNumberClose(totalGasFlow(leftForm), totalGasFlow(rightForm)),
      },
      {
        label: "Gas Inlet",
        left: inletSummary(leftForm),
        right: inletSummary(rightForm),
        changed: inletSummary(leftForm) !== inletSummary(rightForm),
      },
      {
        label: "Pumping Ports",
        left: pumpSummary(leftForm),
        right: pumpSummary(rightForm),
        changed: pumpSummary(leftForm) !== pumpSummary(rightForm),
      },
      {
        label: "Baseline Delta",
        left: leftForm.baselineEnabled ? "On" : "Off",
        right: rightForm.baselineEnabled ? "On" : "Off",
        changed: leftForm.baselineEnabled !== rightForm.baselineEnabled,
      },
      {
        label: "Default epsilon_r",
        left: leftForm.epsilon_r.toFixed(3),
        right: rightForm.epsilon_r.toFixed(3),
        changed: !isNumberClose(leftForm.epsilon_r, rightForm.epsilon_r),
      },
      {
        label: "Wall loss",
        left: leftForm.wall_loss_e.toFixed(3),
        right: rightForm.wall_loss_e.toFixed(3),
        changed: !isNumberClose(leftForm.wall_loss_e, rightForm.wall_loss_e),
      },
      {
        label: "Geometry Count",
        left: String(leftShapes.length),
        right: String(rightShapes.length),
        changed: leftShapes.length !== rightShapes.length,
      },
    ];
    return rows;
  }, [leftForm, leftShapes, rightForm, rightShapes]);

  const geometryDiff = useMemo(() => {
    const leftMap = new Map(leftShapes.map((shape) => [shape.tag, shape]));
    const rightMap = new Map(rightShapes.map((shape) => [shape.tag, shape]));

    const added: ShapeDiffItem[] = [];
    const removed: ShapeDiffItem[] = [];
    const updated: ShapeDiffItem[] = [];

    rightMap.forEach((shape, tag) => {
      if (!leftMap.has(tag)) {
        added.push({ tag, label: shape.label, reason: "added" });
      }
    });

    leftMap.forEach((shape, tag) => {
      if (!rightMap.has(tag)) {
        removed.push({ tag, label: shape.label, reason: "removed" });
        return;
      }
      const rightShape = rightMap.get(tag);
      if (rightShape && shapeSignature(shape) !== shapeSignature(rightShape)) {
        updated.push({ tag, label: rightShape.label, reason: "updated" });
      }
    });

    return {
      added: added.sort((a, b) => a.tag.localeCompare(b.tag)),
      removed: removed.sort((a, b) => a.tag.localeCompare(b.tag)),
      updated: updated.sort((a, b) => a.tag.localeCompare(b.tag)),
    };
  }, [leftShapes, rightShapes]);

  const resultMetricRows = useMemo<ResultMetricRow[]>(() => {
    const leftSheathMean = leftResult?.sheath_metrics?.thickness_mean_mm ?? null;
    const rightSheathMean = rightResult?.sheath_metrics?.thickness_mean_mm ?? null;
    const leftEta = leftResult?.metadata?.eta ?? null;
    const rightEta = rightResult?.metadata?.eta ?? null;
    const leftE = mean(leftResult?.insights?.E_on_sheath_by_r);
    const rightE = mean(rightResult?.insights?.E_on_sheath_by_r);
    const leftNe = mean(leftResult?.insights?.ne_on_sheath_by_r);
    const rightNe = mean(rightResult?.insights?.ne_on_sheath_by_r);
    const leftVld = mean(flattenFiniteGrid(leftResult?.fields?.volume_loss_density));
    const rightVld = mean(flattenFiniteGrid(rightResult?.fields?.volume_loss_density));

    const makeRow = (
      label: string,
      left: number | null,
      right: number | null,
      digits = 3
    ): ResultMetricRow => {
      const delta = left !== null && right !== null ? right - left : null;
      return {
        label,
        left: formatNumber(left, digits),
        right: formatNumber(right, digits),
        delta: formatNumber(delta, digits),
        changed: left !== null && right !== null && !isNumberClose(left, right, 1e-5),
      };
    };

    return [
      makeRow("eta", leftEta, rightEta, 4),
      makeRow("Sheath thickness mean (mm)", leftSheathMean, rightSheathMean, 3),
      makeRow("E on sheath mean", leftE, rightE, 4),
      makeRow("ne on sheath mean", leftNe, rightNe, 4),
      makeRow("Power Absorption Density mean (rel W/mm^3)", leftVld, rightVld, 4),
    ];
  }, [leftResult, rightResult]);
  const changedParameterCount = useMemo(
    () => parameterRows.filter((row) => row.changed).length,
    [parameterRows]
  );
  const changedResultMetricCount = useMemo(
    () => resultMetricRows.filter((row) => row.changed).length,
    [resultMetricRows]
  );
  const geometryDeltaCount = useMemo(
    () => geometryDiff.added.length + geometryDiff.removed.length + geometryDiff.updated.length,
    [geometryDiff.added.length, geometryDiff.removed.length, geometryDiff.updated.length]
  );

  const leftEForPlot = leftResult?.fields?.E_mag;
  const rightEForPlot = rightResult?.fields?.E_mag;
  const leftNeForPlot = leftResult?.fields?.ne;
  const rightNeForPlot = rightResult?.fields?.ne;

  const sharedVldRange = useMemo(
    () =>
      getPositiveMinMax(
        leftResult?.fields?.volume_loss_density,
        rightResult?.fields?.volume_loss_density
      ),
    [leftResult?.fields?.volume_loss_density, rightResult?.fields?.volume_loss_density]
  );

  const leftVldForPlot = useMemo(
    () => buildLogScaledGrid(leftResult?.fields?.volume_loss_density, sharedVldRange),
    [leftResult?.fields?.volume_loss_density, sharedVldRange]
  );

  const rightVldForPlot = useMemo(
    () => buildLogScaledGrid(rightResult?.fields?.volume_loss_density, sharedVldRange),
    [rightResult?.fields?.volume_loss_density, sharedVldRange]
  );

  const eColorRange = useMemo(() => {
    if (legendMode === "fixed") {
      const fixedMax = Math.max(0.001, legendEMax);
      return { zMin: 0, zMax: fixedMax };
    }
    return getSharedColorRange(leftEForPlot, rightEForPlot);
  }, [leftEForPlot, legendEMax, legendMode, rightEForPlot]);

  const neColorRange = useMemo(() => {
    if (legendMode === "fixed") {
      const fixedMax = Math.max(0.001, legendNeMax);
      return { zMin: 0, zMax: fixedMax };
    }
    return getSharedColorRange(leftNeForPlot, rightNeForPlot);
  }, [leftNeForPlot, legendMode, legendNeMax, rightNeForPlot]);

  const eLogRange = useMemo(
    () => getPositiveMinMax(leftResult?.fields?.E_mag, rightResult?.fields?.E_mag),
    [leftResult?.fields?.E_mag, rightResult?.fields?.E_mag]
  );
  const leftELog = useMemo(
    () => buildLogScaledGrid(leftResult?.fields?.E_mag, eLogRange, { nonPositive: "min" }),
    [eLogRange, leftResult?.fields?.E_mag]
  );
  const rightELog = useMemo(
    () => buildLogScaledGrid(rightResult?.fields?.E_mag, eLogRange, { nonPositive: "min" }),
    [eLogRange, rightResult?.fields?.E_mag]
  );

  const neLogRange = useMemo(
    () => getPositiveMinMax(leftResult?.fields?.ne, rightResult?.fields?.ne),
    [leftResult?.fields?.ne, rightResult?.fields?.ne]
  );
  const leftNeLog = useMemo(
    () => buildLogScaledGrid(leftResult?.fields?.ne, neLogRange, { nonPositive: "min" }),
    [leftResult?.fields?.ne, neLogRange]
  );
  const rightNeLog = useMemo(
    () => buildLogScaledGrid(rightResult?.fields?.ne, neLogRange, { nonPositive: "min" }),
    [rightResult?.fields?.ne, neLogRange]
  );

  const vldLinearRange = useMemo(
    () => getFiniteMinMax(leftResult?.fields?.volume_loss_density, rightResult?.fields?.volume_loss_density),
    [leftResult?.fields?.volume_loss_density, rightResult?.fields?.volume_loss_density]
  );
  const vldColorRange = useMemo(
    () =>
      colorScaleMode === "log"
        ? { zMin: leftVldForPlot.logMin, zMax: leftVldForPlot.logMax }
        : { zMin: vldLinearRange?.min, zMax: vldLinearRange?.max },
    [colorScaleMode, leftVldForPlot.logMax, leftVldForPlot.logMin, vldLinearRange?.max, vldLinearRange?.min]
  );
  const vldColorbarTicks = useMemo(
    () =>
      colorScaleMode === "log"
        ? buildLogColorbarTicks(
            vldColorRange.zMin,
            vldColorRange.zMax,
            sharedVldRange?.min,
            sharedVldRange?.max
          )
        : undefined,
    [colorScaleMode, sharedVldRange?.max, sharedVldRange?.min, vldColorRange.zMax, vldColorRange.zMin]
  );
  const eColorbarTicks = useMemo(
    () =>
      colorScaleMode === "log"
        ? buildLogColorbarTicks(leftELog.logMin, leftELog.logMax, leftELog.rawMin, leftELog.rawMax)
        : undefined,
    [colorScaleMode, leftELog.logMax, leftELog.logMin, leftELog.rawMax, leftELog.rawMin]
  );
  const neColorbarTicks = useMemo(
    () =>
      colorScaleMode === "log"
        ? buildLogColorbarTicks(leftNeLog.logMin, leftNeLog.logMax, leftNeLog.rawMin, leftNeLog.rawMax)
        : undefined,
    [colorScaleMode, leftNeLog.logMax, leftNeLog.logMin, leftNeLog.rawMax, leftNeLog.rawMin]
  );

  const eDisplay = useMemo(
    () => ({
      left: colorScaleMode === "log" ? leftELog.grid : leftEForPlot,
      right: colorScaleMode === "log" ? rightELog.grid : rightEForPlot,
      zMin: colorScaleMode === "log" ? leftELog.logMin : eColorRange.zMin,
      zMax: colorScaleMode === "log" ? leftELog.logMax : eColorRange.zMax,
    }),
    [colorScaleMode, eColorRange.zMax, eColorRange.zMin, leftEForPlot, leftELog.grid, leftELog.logMax, leftELog.logMin, rightEForPlot, rightELog.grid]
  );
  const neDisplay = useMemo(
    () => ({
      left: colorScaleMode === "log" ? leftNeLog.grid : leftNeForPlot,
      right: colorScaleMode === "log" ? rightNeLog.grid : rightNeForPlot,
      zMin: colorScaleMode === "log" ? leftNeLog.logMin : neColorRange.zMin,
      zMax: colorScaleMode === "log" ? leftNeLog.logMax : neColorRange.zMax,
    }),
    [colorScaleMode, leftNeForPlot, leftNeLog.grid, leftNeLog.logMax, leftNeLog.logMin, neColorRange.zMax, neColorRange.zMin, rightNeForPlot, rightNeLog.grid]
  );

  const deltaERawField = useMemo(
    () => {
      if (!viewLayers.efield) {
        return { note: "E-Field layer hidden by Compare View Filters." };
      }
      return buildDeltaField(
        leftResult?.fields?.E_mag,
        leftResult?.grid?.r_mm,
        leftResult?.grid?.z_mm,
        rightResult?.fields?.E_mag,
        rightResult?.grid?.r_mm,
        rightResult?.grid?.z_mm
      );
    },
    [
      leftResult?.fields?.E_mag,
      leftResult?.grid?.r_mm,
      leftResult?.grid?.z_mm,
      rightResult?.fields?.E_mag,
      rightResult?.grid?.r_mm,
      rightResult?.grid?.z_mm,
      viewLayers.efield,
    ]
  );
  const deltaEField = useMemo(
    () => {
      if (!viewLayers.efield) {
        return deltaERawField;
      }
      return normalizeDeltaFieldByReference(
        deltaERawField,
        leftResult?.fields?.E_mag,
        "Case A |E| max"
      );
    },
    [deltaERawField, leftResult?.fields?.E_mag, viewLayers.efield]
  );

  const deltaNeRawField = useMemo(
    () => {
      if (!viewLayers.ne) {
        return { note: "ne layer hidden by Compare View Filters." };
      }
      return buildDeltaField(
        leftResult?.fields?.ne,
        leftResult?.grid?.r_mm,
        leftResult?.grid?.z_mm,
        rightResult?.fields?.ne,
        rightResult?.grid?.r_mm,
        rightResult?.grid?.z_mm
      );
    },
    [
      leftResult?.fields?.ne,
      leftResult?.grid?.r_mm,
      leftResult?.grid?.z_mm,
      rightResult?.fields?.ne,
      rightResult?.grid?.r_mm,
      rightResult?.grid?.z_mm,
      viewLayers.ne,
    ]
  );
  const deltaNeField = useMemo(
    () => {
      if (!viewLayers.ne) {
        return deltaNeRawField;
      }
      return normalizeDeltaFieldByReference(
        deltaNeRawField,
        leftResult?.fields?.ne,
        "Case A ne max"
      );
    },
    [deltaNeRawField, leftResult?.fields?.ne, viewLayers.ne]
  );

  const deltaVldRawField = useMemo(
    () => {
      if (!viewLayers.volumeLossDensity) {
        return { note: "Power Absorption Density layer hidden by Compare View Filters." };
      }
      return buildDeltaField(
        leftResult?.fields?.volume_loss_density,
        leftResult?.grid?.r_mm,
        leftResult?.grid?.z_mm,
        rightResult?.fields?.volume_loss_density,
        rightResult?.grid?.r_mm,
        rightResult?.grid?.z_mm
      );
    },
    [
      leftResult?.fields?.volume_loss_density,
      leftResult?.grid?.r_mm,
      leftResult?.grid?.z_mm,
      rightResult?.fields?.volume_loss_density,
      rightResult?.grid?.r_mm,
      rightResult?.grid?.z_mm,
      viewLayers.volumeLossDensity,
    ]
  );
  const deltaVldField = useMemo(
    () => {
      if (!viewLayers.volumeLossDensity) {
        return deltaVldRawField;
      }
      return normalizeDeltaFieldByReference(
        deltaVldRawField,
        leftResult?.fields?.volume_loss_density,
        "Case A PAD max"
      );
    },
    [deltaVldRawField, leftResult?.fields?.volume_loss_density, viewLayers.volumeLossDensity]
  );

  const deltaEColorRange = { zMin: -1, zMax: 1 };
  const deltaNeColorRange = { zMin: -1, zMax: 1 };
  const deltaVldColorRange = { zMin: -1, zMax: 1 };

  const sharedXRange = useMemo(
    () =>
      getSharedAxisRange(
        leftResult?.grid?.r_mm,
        rightResult?.grid?.r_mm,
        Math.max(leftForm.r_max_mm, rightForm.r_max_mm)
      ),
    [leftForm.r_max_mm, leftResult, rightForm.r_max_mm, rightResult]
  );

  const sharedYRange = useMemo(
    () =>
      getSharedAxisRange(
        leftResult?.grid?.z_mm,
        rightResult?.grid?.z_mm,
        Math.max(leftForm.z_max_mm, rightForm.z_max_mm)
      ),
    [leftForm.z_max_mm, leftResult, rightForm.z_max_mm, rightResult]
  );

  const sheathCurveSeries = useMemo<CurveSeries[]>(() => {
    const curves: CurveSeries[] = [];
    if (leftResult?.viz?.r_mm && leftResult.viz.sheath_z_mm_by_r) {
      curves.push({
        x: leftResult.viz.r_mm,
        y: leftResult.viz.sheath_z_mm_by_r,
        name: "Case A Sheath z",
        color: "#118ab2",
      });
    }
    if (rightResult?.viz?.r_mm && rightResult.viz.sheath_z_mm_by_r) {
      curves.push({
        x: rightResult.viz.r_mm,
        y: rightResult.viz.sheath_z_mm_by_r,
        name: "Case B Sheath z",
        color: "#ef476f",
      });
    }
    return curves;
  }, [leftResult, rightResult]);

  const thicknessCurveSeries = useMemo<CurveSeries[]>(() => {
    const curves: CurveSeries[] = [];
    if (leftResult?.viz?.r_mm && leftResult.viz.sheath_thickness_mm_by_r) {
      curves.push({
        x: leftResult.viz.r_mm,
        y: leftResult.viz.sheath_thickness_mm_by_r,
        name: "Case A Thickness",
        color: "#073b4c",
      });
    }
    if (rightResult?.viz?.r_mm && rightResult.viz.sheath_thickness_mm_by_r) {
      curves.push({
        x: rightResult.viz.r_mm,
        y: rightResult.viz.sheath_thickness_mm_by_r,
        name: "Case B Thickness",
        color: "#f78c6b",
      });
    }
    return curves;
  }, [leftResult, rightResult]);

  const leftWarnings = useMemo(
    () =>
      dedupe([
        ...(leftResult?.viz?.warnings || []),
        ...(leftResult?.insights?.warnings || []),
        ...(leftResult?.ion_proxy?.warnings || []),
        ...(leftResult?.sheath_metrics?.warnings || []),
      ]),
    [leftResult]
  );

  const rightWarnings = useMemo(
    () =>
      dedupe([
        ...(rightResult?.viz?.warnings || []),
        ...(rightResult?.insights?.warnings || []),
        ...(rightResult?.ion_proxy?.warnings || []),
        ...(rightResult?.sheath_metrics?.warnings || []),
      ]),
    [rightResult]
  );

  const leftPayloadPreview = useMemo(
    () => buildPayload(leftForm, leftShapes),
    [buildPayload, leftForm, leftShapes]
  );
  const rightPayloadPreview = useMemo(
    () => buildPayload(rightForm, rightShapes),
    [buildPayload, rightForm, rightShapes]
  );
  const leftTagMask = useMemo(
    () => leftResult?.metadata?.geometry?.grid?.tag_mask ?? leftPayloadPreview.geometry.grid.tag_mask,
    [leftPayloadPreview.geometry.grid.tag_mask, leftResult?.metadata?.geometry?.grid?.tag_mask]
  );
  const rightTagMask = useMemo(
    () => rightResult?.metadata?.geometry?.grid?.tag_mask ?? rightPayloadPreview.geometry.grid.tag_mask,
    [rightPayloadPreview.geometry.grid.tag_mask, rightResult?.metadata?.geometry?.grid?.tag_mask]
  );
  const leftVolumeLossRows = useMemo(
    () =>
      viewLayers.volumeLossDensity
        ? buildVolumeLossDensityResultRows(
            leftResult?.fields?.volume_loss_density,
            leftTagMask,
            leftShapes,
            leftResult?.grid?.r_mm,
            leftResult?.grid?.z_mm
          )
        : [],
    [
      leftResult?.fields?.volume_loss_density,
      leftResult?.grid?.r_mm,
      leftResult?.grid?.z_mm,
      leftShapes,
      leftTagMask,
      viewLayers.volumeLossDensity,
    ]
  );
  const rightVolumeLossRows = useMemo(
    () =>
      viewLayers.volumeLossDensity
        ? buildVolumeLossDensityResultRows(
            rightResult?.fields?.volume_loss_density,
            rightTagMask,
            rightShapes,
            rightResult?.grid?.r_mm,
            rightResult?.grid?.z_mm
          )
        : [],
    [
      rightResult?.fields?.volume_loss_density,
      rightResult?.grid?.r_mm,
      rightResult?.grid?.z_mm,
      rightShapes,
      rightTagMask,
      viewLayers.volumeLossDensity,
    ]
  );
  const volumeLossCompareRows = useMemo(
    () =>
      viewLayers.volumeLossDensity
        ? buildVolumeLossDensityCompareRows(leftVolumeLossRows, rightVolumeLossRows)
        : [],
    [leftVolumeLossRows, rightVolumeLossRows, viewLayers.volumeLossDensity]
  );

  const leftInletIndicator = useMemo(
    () =>
      buildInletIndicatorShape(
        leftShapes,
        leftForm.inletSurfaceTag,
        leftForm.inletEmitSide,
        leftForm.inletActiveWidthPercent
      ),
    [
      leftForm.inletActiveWidthPercent,
      leftForm.inletEmitSide,
      leftForm.inletSurfaceTag,
      leftShapes,
    ]
  );

  const leftOverlayShapes = useMemo(
    () => (leftInletIndicator ? [...leftShapes, leftInletIndicator] : leftShapes),
    [leftInletIndicator, leftShapes]
  );

  const rightInletIndicator = useMemo(
    () =>
      buildInletIndicatorShape(
        rightShapes,
        rightForm.inletSurfaceTag,
        rightForm.inletEmitSide,
        rightForm.inletActiveWidthPercent
      ),
    [
      rightForm.inletActiveWidthPercent,
      rightForm.inletEmitSide,
      rightForm.inletSurfaceTag,
      rightShapes,
    ]
  );

  const rightOverlayShapes = useMemo(
    () => (rightInletIndicator ? [...rightShapes, rightInletIndicator] : rightShapes),
    [rightInletIndicator, rightShapes]
  );

  const leftMeshSummary = `${leftForm.nr} x ${leftForm.nz}`;
  const rightMeshSummary = `${rightForm.nr} x ${rightForm.nz}`;
  const leftAdvancedSummary = `eps ${leftForm.epsilon_r.toFixed(2)} | wall ${leftForm.wall_loss_e.toFixed(2)}`;
  const rightAdvancedSummary = `eps ${rightForm.epsilon_r.toFixed(2)} | wall ${rightForm.wall_loss_e.toFixed(2)}`;
  const leftInletSummaryText = `${leftForm.inletSurfaceTag} | ${leftForm.inletDirection} | ${leftForm.inletEmitSide}`;
  const rightInletSummaryText = `${rightForm.inletSurfaceTag} | ${rightForm.inletDirection} | ${rightForm.inletEmitSide}`;
  const leftPumpSummaryText = leftPump
    ? `${leftPump.surface_tag} | x${leftPump.strength.toFixed(2)}`
    : "No pump";
  const rightPumpSummaryText = rightPump
    ? `${rightPump.surface_tag} | x${rightPump.strength.toFixed(2)}`
    : "No pump";
  const leftDcBiasSummaryText =
    leftForm.dcBiasRegions.length > 0
      ? leftForm.dcBiasRegions
          .map((row) => `${row.target_tag}:${row.dc_bias_V.toFixed(1)}V`)
          .join(" | ")
      : "none";
  const rightDcBiasSummaryText =
    rightForm.dcBiasRegions.length > 0
      ? rightForm.dcBiasRegions
          .map((row) => `${row.target_tag}:${row.dc_bias_V.toFixed(1)}V`)
          .join(" | ")
      : "none";

  const syncSelectionByTag = (side: "left" | "right", selectedId: string | null) => {
    if (!selectedId) {
      if (side === "left") {
        setLeftSelectedId(null);
      } else {
        setRightSelectedId(null);
      }
      return;
    }
    const sourceShapes = side === "left" ? leftShapes : rightShapes;
    const targetShapes = side === "left" ? rightShapes : leftShapes;
    const source = sourceShapes.find((shape) => shape.id === selectedId);
    if (!source) {
      return;
    }
    const target = targetShapes.find((shape) => shape.tag === source.tag);
    if (side === "left") {
      setLeftSelectedId(selectedId);
      setRightSelectedId(target?.id ?? null);
    } else {
      setRightSelectedId(selectedId);
      setLeftSelectedId(target?.id ?? null);
    }
  };

  const showEField = viewLayers.efield;
  const showNe = viewLayers.ne;
  const showVolumeLossDensity = viewLayers.volumeLossDensity;
  const showSheath = viewLayers.sheath;
  const resultCurveSummary = showSheath
    ? `${sheathCurveSeries.length + thicknessCurveSeries.length} curves available`
    : "Sheath layer hidden";

  const leftFieldRevision = `${leftResult?.metadata?.request_id ?? "left-empty"}:${fieldRenderMode}:${legendMode}:${colorScaleMode}`;
  const rightFieldRevision = `${rightResult?.metadata?.request_id ?? "right-empty"}:${fieldRenderMode}:${legendMode}:${colorScaleMode}`;

  return (
    <div className="compare-page">
      <header className="compare-header">
        <div>
          <h2>Dual Compare Workspace</h2>
          <p>Parameter + geometry + simulation result are editable side-by-side in one page. A and B run sequentially to reduce timeout risk.</p>
          <p className="compare-disclaimer">
            For detailed absolute plasma certification, use qualified commercial simulation software and calibrated metrology.
          </p>
        </div>
        <div className="compare-actions">
          <button
            type="button"
            className="ghost-button primary-run-button"
            onClick={runBoth}
          >
            {leftRunning || rightRunning ? "Abort Compare Run" : "Run Compare Simulation (A->B)"}
          </button>
          <button
            type="button"
            className="ghost-button"
            onClick={() => {
              setLeftForm(normalizeCompareForm(seedForm));
              setLeftShapes(cloneShapes(seedShapes));
              setLeftResult(null);
              setLeftError(null);
              setLeftSelectedId(null);
            }}
          >
            Reset Left
          </button>
          <button
            type="button"
            className="ghost-button"
            onClick={() => {
              setRightForm(normalizeCompareForm(seedForm));
              setRightShapes(cloneShapes(seedShapes));
              setRightResult(null);
              setRightError(null);
              setRightSelectedId(null);
            }}
          >
            Reset Right
          </button>
          <button
            type="button"
            className="ghost-button"
            onClick={() => copyLeftToRight({ includeGeometry: true })}
          >
            Copy A to B (All)
          </button>
          <button type="button" className="ghost-button" onClick={onBackToSimulator}>
            Back to Simulator
          </button>
        </div>
      </header>

      <section className="summary-grid compare-summary-grid">
        <article className="summary-card">
          <h4>Changed Params</h4>
          <div>{changedParameterCount}</div>
        </article>
        <article className="summary-card">
          <h4>Geometry Added</h4>
          <div>{geometryDiff.added.length}</div>
        </article>
        <article className="summary-card">
          <h4>Geometry Removed</h4>
          <div>{geometryDiff.removed.length}</div>
        </article>
        <article className="summary-card">
          <h4>Geometry Updated</h4>
          <div>{geometryDiff.updated.length}</div>
        </article>
        <article className="summary-card">
          <h4>Result Ready</h4>
          <div>A {leftResult ? "Yes" : "No"}</div>
          <div>B {rightResult ? "Yes" : "No"}</div>
        </article>
      </section>

      <section className="view-layer-panel compare-view-layer-panel">
        <div className="view-layer-head">
          <h3>Compare View Filters (Multi-select)</h3>
          <p>
            Select what to render: E-Field, ne, Power Absorption Density, Sheath.
            Only selected layers are requested from backend during Compare runs.
          </p>
        </div>
        <div className="view-layer-grid">
          {VIEW_LAYER_OPTIONS.map((option) => (
            <label key={`compare-layer-${option.key}`} className="view-layer-chip">
              <input
                type="checkbox"
                checked={viewLayers[option.key]}
                onChange={(event) =>
                  setViewLayers((prev) => ({
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

      <section className="compare-workspace-grid">
        <article className="compare-workspace-card">
          <div className="compare-workspace-head">
            <h3>Case A (Left)</h3>
            <div className="compare-actions-inline">
              <button
                type="button"
                className="ghost-button"
                onClick={() =>
                  setLeftShapes(
                    buildLayerStackExampleShapes({
                      r_max_mm: leftForm.r_max_mm,
                      z_max_mm: leftForm.z_max_mm,
                    })
                  )
                }
              >
                Load Layer Stack
              </button>
              <button
                type="button"
                className="ghost-button"
                onClick={() => runCase("left")}
              >
                {leftRunning ? "Abort A" : "Run A Simulation"}
              </button>
            </div>
          </div>
          {leftError ? <p className="status-error">{leftError}</p> : null}
          <div className="compare-params-grid compare-params-essential">
            <label className="compare-param-field">
              <span>r max (mm)</span>
              <NumberInput
                min={20}
                value={leftForm.r_max_mm}
                onValueChange={(next) => {
                  expandCasePanelsForGeometryEdit();
                  setLeftForm((prev) => ({ ...prev, r_max_mm: next }));
                }}
              />
            </label>
            <label className="compare-param-field">
              <span>z max (mm)</span>
              <NumberInput
                min={20}
                value={leftForm.z_max_mm}
                onValueChange={(next) => {
                  expandCasePanelsForGeometryEdit();
                  setLeftForm((prev) => ({ ...prev, z_max_mm: next }));
                }}
              />
            </label>
            <label className="compare-param-field">
              <span>Pressure (Torr)</span>
              <NumberInput
                step="0.01"
                min={0.01}
                value={leftForm.pressure_Torr}
                onValueChange={(next) => setLeftForm((prev) => ({ ...prev, pressure_Torr: next }))}
              />
            </label>
            <label className="compare-param-field">
              <span>RF Power (W)</span>
              <NumberInput
                step="1"
                min={0}
                value={leftForm.rf_power_W}
                onValueChange={(next) =>
                  updateLeftPrimarySource({
                    rf_power_W: clampFinite(next, leftForm.rf_power_W, 0),
                  })
                }
                onWheel={(e) => (e.currentTarget as HTMLInputElement).blur()}
              />
            </label>
            <label className="compare-param-field">
              <span>Frequency (Hz)</span>
              <NumberInput
                step="1"
                min={1}
                value={leftForm.frequency_Hz}
                onValueChange={(next) =>
                  updateLeftPrimarySource({
                    frequency_Hz: clampFinite(next, leftForm.frequency_Hz, 1),
                  })
                }
                onWheel={(e) => (e.currentTarget as HTMLInputElement).blur()}
              />
            </label>
            <label className="compare-param-field">
              <span>DC Bias (V)</span>
              <NumberInput
                step="1"
                min={-5000}
                max={5000}
                value={leftForm.dc_bias_V}
                onValueChange={(next) =>
                  setLeftForm((prev) => ({
                    ...prev,
                    dc_bias_V: clampFinite(next, prev.dc_bias_V, -5000, 5000),
                  }))
                }
                onWheel={(e) => (e.currentTarget as HTMLInputElement).blur()}
              />
            </label>
            {showLeftRfSourceControls ? (
              <label className="compare-param-field">
                <span>RF source tag</span>
                <select
                  value={leftForm.plasmaSources[0]?.surface_tag || leftRfSourceTagOptions[0]}
                  onChange={(e) =>
                    updateLeftPrimarySource({
                      surface_tag: e.target.value,
                    })
                  }
                >
                  {leftRfSourceTagOptions.map((tag) => (
                    <option key={`left-rf-source-${tag}`} value={tag}>
                      {tag}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
          </div>
          <details
            className="panel-collapsible compare-collapsible"
            open={sharedControlPanels.mesh}
            onToggle={handleSharedPanelToggle("mesh")}
          >
            <summary>
              <span>Mesh / Material / Solver</span>
              <span className="panel-collapsible-summary">
                {leftMeshSummary} | {leftAdvancedSummary}
              </span>
            </summary>
            <div className="panel-collapsible-body">
              <div className="compare-params-grid">
                <label className="compare-param-field">
                  <span>Mesh nr</span>
                  <NumberInput
                    min={MESH_LIMITS.nrMin}
                    max={MESH_LIMITS.nrMax}
                    value={leftForm.nr}
                    onValueChange={(next) =>
                      setLeftForm((prev) => ({ ...prev, nr: Math.round(next) }))
                    }
                  />
                </label>
                <label className="compare-param-field">
                  <span>Mesh nz</span>
                  <NumberInput
                    min={MESH_LIMITS.nzMin}
                    max={MESH_LIMITS.nzMax}
                    value={leftForm.nz}
                    onValueChange={(next) =>
                      setLeftForm((prev) => ({ ...prev, nz: Math.round(next) }))
                    }
                  />
                </label>
                <label className="compare-param-field">
                  <span>Epsilon r</span>
                  <NumberInput
                    min={1}
                    value={leftForm.epsilon_r}
                    onValueChange={(next) => setLeftForm((prev) => ({ ...prev, epsilon_r: next }))}
                  />
                </label>
                <label className="compare-param-field">
                  <span>Wall loss</span>
                  <NumberInput
                    step="0.01"
                    min={0}
                    max={1}
                    value={leftForm.wall_loss_e}
                    onValueChange={(next) => setLeftForm((prev) => ({ ...prev, wall_loss_e: next }))}
                  />
                </label>
                <label className="compare-param-field">
                  <span>Baseline delta</span>
                  <input
                    type="checkbox"
                    checked={leftForm.baselineEnabled}
                    onChange={(e) =>
                      setLeftForm((prev) => ({ ...prev, baselineEnabled: e.target.checked }))
                    }
                  />
                </label>
              </div>
            </div>
          </details>
          <details
            className="panel-collapsible compare-collapsible"
            open={sharedControlPanels.inlet}
            onToggle={handleSharedPanelToggle("inlet")}
          >
            <summary>
              <span>Inlet Controls</span>
              <span className="panel-collapsible-summary">{leftInletSummaryText}</span>
            </summary>
            <div className="panel-collapsible-body">
              <div className="compare-params-grid">
                <label className="compare-param-field">
                  <span>Inlet surface tag</span>
                  <select
                    value={leftForm.inletSurfaceTag}
                    onChange={(e) =>
                      setLeftForm((prev) => ({ ...prev, inletSurfaceTag: e.target.value }))
                    }
                  >
                    {leftInletTagOptions.map((tag) => (
                      <option key={`left-inlet-${tag}`} value={tag}>
                        {tag}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="compare-param-field">
                  <span>Inlet direction</span>
                  <select
                    value={leftForm.inletDirection}
                    onChange={(e) =>
                      setLeftForm((prev) => ({
                        ...prev,
                        inletDirection: e.target.value as InletDirection,
                      }))
                    }
                  >
                    {INLET_DIRECTION_OPTIONS.map((option) => (
                      <option key={`left-dir-${option.value}`} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="compare-param-field">
                  <span>Inlet emit side</span>
                  <select
                    value={leftForm.inletEmitSide}
                    onChange={(e) =>
                      setLeftForm((prev) => ({
                        ...prev,
                        inletEmitSide: e.target.value as InletEmitSide,
                      }))
                    }
                  >
                    {INLET_SIDE_OPTIONS.map((option) => (
                      <option key={`left-side-${option.value}`} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="compare-param-field">
                  <span>Inlet active width (%)</span>
                  <NumberInput
                    min={5}
                    max={100}
                    step={1}
                    value={leftForm.inletActiveWidthPercent}
                    onValueChange={(next) =>
                      setLeftForm((prev) => ({
                        ...prev,
                        inletActiveWidthPercent: next,
                      }))
                    }
                  />
                </label>
              </div>
            </div>
          </details>
          <details
            className="panel-collapsible compare-collapsible"
            open={sharedControlPanels.pump}
            onToggle={handleSharedPanelToggle("pump")}
          >
            <summary>
              <span>Pump Controls</span>
              <span className="panel-collapsible-summary">{leftPumpSummaryText}</span>
            </summary>
            <div className="panel-collapsible-body">
              <div className="compare-params-grid">
                <label className="compare-param-field">
                  <span>Pump surface tag</span>
                  <select
                    value={leftPump?.surface_tag ?? "bottom_pump"}
                    onChange={(e) => updateLeftPump({ surface_tag: e.target.value })}
                  >
                    {leftPumpTagOptions.map((tag) => (
                      <option key={`left-pump-${tag}`} value={tag}>
                        {tag}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="compare-param-field">
                  <span>Pump strength</span>
                  <NumberInput
                    step="0.01"
                    min={0}
                    value={leftPump?.strength ?? 1.0}
                    onValueChange={(next) => updateLeftPump({ strength: next })}
                  />
                </label>
                <label className="compare-param-field">
                  <span>Pump throttle (%)</span>
                  <NumberInput
                    step="0.1"
                    min={0}
                    max={100}
                    value={leftPump?.throttle_percent ?? 100.0}
                    onValueChange={(next) =>
                      updateLeftPump({ throttle_percent: next })
                    }
                  />
                </label>
                <label className="compare-param-field">
                  <span>Pump conductance (L/s)</span>
                  <NumberInput
                    step="1"
                    min={0}
                    value={leftPump?.conductance_lps ?? 220.0}
                    onValueChange={(next) =>
                      updateLeftPump({ conductance_lps: next })
                    }
                  />
                </label>
                <label className="compare-param-field">
                  <span>Pump target pressure (Pa)</span>
                  <NumberInput
                    step="0.1"
                    min={0}
                    value={leftPump?.target_pressure_Pa ?? 8.0}
                    onValueChange={(next) =>
                      updateLeftPump({ target_pressure_Pa: next })
                    }
                  />
                </label>
              </div>
            </div>
          </details>
          <details
            className="panel-collapsible compare-collapsible"
            open={sharedControlPanels.dcBias}
            onToggle={handleSharedPanelToggle("dcBias")}
          >
            <summary>
              <span>DC Bias by Geometry</span>
              <span className="panel-collapsible-summary">{leftDcBiasSummaryText}</span>
            </summary>
            <div className="panel-collapsible-body">
              {leftDcBiasTagOptions.length === 0 ? (
                <p className="compare-note">No structure tags available.</p>
              ) : (
                <>
                  <div className="compare-dc-bias-list">
                    {leftForm.dcBiasRegions.map((row, idx) => (
                      <div className="compare-dc-bias-row" key={`left-dc-bias-${row.id}`}>
                        <select
                          value={row.target_tag}
                          onChange={(e) =>
                            updateLeftDcBiasRegion(row.id, { target_tag: e.target.value })
                          }
                        >
                          {leftDcBiasTagOptions.map((tag) => (
                            <option key={`left-dc-tag-${tag}`} value={tag}>
                              {tag}
                            </option>
                          ))}
                        </select>
                        <NumberInput
                          step={1}
                          min={-5000}
                          max={5000}
                          value={row.dc_bias_V}
                          onValueChange={(next) =>
                            updateLeftDcBiasRegion(row.id, { dc_bias_V: next })
                          }
                        />
                        <button
                          type="button"
                          className="icon-button"
                          onClick={() => removeLeftDcBiasRegion(row.id)}
                          aria-label={`Remove left dc bias row ${idx + 1}`}
                        >
                          -
                        </button>
                      </div>
                    ))}
                  </div>
                  <button
                    type="button"
                    className="ghost-button"
                    onClick={addLeftDcBiasRegion}
                    disabled={leftForm.dcBiasRegions.length >= 16}
                  >
                    + Add DC bias region
                  </button>
                </>
              )}
            </div>
          </details>
          <div className="compare-gas-block">
            <div className="compare-gas-head">
              <span>Gas species</span>
              <span>Flow (sccm)</span>
              <span />
            </div>
            {leftForm.gasComponents.map((row, idx) => (
              <div className="compare-gas-row" key={`left-${row.id}`}>
                <select
                  value={row.species}
                  onChange={(e) => updateLeftGas(row.id, { species: e.target.value })}
                >
                  {GAS_OPTIONS.map((opt) => (
                    <option key={`left-gas-opt-${opt.value}`} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
                <NumberInput
                  min={0}
                  step={0.1}
                  value={row.flow_sccm}
                  onValueChange={(next) => updateLeftGas(row.id, { flow_sccm: next })}
                />
                <button
                  type="button"
                  className="icon-button"
                  onClick={() => removeLeftGas(row.id)}
                  disabled={leftForm.gasComponents.length <= 1}
                  aria-label={`Remove left gas ${idx + 1}`}
                >
                  -
                </button>
              </div>
            ))}
            <button type="button" className="ghost-button" onClick={addLeftGas}>
              + Add gas
            </button>
          </div>
          <p className="compare-note">
            Mesh limits: nr {MESH_LIMITS.nrMin}-{MESH_LIMITS.nrMax}, nz {MESH_LIMITS.nzMin}-{MESH_LIMITS.nzMax}.
          </p>
          <GeometryEditor
            domain={{ r_max_mm: leftForm.r_max_mm, z_max_mm: leftForm.z_max_mm }}
            tool={leftForm.drawTool}
            onToolChange={(tool) => setLeftForm((prev) => ({ ...prev, drawTool: tool }))}
            shapes={leftShapes}
            annotationShapes={leftInletIndicator ? [leftInletIndicator] : []}
            selectedId={leftSelectedId}
            onSelect={(id) => syncSelectionByTag("left", id)}
            onShapesChange={setLeftShapes}
            defaultMaterial={{ epsilon_r: leftForm.epsilon_r, wall_loss_e: leftForm.wall_loss_e }}
            snapToGrid={leftForm.snapToGrid}
            snapStepMm={leftForm.snapStepMm}
          />
        </article>

        <article className="compare-workspace-card">
          <div className="compare-workspace-head">
            <h3>Case B (Right)</h3>
            <div className="compare-actions-inline">
              <button
                type="button"
                className="ghost-button"
                onClick={() => copyLeftToRight({ includeGeometry: false })}
              >
                Copy A Params
              </button>
              <button
                type="button"
                className="ghost-button"
                onClick={() => copyLeftToRight({ includeGeometry: true })}
              >
                Copy A to B All
              </button>
              <button
                type="button"
                className="ghost-button"
                onClick={() =>
                  setRightShapes(
                    buildLayerStackExampleShapes({
                      r_max_mm: rightForm.r_max_mm,
                      z_max_mm: rightForm.z_max_mm,
                    })
                  )
                }
              >
                Load Layer Stack
              </button>
              <button
                type="button"
                className="ghost-button"
                onClick={() => runCase("right")}
              >
                {rightRunning ? "Abort B" : "Run B Simulation"}
              </button>
            </div>
          </div>
          {rightError ? <p className="status-error">{rightError}</p> : null}
          <div className="compare-params-grid compare-params-essential">
            <label className="compare-param-field">
              <span>r max (mm)</span>
              <NumberInput
                min={20}
                value={rightForm.r_max_mm}
                onValueChange={(next) => {
                  expandCasePanelsForGeometryEdit();
                  setRightForm((prev) => ({ ...prev, r_max_mm: next }));
                }}
              />
            </label>
            <label className="compare-param-field">
              <span>z max (mm)</span>
              <NumberInput
                min={20}
                value={rightForm.z_max_mm}
                onValueChange={(next) => {
                  expandCasePanelsForGeometryEdit();
                  setRightForm((prev) => ({ ...prev, z_max_mm: next }));
                }}
              />
            </label>
            <label className="compare-param-field">
              <span>Pressure (Torr)</span>
              <NumberInput
                step="0.01"
                min={0.01}
                value={rightForm.pressure_Torr}
                onValueChange={(next) => setRightForm((prev) => ({ ...prev, pressure_Torr: next }))}
              />
            </label>
            <label className="compare-param-field">
              <span>RF Power (W)</span>
              <NumberInput
                step="1"
                min={0}
                value={rightForm.rf_power_W}
                onValueChange={(next) =>
                  updateRightPrimarySource({
                    rf_power_W: clampFinite(next, rightForm.rf_power_W, 0),
                  })
                }
                onWheel={(e) => (e.currentTarget as HTMLInputElement).blur()}
              />
            </label>
            <label className="compare-param-field">
              <span>Frequency (Hz)</span>
              <NumberInput
                step="1"
                min={1}
                value={rightForm.frequency_Hz}
                onValueChange={(next) =>
                  updateRightPrimarySource({
                    frequency_Hz: clampFinite(next, rightForm.frequency_Hz, 1),
                  })
                }
                onWheel={(e) => (e.currentTarget as HTMLInputElement).blur()}
              />
            </label>
            <label className="compare-param-field">
              <span>DC Bias (V)</span>
              <NumberInput
                step="1"
                min={-5000}
                max={5000}
                value={rightForm.dc_bias_V}
                onValueChange={(next) =>
                  setRightForm((prev) => ({
                    ...prev,
                    dc_bias_V: clampFinite(next, prev.dc_bias_V, -5000, 5000),
                  }))
                }
                onWheel={(e) => (e.currentTarget as HTMLInputElement).blur()}
              />
            </label>
            {showRightRfSourceControls ? (
              <label className="compare-param-field">
                <span>RF source tag</span>
                <select
                  value={rightForm.plasmaSources[0]?.surface_tag || rightRfSourceTagOptions[0]}
                  onChange={(e) =>
                    updateRightPrimarySource({
                      surface_tag: e.target.value,
                    })
                  }
                >
                  {rightRfSourceTagOptions.map((tag) => (
                    <option key={`right-rf-source-${tag}`} value={tag}>
                      {tag}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
          </div>
          <details
            className="panel-collapsible compare-collapsible"
            open={sharedControlPanels.mesh}
            onToggle={handleSharedPanelToggle("mesh")}
          >
            <summary>
              <span>Mesh / Material / Solver</span>
              <span className="panel-collapsible-summary">
                {rightMeshSummary} | {rightAdvancedSummary}
              </span>
            </summary>
            <div className="panel-collapsible-body">
              <div className="compare-params-grid">
                <label className="compare-param-field">
                  <span>Mesh nr</span>
                  <NumberInput
                    min={MESH_LIMITS.nrMin}
                    max={MESH_LIMITS.nrMax}
                    value={rightForm.nr}
                    onValueChange={(next) =>
                      setRightForm((prev) => ({ ...prev, nr: Math.round(next) }))
                    }
                  />
                </label>
                <label className="compare-param-field">
                  <span>Mesh nz</span>
                  <NumberInput
                    min={MESH_LIMITS.nzMin}
                    max={MESH_LIMITS.nzMax}
                    value={rightForm.nz}
                    onValueChange={(next) =>
                      setRightForm((prev) => ({ ...prev, nz: Math.round(next) }))
                    }
                  />
                </label>
                <label className="compare-param-field">
                  <span>Epsilon r</span>
                  <NumberInput
                    min={1}
                    value={rightForm.epsilon_r}
                    onValueChange={(next) =>
                      setRightForm((prev) => ({ ...prev, epsilon_r: next }))
                    }
                  />
                </label>
                <label className="compare-param-field">
                  <span>Wall loss</span>
                  <NumberInput
                    step="0.01"
                    min={0}
                    max={1}
                    value={rightForm.wall_loss_e}
                    onValueChange={(next) =>
                      setRightForm((prev) => ({ ...prev, wall_loss_e: next }))
                    }
                  />
                </label>
                <label className="compare-param-field">
                  <span>Baseline delta</span>
                  <input
                    type="checkbox"
                    checked={rightForm.baselineEnabled}
                    onChange={(e) =>
                      setRightForm((prev) => ({ ...prev, baselineEnabled: e.target.checked }))
                    }
                  />
                </label>
              </div>
            </div>
          </details>
          <details
            className="panel-collapsible compare-collapsible"
            open={sharedControlPanels.inlet}
            onToggle={handleSharedPanelToggle("inlet")}
          >
            <summary>
              <span>Inlet Controls</span>
              <span className="panel-collapsible-summary">{rightInletSummaryText}</span>
            </summary>
            <div className="panel-collapsible-body">
              <div className="compare-params-grid">
                <label className="compare-param-field">
                  <span>Inlet surface tag</span>
                  <select
                    value={rightForm.inletSurfaceTag}
                    onChange={(e) =>
                      setRightForm((prev) => ({ ...prev, inletSurfaceTag: e.target.value }))
                    }
                  >
                    {rightInletTagOptions.map((tag) => (
                      <option key={`right-inlet-${tag}`} value={tag}>
                        {tag}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="compare-param-field">
                  <span>Inlet direction</span>
                  <select
                    value={rightForm.inletDirection}
                    onChange={(e) =>
                      setRightForm((prev) => ({
                        ...prev,
                        inletDirection: e.target.value as InletDirection,
                      }))
                    }
                  >
                    {INLET_DIRECTION_OPTIONS.map((option) => (
                      <option key={`right-dir-${option.value}`} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="compare-param-field">
                  <span>Inlet emit side</span>
                  <select
                    value={rightForm.inletEmitSide}
                    onChange={(e) =>
                      setRightForm((prev) => ({
                        ...prev,
                        inletEmitSide: e.target.value as InletEmitSide,
                      }))
                    }
                  >
                    {INLET_SIDE_OPTIONS.map((option) => (
                      <option key={`right-side-${option.value}`} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="compare-param-field">
                  <span>Inlet active width (%)</span>
                  <NumberInput
                    min={5}
                    max={100}
                    step={1}
                    value={rightForm.inletActiveWidthPercent}
                    onValueChange={(next) =>
                      setRightForm((prev) => ({
                        ...prev,
                        inletActiveWidthPercent: next,
                      }))
                    }
                  />
                </label>
              </div>
            </div>
          </details>
          <details
            className="panel-collapsible compare-collapsible"
            open={sharedControlPanels.pump}
            onToggle={handleSharedPanelToggle("pump")}
          >
            <summary>
              <span>Pump Controls</span>
              <span className="panel-collapsible-summary">{rightPumpSummaryText}</span>
            </summary>
            <div className="panel-collapsible-body">
              <div className="compare-params-grid">
                <label className="compare-param-field">
                  <span>Pump surface tag</span>
                  <select
                    value={rightPump?.surface_tag ?? "bottom_pump"}
                    onChange={(e) => updateRightPump({ surface_tag: e.target.value })}
                  >
                    {rightPumpTagOptions.map((tag) => (
                      <option key={`right-pump-${tag}`} value={tag}>
                        {tag}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="compare-param-field">
                  <span>Pump strength</span>
                  <NumberInput
                    step="0.01"
                    min={0}
                    value={rightPump?.strength ?? 1.0}
                    onValueChange={(next) => updateRightPump({ strength: next })}
                  />
                </label>
                <label className="compare-param-field">
                  <span>Pump throttle (%)</span>
                  <NumberInput
                    step="0.1"
                    min={0}
                    max={100}
                    value={rightPump?.throttle_percent ?? 100.0}
                    onValueChange={(next) =>
                      updateRightPump({ throttle_percent: next })
                    }
                  />
                </label>
                <label className="compare-param-field">
                  <span>Pump conductance (L/s)</span>
                  <NumberInput
                    step="1"
                    min={0}
                    value={rightPump?.conductance_lps ?? 220.0}
                    onValueChange={(next) =>
                      updateRightPump({ conductance_lps: next })
                    }
                  />
                </label>
                <label className="compare-param-field">
                  <span>Pump target pressure (Pa)</span>
                  <NumberInput
                    step="0.1"
                    min={0}
                    value={rightPump?.target_pressure_Pa ?? 8.0}
                    onValueChange={(next) =>
                      updateRightPump({ target_pressure_Pa: next })
                    }
                  />
                </label>
              </div>
            </div>
          </details>
          <details
            className="panel-collapsible compare-collapsible"
            open={sharedControlPanels.dcBias}
            onToggle={handleSharedPanelToggle("dcBias")}
          >
            <summary>
              <span>DC Bias by Geometry</span>
              <span className="panel-collapsible-summary">{rightDcBiasSummaryText}</span>
            </summary>
            <div className="panel-collapsible-body">
              {rightDcBiasTagOptions.length === 0 ? (
                <p className="compare-note">No structure tags available.</p>
              ) : (
                <>
                  <div className="compare-dc-bias-list">
                    {rightForm.dcBiasRegions.map((row, idx) => (
                      <div className="compare-dc-bias-row" key={`right-dc-bias-${row.id}`}>
                        <select
                          value={row.target_tag}
                          onChange={(e) =>
                            updateRightDcBiasRegion(row.id, { target_tag: e.target.value })
                          }
                        >
                          {rightDcBiasTagOptions.map((tag) => (
                            <option key={`right-dc-tag-${tag}`} value={tag}>
                              {tag}
                            </option>
                          ))}
                        </select>
                        <NumberInput
                          step={1}
                          min={-5000}
                          max={5000}
                          value={row.dc_bias_V}
                          onValueChange={(next) =>
                            updateRightDcBiasRegion(row.id, { dc_bias_V: next })
                          }
                        />
                        <button
                          type="button"
                          className="icon-button"
                          onClick={() => removeRightDcBiasRegion(row.id)}
                          aria-label={`Remove right dc bias row ${idx + 1}`}
                        >
                          -
                        </button>
                      </div>
                    ))}
                  </div>
                  <button
                    type="button"
                    className="ghost-button"
                    onClick={addRightDcBiasRegion}
                    disabled={rightForm.dcBiasRegions.length >= 16}
                  >
                    + Add DC bias region
                  </button>
                </>
              )}
            </div>
          </details>
          <div className="compare-gas-block">
            <div className="compare-gas-head">
              <span>Gas species</span>
              <span>Flow (sccm)</span>
              <span />
            </div>
            {rightForm.gasComponents.map((row, idx) => (
              <div className="compare-gas-row" key={`right-${row.id}`}>
                <select
                  value={row.species}
                  onChange={(e) => updateRightGas(row.id, { species: e.target.value })}
                >
                  {GAS_OPTIONS.map((opt) => (
                    <option key={`right-gas-opt-${opt.value}`} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
                <NumberInput
                  min={0}
                  step={0.1}
                  value={row.flow_sccm}
                  onValueChange={(next) =>
                    updateRightGas(row.id, { flow_sccm: next })
                  }
                />
                <button
                  type="button"
                  className="icon-button"
                  onClick={() => removeRightGas(row.id)}
                  disabled={rightForm.gasComponents.length <= 1}
                  aria-label={`Remove right gas ${idx + 1}`}
                >
                  -
                </button>
              </div>
            ))}
            <button type="button" className="ghost-button" onClick={addRightGas}>
              + Add gas
            </button>
          </div>
          <p className="compare-note">
            Mesh limits: nr {MESH_LIMITS.nrMin}-{MESH_LIMITS.nrMax}, nz {MESH_LIMITS.nzMin}-{MESH_LIMITS.nzMax}.
          </p>
          <GeometryEditor
            domain={{ r_max_mm: rightForm.r_max_mm, z_max_mm: rightForm.z_max_mm }}
            tool={rightForm.drawTool}
            onToolChange={(tool) => setRightForm((prev) => ({ ...prev, drawTool: tool }))}
            shapes={rightShapes}
            annotationShapes={rightInletIndicator ? [rightInletIndicator] : []}
            selectedId={rightSelectedId}
            onSelect={(id) => syncSelectionByTag("right", id)}
            onShapesChange={setRightShapes}
            defaultMaterial={{ epsilon_r: rightForm.epsilon_r, wall_loss_e: rightForm.wall_loss_e }}
            snapToGrid={rightForm.snapToGrid}
            snapStepMm={rightForm.snapStepMm}
          />
        </article>
      </section>

      <section className="compare-grid">
        <article className={`compare-card compare-foldable ${deltaPanels.parameter ? "open" : "closed"}`}>
          <button
            type="button"
            className="compare-fold-head"
            onClick={() =>
              setDeltaPanels((prev) => ({ ...prev, parameter: !prev.parameter }))
            }
          >
            <div className="compare-fold-title-wrap">
              <h3>Parameter Delta (A vs B)</h3>
              <p className="compare-fold-summary">
                {changedParameterCount} changed / {parameterRows.length} total
              </p>
            </div>
            <span className="compare-fold-toggle">{deltaPanels.parameter ? "Collapse" : "Expand"}</span>
          </button>
          {deltaPanels.parameter ? (
            <div className="compare-fold-body">
              <div className="compare-table">
                <div className="compare-table-head">Parameter</div>
                <div className="compare-table-head">Case A</div>
                <div className="compare-table-head">Case B</div>
                {parameterRows.map((row) => {
                  const verbose =
                    row.left.includes("\n") ||
                    row.right.includes("\n") ||
                    row.left.length > 64 ||
                    row.right.length > 64;
                  return (
                    <React.Fragment key={row.label}>
                      <div className={`compare-cell ${row.changed ? "changed" : ""}`}>{row.label}</div>
                      <div className={`compare-cell mono ${row.changed ? "changed" : ""} ${verbose ? "multiline" : ""}`}>
                        {row.left}
                      </div>
                      <div className={`compare-cell mono ${row.changed ? "changed" : ""} ${verbose ? "multiline" : ""}`}>
                        {row.right}
                      </div>
                    </React.Fragment>
                  );
                })}
              </div>
            </div>
          ) : null}
        </article>

        <article className={`compare-card compare-foldable ${deltaPanels.geometry ? "open" : "closed"}`}>
          <button
            type="button"
            className="compare-fold-head"
            onClick={() =>
              setDeltaPanels((prev) => ({ ...prev, geometry: !prev.geometry }))
            }
          >
            <div className="compare-fold-title-wrap">
              <h3>Geometry Delta by Tag (A vs B)</h3>
              <p className="compare-fold-summary">
                {geometryDeltaCount} changed
                {" | "}
                +{geometryDiff.added.length} / -{geometryDiff.removed.length} / ~{geometryDiff.updated.length}
              </p>
            </div>
            <span className="compare-fold-toggle">{deltaPanels.geometry ? "Collapse" : "Expand"}</span>
          </button>
          {deltaPanels.geometry ? (
            <div className="compare-fold-body">
              <div className="compare-diff-columns">
                <div>
                  <h4>Added in B</h4>
                  <ul>
                    {geometryDiff.added.length === 0
                      ? <li>No changes</li>
                      : geometryDiff.added.map((item) => <li key={`added-${item.tag}`}>{item.label} ({item.tag})</li>)}
                  </ul>
                </div>
                <div>
                  <h4>Removed from A</h4>
                  <ul>
                    {geometryDiff.removed.length === 0
                      ? <li>No changes</li>
                      : geometryDiff.removed.map((item) => <li key={`removed-${item.tag}`}>{item.label} ({item.tag})</li>)}
                  </ul>
                </div>
                <div>
                  <h4>Updated</h4>
                  <ul>
                    {geometryDiff.updated.length === 0
                      ? <li>No changes</li>
                      : geometryDiff.updated.map((item) => <li key={`updated-${item.tag}`}>{item.label} ({item.tag})</li>)}
                  </ul>
                </div>
              </div>
            </div>
          ) : null}
        </article>
      </section>

      <section className="compare-grid">
        <article className={`compare-card compare-foldable ${deltaPanels.result ? "open" : "closed"}`}>
          <button
            type="button"
            className="compare-fold-head"
            onClick={() =>
              setDeltaPanels((prev) => ({ ...prev, result: !prev.result }))
            }
          >
            <div className="compare-fold-title-wrap">
              <h3>Simulation Result Delta (B - A)</h3>
              <p className="compare-fold-summary">
                {changedResultMetricCount} changed / {resultMetricRows.length} metrics
              </p>
            </div>
            <span className="compare-fold-toggle">{deltaPanels.result ? "Collapse" : "Expand"}</span>
          </button>
          {deltaPanels.result ? (
            <div className="compare-fold-body">
              <div className="compare-table compare-result-table">
                <div className="compare-table-head">Metric</div>
                <div className="compare-table-head">Case A</div>
                <div className="compare-table-head">Case B</div>
                <div className="compare-table-head">Delta</div>
                {resultMetricRows.map((row) => (
                  <React.Fragment key={row.label}>
                    <div className={`compare-cell ${row.changed ? "changed" : ""}`}>{row.label}</div>
                    <div className={`compare-cell mono ${row.changed ? "changed" : ""}`}>{row.left}</div>
                    <div className={`compare-cell mono ${row.changed ? "changed" : ""}`}>{row.right}</div>
                    <div className={`compare-cell mono ${row.changed ? "changed" : ""}`}>{row.delta}</div>
                  </React.Fragment>
                ))}
              </div>
            </div>
          ) : null}
        </article>

        <article
          className={`compare-card compare-foldable ${sharedControlPanels.resultCurves ? "open" : "closed"}`}
        >
          <button
            type="button"
            className="compare-fold-head"
            onClick={() => setSharedPanelOpen("resultCurves", !sharedControlPanels.resultCurves)}
          >
            <div className="compare-fold-title-wrap">
              <h3>Result Curves Overlay</h3>
              <p className="compare-fold-summary">{resultCurveSummary}</p>
            </div>
            <span className="compare-fold-toggle">
              {sharedControlPanels.resultCurves ? "Collapse" : "Expand"}
            </span>
          </button>
          {sharedControlPanels.resultCurves ? (
            <div className="compare-fold-body">
              {showSheath ? (
                <>
                  <p className="compare-note">
                    Sheath thickness is measured per column as the vertical gap:
                    {" "}
                    <code>|z_sheath(r) - z_electrode(r)|</code>.
                  </p>
                  <div className="curve-stack">
                    <CurvePlot title="Sheath Boundary z(r)" series={sheathCurveSeries} yLabel="z (mm)" />
                    <CurvePlot title="Sheath Thickness" series={thicknessCurveSeries} yLabel="|z_sheath(r) - z_electrode(r)| (mm)" />
                  </div>
                </>
              ) : (
                <p className="compare-note">Sheath view is disabled in Compare View Filters.</p>
              )}
            </div>
          ) : null}
        </article>
      </section>

      <section className="compare-grid">
        <article className="compare-card">
          <h3>Power Absorption Density Compare by Part</h3>
          {!showVolumeLossDensity ? (
            <p className="compare-note">
              Power Absorption Density layer is disabled in Compare View Filters.
            </p>
          ) : (
            <div className="compare-loss-density-table">
              <table>
                <thead>
                  <tr>
                    <th>Part (tag)</th>
                    <th>Role</th>
                    <th>Case A mean</th>
                    <th>Case B mean</th>
                    <th>Delta mean (B-A)</th>
                    <th>Case A Abs. P (rel)</th>
                    <th>Case B Abs. P (rel)</th>
                    <th>Delta Abs. P (B-A)</th>
                    <th>Volume A/B (mm^3)</th>
                    <th>Cells A/B</th>
                  </tr>
                </thead>
                <tbody>
                  {volumeLossCompareRows.length === 0 ? (
                    <tr>
                      <td colSpan={10}>Run Case A and Case B to compare Power Absorption Density.</td>
                    </tr>
                  ) : (
                    volumeLossCompareRows.map((row) => (
                      <tr key={`vld-compare-${row.tag}`}>
                        <td>{row.label} ({row.tag})</td>
                        <td>{row.role}</td>
                        <td>{formatLossDensity(row.leftMean)}</td>
                        <td>{formatLossDensity(row.rightMean)}</td>
                        <td>{formatLossDensity(row.deltaMean)}</td>
                        <td>{formatLossDensity(row.leftAbsorbed)}</td>
                        <td>{formatLossDensity(row.rightAbsorbed)}</td>
                        <td>{formatLossDensity(row.deltaAbsorbed)}</td>
                        <td>
                          {formatNumber(row.leftVolumeMm3, 3)} / {formatNumber(row.rightVolumeMm3, 3)}
                        </td>
                        <td>{row.leftCells} / {row.rightCells}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          )}
        </article>
      </section>

      <section className="compare-grid">
        <article className="compare-card compare-legend-card">
          <div className="compare-workspace-head">
            <h3>Field Legend Lock (A/B)</h3>
            <div className="field-mode-toggle" role="group" aria-label="Compare field render mode">
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
            </div>
          </div>
          <p className="compare-legend-lock">
            Legend lock (A/B, same Min-Max): |E|{" "}
            {colorScaleMode === "log"
              ? `${formatNumber(leftELog.rawMin, 4)} ~ ${formatNumber(leftELog.rawMax, 4)}`
              : `${formatNumber(eColorRange.zMin, 4)} ~ ${formatNumber(eColorRange.zMax, 4)}`}{" "}
            / ne{" "}
            {colorScaleMode === "log"
              ? `${formatNumber(leftNeLog.rawMin, 4)} ~ ${formatNumber(leftNeLog.rawMax, 4)}`
              : `${formatNumber(neColorRange.zMin, 4)} ~ ${formatNumber(neColorRange.zMax, 4)}`}{" "}
            / PAD{" "}
            {formatLossDensity(sharedVldRange?.min ?? null)} ~ {formatLossDensity(sharedVldRange?.max ?? null)}
          </p>
          <div className="field-mode-toggle" role="group" aria-label="Compare color scale mode">
            <button
              type="button"
              className={colorScaleMode === "log" ? "active" : ""}
              onClick={() => setColorScaleMode("log")}
            >
              Log Scale (Default)
            </button>
            <button
              type="button"
              className={colorScaleMode === "linear" ? "active" : ""}
              onClick={() => setColorScaleMode("linear")}
            >
              Linear
            </button>
          </div>
          <div className="compare-legend-controls">
            <label className="compare-param-field">
              <span>Legend mode</span>
              <select
                value={legendMode}
                onChange={(e) =>
                  setLegendMode(e.target.value as "fixed" | "auto_shared")
                }
              >
                <option value="fixed">Fixed Reference</option>
                <option value="auto_shared">Auto Shared (A/B)</option>
              </select>
            </label>
            <label className="compare-param-field">
              <span>|E| max (fixed)</span>
              <NumberInput
                min={0.01}
                step={0.01}
                value={legendEMax}
                onValueChange={(next) => setLegendEMax(next)}
                disabled={legendMode !== "fixed"}
              />
            </label>
            <label className="compare-param-field">
              <span>ne max (fixed)</span>
              <NumberInput
                min={0.05}
                step={0.01}
                value={legendNeMax}
                onValueChange={(next) => setLegendNeMax(next)}
                disabled={legendMode !== "fixed"}
              />
            </label>
          </div>
        </article>
      </section>

      <section className="compare-grid">
        <article className="compare-card">
          <h3>Case A Fields</h3>
          {showEField ? (
            <FieldHeatmap
              title="Case A |E|"
              z2d={eDisplay.left}
              x={leftResult?.grid?.r_mm}
              y={leftResult?.grid?.z_mm}
              renderMode={fieldRenderMode}
              overlayShapes={leftOverlayShapes}
              overlayOpacity={0.18}
              showColorScale
              zMin={eDisplay.zMin}
              zMax={eDisplay.zMax}
              colorbarTitle={colorScaleMode === "log" ? "|E| (log)" : "|E|"}
              colorbarTickVals={eColorbarTicks?.tickVals}
              colorbarTickText={eColorbarTicks?.tickText}
              xRange={sharedXRange}
              yRange={sharedYRange}
              plotRevision={`${leftFieldRevision}:e`}
            />
          ) : null}
          {showNe ? (
            <FieldHeatmap
              title="Case A ne"
              z2d={neDisplay.left}
              x={leftResult?.grid?.r_mm}
              y={leftResult?.grid?.z_mm}
              colorscale="Cividis"
              renderMode={fieldRenderMode}
              overlayShapes={leftOverlayShapes}
              overlayOpacity={0.18}
              showColorScale
              zMin={neDisplay.zMin}
              zMax={neDisplay.zMax}
              colorbarTitle={colorScaleMode === "log" ? "ne (log)" : "ne"}
              colorbarTickVals={neColorbarTicks?.tickVals}
              colorbarTickText={neColorbarTicks?.tickText}
              xRange={sharedXRange}
              yRange={sharedYRange}
              plotRevision={`${leftFieldRevision}:ne`}
            />
          ) : null}
          {showVolumeLossDensity ? (
            <FieldHeatmap
              title={`Case A Power Absorption Density (${colorScaleMode === "log" ? "Min-Max Log Scale" : "Min-Max Linear"})`}
              z2d={colorScaleMode === "log" ? leftVldForPlot.grid : leftResult?.fields?.volume_loss_density}
              x={leftResult?.grid?.r_mm}
              y={leftResult?.grid?.z_mm}
              colorscale="Plasma"
              renderMode={fieldRenderMode}
              overlayShapes={leftOverlayShapes}
              overlayOpacity={0.18}
              showColorScale
              zMin={vldColorRange.zMin}
              zMax={vldColorRange.zMax}
              colorbarTitle={colorScaleMode === "log" ? "PAD (rel W/mm^3, log)" : "PAD (rel W/mm^3)"}
              colorbarTickVals={colorScaleMode === "log" ? vldColorbarTicks?.tickVals : undefined}
              colorbarTickText={colorScaleMode === "log" ? vldColorbarTicks?.tickText : undefined}
              xRange={sharedXRange}
              yRange={sharedYRange}
              plotRevision={`${leftFieldRevision}:vld`}
            />
          ) : null}
          {!showEField && !showNe && !showVolumeLossDensity ? (
            <p className="compare-note">E-Field/ne/Power Absorption Density view is disabled in Compare View Filters.</p>
          ) : null}
          <WarningsPanel warnings={leftWarnings} />
        </article>

        <article className="compare-card">
          <h3>Case B Fields</h3>
          <p className="compare-note">
            Color scale range is synchronized between Case A and Case B for direct comparison.
          </p>
          {showEField ? (
            <FieldHeatmap
              title="Case B |E|"
              z2d={eDisplay.right}
              x={rightResult?.grid?.r_mm}
              y={rightResult?.grid?.z_mm}
              renderMode={fieldRenderMode}
              overlayShapes={rightOverlayShapes}
              overlayOpacity={0.18}
              showColorScale
              zMin={eDisplay.zMin}
              zMax={eDisplay.zMax}
              colorbarTitle={colorScaleMode === "log" ? "|E| (log)" : "|E|"}
              colorbarTickVals={eColorbarTicks?.tickVals}
              colorbarTickText={eColorbarTicks?.tickText}
              xRange={sharedXRange}
              yRange={sharedYRange}
              plotRevision={`${rightFieldRevision}:e`}
            />
          ) : null}
          {showNe ? (
            <FieldHeatmap
              title="Case B ne"
              z2d={neDisplay.right}
              x={rightResult?.grid?.r_mm}
              y={rightResult?.grid?.z_mm}
              colorscale="Cividis"
              renderMode={fieldRenderMode}
              overlayShapes={rightOverlayShapes}
              overlayOpacity={0.18}
              showColorScale
              zMin={neDisplay.zMin}
              zMax={neDisplay.zMax}
              colorbarTitle={colorScaleMode === "log" ? "ne (log)" : "ne"}
              colorbarTickVals={neColorbarTicks?.tickVals}
              colorbarTickText={neColorbarTicks?.tickText}
              xRange={sharedXRange}
              yRange={sharedYRange}
              plotRevision={`${rightFieldRevision}:ne`}
            />
          ) : null}
          {showVolumeLossDensity ? (
            <FieldHeatmap
              title={`Case B Power Absorption Density (${colorScaleMode === "log" ? "Min-Max Log Scale" : "Min-Max Linear"})`}
              z2d={colorScaleMode === "log" ? rightVldForPlot.grid : rightResult?.fields?.volume_loss_density}
              x={rightResult?.grid?.r_mm}
              y={rightResult?.grid?.z_mm}
              colorscale="Plasma"
              renderMode={fieldRenderMode}
              overlayShapes={rightOverlayShapes}
              overlayOpacity={0.18}
              showColorScale
              zMin={vldColorRange.zMin}
              zMax={vldColorRange.zMax}
              colorbarTitle={colorScaleMode === "log" ? "PAD (rel W/mm^3, log)" : "PAD (rel W/mm^3)"}
              colorbarTickVals={colorScaleMode === "log" ? vldColorbarTicks?.tickVals : undefined}
              colorbarTickText={colorScaleMode === "log" ? vldColorbarTicks?.tickText : undefined}
              xRange={sharedXRange}
              yRange={sharedYRange}
              plotRevision={`${rightFieldRevision}:vld`}
            />
          ) : null}
          {!showEField && !showNe && !showVolumeLossDensity ? (
            <p className="compare-note">E-Field/ne/Power Absorption Density view is disabled in Compare View Filters.</p>
          ) : null}
          <WarningsPanel warnings={rightWarnings} />
        </article>
      </section>

      <section className="compare-grid">
        <article className="compare-card">
          <h3>Difference Maps (B - A)</h3>
          <p className="compare-note">
            Positive value means Case B is higher. Negative value means Case A is higher.
            Delta values are normalized by Case A maximum and clipped to [-1, 1].
          </p>
          {showEField ? (
            <>
              <p className="compare-delta-note">|E| delta map: {deltaEField.note ?? "Ready"}</p>
              <FieldHeatmap
                title="Delta |E| (B - A, normalized)"
                z2d={deltaEField.z}
                x={deltaEField.x}
                y={deltaEField.y}
                colorscale="RdBu"
                renderMode={fieldRenderMode}
                zMin={deltaEColorRange.zMin}
                zMax={deltaEColorRange.zMax}
                plotRevision={`${leftFieldRevision}:${rightFieldRevision}:delta-e`}
              />
            </>
          ) : null}
          {showNe ? (
            <>
              <p className="compare-delta-note">ne delta map: {deltaNeField.note ?? "Ready"}</p>
              <FieldHeatmap
                title="Delta ne (B - A, normalized)"
                z2d={deltaNeField.z}
                x={deltaNeField.x}
                y={deltaNeField.y}
                colorscale="RdBu"
                renderMode={fieldRenderMode}
                zMin={deltaNeColorRange.zMin}
                zMax={deltaNeColorRange.zMax}
                plotRevision={`${leftFieldRevision}:${rightFieldRevision}:delta-ne`}
              />
            </>
          ) : null}
          {showVolumeLossDensity ? (
            <>
              <p className="compare-delta-note">PAD delta map: {deltaVldField.note ?? "Ready"}</p>
              <FieldHeatmap
                title="Delta Power Absorption Density (B - A, normalized)"
                z2d={deltaVldField.z}
                x={deltaVldField.x}
                y={deltaVldField.y}
                colorscale="RdBu"
                renderMode={fieldRenderMode}
                zMin={deltaVldColorRange.zMin}
                zMax={deltaVldColorRange.zMax}
                plotRevision={`${leftFieldRevision}:${rightFieldRevision}:delta-vld`}
              />
            </>
          ) : null}
          {!showEField && !showNe && !showVolumeLossDensity ? (
            <p className="compare-note">Delta maps are hidden because E-Field/ne/Power Absorption Density view is disabled.</p>
          ) : null}
        </article>
      </section>
    </div>
  );
};

export default ComparePage;
