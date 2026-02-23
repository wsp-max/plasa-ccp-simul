"""Poisson-based electrostatic solver for axisymmetric r-z grids."""

from __future__ import annotations

from bisect import bisect_left
import math
from typing import Dict, Iterable, List, NamedTuple, Optional, Tuple

try:  # pragma: no cover - optional dependency
    import scipy.sparse as sp
    import scipy.sparse.linalg as spla
except ImportError:  # pragma: no cover - optional dependency
    sp = None
    spla = None

try:  # pragma: no cover - optional dependency
    import numpy as np
except ImportError:  # pragma: no cover - optional dependency
    np = None

from schemas import (
    Compare,
    FieldGrid,
    GeometryGridSummary,
    Grid,
    InsightSummary,
    IonProxyCurves,
    NeSolverMetadata,
    Point2D,
    Sheath,
    SheathInsights,
    SheathMetrics,
    SimulationMetadata,
    SimulationRequest,
    SimulationResult,
    VizCurves,
)


_REGION_TYPES = (
    "plasma",
    "solid_wall",
    "powered_electrode",
    "ground_electrode",
    "dielectric",
)

_SHEATH_METHOD = "phi_drop_fraction"

# Normalized drift-diffusion coefficients (not SI units).
MU_E = 1.0
TE_NORM = 1.0
D_E = MU_E * TE_NORM
LAMBDA_RELAX = 1e-2
K_S_WALL = 0.05
K_S_POWERED = 0.05
N_FLOOR = 1e-8
NE_MAX_ITER = 5000
NE_TOL = 1e-6
TE_E_V_DEFAULT = 3.0
MI_AMU_DEFAULT = 40.0
RF_REF_FREQ_HZ = 13_560_000.0
PUMP_CONDUCTANCE_REF_LPS = 220.0
PUMP_TARGET_PRESSURE_REF_PA = 8.0
_INLET_DIRECTION_ION_GAIN = {
    "normal_inward": 1.0,
    "radial_inward": 1.08,
    "radial_outward": 0.92,
    "diffuse": 0.95,
}
_INLET_DIRECTION_LOSS_GAIN = {
    "normal_inward": 1.0,
    "radial_inward": 0.94,
    "radial_outward": 1.08,
    "diffuse": 0.98,
}

_TE_FACTOR_BY_SPECIES = {
    "ar": 1.0,
    "argon": 1.0,
    "o2": 0.86,
    "oxygen": 0.86,
    "n2": 0.93,
    "nitrogen": 0.93,
    "he": 1.18,
    "helium": 1.18,
    "h2": 1.12,
    "hydrogen": 1.12,
    "sih4": 0.72,
    "n2o": 0.82,
    "nh3": 0.8,
}

_MU_FACTOR_BY_SPECIES = {
    "ar": 1.0,
    "argon": 1.0,
    "o2": 0.74,
    "oxygen": 0.74,
    "n2": 0.82,
    "nitrogen": 0.82,
    "he": 1.32,
    "helium": 1.32,
    "h2": 1.24,
    "hydrogen": 1.24,
    "sih4": 0.62,
    "n2o": 0.68,
    "nh3": 0.7,
}

_IONIZATION_FACTOR_BY_SPECIES = {
    "ar": 1.0,
    "argon": 1.0,
    "o2": 0.72,
    "oxygen": 0.72,
    "n2": 0.8,
    "nitrogen": 0.8,
    "he": 1.14,
    "helium": 1.14,
    "h2": 1.08,
    "hydrogen": 1.08,
    "sih4": 0.68,
    "n2o": 0.74,
    "nh3": 0.76,
}

_ATTACHMENT_FACTOR_BY_SPECIES = {
    "ar": 0.22,
    "argon": 0.22,
    "o2": 1.25,
    "oxygen": 1.25,
    "n2": 0.58,
    "nitrogen": 0.58,
    "he": 0.2,
    "helium": 0.2,
    "h2": 0.32,
    "hydrogen": 0.32,
    "sih4": 0.95,
    "n2o": 1.08,
    "nh3": 0.9,
}

_MASS_BY_SPECIES_AMU = {
    "ar": 40.0,
    "argon": 40.0,
    "o2": 32.0,
    "oxygen": 32.0,
    "n2": 28.0,
    "nitrogen": 28.0,
    "he": 4.0,
    "helium": 4.0,
    "h2": 2.0,
    "hydrogen": 2.0,
    "sih4": 32.1,
    "n2o": 44.0,
    "nh3": 17.0,
}


class TransportCoefficients(NamedTuple):
    mu_e: float
    D_e: float
    Te_norm: float
    Te_eV: float
    k_s_wall: float
    k_s_powered: float
    lambda_relax: float
    ionization_gain: float
    bulk_loss: float


class RfDriveSource(NamedTuple):
    surface_tag: Optional[str]
    power_w: float
    frequency_hz: float
    phase_deg: float


class EffectiveRfDrive(NamedTuple):
    total_power_w: float
    effective_frequency_hz: float
    multi_source_factor: float
    source_count: int
    sources: List[RfDriveSource]


class BoundaryDriveComponent(NamedTuple):
    surface_tag: Optional[str]
    real: float
    imag: float


def _clamp(value: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, value))


def _weighted_species_factor(
    request: SimulationRequest,
    table: Dict[str, float],
    fallback: float,
) -> float:
    mixture = request.gas.mixture if request.gas else None
    if not mixture:
        return fallback
    value = 0.0
    weight_total = 0.0
    for component in mixture:
        species = component.species.strip().lower()
        fraction = max(0.0, component.fraction)
        factor = table.get(species, fallback)
        value += factor * fraction
        weight_total += fraction
    if weight_total <= 0.0:
        return fallback
    return value / weight_total


def _collect_outlet_sinks(request: SimulationRequest) -> List[object]:
    flow = request.flow_boundary
    outlets: List[object] = []
    if flow.outlets:
        outlets.extend(flow.outlets)
    elif flow.outlet is not None:
        outlets.append(flow.outlet)
    return outlets


def _inlet_total_flow_sccm(request: SimulationRequest) -> float:
    inlet = request.flow_boundary.inlet
    if inlet is None:
        return 0.0
    return max(float(inlet.total_flow_sccm), 0.0)


def _inlet_direction(request: SimulationRequest) -> str:
    inlet = request.flow_boundary.inlet
    if inlet is None:
        return "normal_inward"
    direction = str(getattr(inlet, "direction", "normal_inward")).strip().lower()
    if direction not in _INLET_DIRECTION_ION_GAIN:
        return "normal_inward"
    return direction


def _inlet_emit_side(request: SimulationRequest) -> str:
    inlet = request.flow_boundary.inlet
    if inlet is None:
        return "center"
    emit_side = str(getattr(inlet, "emit_side", "center")).strip().lower()
    if emit_side not in {"left", "center", "right"}:
        return "center"
    return emit_side


def _inlet_active_width_percent(request: SimulationRequest) -> float:
    inlet = request.flow_boundary.inlet
    if inlet is None:
        return 28.0
    raw = getattr(inlet, "active_width_percent", 28.0)
    try:
        value = float(raw)
    except (TypeError, ValueError):
        value = 28.0
    return _clamp(value, 5.0, 100.0)


