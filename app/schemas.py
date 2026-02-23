"""Pydantic models for the plasma simulation API."""

from __future__ import annotations

from typing import Dict, List, Optional, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


class AppBaseModel(BaseModel):
    """Base model with strict field handling."""

    model_config = ConfigDict(extra="forbid")


class Meta(AppBaseModel):
    """Client metadata for the request."""

    request_id: Optional[str] = Field(default=None)
    user_id: Optional[str] = Field(default=None)
    note: Optional[str] = Field(default=None)


class Point2D(AppBaseModel):
    """A 2D point in millimeters."""

    r_mm: float
    z_mm: float


class GeometryDomain(AppBaseModel):
    """Axisymmetric r-z domain extents and optional grid sizing."""

    r_max_mm: float = Field(gt=0)
    z_max_mm: float = Field(gt=0)
    nr: int = Field(default=8, ge=2)
    nz: int = Field(default=8, ge=2)


RegionLegendValue = Literal[
    "plasma",
    "solid_wall",
    "powered_electrode",
    "ground_electrode",
    "dielectric",
]


class GeometryGrid(AppBaseModel):
    """Frontend-rasterized geometry mask grid."""

    schema: Literal["mask_v1"] = Field(default="mask_v1")
    nr: int = Field(ge=2)
    nz: int = Field(ge=2)
    region_id: List[List[int]]
    region_legend: Dict[int, RegionLegendValue]
    tag_mask: Optional[Dict[str, List[List[bool]]]] = Field(default=None)

    @staticmethod
    def _validate_mask_shape(name: str, mask: List[List[bool]], nz: int, nr: int) -> None:
        if len(mask) != nz:
            raise ValueError(f"{name} must have shape [nz][nr]")
        for row in mask:
            if len(row) != nr:
                raise ValueError(f"{name} must have shape [nz][nr]")

    @model_validator(mode="after")
    def validate_grid(self) -> "GeometryGrid":
        if len(self.region_id) != self.nz:
            raise ValueError("geometry.grid.region_id must have shape [nz][nr]")
        for row in self.region_id:
            if len(row) != self.nr:
                raise ValueError("geometry.grid.region_id must have shape [nz][nr]")

        legend_keys = set(self.region_legend.keys())
        for row in self.region_id:
            for region_value in row:
                if region_value not in legend_keys:
                    raise ValueError(
                        f"geometry.grid.region_id contains unknown id {region_value} not in region_legend"
                    )

        if self.tag_mask is not None:
            for tag, mask in self.tag_mask.items():
                if not tag.strip():
                    raise ValueError("geometry.grid.tag_mask keys must be non-empty strings")
                self._validate_mask_shape(f"geometry.grid.tag_mask['{tag}']", mask, self.nz, self.nr)

        return self


class Geometry(AppBaseModel):
    """Geometry configuration for the simulation domain."""

    axisymmetric: bool = Field(default=True)
    coordinate_system: str = Field(default="r-z")
    domain: GeometryDomain
    tags: Optional[List[str]] = Field(default=None)
    grid: Optional[GeometryGrid] = Field(default=None)

    @field_validator("tags")
    @classmethod
    def validate_tags(cls, value: Optional[List[str]]) -> Optional[List[str]]:
        if value is None:
            return value
        cleaned: List[str] = []
        for tag in value:
            if not isinstance(tag, str) or not tag.strip():
                raise ValueError("geometry.tags entries must be non-empty strings")
            cleaned.append(tag.strip())
        return cleaned


class Process(AppBaseModel):
    """Process conditions for the discharge."""

    pressure_Pa: float = Field(gt=0)
    rf_power_W: float = Field(ge=0)
    frequency_Hz: float = Field(gt=0)
    dc_bias_V: float = Field(default=0.0, ge=-5000.0, le=5000.0)
    rf_sources: Optional[List["PlasmaSource"]] = Field(default=None, max_length=3)
    dc_bias_regions: Optional[List["DCBiasRegion"]] = Field(default=None, max_length=64)

    @model_validator(mode="after")
    def validate_rf_sources(self) -> "Process":
        if self.rf_sources is None:
            pass
        elif len(self.rf_sources) == 0:
            raise ValueError("process.rf_sources must include at least one source when provided")
        elif len(self.rf_sources) > 3:
            raise ValueError("process.rf_sources supports up to 3 sources")
        if self.dc_bias_regions is not None and len(self.dc_bias_regions) == 0:
            raise ValueError("process.dc_bias_regions must include at least one region when provided")
        return self


