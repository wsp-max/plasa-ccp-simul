import type { OutletSinkConfig, SimulationRequestPayload } from "../types/api";

const LEGACY_OUTLET_FIELDS = new Set([
  "throttle_percent",
  "conductance_lps",
  "target_pressure_Pa",
  "note",
]);
const LEGACY_INLET_FIELDS = new Set(["direction", "emit_side", "active_width_percent"]);
const LEGACY_PROCESS_FIELDS = new Set(["dc_bias_regions"]);
const LEGACY_ROOT_FIELDS = new Set(["outputs"]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const sanitizeOutlet = (outlet?: OutletSinkConfig): OutletSinkConfig | undefined => {
  if (!outlet) {
    return undefined;
  }
  return {
    type: "sink",
    surface_tag: outlet.surface_tag,
    strength: outlet.strength,
  };
};

const sanitizeInlet = (
  inlet: SimulationRequestPayload["flow_boundary"]["inlet"]
): SimulationRequestPayload["flow_boundary"]["inlet"] => ({
  type: "surface",
  surface_tag: inlet.surface_tag,
  uniform: inlet.uniform,
  total_flow_sccm: inlet.total_flow_sccm,
});

export const buildLegacyCompatiblePayload = (
  payload: SimulationRequestPayload
): SimulationRequestPayload => {
  const outlet = sanitizeOutlet(payload.flow_boundary.outlet);
  const outlets = payload.flow_boundary.outlets?.map((item) => sanitizeOutlet(item)).filter(Boolean) as
    | OutletSinkConfig[]
    | undefined;
  return {
    ...payload,
    outputs: undefined,
    process: {
      ...payload.process,
      dc_bias_regions: undefined,
      rf_sources: payload.process.rf_sources?.map((source) => ({
        name: source.name,
        surface_tag: source.surface_tag,
        rf_power_W: source.rf_power_W,
        frequency_Hz: source.frequency_Hz,
        phase_deg: source.phase_deg,
      })),
    },
    flow_boundary: {
      ...payload.flow_boundary,
      inlet: sanitizeInlet(payload.flow_boundary.inlet),
      outlet,
      outlets,
    },
  };
};

export const shouldRetryWithLegacyOutlet = (status: number, bodyText: string): boolean => {
  if (status !== 422) {
    return false;
  }

  try {
    const parsed = JSON.parse(bodyText);
    const detail = parsed?.detail;
    if (!Array.isArray(detail)) {
      return false;
    }
    return detail.some((entry) => {
      if (!isRecord(entry) || entry.type !== "extra_forbidden") {
        return false;
      }
      const loc = Array.isArray(entry.loc) ? entry.loc : [];
      if (!loc.includes("flow_boundary")) {
        return false;
      }
      if (loc.includes("outlet") || loc.includes("outlets")) {
        const last = loc[loc.length - 1];
        return typeof last === "string" && LEGACY_OUTLET_FIELDS.has(last);
      }
      if (loc.includes("inlet")) {
        const last = loc[loc.length - 1];
        return typeof last === "string" && LEGACY_INLET_FIELDS.has(last);
      }
      if (loc.includes("process")) {
        const last = loc[loc.length - 1];
        return typeof last === "string" && LEGACY_PROCESS_FIELDS.has(last);
      }
      const rootField = loc.length === 1 ? loc[0] : null;
      if (typeof rootField === "string" && LEGACY_ROOT_FIELDS.has(rootField)) {
        return true;
      }
      return false;
    });
  } catch {
    return (
      /flow_boundary.*outlet.*(throttle_percent|conductance_lps|target_pressure_Pa|note)/i.test(
        bodyText
      ) ||
      /flow_boundary.*inlet.*(direction|emit_side|active_width_percent)/i.test(bodyText) ||
      /process.*dc_bias_regions/i.test(bodyText) ||
      /outputs/i.test(bodyText)
    );
  }
};
