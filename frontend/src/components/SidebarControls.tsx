import React from "react";
import type { SimulationRequestPayload } from "../types/api";
import type { GeometryTool } from "../types/geometry";
import NumberInput from "./NumberInput";

export type InletDirection =
  | "normal_inward"
  | "radial_inward"
  | "radial_outward"
  | "diffuse";

export type InletEmitSide = "left" | "center" | "right";

export type SidebarState = {
  r_max_mm: number;
  z_max_mm: number;
  nr: number;
  nz: number;
  drawTool: GeometryTool;
  snapToGrid: boolean;
  snapStepMm: number;
  showGeometryOverlay: boolean;
  geometryOverlayOpacity: number;
  baselineEnabled: boolean;
  pressure_Torr: number;
  rf_power_W: number;
  frequency_Hz: number;
  dc_bias_V: number;
  plasmaSources: PlasmaSourceState[];
  dcBiasRegions: DCBiasRegionState[];
  gasComponents: GasComponentState[];
  inletSurfaceTag: string;
  inletDirection: InletDirection;
  inletEmitSide: InletEmitSide;
  inletActiveWidthPercent: number;
  pumpPorts: PumpPortState[];
  epsilon_r: number;
  wall_loss_e: number;
  impedanceDelta: number;
};

export type GasComponentState = {
  id: string;
  species: string;
  flow_sccm: number;
};

export type PlasmaSourceState = {
  id: string;
  name: string;
  surface_tag: string;
  rf_power_W: number;
  frequency_Hz: number;
  phase_deg: number;
};

export type DCBiasRegionState = {
  id: string;
  target_tag: string;
  dc_bias_V: number;
};

export type PumpPortState = {
  id: string;
  surface_tag: string;
  strength: number;
  throttle_percent: number;
  conductance_lps: number;
  target_pressure_Pa: number;
  note: string;
};