def _inlet_radial_window(nr: int, emit_side: str, active_width_percent: float) -> Tuple[int, int]:
    if nr <= 1:
        return 0, 1
    width_fraction = _clamp(active_width_percent / 100.0, 0.05, 1.0)
    active_count = max(1, min(nr, int(round(width_fraction * nr))))
    if emit_side == "left":
        start = 0
    elif emit_side == "right":
        start = nr - active_count
    else:
        start = max(0, (nr - active_count) // 2)
    end = min(nr, start + active_count)
    return start, end


def _build_inlet_source_map(
    request: SimulationRequest,
    nz: int,
    nr: int,
    tag_mask: Optional[Dict[str, List[List[bool]]]],
    warnings: List[str],
) -> Tuple[List[List[float]], float]:
    source_map = [[0.0 for _ in range(nr)] for _ in range(nz)]
    inlet = request.flow_boundary.inlet
    if inlet is None or inlet.total_flow_sccm <= 0.0:
        return source_map, 0.0

    emit_side = _inlet_emit_side(request)
    active_width_percent = _inlet_active_width_percent(request)
    j_start, j_end = _inlet_radial_window(nr, emit_side, active_width_percent)
    inlet_tag = str(getattr(inlet, "surface_tag", "")).strip()

    touched = 0
    masked_cells = 0

    if tag_mask is not None and inlet_tag:
        mask = tag_mask.get(inlet_tag)
        if mask is None:
            warnings.append(f"inlet tag '{inlet_tag}' missing in geometry.tag_mask")
        else:
            for k in range(min(nz, len(mask))):
                row = mask[k]
                width = min(nr, len(row))
                for j in range(width):
                    if not row[j]:
                        continue
                    masked_cells += 1
                    if j_start <= j < j_end:
                        source_map[k][j] = 1.0
                        touched += 1

            if masked_cells > 0 and touched == 0:
                # Keep solve stable even when user-selected side/window misses the inlet tag mask.
                for k in range(min(nz, len(mask))):
                    row = mask[k]
                    width = min(nr, len(row))
                    for j in range(width):
                        if row[j]:
                            source_map[k][j] = 1.0
                            touched += 1
                warnings.append(
                    "inlet active window did not overlap inlet surface; fell back to full inlet surface"
                )
    elif tag_mask is None:
        warnings.append("flow inlet defined but geometry.tag_mask is missing")

    if touched == 0:
        top_k = nz - 1
        for j in range(j_start, j_end):
            source_map[top_k][j] = 1.0
            touched += 1
        warnings.append("inlet source map used top-boundary fallback")

    coverage = touched / max(1, nr * nz)
    return source_map, coverage


def _build_inlet_radial_profile(direction: str, nr: int) -> List[float]:
    if nr <= 1:
        return [1.0]
    center = 0.5 * (nr - 1)
    span = max(center, 1.0)
    profile: List[float] = []
    for j in range(nr):
        radial = abs(j - center) / span
        if direction == "radial_inward":
            gain = 1.16 - 0.34 * radial
        elif direction == "radial_outward":
            gain = 0.84 + 0.34 * radial
        elif direction == "diffuse":
            gain = 0.97 + 0.06 * (1.0 - radial)
        else:
            gain = 1.05 - 0.10 * radial
        profile.append(_clamp(gain, 0.68, 1.35))
    return profile


def _build_inlet_axial_profile(direction: str, nz: int) -> List[float]:
    if nz <= 1:
        return [1.0]
    profile: List[float] = []
    denom = max(nz - 1, 1)
    for k in range(nz):
        topness = k / denom
        if direction == "diffuse":
            gain = 1.0
        elif direction == "radial_outward":
            gain = 0.92 + 0.12 * topness
        elif direction == "radial_inward":
            gain = 0.97 + 0.16 * topness
        else:
            gain = 0.94 + 0.20 * topness
        profile.append(_clamp(gain, 0.75, 1.35))
    return profile


def _build_frequency_radial_profile(nr: int, frequency_hz: float) -> List[float]:
    if nr <= 1:
        return [1.0]
    freq_ratio = max(frequency_hz, 1.0) / RF_REF_FREQ_HZ
    high_freq_weight = _clamp(math.log10(freq_ratio + 1.0), 0.0, 0.8)
    low_freq_weight = _clamp(math.log10((1.0 / max(freq_ratio, 1e-6)) + 1.0), 0.0, 0.8)
    center = 0.5 * (nr - 1)
    span = max(center, 1.0)
    profile: List[float] = []
    for j in range(nr):
        radial = abs(j - center) / span
        edge_gain = 0.28 * high_freq_weight * (radial ** 1.35)
        center_gain = 0.18 * low_freq_weight * ((1.0 - radial) ** 1.2)
        profile.append(_clamp(1.0 + edge_gain + center_gain, 0.72, 1.75))
    return profile


def _build_frequency_axial_profile(nz: int, frequency_hz: float) -> List[float]:
    if nz <= 1:
        return [1.0]
    freq_ratio = max(frequency_hz, 1.0) / RF_REF_FREQ_HZ
    high_freq_weight = _clamp(math.log10(freq_ratio + 1.0), 0.0, 0.8)
    low_freq_weight = _clamp(math.log10((1.0 / max(freq_ratio, 1e-6)) + 1.0), 0.0, 0.8)
    profile: List[float] = []
    denom = max(nz - 1, 1)
    for k in range(nz):
        topness = k / denom
        gain = 1.0 + 0.24 * high_freq_weight * topness + 0.16 * low_freq_weight * (1.0 - topness)
        profile.append(_clamp(gain, 0.72, 1.65))
    return profile


def _mean_wall_loss(request: SimulationRequest) -> float:
    values = [_clamp(float(request.material.default.wall_loss_e), 0.0, 1.0)]
    for region in request.material.regions:
        if region.wall_loss_e is None:
            continue
        values.append(_clamp(float(region.wall_loss_e), 0.0, 1.0))
    return sum(values) / max(len(values), 1)


def _effective_outlet_strength(outlet: object) -> float:
    raw_strength = max(float(getattr(outlet, "strength", 0.0)), 0.0)
    throttle_percent = getattr(outlet, "throttle_percent", None)
    conductance_lps = getattr(outlet, "conductance_lps", None)
    target_pressure_pa = getattr(outlet, "target_pressure_Pa", None)

    throttle = (
        max(float(throttle_percent), 0.0) / 100.0
        if throttle_percent is not None
        else 1.0
    )
    conductance = (
        max(float(conductance_lps), 0.0)
        if conductance_lps is not None
        else PUMP_CONDUCTANCE_REF_LPS
    )
    target_pressure = (
        max(float(target_pressure_pa), 0.2)
        if target_pressure_pa is not None
        else PUMP_TARGET_PRESSURE_REF_PA
    )

    conductance_factor = _clamp(
        (conductance / PUMP_CONDUCTANCE_REF_LPS) ** 0.5,
        0.3,
        2.2,
    )
    pressure_factor = _clamp(
        (PUMP_TARGET_PRESSURE_REF_PA / target_pressure) ** 0.5,
        0.35,
        2.4,
    )
    return raw_strength * throttle * conductance_factor * pressure_factor


def _build_outlet_strength_map(
    request: SimulationRequest,
    nz: int,
    nr: int,
    tag_mask: Optional[Dict[str, List[List[bool]]]],
    warnings: List[str],
) -> Tuple[List[List[float]], float]:
    outlet_strength_map = [[0.0 for _ in range(nr)] for _ in range(nz)]
    outlets = _collect_outlet_sinks(request)
    if not outlets:
        return outlet_strength_map, 0.0

    strength_by_tag: Dict[str, float] = {}
    total_strength = 0.0
    for outlet in outlets:
        tag = str(getattr(outlet, "surface_tag", "")).strip()
        if not tag:
            continue
        strength = _effective_outlet_strength(outlet)
        if strength <= 0.0:
            continue
        strength_by_tag[tag] = strength_by_tag.get(tag, 0.0) + strength
        total_strength += strength

    if not strength_by_tag:
        return outlet_strength_map, 0.0

    if tag_mask is None:
        warnings.append("flow outlets defined but geometry.tag_mask is missing")
        return outlet_strength_map, total_strength

    missing_tags: List[str] = []
    touched = False
    for tag, strength in strength_by_tag.items():
        mask = tag_mask.get(tag)
        if mask is None:
            missing_tags.append(tag)
            continue
        for k in range(min(nz, len(mask))):
            row = mask[k]
            width = min(nr, len(row))
            for j in range(width):
                if row[j]:
                    outlet_strength_map[k][j] += strength
                    touched = True

    if missing_tags:
        missing_sorted = ", ".join(sorted(missing_tags))
        warnings.append(f"pump outlet tags missing in geometry.tag_mask: {missing_sorted}")
    if not touched:
        warnings.append("pump outlet masks did not overlap the geometry grid")
    return outlet_strength_map, total_strength


def _spread_outlet_influence(
    source_map: List[List[float]],
    steps: int,
    decay: float,
) -> List[List[float]]:
    if not source_map or not source_map[0] or steps <= 0:
        return source_map

    nz = len(source_map)
    nr = len(source_map[0])
    influence = [row[:] for row in source_map]
    for _ in range(steps):
        updated = [row[:] for row in influence]
        changed = False
        for k in range(nz):
            for j in range(nr):
                north = influence[k - 1][j] if k > 0 else 0.0
                south = influence[k + 1][j] if k + 1 < nz else 0.0
                west = influence[k][j - 1] if j > 0 else 0.0
                east = influence[k][j + 1] if j + 1 < nr else 0.0
                propagated = max(north, south, west, east) * decay
                if propagated > updated[k][j] + 1e-9:
                    updated[k][j] = propagated
                    changed = True
        influence = updated
        if not changed:
            break
    return influence


def _to_density_observable(
    ne_raw: List[List[float]],
    request: SimulationRequest,
    total_pump_strength: float,
) -> List[List[float]]:
    pressure_torr = max(request.process.pressure_Pa / 133.322, 0.005)
    inlet_flow_sccm = _inlet_total_flow_sccm(request)
    inlet_direction = _inlet_direction(request)
    inlet_direction_ion_gain = _INLET_DIRECTION_ION_GAIN.get(inlet_direction, 1.0)
    inlet_direction_loss_gain = _INLET_DIRECTION_LOSS_GAIN.get(inlet_direction, 1.0)
    gas_ionization = _weighted_species_factor(request, _IONIZATION_FACTOR_BY_SPECIES, 1.0)
    gas_attachment = _weighted_species_factor(request, _ATTACHMENT_FACTOR_BY_SPECIES, 0.45)
    rf_drive = _effective_rf_drive(request)
    power_w = max(rf_drive.total_power_w, 0.0)
    frequency_hz = max(rf_drive.effective_frequency_hz, 1.0)
    dc_bias_v = _dc_bias_voltage(request)
    rf_power_gain = _clamp(((power_w + 40.0) / 540.0) ** 0.58, 0.5, 4.8)
    rf_freq_gain = _clamp((frequency_hz / RF_REF_FREQ_HZ) ** 0.14, 0.75, 1.8)
    dc_gain = _clamp((1.0 + abs(dc_bias_v) / 700.0) ** 0.22, 0.9, 1.7)
    dc_polarity_gain = _clamp(1.0 + (-dc_bias_v / 2000.0), 0.82, 1.24)
    rf_gain = _clamp(
        rf_power_gain
        * rf_freq_gain
        * dc_gain
        * dc_polarity_gain
        * (rf_drive.multi_source_factor ** 0.14),
        0.45,
        5.5,
    )

    # Fixed per-request transfer curve (not per-grid normalization) so A/B legend stays meaningful.
    n_sat = 0.08 * ((pressure_torr + 0.04) / 0.14) ** 0.32
    n_sat *= (1.0 + inlet_flow_sccm / 520.0) ** 0.42
    n_sat *= 1.0 + 0.16 * total_pump_strength * inlet_direction_loss_gain
    n_sat /= max(gas_ionization, 0.35) ** 0.28
    n_sat *= max(gas_attachment, 0.15) ** 0.18
    n_sat /= _clamp(rf_gain, 0.65, 2.9) ** 0.45
    n_sat /= _clamp(inlet_direction_ion_gain, 0.8, 1.2) ** 0.2
    n_sat = _clamp(n_sat, 0.03, 0.55)

    rf_nonlin_gain = _clamp(rf_gain ** 0.78, 0.45, 4.2)
    gas_reactivity_gain = _clamp(
        (gas_ionization / max(gas_attachment, 0.2)) ** 0.22,
        0.65,
        1.75,
    )
    pump_damping = _clamp(
        1.0 / (1.0 + 0.14 * total_pump_strength * inlet_direction_loss_gain),
        0.45,
        1.0,
    )

    result: List[List[float]] = []
    for row in ne_raw:
        mapped_row: List[float] = []
        for value in row:
            if not math.isfinite(value) or value <= 0.0:
                mapped_row.append(0.0)
                continue
            value_eff = value * rf_nonlin_gain * gas_reactivity_gain * pump_damping
            mapped_row.append(_clamp(value_eff / (value_eff + n_sat), 0.0, 1.0))
        result.append(mapped_row)
    return result


def _collect_rf_drive_sources(request: SimulationRequest) -> List[RfDriveSource]:
    sources: List[RfDriveSource] = []
    if request.process.rf_sources:
        for source in request.process.rf_sources:
            sources.append(
                RfDriveSource(
                    surface_tag=source.surface_tag,
                    power_w=max(source.rf_power_W, 0.0),
                    frequency_hz=max(source.frequency_Hz, 1.0),
                    phase_deg=source.phase_deg,
                )
            )
    if sources:
        return sources
    return [
        RfDriveSource(
            surface_tag=None,
            power_w=max(request.process.rf_power_W, 0.0),
            frequency_hz=max(request.process.frequency_Hz, 1.0),
            phase_deg=0.0,
        )
    ]


def _effective_rf_drive(request: SimulationRequest) -> EffectiveRfDrive:
    """Collapse multi-source RF inputs into effective trend-level drive parameters."""
    sources = _collect_rf_drive_sources(request)
    total_power_w = sum(source.power_w for source in sources)
    if total_power_w > 0.0:
        effective_frequency_hz = (
            sum(source.power_w * source.frequency_hz for source in sources) / total_power_w
        )
    else:
        effective_frequency_hz = (
            sum(source.frequency_hz for source in sources) / max(len(sources), 1)
        )

    if len(sources) <= 1:
        return EffectiveRfDrive(
            total_power_w=total_power_w,
            effective_frequency_hz=max(effective_frequency_hz, 1.0),
            multi_source_factor=1.0,
            source_count=len(sources),
            sources=sources,
        )

    if total_power_w > 0.0:
        real = 0.0
        imag = 0.0
        for source in sources:
            phase_rad = math.radians(source.phase_deg)
            real += source.power_w * math.cos(phase_rad)
            imag += source.power_w * math.sin(phase_rad)
        coherence = _clamp(math.hypot(real, imag) / total_power_w, 0.0, 1.0)
    else:
        coherence = 1.0

    freq_min = min(source.frequency_hz for source in sources)
    freq_max = max(source.frequency_hz for source in sources)
    spread_norm = _clamp(
        (freq_max - freq_min) / max(effective_frequency_hz, 1.0),
        0.0,
        1.0,
    )

    multi_source_factor = _clamp(
        (1.0 + 0.07 * (len(sources) - 1))
        * (1.0 + 0.10 * (1.0 - coherence))
        * (1.0 + 0.08 * spread_norm),
        1.0,
        1.35,
    )
    return EffectiveRfDrive(
        total_power_w=total_power_w,
        effective_frequency_hz=max(effective_frequency_hz, 1.0),
        multi_source_factor=multi_source_factor,
        source_count=len(sources),
        sources=sources,
    )


def _dc_bias_voltage(request: SimulationRequest) -> float:
    value = request.process.dc_bias_V
    if not math.isfinite(value):
        return 0.0
    return _clamp(value, -5000.0, 5000.0)


def _bias_voltage_to_offset(dc_bias_v: float) -> float:
    if not math.isfinite(dc_bias_v):
        return 0.0
    clamped = _clamp(dc_bias_v, -5000.0, 5000.0)
    if abs(clamped) < 1e-9:
        return 0.0
    polarity_gain = 1.12 if clamped < 0.0 else 1.0
    normalized = (clamped / 500.0) * polarity_gain
    return _clamp(normalized, -3.2, 3.2)


def derive_dc_bias_offset(request: SimulationRequest) -> float:
    """Convert DC bias voltage into solver-scale boundary offset."""
    return _bias_voltage_to_offset(_dc_bias_voltage(request))


def _build_dc_bias_region_offset_map(request: SimulationRequest) -> Dict[str, float]:
    offsets: Dict[str, float] = {}
    regions = request.process.dc_bias_regions
    if not regions:
        return offsets
    for region in regions:
        tag = region.target_tag.strip()
        if not tag:
            continue
        offsets[tag] = offsets.get(tag, 0.0) + _bias_voltage_to_offset(region.dc_bias_V)
    return offsets


def _build_boundary_drive_components(request: SimulationRequest) -> List[BoundaryDriveComponent]:
    """Build normalized phasor components for RF boundary superposition."""
    sources = _collect_rf_drive_sources(request)
    if not sources:
        return []

    total_power_w = sum(source.power_w for source in sources)
    components: List[BoundaryDriveComponent] = []
    if total_power_w > 0.0:
        amp_norm = math.sqrt(total_power_w)
        for source in sources:
            amp = math.sqrt(source.power_w) / amp_norm if source.power_w > 0.0 else 0.0
            phase_rad = math.radians(source.phase_deg)
            components.append(
                BoundaryDriveComponent(
                    surface_tag=source.surface_tag,
                    real=amp * math.cos(phase_rad),
                    imag=amp * math.sin(phase_rad),
                )
            )
        return components

    uniform_amp = 1.0 / max(len(sources), 1)
    for source in sources:
        phase_rad = math.radians(source.phase_deg)
        components.append(
            BoundaryDriveComponent(
                surface_tag=source.surface_tag,
                real=uniform_amp * math.cos(phase_rad),
                imag=uniform_amp * math.sin(phase_rad),
            )
        )
    return components


def derive_powered_boundary_voltage(request: SimulationRequest) -> float:
    """Estimate powered-electrode boundary amplitude from process and gas inputs."""
    rf_drive = _effective_rf_drive(request)
    pressure_torr = max(request.process.pressure_Pa / 133.322, 0.005)
    power_w = max(rf_drive.total_power_w, 0.0)
    frequency_hz = max(rf_drive.effective_frequency_hz, 1.0)
    dc_bias_v = _dc_bias_voltage(request)

    if power_w <= 0.0:
        return 0.0

    power_factor = (power_w / 500.0) ** 0.5
    pressure_factor = (0.12 / pressure_torr) ** 0.22
    freq_factor = (frequency_hz / RF_REF_FREQ_HZ) ** 0.08
    gas_factor = _weighted_species_factor(request, _IONIZATION_FACTOR_BY_SPECIES, 1.0) ** 0.6
    multi_source_factor = rf_drive.multi_source_factor ** 0.18
    dc_gain = _clamp((1.0 + abs(dc_bias_v) / 650.0) ** 0.08, 0.92, 1.35)

    drive = (
        power_factor
        * pressure_factor
        * freq_factor
        * gas_factor
        * multi_source_factor
        * dc_gain
    )
    return _clamp(drive, 0.0, 4.5)


def estimate_te_eV(request: SimulationRequest) -> float:
    """Estimate an effective electron temperature in eV from process conditions."""
    rf_drive = _effective_rf_drive(request)
    pressure_torr = max(request.process.pressure_Pa / 133.322, 0.005)
    power_w = max(rf_drive.total_power_w, 0.0)
    frequency_hz = max(rf_drive.effective_frequency_hz, 1.0)

    gas_factor = _weighted_species_factor(request, _TE_FACTOR_BY_SPECIES, 1.0)
    power_factor = ((power_w + 40.0) / 540.0) ** 0.35
    pressure_factor = (0.12 / pressure_torr) ** 0.22
    freq_factor = (frequency_hz / RF_REF_FREQ_HZ) ** 0.08
    multi_source_factor = rf_drive.multi_source_factor ** 0.16

    te_eV = (
        TE_E_V_DEFAULT
        * power_factor
        * pressure_factor
        * gas_factor
        * freq_factor
        * multi_source_factor
    )
    return _clamp(te_eV, 1.0, 8.5)


def derive_transport_coefficients(request: SimulationRequest) -> TransportCoefficients:
    """Derive transport coefficients from process and gas conditions."""
    rf_drive = _effective_rf_drive(request)
    pressure_torr = max(request.process.pressure_Pa / 133.322, 0.005)
    power_w = max(rf_drive.total_power_w, 0.0)
    power_norm = ((power_w + 40.0) / 540.0) ** 0.5
    power_norm *= rf_drive.multi_source_factor ** 0.25
    frequency_hz = max(rf_drive.effective_frequency_hz, 1.0)

    gas_mu_factor = _weighted_species_factor(request, _MU_FACTOR_BY_SPECIES, 1.0)
    gas_ionization_factor = _weighted_species_factor(
        request, _IONIZATION_FACTOR_BY_SPECIES, 1.0
    )
    gas_attachment_factor = _weighted_species_factor(
        request, _ATTACHMENT_FACTOR_BY_SPECIES, 0.45
    )
    te_eV = estimate_te_eV(request)
    te_norm = te_eV / TE_E_V_DEFAULT

    mu_scale = (0.1 / pressure_torr) ** 0.65 * gas_mu_factor
    mu_e = _clamp(MU_E * mu_scale, 0.08, 4.0)

    # Keep D_E hookable through module-level D_E for tests and operator tuning.
    d_e = D_E * (mu_e / MU_E) * te_norm

    wall_scale = 1.0 + 0.45 * pressure_torr / (pressure_torr + 0.15)
    k_s_wall = _clamp(K_S_WALL * wall_scale, 0.015, 0.35)
    k_s_powered = _clamp(
        k_s_wall
        * (1.2 + 0.6 * power_norm)
        * (1.0 + 0.18 * (rf_drive.multi_source_factor - 1.0)),
        0.02,
        0.45,
    )
    lambda_relax = _clamp(
        LAMBDA_RELAX
        * (0.7 + 0.9 * power_norm)
        * (1.0 + 0.08 * (rf_drive.multi_source_factor - 1.0)),
        0.002,
        0.04,
    )
    freq_factor = (frequency_hz / RF_REF_FREQ_HZ) ** 0.2
    freq_factor *= rf_drive.multi_source_factor ** 0.12
    ionization_gain = _clamp(
        0.014
        * power_norm
        * te_norm
        * freq_factor
        * rf_drive.multi_source_factor
        * gas_ionization_factor
        * (0.12 / pressure_torr) ** 0.3,
        0.002,
        0.09,
    )
    attachment_loss = _clamp(
        0.008 * gas_attachment_factor * (pressure_torr / 0.1) ** 0.35,
        0.001,
        0.06,
    )
    geometric_loss = _clamp(0.006 + 0.012 * pressure_torr / (pressure_torr + 0.15), 0.004, 0.03)
    bulk_loss = _clamp(attachment_loss + geometric_loss, 0.005, 0.08)

    return TransportCoefficients(
        mu_e=mu_e,
        D_e=d_e,
        Te_norm=te_norm,
        Te_eV=te_eV,
        k_s_wall=k_s_wall,
        k_s_powered=k_s_powered,
        lambda_relax=lambda_relax,
        ionization_gain=ionization_gain,
        bulk_loss=bulk_loss,
    )


def impedance_delta_to_eta(delta_percent: float) -> float:
    """Convert impedance delta percent to a placeholder coupling efficiency."""
    return max(0.0, min(1.0, 1.0 - abs(delta_percent) / 100.0))


def _linspace(start: float, stop: float, count: int) -> List[float]:
    if count <= 1:
        return [start]
    step = (stop - start) / (count - 1)
    return [start + step * index for index in range(count)]


def _harmonic(a: float, b: float) -> float:
    if a <= 0 or b <= 0:
        return 0.0
    return 2.0 * a * b / (a + b)


def _bernoulli(x: float) -> float:
    """Stable Bernoulli function for Scharfetter-Gummel."""
    if abs(x) < 1e-6:
        return 1.0 - 0.5 * x + (x * x) / 12.0
    if x > 50.0:
        return 0.0
    if x < -50.0:
        return -x
    return x / (math.exp(x) - 1.0)


def _grid_summary(request: SimulationRequest) -> Optional[GeometryGridSummary]:
    grid = request.geometry.grid
    if grid is None:
        return None

    region_type_counts: Dict[str, int] = {}
    for region_type in grid.region_legend.values():
        region_type_counts.setdefault(region_type, 0)

    for row in grid.region_id:
        for region_value in row:
            region_type = grid.region_legend.get(region_value)
            if region_type is None:
                continue
            region_type_counts[region_type] = region_type_counts.get(region_type, 0) + 1

    tag_counts = None
    if grid.tag_mask is not None:
        tag_counts = {}
        for tag, mask in grid.tag_mask.items():
            tag_counts[tag] = sum(1 for row in mask for cell in row if cell)

    return GeometryGridSummary(region_type_counts=region_type_counts, tag_counts=tag_counts)


def build_epsilon_map(request: SimulationRequest) -> List[List[float]]:
    """Build a relative permittivity map from region ids and material config."""
    grid = request.geometry.grid
    if grid is None:
        raise ValueError("geometry.grid is required for poisson_v1")

    eps = [[1.0 for _ in range(grid.nr)] for _ in range(grid.nz)]
    for k in range(grid.nz):
        for j in range(grid.nr):
            region_type = grid.region_legend[grid.region_id[k][j]]
            if region_type == "dielectric":
                eps[k][j] = request.material.default.epsilon_r
            else:
                eps[k][j] = 1.0

    if grid.tag_mask is not None:
        for override in request.material.regions:
            if override.epsilon_r is None:
                continue
            mask = grid.tag_mask.get(override.target_tag)
            if mask is None:
                continue
            for k in range(grid.nz):
                for j in range(grid.nr):
                    if mask[k][j]:
                        eps[k][j] = override.epsilon_r

    return eps


def build_wall_loss_map(request: SimulationRequest) -> List[List[float]]:
    """Build a wall-loss map with default + tag overrides."""
    grid = request.geometry.grid
    if grid is None:
        raise ValueError("geometry.grid is required for poisson_v1")

    default_loss = _clamp(float(request.material.default.wall_loss_e), 0.0, 1.0)
    wall_loss = [[default_loss for _ in range(grid.nr)] for _ in range(grid.nz)]

    if grid.tag_mask is not None:
        for override in request.material.regions:
            if override.wall_loss_e is None:
                continue
            mask = grid.tag_mask.get(override.target_tag)
            if mask is None:
                continue
            loss_value = _clamp(float(override.wall_loss_e), 0.0, 1.0)
            for k in range(grid.nz):
                for j in range(grid.nr):
                    if mask[k][j]:
                        wall_loss[k][j] = loss_value

    return wall_loss


def _is_excluded_vld_tag(tag: str) -> bool:
    normalized = tag.strip().lower()
    if not normalized:
        return True
    if "chamber" in normalized:
        return True
    if "pump" in normalized or "outlet" in normalized or "exhaust" in normalized:
        return True
    return normalized in {
        "plasma",
        "solid_wall",
        "powered_electrode",
        "ground_electrode",
        "dielectric",
    }


def build_vld_geometry_mask(request: SimulationRequest) -> Optional[List[List[bool]]]:
    """Build a mask that keeps VLD/PAD only on explicit geometry tags (excluding chamber/common tags)."""
    grid = request.geometry.grid
    if grid is None or grid.tag_mask is None:
        return None

    selected_masks = [
        mask
        for tag, mask in grid.tag_mask.items()
        if not _is_excluded_vld_tag(tag)
    ]
    if not selected_masks:
        return None

    geometry_mask: List[List[bool]] = [[False for _ in range(grid.nr)] for _ in range(grid.nz)]
    for mask in selected_masks:
        z_limit = min(grid.nz, len(mask))
        for k in range(z_limit):
            row = mask[k]
            x_limit = min(grid.nr, len(row))
            for j in range(x_limit):
                if row[j]:
                    geometry_mask[k][j] = True
    return geometry_mask


def _neighbor_max_mean(
    field: Optional[List[List[float]]],
    k: int,
    j: int,
    radius: int,
) -> Tuple[float, float]:
    if field is None or radius < 0:
        return 0.0, 0.0
    nz = len(field)
    if nz == 0:
        return 0.0, 0.0

    total = 0.0
    count = 0
    vmax = 0.0
    k_lo = max(0, k - radius)
    k_hi = min(nz - 1, k + radius)
    for kk in range(k_lo, k_hi + 1):
        row = field[kk]
        if not row:
            continue
        j_lo = max(0, j - radius)
        j_hi = min(len(row) - 1, j + radius)
        for jj in range(j_lo, j_hi + 1):
            value = row[jj]
            if not math.isfinite(value) or value <= 0.0:
                continue
            total += value
            count += 1
            vmax = max(vmax, value)

    if count <= 0:
        return 0.0, 0.0
    return vmax, total / count


def _build_tag_weight_map(
    tag_mask: Optional[Dict[str, List[List[bool]]]],
    tag_weights: Dict[str, float],
    nz: int,
    nr: int,
) -> List[List[float]]:
    weighted_map: List[List[float]] = [[0.0 for _ in range(nr)] for _ in range(nz)]
    if tag_mask is None:
        return weighted_map

    for tag, weight in tag_weights.items():
        if weight <= 0.0:
            continue
        mask = tag_mask.get(tag)
        if mask is None:
            continue
        z_limit = min(nz, len(mask))
        for k in range(z_limit):
            row = mask[k]
            x_limit = min(nr, len(row))
            for j in range(x_limit):
                if row[j]:
                    weighted_map[k][j] += weight
    return weighted_map


def _build_tag_boolean_mask(
    tag_mask: Optional[Dict[str, List[List[bool]]]],
    tags: Iterable[str],
    nz: int,
    nr: int,
) -> List[List[bool]]:
    mask_out: List[List[bool]] = [[False for _ in range(nr)] for _ in range(nz)]
    if tag_mask is None:
        return mask_out

    for tag in tags:
        key = tag.strip()
        if not key:
            continue
        mask = tag_mask.get(key)
        if mask is None:
            continue
        z_limit = min(nz, len(mask))
        for k in range(z_limit):
            row = mask[k]
            x_limit = min(nr, len(row))
            for j in range(x_limit):
                if row[j]:
                    mask_out[k][j] = True
    return mask_out


def compute_volume_loss_density(
    ne_norm: Optional[List[List[float]]],
    e_mag: Optional[List[List[float]]],
    wall_loss_map: List[List[float]],
    epsilon_map: List[List[float]],
    request: SimulationRequest,
    geometry_mask: Optional[List[List[bool]]] = None,
) -> Optional[List[List[float]]]:
    """Compute geometry-local per-volume power absorption density proxy.

    Note:
        The response key remains `volume_loss_density` for backward compatibility.
        Semantically this field represents a relative absorbed power density map
        (per unit volume), not a material "volume loss" term.
    """
    if e_mag is None or not e_mag or not e_mag[0]:
        return None

    rf_drive = _effective_rf_drive(request)
    power_gain = _clamp(((rf_drive.total_power_w + 30.0) / 530.0) ** 0.55, 0.45, 3.8)
    freq_gain = _clamp((rf_drive.effective_frequency_hz / RF_REF_FREQ_HZ) ** 0.15, 0.75, 1.9)
    dc_bias_gain = _clamp((1.0 + abs(_dc_bias_voltage(request)) / 1700.0) ** 0.18, 1.0, 1.6)
    multi_source_gain = _clamp(rf_drive.multi_source_factor ** 0.2, 0.85, 1.3)

    nz = len(e_mag)
    nr = len(e_mag[0])
    result: List[List[float]] = [[0.0 for _ in range(nr)] for _ in range(nz)]
    e_ref = 0.0

    tag_mask = request.geometry.grid.tag_mask if request.geometry.grid is not None else None

    rf_tag_weights: Dict[str, float] = {}
    for source in rf_drive.sources:
        if source.surface_tag is None:
            continue
        tag = source.surface_tag.strip()
        if not tag:
            continue
        weight = max(source.power_w, 1.0)
        rf_tag_weights[tag] = rf_tag_weights.get(tag, 0.0) + weight
    if not rf_tag_weights and tag_mask is not None:
        for tag in tag_mask.keys():
            normalized = tag.strip().lower()
            if "powered" in normalized or "rf" in normalized or "source" in normalized:
                rf_tag_weights[tag] = 1.0

    rf_seed_map = _build_tag_weight_map(tag_mask, rf_tag_weights, nz, nr)
    rf_influence = _spread_outlet_influence(rf_seed_map, steps=8, decay=0.84)
    rf_ref = max((max(row) for row in rf_influence), default=0.0)
    rf_contact_threshold = 1e-9

    outlet_tag_weights: Dict[str, float] = {}
    outlet_tags: set[str] = set()
    for outlet in _collect_outlet_sinks(request):
        tag = str(getattr(outlet, "surface_tag", "")).strip()
        if not tag:
            continue
        outlet_tags.add(tag)
        weight = _effective_outlet_strength(outlet)
        if weight <= 0.0:
            continue
        outlet_tag_weights[tag] = outlet_tag_weights.get(tag, 0.0) + weight

    outlet_exclusion = _build_tag_boolean_mask(tag_mask, outlet_tags, nz, nr)
    outlet_seed_map = _build_tag_weight_map(tag_mask, outlet_tag_weights, nz, nr)
    outlet_influence = _spread_outlet_influence(outlet_seed_map, steps=7, decay=0.82)
    outlet_ref = max((max(row) for row in outlet_influence), default=0.0)

    for k in range(nz):
        for j in range(nr):
            if outlet_exclusion[k][j]:
                continue
            if geometry_mask is not None:
                if k >= len(geometry_mask) or j >= len(geometry_mask[k]) or not geometry_mask[k][j]:
                    continue
            if rf_ref > 1e-12 and rf_influence[k][j] <= rf_contact_threshold * rf_ref:
                continue
            e_here = e_mag[k][j] if k < len(e_mag) and j < len(e_mag[k]) else 0.0
            if not math.isfinite(e_here):
                e_here = 0.0
            e_neighbor_max, e_neighbor_mean = _neighbor_max_mean(e_mag, k, j, radius=2)
            e_interface = max(
                e_here,
                0.90 * e_neighbor_max,
                0.65 * e_neighbor_mean,
            )
            if e_interface <= 0.0:
                continue
            e_ref = max(e_ref, e_interface)

    e_ref = max(e_ref, 1e-9)

    for k in range(nz):
        for j in range(nr):
            if outlet_exclusion[k][j]:
                result[k][j] = 0.0
                continue
            if geometry_mask is not None:
                if k >= len(geometry_mask) or j >= len(geometry_mask[k]) or not geometry_mask[k][j]:
                    result[k][j] = 0.0
                    continue
            if rf_ref > 1e-12 and rf_influence[k][j] <= rf_contact_threshold * rf_ref:
                result[k][j] = 0.0
                continue
            if k >= len(e_mag) or j >= len(e_mag[k]):
                result[k][j] = 0.0
                continue
            e_here = e_mag[k][j]
            if not math.isfinite(e_here):
                e_here = 0.0
            e_neighbor_max, e_neighbor_mean = _neighbor_max_mean(e_mag, k, j, radius=2)
            e_interface = max(
                e_here,
                0.90 * e_neighbor_max,
                0.65 * e_neighbor_mean,
            )
            if e_interface <= 0.0:
                result[k][j] = 0.0
                continue

            ne_here = 0.0
            if ne_norm is not None and k < len(ne_norm) and j < len(ne_norm[k]):
                ne_raw = ne_norm[k][j]
                if math.isfinite(ne_raw):
                    ne_here = max(0.0, ne_raw)
            ne_neighbor_max, ne_neighbor_mean = _neighbor_max_mean(ne_norm, k, j, radius=1)
            ne_interface = max(
                ne_here,
                0.72 * ne_neighbor_max,
                0.45 * ne_neighbor_mean,
            )
            plasma_coupling = _clamp(0.22 + 0.78 * math.sqrt(ne_interface), 0.22, 1.0)

            wall_loss = _clamp(float(wall_loss_map[k][j]), 0.0, 1.0)
            eps_r = 1.0
            if k < len(epsilon_map) and j < len(epsilon_map[k]):
                eps_raw = epsilon_map[k][j]
                if math.isfinite(eps_raw):
                    eps_r = max(1.0, eps_raw)
            loss_tangent_proxy = _clamp(0.08 + 0.92 * wall_loss, 0.08, 1.0)
            eps_coupling = _clamp(eps_r ** 0.22, 1.0, 2.1)
            material_coupling = loss_tangent_proxy * eps_coupling

            source_factor = 1.0
            if rf_ref > 1e-12:
                source_factor = _clamp(
                    0.72 + 0.88 * (rf_influence[k][j] / rf_ref),
                    0.72,
                    1.6,
                )

            sink_factor = 1.0
            if outlet_ref > 1e-12:
                sink_factor = _clamp(
                    1.0 - 0.32 * (outlet_influence[k][j] / outlet_ref),
                    0.58,
                    1.0,
                )

            e_rel = _clamp(e_interface / e_ref, 0.0, 1.0)
            scaled = (
                (e_rel ** 2)
                * (0.55 + 0.45 * plasma_coupling)
                * material_coupling
                * power_gain
                * freq_gain
                * dc_bias_gain
                * multi_source_gain
                * source_factor
                * sink_factor
            )
            result[k][j] = _clamp(scaled, 0.0, 3.6)

    return result


def _cell_matches_source_tag(
    tag_mask: Optional[Dict[str, List[List[bool]]]],
    k: int,
    j: int,
    source_tag: Optional[str],
) -> bool:
    if source_tag is None:
        return True
    if tag_mask is None:
        return False
    mask = tag_mask.get(source_tag)
    if mask is None:
        return False
    return bool(mask[k][j])


def build_dirichlet_mask_values(
    request: SimulationRequest, powered_voltage: float = 1.0, dc_offset: float = 0.0
) -> Tuple[List[List[bool]], List[List[float]]]:
    """Build Dirichlet masks and values for electrodes and grounded walls."""
    grid = request.geometry.grid
    if grid is None:
        raise ValueError("geometry.grid is required for poisson_v1")

    mask = [[False for _ in range(grid.nr)] for _ in range(grid.nz)]
    values = [[0.0 for _ in range(grid.nr)] for _ in range(grid.nz)]
    rf_components = _build_boundary_drive_components(request)
    powered_cells: List[Tuple[int, int]] = []
    powered_cell_local_offsets: Dict[Tuple[int, int], float] = {}
    any_tagged_source = any(component.surface_tag is not None for component in rf_components)
    untagged_components = [component for component in rf_components if component.surface_tag is None]
    dc_bias_region_offsets = _build_dc_bias_region_offset_map(request)

    def local_region_offset(k: int, j: int) -> float:
        if not dc_bias_region_offsets:
            return 0.0
        if grid.tag_mask is None:
            return 0.0
        offset = 0.0
        for tag, tag_offset in dc_bias_region_offsets.items():
            mask_for_tag = grid.tag_mask.get(tag)
            if mask_for_tag is None:
                continue
            if k >= len(mask_for_tag) or j >= len(mask_for_tag[k]):
                continue
            if mask_for_tag[k][j]:
                offset += tag_offset
        return offset

    for k in range(grid.nz):
        for j in range(grid.nr):
            region_type = grid.region_legend[grid.region_id[k][j]]
            if region_type == "powered_electrode":
                mask[k][j] = True
                powered_cells.append((k, j))

                matched: List[BoundaryDriveComponent] = [
                    component
                    for component in rf_components
                    if _cell_matches_source_tag(grid.tag_mask, k, j, component.surface_tag)
                ]
                if not matched:
                    if any_tagged_source and untagged_components:
                        matched = untagged_components
                    elif rf_components:
                        matched = rf_components

                if not matched:
                    values[k][j] = powered_voltage
                else:
                    real = sum(component.real for component in matched)
                    imag = sum(component.imag for component in matched)
                    values[k][j] = math.hypot(real, imag)
                powered_cell_local_offsets[(k, j)] = local_region_offset(k, j)
            elif region_type in {"ground_electrode", "solid_wall"}:
                mask[k][j] = True
                values[k][j] = local_region_offset(k, j)

    if powered_cells:
        max_drive = max(values[k][j] for k, j in powered_cells)
        if max_drive > 0.0:
            scale = powered_voltage / max_drive
            for k, j in powered_cells:
                values[k][j] = (
                    values[k][j] * scale
                    + dc_offset
                    + powered_cell_local_offsets.get((k, j), 0.0)
                )
        else:
            for k, j in powered_cells:
                values[k][j] = dc_offset + powered_cell_local_offsets.get((k, j), 0.0)

    return mask, values


def _add_entry(rows: List[Dict[int, float]], row: int, col: int, value: float) -> None:
    rows[row][col] = rows[row].get(col, 0.0) + value


def assemble_poisson_matrix(
    eps: List[List[float]],
    dr: float,
    dz: float,
    nz: int,
    nr: int,
    dirichlet_mask: List[List[bool]],
    dirichlet_values: List[List[float]],
):
    """Assemble the sparse Poisson matrix and RHS using a 5-point stencil."""
    total = nz * nr
    rows: List[Dict[int, float]] = [dict() for _ in range(total)]
    b = [0.0 for _ in range(total)]

    # 2D -> 1D indexing: idx(k, j) = k * nr + j
    def idx(k: int, j: int) -> int:
        return k * nr + j

    def add_neighbor(i: int, k: int, j: int, coef: float) -> None:
        if dirichlet_mask[k][j]:
            b[i] += coef * dirichlet_values[k][j]
        else:
            _add_entry(rows, i, idx(k, j), -coef)
        _add_entry(rows, i, i, coef)

    for k in range(nz):
        for j in range(nr):
            i = idx(k, j)
            if dirichlet_mask[k][j]:
                _add_entry(rows, i, i, 1.0)
                b[i] = dirichlet_values[k][j]
                continue

            if j == 0:
                eps_e = _harmonic(eps[k][j], eps[k][j + 1])
                add_neighbor(i, k, j + 1, 2.0 * eps_e / (dr * dr))
            elif j == nr - 1:
                eps_w = _harmonic(eps[k][j], eps[k][j - 1])
                add_neighbor(i, k, j - 1, 2.0 * eps_w / (dr * dr))
            else:
                eps_e = _harmonic(eps[k][j], eps[k][j + 1])
                eps_w = _harmonic(eps[k][j], eps[k][j - 1])
                add_neighbor(i, k, j + 1, eps_e / (dr * dr))
                add_neighbor(i, k, j - 1, eps_w / (dr * dr))

            if k == 0:
                eps_n = _harmonic(eps[k][j], eps[k + 1][j])
                add_neighbor(i, k + 1, j, 2.0 * eps_n / (dz * dz))
            elif k == nz - 1:
                eps_s = _harmonic(eps[k][j], eps[k - 1][j])
                add_neighbor(i, k - 1, j, 2.0 * eps_s / (dz * dz))
            else:
                eps_n = _harmonic(eps[k][j], eps[k + 1][j])
                eps_s = _harmonic(eps[k][j], eps[k - 1][j])
                add_neighbor(i, k + 1, j, eps_n / (dz * dz))
                add_neighbor(i, k - 1, j, eps_s / (dz * dz))

    if sp is None:
        return rows, b

    data: List[float] = []
    row_idx: List[int] = []
    col_idx: List[int] = []
    for i, row in enumerate(rows):
        for j, value in row.items():
            row_idx.append(i)
            col_idx.append(j)
            data.append(value)

    matrix = sp.csr_matrix((data, (row_idx, col_idx)), shape=(total, total))
    return matrix, b


def _matvec_rows(rows: List[Dict[int, float]], vector: Iterable[float]) -> List[float]:
    vec = list(vector)
    result = [0.0 for _ in range(len(rows))]
    for i, row in enumerate(rows):
        acc = 0.0
        for j, value in row.items():
            acc += value * vec[j]
        result[i] = acc
    return result


def cg_solve(matvec, b: List[float], tol: float = 1e-10, maxiter: int = 5000) -> List[float]:
    """Minimal Conjugate Gradient solver for SPD systems."""
    x = [0.0 for _ in b]
    r = [bi for bi in b]
    p = [ri for ri in r]
    rsold = sum(ri * ri for ri in r)

    for _ in range(maxiter):
        Ap = matvec(p)
        denom = sum(pi * api for pi, api in zip(p, Ap))
        if denom == 0.0:
            break
        alpha = rsold / denom
        x = [xi + alpha * pi for xi, pi in zip(x, p)]
        r = [ri - alpha * api for ri, api in zip(r, Ap)]
        rsnew = sum(ri * ri for ri in r)
        if math.sqrt(rsnew) < tol:
            break
        beta = rsnew / rsold
        p = [ri + beta * pi for ri, pi in zip(r, p)]
        rsold = rsnew

    return x


def solve_phi(A, b: List[float], nz: int, nr: int) -> List[List[float]]:
    """Solve for phi and reshape to [nz][nr]."""
    if sp is not None and hasattr(A, "shape"):
        phi = spla.spsolve(A, b)
        phi_list = phi.tolist()
    else:
        rows = A
        phi_list = cg_solve(lambda v: _matvec_rows(rows, v), b)

    phi_2d = [phi_list[k * nr : (k + 1) * nr] for k in range(nz)]
    return phi_2d


def compute_E_components(phi: List[List[float]], dr: float, dz: float) -> Tuple[List[List[float]], List[List[float]]]:
    """Compute Er and Ez from the potential."""
    if np is not None:
        phi_arr = np.asarray(phi, dtype=float)
        if phi_arr.ndim == 2 and phi_arr.shape[0] > 1 and phi_arr.shape[1] > 1:
            dphi_dz, dphi_dr = np.gradient(phi_arr, dz, dr, edge_order=1)
            er_arr = -dphi_dr
            ez_arr = -dphi_dz
            er_arr[:, 0] = 0.0  # r=0 axis symmetry
            return er_arr.tolist(), ez_arr.tolist()

    nz = len(phi)
    nr = len(phi[0]) if nz > 0 else 0
    er = [[0.0 for _ in range(nr)] for _ in range(nz)]
    ez = [[0.0 for _ in range(nr)] for _ in range(nz)]

    for k in range(nz):
        for j in range(nr):
            if j == 0:
                er[k][j] = 0.0
            elif j == nr - 1:
                er[k][j] = -(phi[k][j] - phi[k][j - 1]) / dr
            else:
                er[k][j] = -(phi[k][j + 1] - phi[k][j - 1]) / (2.0 * dr)

            if k == 0:
                ez[k][j] = -(phi[k + 1][j] - phi[k][j]) / dz
            elif k == nz - 1:
                ez[k][j] = -(phi[k][j] - phi[k - 1][j]) / dz
            else:
                ez[k][j] = -(phi[k + 1][j] - phi[k - 1][j]) / (2.0 * dz)

    return er, ez


def compute_Emag(phi: List[List[float]], dr: float, dz: float) -> List[List[float]]:
    """Compute the electric field magnitude from the potential."""
    er, ez = compute_E_components(phi, dr, dz)
    if np is not None:
        er_arr = np.asarray(er, dtype=float)
        ez_arr = np.asarray(ez, dtype=float)
        if er_arr.shape == ez_arr.shape:
            return np.hypot(er_arr, ez_arr).tolist()

    nz = len(phi)
    nr = len(phi[0]) if nz > 0 else 0
    e_mag = [[0.0 for _ in range(nr)] for _ in range(nz)]

    for k in range(nz):
        for j in range(nr):
            e_mag[k][j] = math.sqrt(er[k][j] * er[k][j] + ez[k][j] * ez[k][j])

    return e_mag


def build_ne_proxy_from_phi(phi: List[List[float]], alpha: float = 1.0) -> List[List[float]]:
    """Build a deterministic proxy n_ref from phi (normalized)."""
    flat_phi = [value for row in phi for value in row]
    phi_ref = min(flat_phi) if flat_phi else 0.0
    ne_raw = [math.exp(alpha * (value - phi_ref)) for value in flat_phi]
    min_ne = min(ne_raw) if ne_raw else 0.0
    max_ne = max(ne_raw) if ne_raw else 0.0
    if max_ne <= min_ne:
        return [[0.0 for _ in row] for row in phi]

    scale = max_ne - min_ne
    ne_norm_flat = [(value - min_ne) / scale for value in ne_raw]
    nr = len(phi[0]) if phi else 0
    ne_norm = [ne_norm_flat[k * nr : (k + 1) * nr] for k in range(len(phi))]
    return ne_norm


def normalize_ne(ne: List[List[float]]) -> List[List[float]]:
    """Normalize n_e to [0,1] with safe flat handling."""
    flat = [value for row in ne for value in row]
    if not flat:
        return ne
    min_ne = min(flat)
    max_ne = max(flat)
    if max_ne <= min_ne:
        return [[0.0 for _ in row] for row in ne]
    scale = max_ne - min_ne
    return [[(value - min_ne) / scale for value in row] for row in ne]


def _solve_linear_gs(
    rows: List[Dict[int, float]],
    b: List[float],
    x0: List[float],
    tol: float,
    maxiter: int,
) -> Tuple[List[float], bool, int, float, List[str]]:
    x = list(x0)
    warnings: List[str] = []
    converged = False
    residual = 0.0

    for iteration in range(1, maxiter + 1):
        max_delta = 0.0
        for i, row in enumerate(rows):
            diag = row.get(i)
            if diag is None or diag == 0.0:
                warnings.append("zero diagonal in GS solver")
                return x, False, iteration, 1e9, warnings
            sigma = 0.0
            for j, value in row.items():
                if j == i:
                    continue
                sigma += value * x[j]
            new_value = (b[i] - sigma) / diag
            if new_value < N_FLOOR:
                new_value = N_FLOOR
            delta = abs(new_value - x[i])
            if delta > max_delta:
                max_delta = delta
            x[i] = new_value
        if max_delta < tol:
            converged = True
            residual = max_delta
            return x, converged, iteration, residual, warnings

    residual = max_delta
    return x, converged, maxiter, residual, warnings


def _compute_residual(rows: List[Dict[int, float]], x: List[float], b: List[float]) -> float:
    residual = 0.0
    for i, row in enumerate(rows):
        acc = 0.0
        for j, value in row.items():
            acc += value * x[j]
        residual = max(residual, abs(acc - b[i]))
    return residual


def solve_ne_drift_diffusion_sg(
    phi: List[List[float]],
    request: SimulationRequest,
    coefficients: Optional[TransportCoefficients] = None,
) -> Tuple[List[List[float]], NeSolverMetadata]:
    """Solve steady drift-diffusion for electrons using SG discretization."""
    grid = request.geometry.grid
    if grid is None:
        raise ValueError("geometry.grid is required for poisson_v1")

    coeff = coefficients or derive_transport_coefficients(request)
    mu_e = coeff.mu_e
    d_e = coeff.D_e
    te_norm = coeff.Te_norm
    k_s_wall = coeff.k_s_wall
    k_s_powered = coeff.k_s_powered
    lambda_relax = coeff.lambda_relax
    ionization_gain = coeff.ionization_gain
    bulk_loss = coeff.bulk_loss

    warnings: List[str] = []
    if d_e <= 0.0:
        warnings.append("D_e must be positive; using proxy ne")
        n_ref = build_ne_proxy_from_phi(phi)
        meta = NeSolverMetadata(
            method="drift_diffusion_sg_v1",
            mu_e=mu_e,
            D_e=d_e,
            Te_norm=te_norm,
            k_s_wall=k_s_wall,
            k_s_powered=k_s_powered,
            lambda_relax=lambda_relax,
            ionization_gain=ionization_gain,
            bulk_loss=bulk_loss,
            converged=False,
            iterations=0,
            residual=0.0,
            fallback_used=True,
            warnings=warnings,
        )
        return n_ref, meta

    domain = request.geometry.domain
    nr = domain.nr
    nz = domain.nz
    dr = domain.r_max_mm / (nr - 1)
    dz = domain.z_max_mm / (nz - 1)
    pressure_torr = max(request.process.pressure_Pa / 133.322, 0.005)
    inlet_flow_sccm = _inlet_total_flow_sccm(request)
    inlet_direction = _inlet_direction(request)
    inlet_direction_ion_gain = _INLET_DIRECTION_ION_GAIN.get(inlet_direction, 1.0)
    inlet_direction_loss_gain = _INLET_DIRECTION_LOSS_GAIN.get(inlet_direction, 1.0)
    inlet_radial_profile = _build_inlet_radial_profile(inlet_direction, nr)
    inlet_axial_profile = _build_inlet_axial_profile(inlet_direction, nz)
    inlet_source_map, inlet_coverage = _build_inlet_source_map(
        request,
        nz,
        nr,
        grid.tag_mask,
        warnings,
    )
    inlet_spread_steps = max(6, min(28, int(0.08 * (nr + nz))))
    inlet_influence_map = _spread_outlet_influence(
        inlet_source_map,
        steps=inlet_spread_steps,
        decay=0.9,
    )
    rf_drive = _effective_rf_drive(request)
    frequency_hz = max(rf_drive.effective_frequency_hz, 1.0)
    dc_bias_v = _dc_bias_voltage(request)
    dc_abs_norm = _clamp(abs(dc_bias_v) / 650.0, 0.0, 6.0)
    dc_sheath_gain = _clamp(1.0 + 0.12 * dc_abs_norm, 1.0, 1.85)
    dc_loss_gain = _clamp(1.0 + 0.07 * dc_abs_norm, 1.0, 1.45)
    dc_polarity_ion_gain = _clamp(1.0 + (-dc_bias_v / 2400.0), 0.8, 1.35)
    frequency_radial_profile = _build_frequency_radial_profile(nr, frequency_hz)
    frequency_axial_profile = _build_frequency_axial_profile(nz, frequency_hz)
    gas_ionization_factor = _weighted_species_factor(
        request, _IONIZATION_FACTOR_BY_SPECIES, 1.0
    )
    gas_attachment_factor = _weighted_species_factor(
        request, _ATTACHMENT_FACTOR_BY_SPECIES, 0.45
    )
    gas_reactivity_gain = _clamp(
        (gas_ionization_factor / max(gas_attachment_factor, 0.2)) ** 0.32,
        0.62,
        2.2,
    )
    wall_loss_mean = _mean_wall_loss(request)
    powered_voltage = derive_powered_boundary_voltage(request)
    outlet_strength_map, total_pump_strength = _build_outlet_strength_map(
        request,
        nz,
        nr,
        grid.tag_mask,
        warnings,
    )
    spread_steps = max(6, min(24, int(0.06 * (nr + nz))))
    outlet_influence_map = _spread_outlet_influence(
        outlet_strength_map,
        steps=spread_steps,
        decay=0.88,
    )
    pump_bulk_loss = _clamp(0.018 * total_pump_strength, 0.0, 0.16)
    flow_residence_loss = _clamp(
        0.0012 * inlet_flow_sccm / max(pressure_torr, 0.2),
        0.0,
        0.12,
    )
    wall_quench_loss = _clamp(0.05 * wall_loss_mean, 0.0, 0.08)
    attachment_bulk_gain = _clamp(0.72 + 0.42 * gas_attachment_factor, 0.65, 1.75)
    effective_bulk_loss = _clamp(
        (bulk_loss + pump_bulk_loss + flow_residence_loss + wall_quench_loss)
        * attachment_bulk_gain
        * dc_loss_gain
        * inlet_direction_loss_gain,
        0.003,
        0.34,
    )
    pump_face_sink_gain = _clamp(0.06 * total_pump_strength, 0.0, 1.1)
    pump_local_sink_gain = _clamp(0.035 * total_pump_strength, 0.0, 0.65)
    convective_sink_gain = _clamp(
        0.018 + 0.008 * inlet_flow_sccm / max(pressure_torr, 0.2),
        0.01,
        0.22,
    )
    power_coupling_gain = _clamp(
        (max(powered_voltage, 0.0) + 0.08) ** 0.9 * dc_sheath_gain * dc_polarity_ion_gain,
        0.3,
        4.6,
    )
    power_trend_gain = _clamp(
        ((max(rf_drive.total_power_w, 0.0) + 40.0) / 540.0) ** 0.62,
        0.35,
        6.5,
    )
    frequency_trend_gain = _clamp((frequency_hz / RF_REF_FREQ_HZ) ** 0.25, 0.55, 2.1)
    inlet_flow_gain = _clamp(
        0.35 + 0.0038 * inlet_flow_sccm / max(pressure_torr, 0.2),
        0.25,
        2.6,
    )
    inlet_coverage_gain = _clamp(0.8 + 3.5 * inlet_coverage, 0.8, 1.9)
    frequency_sheath_gain = _clamp(
        (frequency_hz / RF_REF_FREQ_HZ) ** 0.18 * (1.0 + 0.08 * dc_abs_norm),
        0.76,
        2.25,
    )
    flow_residence_factor = _clamp(
        1.0 / (1.0 + 0.0045 * inlet_flow_sccm / max(pressure_torr, 0.2)),
        0.35,
        1.0,
    )
    pump_exhaust_factor = _clamp(1.0 / (1.0 + 0.22 * total_pump_strength), 0.45, 1.0)
    radial_center = 0.5 * (nr - 1)
    radial_span = max(radial_center, 1.0)

    n_ref = build_ne_proxy_from_phi(phi)
    rows: List[Dict[int, float]] = [dict() for _ in range(nr * nz)]
    b = [0.0 for _ in range(nr * nz)]

    def idx(k: int, j: int) -> int:
        return k * nr + j

    def region_type(k: int, j: int) -> str:
        return grid.region_legend[grid.region_id[k][j]]

    def outlet_strength(k: int, j: int) -> float:
        if k < 0 or k >= nz or j < 0 or j >= nr:
            return 0.0
        return outlet_strength_map[k][j]

    def outlet_influence(k: int, j: int) -> float:
        if k < 0 or k >= nz or j < 0 or j >= nr:
            return 0.0
        return outlet_influence_map[k][j]

    def inlet_influence(k: int, j: int) -> float:
        if k < 0 or k >= nz or j < 0 or j >= nr:
            return 0.0
        return inlet_influence_map[k][j]

    coef_r = d_e / (dr * dr)
    coef_z = d_e / (dz * dz)
    e_mag_proxy = compute_Emag(phi, dr, dz)
    e_ref = _clamp(0.07 + 0.26 * (pressure_torr / (pressure_torr + 0.6)), 0.05, 0.38)

    # SG flux coefficients for div(Gamma) with fixed E from phi.

    for k in range(nz):
        for j in range(nr):
            i = idx(k, j)
            if region_type(k, j) != "plasma":
                _add_entry(rows, i, i, 1.0)
                b[i] = N_FLOOR
                continue

            local_outlet_strength = outlet_influence(k, j)
            inlet_local = inlet_influence(k, j)
            local_convective_sink = convective_sink_gain * (
                0.55 * local_outlet_strength
                + 0.25 * inlet_local
                + 0.20 * (1.0 - inlet_axial_profile[k])
            )
            a_p = (
                lambda_relax
                + effective_bulk_loss
                + pump_local_sink_gain * local_outlet_strength
                + local_convective_sink
            )

            # East face
            if j < nr - 1:
                east_region = region_type(k, j + 1)
                if east_region == "plasma":
                    pe = mu_e * (phi[k][j + 1] - phi[k][j]) / d_e
                    bpe = _bernoulli(pe)
                    bme = _bernoulli(-pe)
                    a_p += coef_r * bpe
                    _add_entry(rows, i, idx(k, j + 1), -coef_r * bme)
                else:
                    sink = k_s_powered if east_region == "powered_electrode" else k_s_wall
                    sink += pump_face_sink_gain * outlet_strength(k, j + 1)
                    a_p += sink / dr
            else:
                sink = k_s_wall + pump_face_sink_gain * outlet_strength(k, j)
                a_p += sink / dr

            # West face (r=0 symmetry)
            if j > 0:
                west_region = region_type(k, j - 1)
                if west_region == "plasma":
                    pe = mu_e * (phi[k][j] - phi[k][j - 1]) / d_e
                    bpw = _bernoulli(pe)
                    bmw = _bernoulli(-pe)
                    a_p += coef_r * bmw
                    _add_entry(rows, i, idx(k, j - 1), -coef_r * bpw)
                else:
                    sink = k_s_powered if west_region == "powered_electrode" else k_s_wall
                    sink += pump_face_sink_gain * outlet_strength(k, j - 1)
                    a_p += sink / dr

            # North face
            if k < nz - 1:
                north_region = region_type(k + 1, j)
                if north_region == "plasma":
                    pe = mu_e * (phi[k + 1][j] - phi[k][j]) / d_e
                    bpn = _bernoulli(pe)
                    bmn = _bernoulli(-pe)
                    a_p += coef_z * bpn
                    _add_entry(rows, i, idx(k + 1, j), -coef_z * bmn)
                else:
                    sink = k_s_powered if north_region == "powered_electrode" else k_s_wall
                    sink += pump_face_sink_gain * outlet_strength(k + 1, j)
                    a_p += sink / dz
            else:
                sink = k_s_wall + pump_face_sink_gain * outlet_strength(k, j)
                a_p += sink / dz

            # South face
            if k > 0:
                south_region = region_type(k - 1, j)
                if south_region == "plasma":
                    pe = mu_e * (phi[k][j] - phi[k - 1][j]) / d_e
                    bps = _bernoulli(pe)
                    bms = _bernoulli(-pe)
                    a_p += coef_z * bms
                    _add_entry(rows, i, idx(k - 1, j), -coef_z * bps)
                else:
                    sink = k_s_powered if south_region == "powered_electrode" else k_s_wall
                    sink += pump_face_sink_gain * outlet_strength(k - 1, j)
                    a_p += sink / dz
            else:
                sink = k_s_wall + pump_face_sink_gain * outlet_strength(k, j)
                a_p += sink / dz

            _add_entry(rows, i, i, a_p)
            e_local = e_mag_proxy[k][j]
            if not math.isfinite(e_local) or e_local < 0.0:
                e_local = 0.0
            inlet_gain = (
                inlet_direction_ion_gain
                * inlet_radial_profile[j]
                * inlet_axial_profile[k]
                * (1.0 + inlet_flow_gain * inlet_coverage_gain * inlet_local)
            )
            frequency_gain = (
                frequency_trend_gain
                * frequency_radial_profile[j]
                * frequency_axial_profile[k]
            )
            edge_ratio = abs(j - radial_center) / radial_span
            sheath_coupling_gain = _clamp(
                1.0
                + 0.32
                * (frequency_sheath_gain - 1.0)
                * (0.45 + 0.55 * edge_ratio)
                * (0.35 + 0.65 * inlet_axial_profile[k]),
                0.72,
                1.95,
            )
            local_feed_exhaust_gain = _clamp(
                (1.0 + 0.85 * inlet_local) / (1.0 + 0.65 * local_outlet_strength),
                0.35,
                2.6,
            )
            local_attachment_gain = _clamp(
                1.0 / (1.0 + 0.32 * gas_attachment_factor * (0.25 + local_outlet_strength)),
                0.45,
                1.08,
            )
            e_source_gain = (e_local / (e_local + e_ref)) ** 0.78
            ion_source = (
                ionization_gain
                * power_coupling_gain
                * power_trend_gain
                * flow_residence_factor
                * pump_exhaust_factor
                * gas_reactivity_gain
                * inlet_gain
                * frequency_gain
                * sheath_coupling_gain
                * local_feed_exhaust_gain
                * local_attachment_gain
                * e_source_gain
            )
            ion_source = _clamp(ion_source, 0.0, 20.0)
            b[i] = lambda_relax * n_ref[k][j] + ion_source

    fallback_used = False
    converged = False
    iterations = 0
    residual = 0.0

    if sp is not None:
        data: List[float] = []
        row_idx: List[int] = []
        col_idx: List[int] = []
        for i, row in enumerate(rows):
            for j, value in row.items():
                row_idx.append(i)
                col_idx.append(j)
                data.append(value)
        matrix = sp.csr_matrix((data, (row_idx, col_idx)), shape=(nr * nz, nr * nz))
        try:
            solution = spla.spsolve(matrix, b)
            if not all(math.isfinite(val) for val in solution):
                raise ValueError("non-finite solution")
            solution = [max(val, N_FLOOR) for val in solution]
            residual = _compute_residual(rows, solution, b)
            converged = True
            iterations = 1
        except Exception as exc:
            warnings.append(f"spsolve failed: {exc}; using GS")
            x0 = [n_ref[k][j] for k in range(nz) for j in range(nr)]
            solution, converged, iterations, residual, gs_warnings = _solve_linear_gs(
                rows, b, x0, NE_TOL, NE_MAX_ITER
            )
            warnings.extend(gs_warnings)
    else:
        x0 = [n_ref[k][j] for k in range(nz) for j in range(nr)]
        solution, converged, iterations, residual, gs_warnings = _solve_linear_gs(
            rows, b, x0, NE_TOL, NE_MAX_ITER
        )
        warnings.extend(gs_warnings)

    # Fallback to proxy if the DD solve is unstable.
    if not converged and not fallback_used:
        warnings.append("drift-diffusion did not converge; using proxy ne")
        fallback_used = True
        solution = [n_ref[k][j] for k in range(nz) for j in range(nr)]

    ne_raw = [solution[k * nr : (k + 1) * nr] for k in range(nz)]
    ne_norm = _to_density_observable(ne_raw, request, total_pump_strength)

    meta = NeSolverMetadata(
        method="drift_diffusion_sg_v1",
        mu_e=mu_e,
        D_e=d_e,
        Te_norm=te_norm,
        k_s_wall=k_s_wall,
        k_s_powered=k_s_powered,
        lambda_relax=lambda_relax,
        ionization_gain=ionization_gain,
        bulk_loss=effective_bulk_loss,
        converged=converged,
        iterations=iterations,
        residual=residual,
        fallback_used=fallback_used,
        warnings=warnings,
    )

    return ne_norm, meta


def _sheath_from_phi_drop(
    phi: List[List[float]],
    r_values: List[float],
    z_values: List[float],
    fraction: float = 0.9,
) -> Tuple[List[Point2D], List[List[bool]]]:
    """Build sheath boundary from a potential drop fraction."""
    nz = len(phi)
    nr = len(phi[0]) if nz > 0 else 0
    threshold = (1.0 - fraction) * 1.0
    z_boundary: List[float] = [z_values[-1] for _ in range(nr)]

    for j in range(nr):
        z_found = z_values[-1]
        for k in range(nz):
            if phi[k][j] <= threshold:
                z_found = z_values[k]
                break
        z_boundary[j] = z_found

    polyline = [Point2D(r_mm=r_values[j], z_mm=z_boundary[j]) for j in range(nr)]
    mask = [[z_values[k] <= z_boundary[j] for j in range(nr)] for k in range(nz)]

    return polyline, mask


def _sheath_from_emag_threshold(
    e_mag: List[List[float]],
    r_values: List[float],
    z_values: List[float],
    threshold: float = 0.2,
) -> Tuple[List[Point2D], List[List[bool]]]:
    """Build sheath boundary from an E-field magnitude threshold."""
    nz = len(e_mag)
    nr = len(e_mag[0]) if nz > 0 else 0
    z_boundary: List[float] = [z_values[-1] for _ in range(nr)]

    for j in range(nr):
        column = [e_mag[k][j] for k in range(nz)]
        max_val = max(column) if column else 0.0
        cutoff = max_val * threshold
        z_found = z_values[-1]
        for k in range(nz):
            if column[k] <= cutoff:
                z_found = z_values[k]
                break
        z_boundary[j] = z_found

    polyline = [Point2D(r_mm=r_values[j], z_mm=z_boundary[j]) for j in range(nr)]
    mask = [[z_values[k] <= z_boundary[j] for j in range(nr)] for k in range(nz)]

    return polyline, mask


def build_sheath(
    phi: List[List[float]],
    e_mag: List[List[float]],
    r_values: List[float],
    z_values: List[float],
) -> Sheath:
    """Build a sheath polyline and mask from phi or E-field."""
    if _SHEATH_METHOD == "e_threshold":
        polyline, mask = _sheath_from_emag_threshold(e_mag, r_values, z_values)
    else:
        polyline, mask = _sheath_from_phi_drop(phi, r_values, z_values)
    return Sheath(polyline_mm=polyline, mask=mask)


def extract_sheath_z_by_r(sheath: Sheath) -> List[float]:
    """Extract sheath boundary z-values from the polyline."""
    return [point.z_mm for point in sheath.polyline_mm]


def _format_index_list(indices: List[int], limit: int = 6) -> str:
    if not indices:
        return ""
    shown = ", ".join(str(idx) for idx in indices[:limit])
    if len(indices) > limit:
        return f"{shown}, ..."
    return shown


def _select_powered_surface_tags(tags: Iterable[str]) -> Tuple[List[str], bool]:
    candidates: List[str] = []
    fallback: List[str] = []
    for tag in tags:
        normalized = tag.strip().lower()
        if "powered" in normalized and "electrode" in normalized:
            if any(token in normalized for token in ("surface", "face", "boundary")):
                candidates.append(tag)
            else:
                fallback.append(tag)
    if candidates:
        return sorted(candidates), False
    if fallback:
        return sorted(fallback), True
    return [], False


def estimate_electrode_surface_z_by_r(
    request: SimulationRequest,
    region_id: List[List[int]],
    region_legend: Dict[int, str],
    tag_mask: Optional[Dict[str, List[List[bool]]]],
    z_values: List[float],
) -> Tuple[List[float], List[str]]:
    """Estimate a powered electrode surface z per r-column with tag_mask preference."""
    warnings: List[str] = []
    if not region_id or not region_id[0]:
        warnings.append("empty geometry grid; defaulted electrode_z to z0")
        return [z_values[0] if z_values else 0.0], warnings

    nr = len(region_id[0])
    nz = len(region_id)
    electrode_z = [z_values[0] for _ in range(nr)]

    if tag_mask:
        candidate_tags, used_fallback = _select_powered_surface_tags(tag_mask.keys())
        if candidate_tags:
            chosen_tag = candidate_tags[0]
            if len(candidate_tags) > 1:
                warnings.append(
                    f"multiple powered electrode surface tags found; using '{chosen_tag}'"
                )
            if used_fallback:
                warnings.append(
                    f"no explicit powered electrode surface tag; using '{chosen_tag}'"
                )
            mask = tag_mask.get(chosen_tag)
            if mask is not None:
                missing_cols: List[int] = []
                for j in range(nr):
                    indices = [k for k in range(nz) if mask[k][j]]
                    if indices:
                        electrode_z[j] = z_values[max(indices)]
                    else:
                        electrode_z[j] = z_values[0]
                        missing_cols.append(j)
                if missing_cols:
                    warnings.append(
                        "no powered electrode surface mask in columns "
                        f"{_format_index_list(missing_cols)}; defaulted electrode_z to z0"
                    )
                return electrode_z, warnings
        else:
            warnings.append(
                "no powered electrode surface tag found in geometry.grid.tag_mask; "
                "falling back to region_legend"
            )

    missing_cols: List[int] = []
    disconnected_cols: List[int] = []
    for j in range(nr):
        powered_indices = [
            k
            for k in range(nz)
            if region_legend.get(region_id[k][j]) == "powered_electrode"
        ]
        if powered_indices:
            powered_indices.sort()
            segments = 1
            for a, b in zip(powered_indices, powered_indices[1:]):
                if b - a > 1:
                    segments += 1
            if segments > 1:
                disconnected_cols.append(j)
            electrode_z[j] = z_values[max(powered_indices)]
        else:
            electrode_z[j] = z_values[0]
            missing_cols.append(j)

    if disconnected_cols:
        warnings.append(
            "powered electrode has disconnected segments in columns "
            f"{_format_index_list(disconnected_cols)}; using max z"
        )
    if missing_cols:
        warnings.append(
            "no powered electrode in columns "
            f"{_format_index_list(missing_cols)}; defaulted electrode_z to z0"
        )

    return electrode_z, warnings


def estimate_powered_electrode_z_by_r(
    request: SimulationRequest,
    z_values: List[float],
) -> Tuple[List[float], List[str]]:
    """Backward-compatible wrapper for electrode surface estimation."""
    grid = request.geometry.grid
    if grid is None:
        return [z_values[0] for _ in range(request.geometry.domain.nr)], [
            "geometry.grid missing; defaulted electrode_z to z0"
        ]
    return estimate_electrode_surface_z_by_r(
        request,
        grid.region_id,
        grid.region_legend,
        grid.tag_mask,
        z_values,
    )


def _summary_stats(values: List[float]) -> Tuple[float, float, float]:
    if not values:
        return 0.0, 0.0, 0.0
    return sum(values) / len(values), min(values), max(values)


def _summary_stats_optional(values: Optional[List[float]]) -> Tuple[Optional[float], Optional[float], Optional[float]]:
    if not values:
        return None, None, None
    finite_values = [value for value in values if math.isfinite(value)]
    if not finite_values:
        return None, None, None
    return (
        sum(finite_values) / len(finite_values),
        min(finite_values),
        max(finite_values),
    )


def compute_sheath_metrics(
    request: SimulationRequest,
    sheath: Sheath,
    z_values: List[float],
) -> SheathMetrics:
    """Compute sheath boundary and thickness metrics."""
    z_mm_by_r = extract_sheath_z_by_r(sheath)
    electrode_z_mm_by_r, warnings = estimate_powered_electrode_z_by_r(request, z_values)
    thickness_mm_by_r = [
        abs(z_mm_by_r[j] - electrode_z_mm_by_r[j]) for j in range(len(z_mm_by_r))
    ]
    thickness_mean, thickness_min, thickness_max = _summary_stats(thickness_mm_by_r)
    z_mean, z_min, z_max = _summary_stats(z_mm_by_r)

    return SheathMetrics(
        z_mm_by_r=z_mm_by_r,
        electrode_z_mm_by_r=electrode_z_mm_by_r,
        thickness_mm_by_r=thickness_mm_by_r,
        thickness_mean_mm=thickness_mean,
        thickness_min_mm=thickness_min,
        thickness_max_mm=thickness_max,
        z_mean_mm=z_mean,
        z_min_mm=z_min,
        z_max_mm=z_max,
        warnings=warnings,
    )


def compute_delta_sheath_metrics(
    baseline: SheathMetrics,
    perturbed: SheathMetrics,
) -> SheathMetrics:
    """Compute delta sheath metrics (perturbed - baseline)."""
    z_delta = [
        perturbed.z_mm_by_r[j] - baseline.z_mm_by_r[j]
        for j in range(len(baseline.z_mm_by_r))
    ]
    thickness_delta = None
    if baseline.thickness_mm_by_r and perturbed.thickness_mm_by_r:
        thickness_delta = [
            perturbed.thickness_mm_by_r[j] - baseline.thickness_mm_by_r[j]
            for j in range(len(baseline.thickness_mm_by_r))
        ]

    thickness_mean = None
    thickness_min = None
    thickness_max = None
    if thickness_delta is not None:
        thickness_mean, thickness_min, thickness_max = _summary_stats(thickness_delta)

    z_mean, z_min, z_max = _summary_stats(z_delta)
    warnings = [f"baseline: {msg}" for msg in baseline.warnings] + [
        f"perturbed: {msg}" for msg in perturbed.warnings
    ]

    return SheathMetrics(
        z_mm_by_r=z_delta,
        electrode_z_mm_by_r=None,
        thickness_mm_by_r=thickness_delta,
        thickness_mean_mm=thickness_mean,
        thickness_min_mm=thickness_min,
        thickness_max_mm=thickness_max,
        z_mean_mm=z_mean,
        z_min_mm=z_min,
        z_max_mm=z_max,
        warnings=warnings,
    )


def sample_field_on_sheath(
    field_2d: List[List[float]],
    sheath_z_by_r: List[float],
    z_values: List[float],
) -> List[float]:
    """Sample a field along the sheath boundary (nearest z index)."""
    if not field_2d:
        return []
    nz = len(field_2d)
    nr = len(field_2d[0])
    if len(z_values) != nz:
        raise ValueError("z_values length must match field nz")
    if len(sheath_z_by_r) != nr:
        raise ValueError("sheath_z_by_r length must match field nr")

    def nearest_index(target: float) -> int:
        pos = bisect_left(z_values, target)
        if pos <= 0:
            return 0
        if pos >= nz:
            return nz - 1
        lower = z_values[pos - 1]
        upper = z_values[pos]
        if abs(target - lower) <= abs(upper - target):
            return pos - 1
        return pos

    samples: List[float] = []
    for j in range(nr):
        target = sheath_z_by_r[j]
        k = nearest_index(target)
        indices = [k]
        if k > 0:
            indices.append(k - 1)
        if k < nz - 1:
            indices.append(k + 1)
        samples.append(sum(field_2d[idx][j] for idx in indices) / len(indices))
    return samples


def _sample_field_by_z(
    field_2d: List[List[float]],
    z_by_r: List[float],
    z_values: List[float],
) -> List[float]:
    """Sample a field at specified z positions per r column."""
    if not field_2d:
        return []
    nz = len(field_2d)
    nr = len(field_2d[0])
    if len(z_values) != nz:
        raise ValueError("z_values length must match field nz")
    if len(z_by_r) != nr:
        raise ValueError("z_by_r length must match field nr")

    def nearest_index(target: float) -> int:
        pos = bisect_left(z_values, target)
        if pos <= 0:
            return 0
        if pos >= nz:
            return nz - 1
        lower = z_values[pos - 1]
        upper = z_values[pos]
        if abs(target - lower) <= abs(upper - target):
            return pos - 1
        return pos

    samples: List[float] = []
    for j in range(nr):
        target = z_by_r[j]
        k = nearest_index(target)
        indices = [k]
        if k > 0:
            indices.append(k - 1)
        if k < nz - 1:
            indices.append(k + 1)
        samples.append(sum(field_2d[idx][j] for idx in indices) / len(indices))
    return samples


def _infer_mi_amu(request: SimulationRequest) -> Tuple[float, Optional[str]]:
    mixture = request.gas.mixture if request.gas else None
    if not mixture:
        return MI_AMU_DEFAULT, "gas mixture missing; using Mi_amu=40"
    weighted_mass = 0.0
    known_fraction = 0.0
    for component in mixture:
        species = component.species.strip().lower()
        fraction = max(0.0, component.fraction)
        mass = _MASS_BY_SPECIES_AMU.get(species)
        if mass is None:
            continue
        weighted_mass += fraction * mass
        known_fraction += fraction

    if known_fraction <= 0.0:
        dominant = max(mixture, key=lambda comp: comp.fraction)
        return MI_AMU_DEFAULT, f"unknown dominant gas '{dominant.species}'; using Mi_amu=40"

    mi_amu = weighted_mass / known_fraction
    warning = None
    if known_fraction < 0.9:
        warning = "gas includes unknown species; Mi_amu inferred from known components"
    return mi_amu, warning


def compute_viz_curves(
    r_values: List[float],
    sheath_metrics: SheathMetrics,
    sheath_metrics_2: Optional[SheathMetrics] = None,
) -> VizCurves:
    """Build plot-ready 1D curves for the UI."""
    warnings = list(sheath_metrics.warnings)
    thickness = sheath_metrics.thickness_mm_by_r
    if thickness is None:
        warnings.append("sheath thickness missing; sheath_thickness_mm_by_r unavailable")

    delta_z = None
    delta_thickness = None
    if sheath_metrics_2 is not None:
        delta_z = [
            sheath_metrics_2.z_mm_by_r[j] - sheath_metrics.z_mm_by_r[j]
            for j in range(len(sheath_metrics.z_mm_by_r))
        ]
        if thickness is not None and sheath_metrics_2.thickness_mm_by_r is not None:
            delta_thickness = [
                sheath_metrics_2.thickness_mm_by_r[j] - thickness[j]
                for j in range(len(thickness))
            ]
        else:
            warnings.append("sheath thickness missing; delta thickness unavailable")

    return VizCurves(
        r_mm=r_values,
        sheath_z_mm_by_r=sheath_metrics.z_mm_by_r,
        sheath_thickness_mm_by_r=thickness,
        delta_sheath_z_mm_by_r=delta_z,
        delta_sheath_thickness_mm_by_r=delta_thickness,
        warnings=warnings,
    )


def compute_ion_proxy(
    request: SimulationRequest,
    phi_2d: List[List[float]],
    sheath_metrics: SheathMetrics,
    ne_2d: Optional[List[List[float]]],
    r_values: List[float],
    z_values: List[float],
    te_eV_used: Optional[float] = None,
) -> IonProxyCurves:
    """Compute lightweight ion proxy curves derived from phi and ne."""
    warnings: List[str] = []

    ion_energy_proxy: Optional[List[float]] = None
    ion_flux_proxy: Optional[List[float]] = None
    te_eV = te_eV_used if te_eV_used is not None else estimate_te_eV(request)
    te_eV = _clamp(te_eV, 0.5, 15.0)

    if sheath_metrics.electrode_z_mm_by_r is None:
        warnings.append("electrode_z_mm_by_r missing; ion_energy_proxy unavailable")
    else:
        try:
            phi_sheath = _sample_field_by_z(phi_2d, sheath_metrics.z_mm_by_r, z_values)
            phi_electrode = _sample_field_by_z(
                phi_2d, sheath_metrics.electrode_z_mm_by_r, z_values
            )
            ion_energy_proxy = []
            for ps, pe in zip(phi_sheath, phi_electrode):
                if not math.isfinite(ps) or not math.isfinite(pe):
                    ion_energy_proxy.append(0.0)
                    warnings.append("non-finite phi sample; ion_energy_proxy clamped to 0")
                else:
                    ion_energy_proxy.append(max(0.0, abs(ps - pe)))

            phi_flat = [val for row in phi_2d for val in row]
            max_phi = max(phi_flat) if phi_flat else 0.0
            if max_phi <= 2.0:
                warnings.append(
                    "phi appears normalized; ion_energy_proxy is relative, not absolute eV"
                )
        except Exception as exc:
            ion_energy_proxy = None
            warnings.append(f"failed to sample phi for ion_energy_proxy: {exc}")

    mi_used, mi_warning = _infer_mi_amu(request)
    if mi_warning:
        warnings.append(mi_warning)

    if ne_2d is None:
        warnings.append("ne missing; ion_flux_proxy unavailable")
    else:
        try:
            ne_on_sheath = _sample_field_by_z(ne_2d, sheath_metrics.z_mm_by_r, z_values)
            if mi_used <= 0.0:
                raise ValueError("Mi_amu must be positive")
            flux_factor = math.sqrt(te_eV / mi_used)
            ion_flux_proxy = []
            for ne_val in ne_on_sheath:
                if not math.isfinite(ne_val):
                    ion_flux_proxy.append(0.0)
                    warnings.append("non-finite ne sample; ion_flux_proxy clamped to 0")
                else:
                    ion_flux_proxy.append(max(0.0, ne_val) * flux_factor)
        except Exception as exc:
            ion_flux_proxy = None
            warnings.append(f"failed to compute ion_flux_proxy: {exc}")

    return IonProxyCurves(
        ion_energy_proxy_rel_by_r=ion_energy_proxy,
        ion_flux_proxy_rel_by_r=ion_flux_proxy,
        Te_eV_used=te_eV,
        Mi_amu_used=mi_used,
        warnings=warnings,
    )


def compute_delta_ion_proxy(
    baseline: IonProxyCurves,
    perturbed: IonProxyCurves,
) -> IonProxyCurves:
    """Compute delta ion proxy curves (perturbed - baseline)."""
    warnings = [f"baseline: {msg}" for msg in baseline.warnings] + [
        f"perturbed: {msg}" for msg in perturbed.warnings
    ]

    def delta_list(
        a: Optional[List[float]],
        b: Optional[List[float]],
        label: str,
    ) -> Optional[List[float]]:
        if a is None or b is None:
            warnings.append(f"{label} missing for delta")
            return None
        if len(a) != len(b):
            warnings.append(f"{label} length mismatch for delta")
            return None
        return [b[idx] - a[idx] for idx in range(len(a))]

    energy_delta = delta_list(
        baseline.ion_energy_proxy_rel_by_r,
        perturbed.ion_energy_proxy_rel_by_r,
        "ion_energy_proxy_rel_by_r",
    )
    flux_delta = delta_list(
        baseline.ion_flux_proxy_rel_by_r,
        perturbed.ion_flux_proxy_rel_by_r,
        "ion_flux_proxy_rel_by_r",
    )

    return IonProxyCurves(
        ion_energy_proxy_rel_by_r=energy_delta,
        ion_flux_proxy_rel_by_r=flux_delta,
        Te_eV_used=baseline.Te_eV_used,
        Mi_amu_used=baseline.Mi_amu_used,
        warnings=warnings,
    )


def compute_insights(
    request: SimulationRequest,
    fields: FieldGrid,
    sheath_metrics: SheathMetrics,
    z_values: List[float],
    r_values: List[float],
) -> SheathInsights:
    """Compute 1D insight curves sampled along the sheath."""
    warnings = list(sheath_metrics.warnings)
    e_on_sheath: Optional[List[float]] = None
    ne_on_sheath: Optional[List[float]] = None

    if fields.E_mag is None:
        warnings.append("E_mag missing; E_on_sheath_by_r omitted")
    else:
        try:
            e_on_sheath = sample_field_on_sheath(
                fields.E_mag, sheath_metrics.z_mm_by_r, z_values
            )
        except Exception as exc:
            warnings.append(f"failed to sample E_mag on sheath: {exc}")

    if fields.ne is None:
        warnings.append("ne field missing; ne_on_sheath_by_r omitted")
    else:
        try:
            ne_on_sheath = sample_field_on_sheath(
                fields.ne, sheath_metrics.z_mm_by_r, z_values
            )
        except Exception as exc:
            warnings.append(f"failed to sample ne on sheath: {exc}")

    thickness = sheath_metrics.thickness_mm_by_r

    e_mean, e_min, e_max = _summary_stats_optional(e_on_sheath)
    ne_mean, ne_min, ne_max = _summary_stats_optional(ne_on_sheath)
    t_mean, t_min, t_max = _summary_stats_optional(thickness)

    summary = InsightSummary(
        e_on_sheath_mean=e_mean,
        e_on_sheath_min=e_min,
        e_on_sheath_max=e_max,
        ne_on_sheath_mean=ne_mean,
        ne_on_sheath_min=ne_min,
        ne_on_sheath_max=ne_max,
        thickness_mean_mm=t_mean,
        thickness_min_mm=t_min,
        thickness_max_mm=t_max,
    )

    return SheathInsights(
        r_mm=r_values,
        sheath_z_mm_by_r=sheath_metrics.z_mm_by_r,
        sheath_thickness_mm_by_r=thickness,
        E_on_sheath_by_r=e_on_sheath,
        ne_on_sheath_by_r=ne_on_sheath,
        summary=summary,
        warnings=warnings,
    )


def compute_delta_insights(
    baseline: SheathInsights,
    perturbed: SheathInsights,
) -> SheathInsights:
    """Compute delta insights (perturbed - baseline)."""
    warnings = [f"baseline: {msg}" for msg in baseline.warnings] + [
        f"perturbed: {msg}" for msg in perturbed.warnings
    ]

    def delta_list(
        a: Optional[List[float]],
        b: Optional[List[float]],
        label: str,
    ) -> Optional[List[float]]:
        if a is None or b is None:
            warnings.append(f"{label} missing for delta")
            return None
        if len(a) != len(b):
            warnings.append(f"{label} length mismatch for delta")
            return None
        return [b[idx] - a[idx] for idx in range(len(a))]

    def delta_value(a: Optional[float], b: Optional[float]) -> Optional[float]:
        if a is None or b is None:
            return None
        if not math.isfinite(a) or not math.isfinite(b):
            return None
        return b - a

    e_delta = delta_list(baseline.E_on_sheath_by_r, perturbed.E_on_sheath_by_r, "E_on_sheath_by_r")
    ne_delta = delta_list(
        baseline.ne_on_sheath_by_r, perturbed.ne_on_sheath_by_r, "ne_on_sheath_by_r"
    )
    thickness_delta = delta_list(
        baseline.sheath_thickness_mm_by_r,
        perturbed.sheath_thickness_mm_by_r,
        "sheath_thickness_mm_by_r",
    )
    sheath_z_delta = delta_list(
        baseline.sheath_z_mm_by_r, perturbed.sheath_z_mm_by_r, "sheath_z_mm_by_r"
    )

    summary = InsightSummary(
        e_on_sheath_mean=delta_value(
            baseline.summary.e_on_sheath_mean, perturbed.summary.e_on_sheath_mean
        ),
        e_on_sheath_min=delta_value(
            baseline.summary.e_on_sheath_min, perturbed.summary.e_on_sheath_min
        ),
        e_on_sheath_max=delta_value(
            baseline.summary.e_on_sheath_max, perturbed.summary.e_on_sheath_max
        ),
        ne_on_sheath_mean=delta_value(
            baseline.summary.ne_on_sheath_mean, perturbed.summary.ne_on_sheath_mean
        ),
        ne_on_sheath_min=delta_value(
            baseline.summary.ne_on_sheath_min, perturbed.summary.ne_on_sheath_min
        ),
        ne_on_sheath_max=delta_value(
            baseline.summary.ne_on_sheath_max, perturbed.summary.ne_on_sheath_max
        ),
        thickness_mean_mm=delta_value(
            baseline.summary.thickness_mean_mm, perturbed.summary.thickness_mean_mm
        ),
        thickness_min_mm=delta_value(
            baseline.summary.thickness_min_mm, perturbed.summary.thickness_min_mm
        ),
        thickness_max_mm=delta_value(
            baseline.summary.thickness_max_mm, perturbed.summary.thickness_max_mm
        ),
    )

    if len(baseline.r_mm) != len(perturbed.r_mm):
        warnings.append("r_mm length mismatch; using baseline r_mm")

    return SheathInsights(
        r_mm=baseline.r_mm,
        sheath_z_mm_by_r=sheath_z_delta or [],
        sheath_thickness_mm_by_r=thickness_delta,
        E_on_sheath_by_r=e_delta,
        ne_on_sheath_by_r=ne_delta,
        summary=summary,
        warnings=warnings,
    )


def run_simulation_poisson_v1(request: SimulationRequest, request_id: str) -> SimulationResult:
    """Run a Poisson solve and return a simulation result payload."""
    grid = request.geometry.grid
    if grid is None:
        raise ValueError("geometry.grid is required for poisson_v1")

    domain = request.geometry.domain
    nr = domain.nr
    nz = domain.nz
    dr = domain.r_max_mm / (nr - 1)
    dz = domain.z_max_mm / (nz - 1)

    outputs = request.outputs
    enable_efield = outputs.efield if outputs is not None else True
    expose_ne = outputs.ne if outputs is not None else True
    enable_vld = outputs.volume_loss_density if outputs is not None else True
    enable_sheath = outputs.sheath if outputs is not None else True

    need_ne_solver = expose_ne or enable_vld

    transport = derive_transport_coefficients(request)
    eps = build_epsilon_map(request)
    wall_loss_map = build_wall_loss_map(request)
    vld_geometry_mask = build_vld_geometry_mask(request) if enable_vld else None
    powered_voltage = derive_powered_boundary_voltage(request)
    dc_offset = derive_dc_bias_offset(request)
    dirichlet_mask, dirichlet_values = build_dirichlet_mask_values(
        request, powered_voltage=powered_voltage, dc_offset=dc_offset
    )
    A, b = assemble_poisson_matrix(eps, dr, dz, nz, nr, dirichlet_mask, dirichlet_values)
    phi = solve_phi(A, b, nz, nr)
    e_mag = compute_Emag(phi, dr, dz)

    ne_norm_raw: Optional[List[List[float]]] = None
    ne_meta: Optional[NeSolverMetadata] = None
    plasma_mask = [
        [grid.region_legend[grid.region_id[k][j]] == "plasma" for j in range(nr)]
        for k in range(nz)
    ]

    if need_ne_solver:
        solved_ne, ne_meta = solve_ne_drift_diffusion_sg(phi, request, coefficients=transport)
        ne_norm_raw = [
            [solved_ne[k][j] if plasma_mask[k][j] else 0.0 for j in range(nr)]
            for k in range(nz)
        ]

    volume_loss_density = (
        compute_volume_loss_density(
            ne_norm_raw,
            e_mag,
            wall_loss_map,
            eps,
            request,
            geometry_mask=vld_geometry_mask,
        )
        if enable_vld
        else None
    )

    r_values = _linspace(0.0, domain.r_max_mm, nr)
    z_values = _linspace(0.0, domain.z_max_mm, nz)
    grid_out = Grid(r_mm=r_values, z_mm=z_values)

    fields_e = e_mag if enable_efield else None
    fields_ne = ne_norm_raw if expose_ne else None
    has_any_field = fields_e is not None or fields_ne is not None or volume_loss_density is not None
    fields = (
        FieldGrid(
            E_mag=fields_e,
            ne=fields_ne,
            volume_loss_density=volume_loss_density,
            emission=None,
        )
        if has_any_field
        else None
    )

    sheath = build_sheath(phi, e_mag, r_values, z_values)
    sheath_metrics: Optional[SheathMetrics] = None
    insights: Optional[SheathInsights] = None
    ion_proxy: Optional[IonProxyCurves] = None
    if enable_sheath:
        sheath_metrics = compute_sheath_metrics(request, sheath, z_values)
        if sheath_metrics is not None:
            insights_fields = FieldGrid(E_mag=fields_e, ne=fields_ne, volume_loss_density=None, emission=None)
            if fields_e is not None or fields_ne is not None:
                insights = compute_insights(request, insights_fields, sheath_metrics, z_values, r_values)
            ion_proxy = compute_ion_proxy(
                request,
                phi,
                sheath_metrics,
                ne_norm_raw,
                r_values,
                z_values,
                te_eV_used=transport.Te_eV,
            )

    sheath_metrics_2: Optional[SheathMetrics] = None
    delta_ion_proxy: Optional[IonProxyCurves] = None

    compare: Optional[Compare] = None
    run_compare = request.baseline.enabled and (enable_efield or expose_ne or enable_vld or enable_sheath)
    if run_compare:
        perturbed_voltage = powered_voltage * 1.02 if powered_voltage > 0.0 else 0.0
        dirichlet_mask_perturbed, dirichlet_values_perturbed = build_dirichlet_mask_values(
            request, powered_voltage=perturbed_voltage, dc_offset=dc_offset
        )
        A2, b2 = assemble_poisson_matrix(
            eps, dr, dz, nz, nr, dirichlet_mask_perturbed, dirichlet_values_perturbed
        )
        phi2 = solve_phi(A2, b2, nz, nr)
        e_mag2 = compute_Emag(phi2, dr, dz)

        ne_norm2: Optional[List[List[float]]] = None
        if need_ne_solver:
            solved_ne2, _ = solve_ne_drift_diffusion_sg(phi2, request, coefficients=transport)
            ne_norm2 = [
                [solved_ne2[k][j] if plasma_mask[k][j] else 0.0 for j in range(nr)]
                for k in range(nz)
            ]

        volume_loss_density2 = (
            compute_volume_loss_density(
                ne_norm2,
                e_mag2,
                wall_loss_map,
                eps,
                request,
                geometry_mask=vld_geometry_mask,
            )
            if enable_vld
            else None
        )

        delta_sheath_metrics: Optional[SheathMetrics] = None
        delta_insights: Optional[SheathInsights] = None

        if enable_sheath and sheath_metrics is not None:
            sheath2 = build_sheath(phi2, e_mag2, r_values, z_values)
            sheath_metrics2 = compute_sheath_metrics(request, sheath2, z_values)
            sheath_metrics_2 = sheath_metrics2
            delta_sheath_metrics = compute_delta_sheath_metrics(sheath_metrics, sheath_metrics2)

            if fields_e is not None or fields_ne is not None:
                fields2 = FieldGrid(
                    E_mag=e_mag2 if enable_efield else None,
                    ne=ne_norm2 if expose_ne else None,
                    volume_loss_density=None,
                    emission=None,
                )
                insights2 = compute_insights(request, fields2, sheath_metrics2, z_values, r_values)
                if insights is not None:
                    delta_insights = compute_delta_insights(insights, insights2)

            ion_proxy2 = compute_ion_proxy(
                request,
                phi2,
                sheath_metrics2,
                ne_norm2,
                r_values,
                z_values,
                te_eV_used=transport.Te_eV,
            )
            if ion_proxy is not None:
                delta_ion_proxy = compute_delta_ion_proxy(ion_proxy, ion_proxy2)

        delta_e = (
            [[e_mag2[k][j] - e_mag[k][j] for j in range(nr)] for k in range(nz)]
            if enable_efield
            else None
        )
        delta_ne = (
            [[ne_norm2[k][j] - ne_norm_raw[k][j] for j in range(nr)] for k in range(nz)]
            if expose_ne and ne_norm_raw is not None and ne_norm2 is not None
            else None
        )
        delta_vld = (
            [
                [
                    volume_loss_density2[k][j] - volume_loss_density[k][j]
                    for j in range(nr)
                ]
                for k in range(nz)
            ]
            if enable_vld and volume_loss_density is not None and volume_loss_density2 is not None
            else None
        )

        delta_fields = None
        if delta_e is not None or delta_ne is not None or delta_vld is not None:
            delta_fields = FieldGrid(
                E_mag=delta_e,
                ne=delta_ne,
                volume_loss_density=delta_vld,
                emission=None,
            )

        delta_thickness_mean = None
        if delta_sheath_metrics is not None and delta_sheath_metrics.thickness_mm_by_r is not None:
            delta_thickness_mean, _, _ = _summary_stats(delta_sheath_metrics.thickness_mm_by_r)

        compare = Compare(
            enabled=True,
            delta_fields=delta_fields,
            delta_sheath_thickness_mm=delta_thickness_mean,
            delta_sheath_metrics=delta_sheath_metrics,
            delta_insights=delta_insights,
            delta_ion_proxy=delta_ion_proxy,
        )

    viz = (
        compute_viz_curves(r_values, sheath_metrics, sheath_metrics_2)
        if enable_sheath and sheath_metrics is not None
        else None
    )

    metadata = SimulationMetadata(
        request_id=request_id,
        eta=impedance_delta_to_eta(request.impedance.delta_percent),
        geometry=request.geometry,
        process=request.process,
        gas=request.gas,
        flow_boundary=request.flow_boundary,
        material=request.material,
        impedance=request.impedance,
        grid_summary=_grid_summary(request),
        ne_solver=ne_meta,
    )

    return SimulationResult(
        metadata=metadata,
        grid=grid_out,
        fields=fields,
        sheath=sheath,
        sheath_metrics=sheath_metrics,
        insights=insights,
        viz=viz,
        ion_proxy=ion_proxy,
        compare=compare,
    )