class PlasmaSource(AppBaseModel):
    """Per-source RF drive configuration for multi-source excitation."""

    name: Optional[str] = Field(default=None)
    surface_tag: Optional[str] = Field(default=None)
    rf_power_W: float = Field(ge=0)
    frequency_Hz: float = Field(gt=0)
    phase_deg: float = Field(default=0.0, ge=-360.0, le=360.0)

    @field_validator("surface_tag")
    @classmethod
    def validate_surface_tag(cls, value: Optional[str]) -> Optional[str]:
        if value is None:
            return value
        trimmed = value.strip()
        if not trimmed:
            return None
        return trimmed


class DCBiasRegion(AppBaseModel):
    """Per-tag DC bias override in volts."""

    target_tag: str
    dc_bias_V: float = Field(default=0.0, ge=-5000.0, le=5000.0)

    @field_validator("target_tag")
    @classmethod
    def validate_target_tag(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("target_tag must be a non-empty string")
        return value.strip()


Process.model_rebuild()


class GasComponent(AppBaseModel):
    """One component of the gas mixture."""

    species: str
    fraction: float = Field(ge=0, le=1)


class Gas(AppBaseModel):
    """Gas mixture definition."""

    mixture: List[GasComponent]

    @model_validator(mode="after")
    def validate_mixture(self) -> "Gas":
        if not self.mixture:
            raise ValueError("gas mixture must include at least one component")
        total = sum(component.fraction for component in self.mixture)
        if abs(total - 1.0) > 1e-6:
            raise ValueError("gas mixture fractions must sum to 1 within 1e-6")
        return self


class InletSurface(AppBaseModel):
    """Uniform inlet surface definition."""

    type: Literal["surface"]
    surface_tag: str
    uniform: bool = Field(default=True)
    total_flow_sccm: float = Field(ge=0)
    direction: Literal[
        "normal_inward",
        "radial_inward",
        "radial_outward",
        "diffuse",
    ] = Field(default="normal_inward")
    emit_side: Literal["left", "center", "right"] = Field(default="center")
    active_width_percent: float = Field(default=28.0, ge=5.0, le=100.0)

    @field_validator("surface_tag")
    @classmethod
    def validate_surface_tag(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("surface_tag must be a non-empty string")
        return value.strip()

    @field_validator("uniform")
    @classmethod
    def validate_uniform(cls, value: bool) -> bool:
        if value is not True:
            raise ValueError("uniform must be true for MVP")
        return value


class OutletSink(AppBaseModel):
    """Outlet sink definition."""

    type: Literal["sink"]
    surface_tag: str
    strength: float = Field(default=1.0, ge=0)
    throttle_percent: Optional[float] = Field(default=None, ge=0, le=100)
    conductance_lps: Optional[float] = Field(default=None, ge=0)
    target_pressure_Pa: Optional[float] = Field(default=None, ge=0)
    note: Optional[str] = Field(default=None, max_length=240)

    @field_validator("surface_tag")
    @classmethod
    def validate_surface_tag(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("surface_tag must be a non-empty string")
        return value.strip()

    @field_validator("note")
    @classmethod
    def validate_note(cls, value: Optional[str]) -> Optional[str]:
        if value is None:
            return value
        cleaned = value.strip()
        return cleaned or None


class FlowBoundary(AppBaseModel):
    """Flow boundary conditions for the chamber."""

    inlet: Optional[InletSurface] = Field(default=None)
    outlet: Optional[OutletSink] = Field(default=None)
    outlets: Optional[List[OutletSink]] = Field(default=None, max_length=8)
    wall_temperature_K: Optional[float] = Field(default=None, gt=0)

    @model_validator(mode="before")
    @classmethod
    def translate_legacy(cls, data):
        if not isinstance(data, dict):
            return data
        legacy_keys = {"inlet_sccm", "outlet_pressure_Pa"}
        has_legacy = any(key in data for key in legacy_keys)
        has_new = "inlet" in data or "outlet" in data or "outlets" in data
        if has_new and has_legacy:
            raise ValueError("flow_boundary must use either v1.1 inlet/outlet or legacy fields")
        if has_legacy:
            inlet_sccm = data.get("inlet_sccm", 0.0)
            if inlet_sccm is None:
                inlet_sccm = 0.0
            outlet_pressure = data.get("outlet_pressure_Pa")
            wall_temp = data.get("wall_temperature_K")
            inlet = {
                "type": "surface",
                "surface_tag": "showerhead",
                "uniform": True,
                "total_flow_sccm": inlet_sccm,
                "direction": "normal_inward",
                "emit_side": "center",
                "active_width_percent": 28.0,
            }
            outlet = None
            if outlet_pressure is not None:
                outlet = {"type": "sink", "surface_tag": "bottom_pump", "strength": 1.0}
            return {"inlet": inlet, "outlet": outlet, "outlets": None, "wall_temperature_K": wall_temp}
        return data

    @model_validator(mode="after")
    def validate_definition(self) -> "FlowBoundary":
        if self.outlet is not None and self.outlets:
            raise ValueError("flow_boundary must use either outlet or outlets, not both")
        if self.outlets is not None and len(self.outlets) == 0:
            raise ValueError("flow_boundary.outlets must include at least one outlet")
        if self.inlet is None and self.outlet is None and not self.outlets:
            raise ValueError("flow_boundary must define inlet or outlet/outlets")
        return self


class MaterialProps(AppBaseModel):
    """Material properties for a region."""

    epsilon_r: float = Field(gt=0)
    wall_loss_e: float = Field(ge=0, le=1)


class MaterialRegionOverride(AppBaseModel):
    """Per-region material overrides."""

    target_tag: str
    epsilon_r: Optional[float] = Field(default=None, gt=0)
    wall_loss_e: Optional[float] = Field(default=None, ge=0, le=1)

    @field_validator("target_tag")
    @classmethod
    def validate_target_tag(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("target_tag must be a non-empty string")
        return value.strip()

    @model_validator(mode="after")
    def validate_override(self) -> "MaterialRegionOverride":
        if self.epsilon_r is None and self.wall_loss_e is None:
            raise ValueError("material region overrides require epsilon_r or wall_loss_e")
        return self


class MaterialConfig(AppBaseModel):
    """Material configuration with defaults and region overrides."""

    name: Optional[str] = Field(default=None)
    default: MaterialProps
    regions: List[MaterialRegionOverride] = Field(default_factory=list)

    @model_validator(mode="before")
    @classmethod
    def translate_legacy(cls, data):
        if not isinstance(data, dict):
            return data
        has_legacy = "epsilon_r" in data or "wall_loss_e" in data
        has_new = "default" in data or "regions" in data
        if has_new and has_legacy:
            raise ValueError("material must use either v1.1 default/regions or legacy fields")
        if has_legacy:
            return {
                "name": data.get("name"),
                "default": {
                    "epsilon_r": data.get("epsilon_r"),
                    "wall_loss_e": data.get("wall_loss_e"),
                },
                "regions": [],
            }
        return data


class Impedance(AppBaseModel):
    """Impedance delta used to infer coupling efficiency."""

    delta_percent: float

    @field_validator("delta_percent")
    @classmethod
    def validate_delta_percent(cls, value: float) -> float:
        if value < -100 or value > 100:
            raise ValueError("impedance.delta_percent must be within [-100, 100]")
        return value


class Baseline(AppBaseModel):
    """Baseline comparison configuration."""

    enabled: bool = Field(default=False)
    baseline_id: Optional[str] = Field(default=None)


class OutputSelection(AppBaseModel):
    """Selective output controls for optional post-processing."""

    efield: bool = Field(default=True)
    ne: bool = Field(default=True)
    volume_loss_density: bool = Field(
        default=True,
        description=(
            "Backward-compatible key. Enables geometry-local per-volume absorbed power "
            "density proxy output (relative), not a material volume-loss term."
        ),
    )
    sheath: bool = Field(default=True)


class SimulationRequest(AppBaseModel):
    """Top-level request payload for simulation."""

    meta: Meta
    geometry: Geometry
    process: Process
    gas: Gas
    flow_boundary: FlowBoundary
    material: MaterialConfig
    impedance: Impedance
    baseline: Baseline
    outputs: Optional[OutputSelection] = Field(default=None)

    @model_validator(mode="after")
    def validate_tag_consistency(self) -> "SimulationRequest":
        if self.geometry.grid is not None:
            if self.geometry.grid.nr != self.geometry.domain.nr:
                raise ValueError("geometry.grid.nr must match geometry.domain.nr")
            if self.geometry.grid.nz != self.geometry.domain.nz:
                raise ValueError("geometry.grid.nz must match geometry.domain.nz")

        tags = self.geometry.tags
        if tags is None:
            return self
        tag_set = set(tags)
        if self.flow_boundary.inlet is not None:
            inlet_tag = self.flow_boundary.inlet.surface_tag
            if inlet_tag not in tag_set:
                raise ValueError(f"flow_boundary.inlet.surface_tag '{inlet_tag}' not found in geometry.tags")
        if self.flow_boundary.outlet is not None:
            outlet_tag = self.flow_boundary.outlet.surface_tag
            if outlet_tag not in tag_set:
                raise ValueError(f"flow_boundary.outlet.surface_tag '{outlet_tag}' not found in geometry.tags")
        if self.flow_boundary.outlets is not None:
            for index, outlet in enumerate(self.flow_boundary.outlets):
                outlet_tag = outlet.surface_tag
                if outlet_tag not in tag_set:
                    raise ValueError(
                        f"flow_boundary.outlets[{index}].surface_tag '{outlet_tag}' not found in geometry.tags"
                    )
        for index, region in enumerate(self.material.regions):
            target_tag = region.target_tag
            if target_tag not in tag_set:
                raise ValueError(
                    f"material.regions[{index}].target_tag '{target_tag}' not found in geometry.tags"
                )
        if self.process.rf_sources is not None:
            for index, source in enumerate(self.process.rf_sources):
                source_tag = source.surface_tag
                if source_tag is not None and source_tag not in tag_set:
                    raise ValueError(
                        f"process.rf_sources[{index}].surface_tag '{source_tag}' not found in geometry.tags"
                    )
        if self.process.dc_bias_regions is not None:
            for index, region in enumerate(self.process.dc_bias_regions):
                target_tag = region.target_tag
                if target_tag not in tag_set:
                    raise ValueError(
                        f"process.dc_bias_regions[{index}].target_tag '{target_tag}' not found in geometry.tags"
                    )
        if self.geometry.grid is not None and self.geometry.grid.tag_mask is not None:
            for tag in self.geometry.grid.tag_mask.keys():
                if tag not in tag_set:
                    raise ValueError(f"geometry.grid.tag_mask['{tag}'] not found in geometry.tags")
        return self


class GeometryGridSummary(AppBaseModel):
    """Summary counts derived from the geometry grid."""

    region_type_counts: Dict[str, int]
    tag_counts: Optional[Dict[str, int]] = Field(default=None)


class NeSolverMetadata(AppBaseModel):
    """Metadata for the electron density solver."""

    method: str
    mu_e: float
    D_e: float
    Te_norm: float
    k_s_wall: float
    k_s_powered: float
    lambda_relax: float
    ionization_gain: Optional[float] = Field(default=None)
    bulk_loss: Optional[float] = Field(default=None)
    converged: bool
    iterations: int
    residual: float
    fallback_used: bool
    warnings: List[str] = Field(default_factory=list)


class InsightSummary(AppBaseModel):
    """Summary statistics for sheath insights."""

    e_on_sheath_mean: Optional[float] = Field(default=None)
    e_on_sheath_min: Optional[float] = Field(default=None)
    e_on_sheath_max: Optional[float] = Field(default=None)
    ne_on_sheath_mean: Optional[float] = Field(default=None)
    ne_on_sheath_min: Optional[float] = Field(default=None)
    ne_on_sheath_max: Optional[float] = Field(default=None)
    thickness_mean_mm: Optional[float] = Field(default=None)
    thickness_min_mm: Optional[float] = Field(default=None)
    thickness_max_mm: Optional[float] = Field(default=None)


class SheathInsights(AppBaseModel):
    """1D insight curves for sheath and near-sheath fields."""

    r_mm: List[float]
    sheath_z_mm_by_r: List[float]
    sheath_thickness_mm_by_r: Optional[List[float]] = Field(default=None)
    E_on_sheath_by_r: Optional[List[float]] = Field(default=None)
    ne_on_sheath_by_r: Optional[List[float]] = Field(default=None)
    summary: InsightSummary
    warnings: List[str] = Field(default_factory=list)


class VizCurves(AppBaseModel):
    """Plot-ready 1D curves for visualization."""

    r_mm: List[float]
    sheath_z_mm_by_r: List[float]
    sheath_thickness_mm_by_r: Optional[List[float]] = Field(default=None)
    delta_sheath_z_mm_by_r: Optional[List[float]] = Field(default=None)
    delta_sheath_thickness_mm_by_r: Optional[List[float]] = Field(default=None)
    warnings: List[str] = Field(default_factory=list)


class IonProxyCurves(AppBaseModel):
    """Proxy ion curves derived from phi and ne for plotting."""

    ion_energy_proxy_rel_by_r: Optional[List[float]] = Field(default=None)
    ion_flux_proxy_rel_by_r: Optional[List[float]] = Field(default=None)
    Te_eV_used: Optional[float] = Field(default=None)
    Mi_amu_used: Optional[float] = Field(default=None)
    warnings: List[str] = Field(default_factory=list)



class SimulationMetadata(AppBaseModel):
    """Echoed inputs and derived metadata."""

    request_id: str
    eta: float
    geometry: Geometry
    process: Process
    gas: Gas
    flow_boundary: FlowBoundary
    material: MaterialConfig
    impedance: Impedance
    grid_summary: Optional[GeometryGridSummary] = Field(default=None)
    ne_solver: Optional[NeSolverMetadata] = Field(default=None)


class Grid(AppBaseModel):
    """Grid coordinates for the simulation."""

    r_mm: List[float]
    z_mm: List[float]


class FieldGrid(AppBaseModel):
    """Plasma fields on the grid."""

    E_mag: Optional[List[List[float]]] = Field(default=None)
    ne: Optional[List[List[float]]] = Field(default=None)
    volume_loss_density: Optional[List[List[float]]] = Field(
        default=None,
        description=(
            "Backward-compatible key for geometry-local per-volume absorbed power density "
            "proxy field (relative)."
        ),
    )
    emission: Optional[List[List[float]]] = Field(default=None)


class Sheath(AppBaseModel):
    """Sheath contour and optional mask."""

    polyline_mm: List[Point2D]
    mask: Optional[List[List[bool]]] = Field(default=None)


class SheathMetrics(AppBaseModel):
    """Derived sheath diagnostics for insight views."""

    z_mm_by_r: List[float]
    electrode_z_mm_by_r: Optional[List[float]] = Field(default=None)
    thickness_mm_by_r: Optional[List[float]] = Field(default=None)
    thickness_mean_mm: Optional[float] = Field(default=None)
    thickness_min_mm: Optional[float] = Field(default=None)
    thickness_max_mm: Optional[float] = Field(default=None)
    z_mean_mm: float
    z_min_mm: float
    z_max_mm: float
    warnings: List[str] = Field(default_factory=list)



class Compare(AppBaseModel):
    """Baseline comparison outputs."""

    enabled: bool
    delta_fields: Optional[FieldGrid] = Field(default=None)
    delta_sheath_thickness_mm: Optional[float] = Field(default=None)
    delta_sheath_metrics: Optional[SheathMetrics] = Field(default=None)
    delta_insights: Optional[SheathInsights] = Field(default=None)
    delta_ion_proxy: Optional[IonProxyCurves] = Field(default=None)


class SimulationResult(AppBaseModel):
    """Full simulation output payload."""

    metadata: SimulationMetadata
    grid: Grid
    fields: Optional[FieldGrid] = Field(default=None)
    sheath: Sheath
    sheath_metrics: Optional[SheathMetrics] = Field(default=None)
    insights: Optional[SheathInsights] = Field(default=None)
    viz: Optional[VizCurves] = Field(default=None)
    ion_proxy: Optional[IonProxyCurves] = Field(default=None)
    compare: Optional[Compare] = Field(default=None)


class StorageInfo(AppBaseModel):
    """Storage information for large results."""

    backend: str
    url: Optional[str] = Field(default=None)
    bucket: Optional[str] = Field(default=None)
    key: Optional[str] = Field(default=None)
    local_path: Optional[str] = Field(default=None)
    expires_in: Optional[int] = Field(default=None)


class SimulationResponse(AppBaseModel):
    """API response for simulation requests."""

    request_id: str
    stored: bool
    size_bytes: int
    result: Optional[SimulationResult] = Field(default=None)
    result_url: Optional[str] = Field(default=None)
    storage: StorageInfo