type SidebarControlsProps = {
  state: SidebarState;
  onChange: (next: Partial<SidebarState>) => void;
  onRun: (payload: SimulationRequestPayload) => void | Promise<void>;
  onAbort?: () => void;
  buildPayload: (state: SidebarState) => SimulationRequestPayload;
  isRunning: boolean;
  onLoadExample: () => void;
  onLoadLayerStack: () => void;
  onOpenTheory: () => void;
  onOpenCompare: () => void;
  onGoHome?: () => void;
  rfSurfaceTagOptions: string[];
  dcBiasTagOptions: string[];
  inletSurfaceTagOptions: string[];
  pumpSurfaceTagOptions: string[];
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

const PROCESS_PRESETS: {
  id: string;
  label: string;
  note: string;
  reference: string;
  referenceUrl?: string;
  pressure_Torr: number;
  sources: {
    name: string;
    surface_tag?: string;
    rf_power_W: number;
    frequency_Hz: number;
    phase_deg: number;
  }[];
  gas: { species: string; flow_sccm: number }[];
}[] = [
  {
    id: "pecvd-hp-ncsi",
    label: "PECVD HP nc-Si:H (SiH4/Ar/H2)",
    note: "High-pressure PECVD window inspired by reported nc-Si:H growth (2-8 Torr, 13.56 MHz).",
    reference: "Thin Solid Films / high-pressure PECVD SiH4-Ar-H2 window",
    referenceUrl: "https://www.sciencedirect.com/science/article/abs/pii/S0040609000016035",
    pressure_Torr: 4.0,
    sources: [
      {
        name: "HP PECVD RF",
        surface_tag: "powered_electrode_surface",
        rf_power_W: 650,
        frequency_Hz: 13_560_000,
        phase_deg: 0,
      },
    ],
    gas: [
      { species: "Ar", flow_sccm: 3500 },
      { species: "SiH4", flow_sccm: 120 },
      { species: "H2", flow_sccm: 1100 },
    ],
  },
  {
    id: "pecvd-sinx",
    label: "PECVD SiNx:H (SiH4/NH3/N2)",
    note: "SiNx:H deposition template for dielectric/passivation studies.",
    reference: "Microelectronics Reliability 50 (2010), SiH4/NH3/N2 PECVD SiNx:H",
    referenceUrl: "https://www.sciencedirect.com/science/article/abs/pii/S0026271410001836",
    pressure_Torr: 0.9,
    sources: [
      {
        name: "SiNx RF",
        surface_tag: "powered_electrode_surface",
        rf_power_W: 320,
        frequency_Hz: 13_560_000,
        phase_deg: 0,
      },
    ],
    gas: [
      { species: "SiH4", flow_sccm: 120 },
      { species: "NH3", flow_sccm: 650 },
      { species: "N2", flow_sccm: 1200 },
    ],
  },
  {
    id: "pecvd-sio2",
    label: "PECVD SiO2 (SiH4/Ar/N2O)",
    note: "SiO2 growth template based on SiH4/Ar/N2O PECVD studies.",
    reference: "Thin Solid Films 797 (2024), SiH4/Ar/N2O PECVD SiO2",
    referenceUrl: "https://www.sciencedirect.com/science/article/abs/pii/S0040609024001494",
    pressure_Torr: 1.2,
    sources: [
      {
        name: "SiO2 RF",
        surface_tag: "powered_electrode_surface",
        rf_power_W: 280,
        frequency_Hz: 13_560_000,
        phase_deg: 0,
      },
    ],
    gas: [
      { species: "SiH4", flow_sccm: 90 },
      { species: "N2O", flow_sccm: 1000 },
      { species: "Ar", flow_sccm: 900 },
    ],
  },
  {
    id: "dfccp-60-13",
    label: "Dual Frequency CCP (60/13.56 MHz)",
    note: "Dual-frequency CCP etch-inspired template with independent ion/radical control.",
    reference: "JVST A 35 (2016), dual-frequency CCP etch (13.56/60 MHz)",
    referenceUrl: "https://doi.org/10.1116/1.4973299",
    pressure_Torr: 0.04,
    sources: [
      {
        name: "HF Bias",
        surface_tag: "powered_electrode_surface",
        rf_power_W: 500,
        frequency_Hz: 60_000_000,
        phase_deg: 0,
      },
      {
        name: "LF Bias",
        surface_tag: "powered_electrode_surface",
        rf_power_W: 220,
        frequency_Hz: 13_560_000,
        phase_deg: 180,
      },
    ],
    gas: [
      { species: "Ar", flow_sccm: 50 },
      { species: "O2", flow_sccm: 8 },
    ],
  },
  {
    id: "dfccp-13-2",
    label: "Dual Frequency CCP (13.56/2 MHz)",
    note: "Superimposed 13.56/2 MHz mode commonly used for bias-coupled uniformity tuning.",
    reference: "Vacuum 173 (2020), dual-frequency 13.56/2 MHz plasma characteristics",
    referenceUrl: "https://www.sciencedirect.com/science/article/abs/pii/S0042207X19308048",
    pressure_Torr: 0.08,
    sources: [
      {
        name: "HF Source",
        surface_tag: "powered_electrode_surface",
        rf_power_W: 420,
        frequency_Hz: 13_560_000,
        phase_deg: 0,
      },
      {
        name: "LF Source",
        surface_tag: "powered_electrode_surface",
        rf_power_W: 180,
        frequency_Hz: 2_000_000,
        phase_deg: 180,
      },
    ],
    gas: [
      { species: "Ar", flow_sccm: 55 },
      { species: "O2", flow_sccm: 6 },
    ],
  },
  {
    id: "etch-ar-o2",
    label: "Etch / Ash (Ar/O2)",
    note: "Reactive ion etch/ash window used in low-pressure O2-assisted plasma steps.",
    reference: "CCP etch studies with Ar/O2 admixture and low-pressure operation",
    referenceUrl: "https://arxiv.org/abs/2411.03146",
    pressure_Torr: 0.15,
    sources: [
      {
        name: "Etch RF",
        surface_tag: "powered_electrode_surface",
        rf_power_W: 600,
        frequency_Hz: 13_560_000,
        phase_deg: 0,
      },
    ],
    gas: [
      { species: "Ar", flow_sccm: 40 },
      { species: "O2", flow_sccm: 20 },
    ],
  },
  {
    id: "o2-ashing",
    label: "Photoresist O2 Ashing",
    note: "Typical single-wafer oxygen plasma ashing range (0.25-2 Torr, 100-500 W).",
    reference: "Industrial O2 plasma ashing process window (13.56 MHz class)",
    referenceUrl: "https://piescientific.com/Resource_pages/Resource_photoresist_ashing/",
    pressure_Torr: 0.6,
    sources: [
      {
        name: "Ash RF",
        surface_tag: "powered_electrode_surface",
        rf_power_W: 350,
        frequency_Hz: 13_560_000,
        phase_deg: 0,
      },
    ],
    gas: [
      { species: "O2", flow_sccm: 90 },
      { species: "Ar", flow_sccm: 10 },
    ],
  },
  {
    id: "nitridation-n2-h2",
    label: "Nitridation / Surface Activate (N2/H2)",
    note: "N2/H2 plasma surface treatment template for pre-clean/activation steps.",
    reference: "Industrial CCP pre-clean/activation operating window",
    pressure_Torr: 0.18,
    sources: [
      {
        name: "Activate RF",
        surface_tag: "powered_electrode_surface",
        rf_power_W: 420,
        frequency_Hz: 13_560_000,
        phase_deg: 0,
      },
    ],
    gas: [
      { species: "N2", flow_sccm: 80 },
      { species: "H2", flow_sccm: 20 },
    ],
  },
];

const TOOL_OPTIONS: { value: GeometryTool; label: string }[] = [
  { value: "select", label: "Select" },
  { value: "rect", label: "Rectangle" },
  { value: "circle", label: "Circle" },
  { value: "polyline", label: "Polyline/Polygon" },
  { value: "chamber", label: "Chamber" },
];

const MESH_LIMITS = {
  nrMin: 16,
  nrMax: 224,
  nzMin: 16,
  nzMax: 256,
};

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

const SidebarControls = ({
  state,
  onChange,
  onRun,
  onAbort,
  buildPayload,
  isRunning,
  onLoadExample,
  onLoadLayerStack,
  onOpenTheory,
  onOpenCompare,
  onGoHome,
  rfSurfaceTagOptions,
  dcBiasTagOptions,
  inletSurfaceTagOptions,
  pumpSurfaceTagOptions,
}: SidebarControlsProps) => {
  const [selectedPresetId, setSelectedPresetId] = React.useState<string | null>(null);

  const summarizeSources = (sources: PlasmaSourceState[]) => {
    if (sources.length === 0) {
      return {
        totalPower: 0,
        effectiveFrequencyHz: state.frequency_Hz,
      };
    }
    const totalPower = sources.reduce((sum, source) => sum + Math.max(0, source.rf_power_W), 0);
    if (totalPower > 0) {
      const effectiveFrequencyHz =
        sources.reduce(
          (sum, source) =>
            sum + Math.max(0, source.rf_power_W) * Math.max(1, source.frequency_Hz),
          0
        ) / totalPower;
      return { totalPower, effectiveFrequencyHz };
    }
    const effectiveFrequencyHz =
      sources.reduce((sum, source) => sum + Math.max(1, source.frequency_Hz), 0) / sources.length;
    return { totalPower, effectiveFrequencyHz };
  };

  const applyPlasmaSources = (sources: PlasmaSourceState[]) => {
    const { totalPower, effectiveFrequencyHz } = summarizeSources(sources);
    onChange({
      plasmaSources: sources.slice(0, 3),
      rf_power_W: totalPower,
      frequency_Hz: effectiveFrequencyHz,
    });
  };

  const buildSourceId = () => `src-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
  const defaultSurfaceTag = rfSurfaceTagOptions[0] ?? "";
  const makeSource = (
    index: number,
    patch: Partial<PlasmaSourceState> = {}
  ): PlasmaSourceState => ({
    id: patch.id ?? buildSourceId(),
    name: patch.name ?? `Source ${index + 1}`,
    surface_tag: patch.surface_tag ?? defaultSurfaceTag,
    rf_power_W: patch.rf_power_W ?? 300,
    frequency_Hz: patch.frequency_Hz ?? 13_560_000,
    phase_deg: patch.phase_deg ?? 0,
  });

  const update = (field: keyof SidebarState, value: SidebarState[keyof SidebarState]) => {
    onChange({ [field]: value });
  };

  const handleRun = () => {
    if (isRunning) {
      onAbort?.();
      return;
    }
    onRun(buildPayload(state));
  };

  const inletTagOptions = inletSurfaceTagOptions.includes(state.inletSurfaceTag)
    ? inletSurfaceTagOptions
    : state.inletSurfaceTag
      ? [state.inletSurfaceTag, ...inletSurfaceTagOptions]
      : inletSurfaceTagOptions;

  const updateGas = (id: string, patch: Partial<GasComponentState>) => {
    onChange({
      gasComponents: state.gasComponents.map((row) =>
        row.id === id ? { ...row, ...patch } : row
      ),
    });
  };

  const addGas = () => {
    const used = new Set(state.gasComponents.map((row) => row.species));
    const next = GAS_OPTIONS.find((opt) => !used.has(opt.value))?.value ?? "Ar";
    const id = `gas-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    onChange({
      gasComponents: [...state.gasComponents, { id, species: next, flow_sccm: 5 }],
    });
  };

  const removeGas = (id: string) => {
    if (state.gasComponents.length <= 1) {
      return;
    }
    onChange({ gasComponents: state.gasComponents.filter((row) => row.id !== id) });
  };

  const applyProcessPreset = (presetId: string) => {
    const preset = PROCESS_PRESETS.find((item) => item.id === presetId);
    if (!preset) {
      return;
    }
    const sourceRows = preset.sources.map((row, idx) =>
      makeSource(idx, {
        id: `preset-${preset.id}-src-${idx}-${Date.now()}`,
        name: row.name,
        surface_tag: row.surface_tag ?? defaultSurfaceTag,
        rf_power_W: row.rf_power_W,
        frequency_Hz: row.frequency_Hz,
        phase_deg: row.phase_deg,
      })
    );
    const sourceSummary = summarizeSources(sourceRows);
    onChange({
      pressure_Torr: preset.pressure_Torr,
      plasmaSources: sourceRows,
      rf_power_W: sourceSummary.totalPower,
      frequency_Hz: sourceSummary.effectiveFrequencyHz,
      gasComponents: preset.gas.map((row, idx) => ({
        id: `preset-${preset.id}-${idx}-${Date.now()}`,
        species: row.species,
        flow_sccm: row.flow_sccm,
      })),
    });
    setSelectedPresetId(preset.id);
  };

  const updateSource = (id: string, patch: Partial<PlasmaSourceState>) => {
    applyPlasmaSources(state.plasmaSources.map((source) => (source.id === id ? { ...source, ...patch } : source)));
  };

  const addSource = () => {
    if (state.plasmaSources.length >= 3) {
      return;
    }
    applyPlasmaSources([...state.plasmaSources, makeSource(state.plasmaSources.length)]);
  };

  const removeSource = (id: string) => {
    if (state.plasmaSources.length <= 1) {
      return;
    }
    applyPlasmaSources(state.plasmaSources.filter((source) => source.id !== id));
  };

  const buildDcBiasRegionId = () => `dc-bias-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
  const defaultDcBiasTag = dcBiasTagOptions[0] ?? rfSurfaceTagOptions[0] ?? "";
  const makeDcBiasRegion = (
    index: number,
    patch: Partial<DCBiasRegionState> = {}
  ): DCBiasRegionState => ({
    id: patch.id ?? buildDcBiasRegionId(),
    target_tag: patch.target_tag ?? defaultDcBiasTag,
    dc_bias_V: patch.dc_bias_V ?? 0.0,
  });

  const updateDcBiasRegion = (id: string, patch: Partial<DCBiasRegionState>) => {
    onChange({
      dcBiasRegions: state.dcBiasRegions.map((row) =>
        row.id === id ? { ...row, ...patch } : row
      ),
    });
  };

  const addDcBiasRegion = () => {
    if (state.dcBiasRegions.length >= 16) {
      return;
    }
    const used = new Set(state.dcBiasRegions.map((row) => row.target_tag));
    const nextTag = dcBiasTagOptions.find((tag) => !used.has(tag)) ?? defaultDcBiasTag;
    onChange({
      dcBiasRegions: [
        ...state.dcBiasRegions,
        makeDcBiasRegion(state.dcBiasRegions.length, { target_tag: nextTag }),
      ],
    });
  };

  const removeDcBiasRegion = (id: string) => {
    onChange({
      dcBiasRegions: state.dcBiasRegions.filter((row) => row.id !== id),
    });
  };

  const buildPumpId = () => `pump-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
  const defaultPumpTag = pumpSurfaceTagOptions[0] ?? "bottom_pump";
  const makePumpPort = (patch: Partial<PumpPortState> = {}): PumpPortState => ({
    id: patch.id ?? buildPumpId(),
    surface_tag: patch.surface_tag ?? defaultPumpTag,
    strength: patch.strength ?? 1.0,
    throttle_percent: patch.throttle_percent ?? 100.0,
    conductance_lps: patch.conductance_lps ?? 220.0,
    target_pressure_Pa: patch.target_pressure_Pa ?? 8.0,
    note: patch.note ?? "",
  });

  const updatePump = (id: string, patch: Partial<PumpPortState>) => {
    onChange({
      pumpPorts: state.pumpPorts.map((row) => (row.id === id ? { ...row, ...patch } : row)),
    });
  };

  const addPump = () => {
    if (state.pumpPorts.length >= 4) {
      return;
    }
    onChange({ pumpPorts: [...state.pumpPorts, makePumpPort()] });
  };

  const removePump = (id: string) => {
    if (state.pumpPorts.length <= 1) {
      return;
    }
    onChange({ pumpPorts: state.pumpPorts.filter((row) => row.id !== id) });
  };

  const meshSummary = `${state.nr} x ${state.nz} | ${(state.nr * state.nz).toLocaleString()} cells`;
  const inletSummaryText = `${state.inletSurfaceTag} | ${state.inletDirection} | ${state.inletEmitSide}`;
  const pumpSummaryText = `${state.pumpPorts.length} port${state.pumpPorts.length > 1 ? "s" : ""}`;
  const advancedSummaryText = `eps ${state.epsilon_r.toFixed(2)} | wall ${state.wall_loss_e.toFixed(2)}`;
  const selectedPreset = PROCESS_PRESETS.find((preset) => preset.id === selectedPresetId) ?? null;

  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <h1>
          <button type="button" className="app-title-link sidebar-title-link" onClick={onGoHome}>
            2D RF CCP Chamber Simulator
          </button>
        </h1>
        <p>Axisymmetric r-z CCP trend engine with CAD-style geometry editing</p>
      </div>

      <section>
        <h2>Quick Start</h2>
        <div className="quick-actions">
          <button type="button" className="chip-button chip-primary" onClick={onLoadExample}>
            Load 300mm CCP Baseline
          </button>
          <button type="button" className="chip-button" onClick={onLoadLayerStack}>
            Load Layer Stack
          </button>
          <button type="button" className="chip-button" onClick={onOpenTheory}>
            Open Theory Page
          </button>
          <button type="button" className="chip-button" onClick={onOpenCompare}>
            Open Compare Page
          </button>
        </div>
        <p className="section-note">
          CCP baseline starts at 500 W, 5 Torr, Ar/SiH4 CVD flow, and fully editable geometry.
        </p>
      </section>

      <section>
        <h2>Geometry and Mesh</h2>
        <div className="control-row">
          <label>r max (mm)</label>
          <NumberInput
            min={1}
            value={state.r_max_mm}
            onValueChange={(next) => update("r_max_mm", next)}
          />
        </div>
        <div className="control-row">
          <label>z max (mm)</label>
          <NumberInput
            min={1}
            value={state.z_max_mm}
            onValueChange={(next) => update("z_max_mm", next)}
          />
        </div>
        <div className="control-row">
          <label>Geometry tool</label>
          <select
            value={state.drawTool}
            onChange={(e) => update("drawTool", e.target.value as GeometryTool)}
          >
            {TOOL_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
        <div className="control-row">
          <label>Snap to grid</label>
          <input
            type="checkbox"
            checked={state.snapToGrid}
            onChange={(e) => update("snapToGrid", e.target.checked)}
          />
        </div>
        <div className="control-row">
          <label>Snap step (mm)</label>
          <NumberInput
            step={0.1}
            min={0.1}
            max={10}
            value={state.snapStepMm}
            onValueChange={(next) => update("snapStepMm", next)}
            disabled={!state.snapToGrid}
          />
        </div>
        <div className="control-row">
          <label>Overlay geometry</label>
          <input
            type="checkbox"
            checked={state.showGeometryOverlay}
            onChange={(e) => update("showGeometryOverlay", e.target.checked)}
          />
        </div>
        <div className="control-row">
          <label>Overlay opacity</label>
          <NumberInput
            step="0.05"
            min={0}
            max={0.6}
            value={state.geometryOverlayOpacity}
            onValueChange={(next) => update("geometryOverlayOpacity", next)}
            disabled={!state.showGeometryOverlay}
          />
        </div>
        <details className="sidebar-collapsible">
          <summary>
            <span>Mesh Controls</span>
            <span className="sidebar-collapsible-summary">{meshSummary}</span>
          </summary>
          <div className="sidebar-collapsible-body">
            <div className="control-row">
              <label>Mesh nr</label>
              <NumberInput
                min={MESH_LIMITS.nrMin}
                max={MESH_LIMITS.nrMax}
                value={state.nr}
                onValueChange={(next) => update("nr", Math.round(next))}
              />
            </div>
            <div className="control-row">
              <label>Mesh nz</label>
              <NumberInput
                min={MESH_LIMITS.nzMin}
                max={MESH_LIMITS.nzMax}
                value={state.nz}
                onValueChange={(next) => update("nz", Math.round(next))}
              />
            </div>
            <p className="section-note">
              Mesh limits: nr {MESH_LIMITS.nrMin}-{MESH_LIMITS.nrMax}, nz {MESH_LIMITS.nzMin}-
              {MESH_LIMITS.nzMax}
            </p>
          </div>
        </details>
      </section>

      <section>
        <h2>Process Setup</h2>
        <div className="preset-row">
          {PROCESS_PRESETS.map((preset) => (
            <button
              key={preset.id}
              type="button"
              className={`chip-button ${selectedPresetId === preset.id ? "chip-primary" : ""}`}
              onClick={() => applyProcessPreset(preset.id)}
              title={`${preset.note} | ${preset.reference}`}
            >
              {preset.label}
            </button>
          ))}
        </div>
        {selectedPreset ? (
          <p className="section-note">
            {selectedPreset.note}
            {" "}
            {selectedPreset.referenceUrl ? (
              <a className="mini-link-anchor" href={selectedPreset.referenceUrl} target="_blank" rel="noreferrer">
                Source
              </a>
            ) : (
              <span>({selectedPreset.reference})</span>
            )}
          </p>
        ) : (
          <p className="section-note">
            Presets are literature/industry-inspired starting windows (tune by chamber and material stack).
          </p>
        )}
        <div className="control-row">
          <label>Pressure (Torr)</label>
          <NumberInput
            step="0.01"
            min={0.01}
            value={state.pressure_Torr}
            onValueChange={(next) => update("pressure_Torr", next)}
          />
        </div>
        <div className="control-row">
          <label>DC Bias (V)</label>
          <NumberInput
            step="1"
            min={-5000}
            max={5000}
            value={state.dc_bias_V}
            onValueChange={(next) => update("dc_bias_V", next)}
            onWheel={(e) => (e.currentTarget as HTMLInputElement).blur()}
          />
        </div>
        <div className="source-list">
          {state.plasmaSources.map((source, idx) => {
            const tagOptions = rfSurfaceTagOptions.includes(source.surface_tag)
              ? rfSurfaceTagOptions
              : source.surface_tag
                ? [source.surface_tag, ...rfSurfaceTagOptions]
                : rfSurfaceTagOptions;
            return (
              <div className="source-card" key={source.id}>
                <div className="source-card-head">
                  <span>{source.name || `Source ${idx + 1}`}</span>
                  <button
                    type="button"
                    className="icon-button"
                    onClick={() => removeSource(source.id)}
                    disabled={state.plasmaSources.length <= 1}
                    aria-label={`Remove plasma source ${idx + 1}`}
                  >
                    -
                  </button>
                </div>
                <div className="control-row">
                  <label>Target surface tag</label>
                  <select
                    value={source.surface_tag}
                    onChange={(e) => updateSource(source.id, { surface_tag: e.target.value })}
                  >
                    {tagOptions.length === 0 ? (
                      <option value="">(No powered tag)</option>
                    ) : (
                      tagOptions.map((tag) => (
                        <option key={tag} value={tag}>
                          {tag}
                        </option>
                      ))
                    )}
                  </select>
                </div>
                <div className="control-row">
                  <label>RF power (W)</label>
                  <NumberInput
                    min={0}
                    value={source.rf_power_W}
                    onValueChange={(next) => updateSource(source.id, { rf_power_W: next })}
                    onWheel={(e) => (e.currentTarget as HTMLInputElement).blur()}
                  />
                </div>
                <div className="control-row">
                  <label>Frequency (Hz)</label>
                  <NumberInput
                    min={1}
                    value={source.frequency_Hz}
                    onValueChange={(next) => updateSource(source.id, { frequency_Hz: next })}
                    onWheel={(e) => (e.currentTarget as HTMLInputElement).blur()}
                  />
                </div>
                <div className="control-row">
                  <label>Phase (deg)</label>
                  <NumberInput
                    min={-360}
                    max={360}
                    value={source.phase_deg}
                    onValueChange={(next) => updateSource(source.id, { phase_deg: next })}
                  />
                </div>
              </div>
            );
          })}
        </div>
        <button
          type="button"
          className="ghost-button"
          onClick={addSource}
          disabled={state.plasmaSources.length >= 3}
        >
          + Add plasma source (max 3)
        </button>
        <details className="sidebar-collapsible">
          <summary>
            <span>DC Bias by Geometry</span>
            <span className="sidebar-collapsible-summary">
              {state.dcBiasRegions.length} region{state.dcBiasRegions.length === 1 ? "" : "s"}
            </span>
          </summary>
          <div className="sidebar-collapsible-body">
            <div className="source-list">
              {state.dcBiasRegions.map((row, idx) => {
                const tagOptions = dcBiasTagOptions.includes(row.target_tag)
                  ? dcBiasTagOptions
                  : row.target_tag
                    ? [row.target_tag, ...dcBiasTagOptions]
                    : dcBiasTagOptions;
                return (
                  <div className="source-card" key={row.id}>
                    <div className="source-card-head">
                      <span>DC Bias Region {idx + 1}</span>
                      <button
                        type="button"
                        className="icon-button"
                        onClick={() => removeDcBiasRegion(row.id)}
                        aria-label={`Remove dc bias region ${idx + 1}`}
                      >
                        -
                      </button>
                    </div>
                    <div className="control-row">
                      <label>Target geometry tag</label>
                      <select
                        value={row.target_tag}
                        onChange={(e) =>
                          updateDcBiasRegion(row.id, { target_tag: e.target.value })
                        }
                      >
                        {tagOptions.length === 0 ? (
                          <option value="">(No geometry tag)</option>
                        ) : (
                          tagOptions.map((tag) => (
                            <option key={`${row.id}-${tag}`} value={tag}>
                              {tag}
                            </option>
                          ))
                        )}
                      </select>
                    </div>
                    <div className="control-row">
                      <label>DC bias (V)</label>
                      <NumberInput
                        step="1"
                        min={-5000}
                        max={5000}
                        value={row.dc_bias_V}
                        onValueChange={(next) =>
                          updateDcBiasRegion(row.id, { dc_bias_V: next })
                        }
                        onWheel={(e) => (e.currentTarget as HTMLInputElement).blur()}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
            <button
              type="button"
              className="ghost-button"
              onClick={addDcBiasRegion}
              disabled={state.dcBiasRegions.length >= 16}
            >
              + Add DC bias region (max 16)
            </button>
            <p className="section-note">
              Adds local DC offset for selected geometry tags (global DC Bias + per-tag DC Bias).
            </p>
          </div>
        </details>
        <p className="section-note">
          Total RF power {state.rf_power_W.toFixed(1)} W | Effective frequency{" "}
          {(state.frequency_Hz / 1_000_000).toFixed(2)} MHz
        </p>
      </section>

      <section>
        <h2>Gas Mixture</h2>
        <div className="gas-header">
          <span>Species</span>
          <span>Flow (sccm)</span>
          <span />
        </div>
        <div className="gas-list">
          {state.gasComponents.map((row, idx) => (
            <div className="gas-row" key={row.id}>
              <select value={row.species} onChange={(e) => updateGas(row.id, { species: e.target.value })}>
                {GAS_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
              <NumberInput
                min={0}
                step="0.1"
                value={row.flow_sccm}
                onValueChange={(next) => updateGas(row.id, { flow_sccm: next })}
              />
              <button
                type="button"
                className="icon-button"
                onClick={() => removeGas(row.id)}
                disabled={state.gasComponents.length <= 1}
                aria-label={`Remove gas ${idx + 1}`}
              >
                -
              </button>
            </div>
          ))}
        </div>
        <button type="button" className="ghost-button" onClick={addGas}>
          + Add gas
        </button>
        <details className="sidebar-collapsible">
          <summary>
            <span>Inlet Controls</span>
            <span className="sidebar-collapsible-summary">{inletSummaryText}</span>
          </summary>
          <div className="sidebar-collapsible-body">
            <div className="control-row">
              <label>Inlet surface tag</label>
              <select
                value={state.inletSurfaceTag}
                onChange={(e) => update("inletSurfaceTag", e.target.value)}
              >
                {inletTagOptions.length === 0 ? (
                  <option value="showerhead">showerhead</option>
                ) : (
                  inletTagOptions.map((tag) => (
                    <option key={`inlet-${tag}`} value={tag}>
                      {tag}
                    </option>
                  ))
                )}
              </select>
            </div>
            <div className="control-row">
              <label>Inlet direction</label>
              <select
                value={state.inletDirection}
                onChange={(e) => update("inletDirection", e.target.value as InletDirection)}
              >
                {INLET_DIRECTION_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="control-row">
              <label>Inlet emit side</label>
              <select
                value={state.inletEmitSide}
                onChange={(e) => update("inletEmitSide", e.target.value as InletEmitSide)}
              >
                {INLET_SIDE_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="control-row">
              <label>Inlet active width (%)</label>
              <NumberInput
                min={5}
                max={100}
                step={1}
                value={state.inletActiveWidthPercent}
                onValueChange={(next) => update("inletActiveWidthPercent", next)}
              />
            </div>
          </div>
        </details>
      </section>

      <section>
        <h2>Pumping Ports</h2>
        <details className="sidebar-collapsible">
          <summary>
            <span>Pump Controls</span>
            <span className="sidebar-collapsible-summary">{pumpSummaryText}</span>
          </summary>
          <div className="sidebar-collapsible-body">
            <div className="source-list">
              {state.pumpPorts.map((port, idx) => {
                const tagOptions = pumpSurfaceTagOptions.includes(port.surface_tag)
                  ? pumpSurfaceTagOptions
                  : port.surface_tag
                    ? [port.surface_tag, ...pumpSurfaceTagOptions]
                    : pumpSurfaceTagOptions;
                return (
                  <div className="source-card" key={port.id}>
                    <div className="source-card-head">
                      <span>Pump Port {idx + 1}</span>
                      <button
                        type="button"
                        className="icon-button"
                        onClick={() => removePump(port.id)}
                        disabled={state.pumpPorts.length <= 1}
                        aria-label={`Remove pump port ${idx + 1}`}
                      >
                        -
                      </button>
                    </div>
                    <div className="control-row">
                      <label>Surface tag</label>
                      <select
                        value={port.surface_tag}
                        onChange={(e) => updatePump(port.id, { surface_tag: e.target.value })}
                      >
                        {tagOptions.length === 0 ? (
                          <option value="bottom_pump">bottom_pump</option>
                        ) : (
                          tagOptions.map((tag) => (
                            <option key={`${port.id}-${tag}`} value={tag}>
                              {tag}
                            </option>
                          ))
                        )}
                      </select>
                    </div>
                    <div className="control-row">
                      <label>Strength</label>
                      <NumberInput
                        step="0.01"
                        min={0}
                        value={port.strength}
                        onValueChange={(next) => updatePump(port.id, { strength: next })}
                      />
                    </div>
                    <div className="control-row">
                      <label>Throttle (%)</label>
                      <NumberInput
                        step="0.1"
                        min={0}
                        max={100}
                        value={port.throttle_percent}
                        onValueChange={(next) =>
                          updatePump(port.id, { throttle_percent: next })
                        }
                      />
                    </div>
                    <div className="control-row">
                      <label>Conductance (L/s)</label>
                      <NumberInput
                        step="1"
                        min={0}
                        value={port.conductance_lps}
                        onValueChange={(next) =>
                          updatePump(port.id, { conductance_lps: next })
                        }
                      />
                    </div>
                    <div className="control-row">
                      <label>Target pressure (Pa)</label>
                      <NumberInput
                        step="0.1"
                        min={0}
                        value={port.target_pressure_Pa}
                        onValueChange={(next) =>
                          updatePump(port.id, { target_pressure_Pa: next })
                        }
                      />
                    </div>
                    <div className="control-row">
                      <label>Note</label>
                      <input
                        type="text"
                        value={port.note}
                        onChange={(e) => updatePump(port.id, { note: e.target.value })}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
            <button
              type="button"
              className="ghost-button"
              onClick={addPump}
              disabled={state.pumpPorts.length >= 4}
            >
              + Add pump port (max 4)
            </button>
          </div>
        </details>
      </section>

      <section>
        <h2>Material and Solver</h2>
        <details className="sidebar-collapsible">
          <summary>
            <span>Advanced Material / Solver</span>
            <span className="sidebar-collapsible-summary">{advancedSummaryText}</span>
          </summary>
          <div className="sidebar-collapsible-body">
            <div className="control-row">
              <label>Epsilon r (default dielectric)</label>
              <NumberInput
                value={state.epsilon_r}
                onValueChange={(next) => update("epsilon_r", next)}
              />
            </div>
            <div className="control-row">
              <label>Wall loss factor</label>
              <NumberInput
                step="0.01"
                min={0}
                max={1}
                value={state.wall_loss_e}
                onValueChange={(next) => update("wall_loss_e", next)}
              />
            </div>
            <div className="control-row">
              <label>Enable baseline delta</label>
              <input
                type="checkbox"
                checked={state.baselineEnabled}
                onChange={(e) => update("baselineEnabled", e.target.checked)}
              />
            </div>
          </div>
        </details>
      </section>

      <button className={`run-button ${isRunning ? "abort" : ""}`} onClick={handleRun}>
        {isRunning ? "Abort Simulation" : "Run Plasma Simulation"}
      </button>
    </aside>
  );
};

export default SidebarControls;
