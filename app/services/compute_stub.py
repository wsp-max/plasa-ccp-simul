"""Stubbed compute service returning dummy field data."""

from __future__ import annotations

from typing import List, Optional

from schemas import (
    Compare,
    FieldGrid,
    GeometryGridSummary,
    Grid,
    Point2D,
    Sheath,
    SimulationMetadata,
    SimulationRequest,
    SimulationResult,
)


_REGION_TYPES = (
    "plasma",
    "solid_wall",
    "powered_electrode",
    "ground_electrode",
    "dielectric",
)


def impedance_delta_to_eta(delta_percent: float) -> float:
    """Convert impedance delta percent to a placeholder coupling efficiency."""
    return max(0.0, min(1.0, 1.0 - abs(delta_percent) / 100.0))


def _linspace(start: float, stop: float, count: int) -> List[float]:
    if count <= 1:
        return [start]
    step = (stop - start) / (count - 1)
    return [start + step * index for index in range(count)]


def _make_field(z_values: List[float], r_values: List[float], scale: float) -> List[List[float]]:
    """Create a simple z-major 2D field with deterministic values."""
    field: List[List[float]] = []
    r_max = r_values[-1] if r_values else 1.0
    z_max = z_values[-1] if z_values else 1.0
    for z in z_values:
        row = []
        for r in r_values:
            row.append(scale * ((r / r_max) + (z / z_max)))
        field.append(row)
    return field


def _grid_summary(request: SimulationRequest) -> Optional[GeometryGridSummary]:
    grid = request.geometry.grid
    if grid is None:
        return None

    region_type_counts = {region_type: 0 for region_type in _REGION_TYPES}
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


def _build_metadata(request: SimulationRequest, request_id: str, eta: float) -> SimulationMetadata:
    return SimulationMetadata(
        request_id=request_id,
        eta=eta,
        geometry=request.geometry,
        process=request.process,
        gas=request.gas,
        flow_boundary=request.flow_boundary,
        material=request.material,
        impedance=request.impedance,
        grid_summary=_grid_summary(request),
    )


def run_simulation_stub(request: SimulationRequest, request_id: str) -> SimulationResult:
    """Return dummy result payload with grid, fields, sheath, and compare data."""
    domain = request.geometry.domain
    nr = max(2, min(domain.nr, 10))
    nz = max(2, min(domain.nz, 10))

    r_values = _linspace(0.0, domain.r_max_mm, nr)
    z_values = _linspace(0.0, domain.z_max_mm, nz)

    grid = Grid(r_mm=r_values, z_mm=z_values)
    outputs = request.outputs
    show_e = outputs.efield if outputs is not None else True
    show_ne = outputs.ne if outputs is not None else True
    show_vld = outputs.volume_loss_density if outputs is not None else True

    e_field = _make_field(z_values, r_values, scale=1.0)
    ne_field = _make_field(z_values, r_values, scale=1e-2)
    # Backward-compatible key `volume_loss_density` carries a per-volume
    # absorbed-power-density proxy field (relative).
    vld_field = _make_field(z_values, r_values, scale=4e-3)
    fields = FieldGrid(
        E_mag=e_field if show_e else None,
        ne=ne_field if show_ne else None,
        volume_loss_density=vld_field if show_vld else None,
        emission=_make_field(z_values, r_values, scale=5e-3),
    )

    sheath_z = domain.z_max_mm * 0.1
    polyline = [Point2D(r_mm=r, z_mm=sheath_z) for r in r_values]
    mask = [[z <= sheath_z for _ in r_values] for z in z_values]
    sheath = Sheath(polyline_mm=polyline, mask=mask)

    compare: Optional[Compare] = None
    if request.baseline.enabled:
        delta_fields = FieldGrid(
            E_mag=_make_field(z_values, r_values, scale=0.05) if show_e else None,
            ne=_make_field(z_values, r_values, scale=0.0) if show_ne else None,
            volume_loss_density=_make_field(z_values, r_values, scale=1e-3) if show_vld else None,
            emission=_make_field(z_values, r_values, scale=-0.02),
        )
        compare = Compare(
            enabled=True,
            delta_fields=delta_fields,
            delta_sheath_thickness_mm=0.2,
        )

    metadata = _build_metadata(request, request_id, impedance_delta_to_eta(request.impedance.delta_percent))

    return SimulationResult(
        metadata=metadata,
        grid=grid,
        fields=fields,
        sheath=sheath,
        compare=compare,
    )
