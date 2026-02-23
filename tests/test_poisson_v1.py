"""Poisson v1 solver tests."""

from __future__ import annotations

import copy
import math

from schemas import FieldGrid, SimulationRequest
from services import compute_poisson_v1
from services.compute_poisson_v1 import (
    assemble_poisson_matrix,
    build_dirichlet_mask_values,
    build_epsilon_map,
    build_ne_proxy_from_phi,
    cg_solve,
    compute_insights,
    derive_dc_bias_offset,
    derive_powered_boundary_voltage,
    derive_transport_coefficients,
    estimate_te_eV,
    run_simulation_poisson_v1,
    solve_phi,
)


def _poisson_request_payload() -> dict:
    return {
        "meta": {"request_id": "poisson-test"},
        "geometry": {
            "axisymmetric": True,
            "coordinate_system": "r-z",
            "domain": {"r_max_mm": 10.0, "z_max_mm": 20.0, "nr": 4, "nz": 4},
            "tags": ["showerhead", "bottom_pump", "dielectric_block"],
            "grid": {
                "schema": "mask_v1",
                "nr": 4,
                "nz": 4,
                "region_id": [
                    [2, 2, 1, 1],
                    [0, 0, 1, 1],
                    [4, 4, 3, 3],
                    [4, 4, 3, 3],
                ],
                "region_legend": {
                    "0": "plasma",
                    "1": "solid_wall",
                    "2": "powered_electrode",
                    "3": "ground_electrode",
                    "4": "dielectric",
                },
                "tag_mask": {
                    "dielectric_block": [
                        [False, False, False, False],
                        [False, False, False, False],
                        [True, True, False, False],
                        [True, True, False, False],
                    ]
                },
            },
        },
        "process": {"pressure_Pa": 10.0, "rf_power_W": 100.0, "frequency_Hz": 13_560_000.0},
        "gas": {"mixture": [{"species": "Ar", "fraction": 1.0}]},
        "flow_boundary": {
            "inlet": {
                "type": "surface",
                "surface_tag": "showerhead",
                "uniform": True,
                "total_flow_sccm": 10.0,
                "direction": "normal_inward",
            },
            "outlet": {"type": "sink", "surface_tag": "bottom_pump", "strength": 1.0},
        },
        "material": {
            "default": {"epsilon_r": 4.0, "wall_loss_e": 0.2},
            "regions": [
                {"target_tag": "dielectric_block", "epsilon_r": 5.0},
            ],
        },
        "impedance": {"delta_percent": 5.0},
        "baseline": {"enabled": False},
    }


def _pad_request_payload() -> dict:
    return {
        "meta": {"request_id": "pad-test"},
        "geometry": {
            "axisymmetric": True,
            "coordinate_system": "r-z",
            "domain": {"r_max_mm": 12.0, "z_max_mm": 12.0, "nr": 6, "nz": 6},
            "tags": [
                "showerhead",
                "bottom_pump",
                "dielectric_block",
                "powered_electrode_surface",
            ],
            "grid": {
                "schema": "mask_v1",
                "nr": 6,
                "nz": 6,
                "region_id": [
                    [2, 2, 2, 2, 2, 2],
                    [0, 0, 0, 0, 0, 0],
                    [0, 4, 4, 4, 4, 0],
                    [0, 0, 0, 0, 0, 0],
                    [3, 3, 3, 3, 3, 3],
                    [3, 3, 3, 3, 3, 3],
                ],
                "region_legend": {
                    "0": "plasma",
                    "1": "solid_wall",
                    "2": "powered_electrode",
                    "3": "ground_electrode",
                    "4": "dielectric",
                },
                "tag_mask": {
                    "powered_electrode_surface": [
                        [False, True, True, True, True, False],
                        [False, False, False, False, False, False],
                        [False, False, False, False, False, False],
                        [False, False, False, False, False, False],
                        [False, False, False, False, False, False],
                        [False, False, False, False, False, False],
                    ],
                    "dielectric_block": [
                        [False, False, False, False, False, False],
                        [False, False, False, False, False, False],
                        [False, True, True, True, True, False],
                        [False, False, False, False, False, False],
                        [False, False, False, False, False, False],
                        [False, False, False, False, False, False],
                    ],
                    "bottom_pump": [
                        [False, False, False, False, False, False],
                        [False, False, False, False, False, False],
                        [False, False, False, False, False, False],
                        [False, False, False, False, False, False],
                        [False, False, True, True, False, False],
                        [False, False, False, False, False, False],
                    ],
                },
            },
        },
        "process": {"pressure_Pa": 10.0, "rf_power_W": 120.0, "frequency_Hz": 13_560_000.0},
        "gas": {"mixture": [{"species": "Ar", "fraction": 1.0}]},
        "flow_boundary": {
            "inlet": {
                "type": "surface",
                "surface_tag": "showerhead",
                "uniform": True,
                "total_flow_sccm": 10.0,
                "direction": "normal_inward",
            },
            "outlet": {"type": "sink", "surface_tag": "bottom_pump", "strength": 1.0},
        },
        "material": {
            "default": {"epsilon_r": 4.0, "wall_loss_e": 0.2},
            "regions": [{"target_tag": "dielectric_block", "epsilon_r": 6.0, "wall_loss_e": 0.6}],
        },
        "impedance": {"delta_percent": 5.0},
        "baseline": {"enabled": False},
    }


def _tag_mean(field: list[list[float]], mask: list[list[bool]]) -> float:
    values = [
        field[k][j]
        for k in range(min(len(field), len(mask)))
        for j in range(min(len(field[k]), len(mask[k])))
        if mask[k][j] and math.isfinite(field[k][j])
    ]
    assert values
    return sum(values) / len(values)


def _assert_close_grid(grid_a, grid_b, tol: float = 1e-9) -> None:
    assert len(grid_a) == len(grid_b)
    for row_a, row_b in zip(grid_a, grid_b):
        assert len(row_a) == len(row_b)
        for a, b in zip(row_a, row_b):
            assert math.isclose(a, b, rel_tol=tol, abs_tol=tol)


def _assert_1d_series(series) -> None:
    assert all(not isinstance(value, list) for value in series)


def test_poisson_v1_emag_shape_and_finite() -> None:
    payload = _poisson_request_payload()
    request = SimulationRequest.model_validate(payload)
    result = run_simulation_poisson_v1(request, "test")
    e_mag = result.fields.E_mag

    assert len(e_mag) == 4
    assert all(len(row) == 4 for row in e_mag)
    for row in e_mag:
        for value in row:
            assert math.isfinite(value)


def test_poisson_v1_dirichlet_constraints() -> None:
    payload = _poisson_request_payload()
    request = SimulationRequest.model_validate(payload)

    eps = build_epsilon_map(request)
    dirichlet_mask, dirichlet_values = build_dirichlet_mask_values(request, powered_voltage=1.0)
    domain = request.geometry.domain
    dr = domain.r_max_mm / (domain.nr - 1)
    dz = domain.z_max_mm / (domain.nz - 1)
    A, b = assemble_poisson_matrix(
        eps,
        dr,
        dz,
        domain.nz,
        domain.nr,
        dirichlet_mask,
        dirichlet_values,
    )
    phi = solve_phi(A, b, domain.nz, domain.nr)

    for k in range(domain.nz):
        for j in range(domain.nr):
            if dirichlet_mask[k][j]:
                expected = dirichlet_values[k][j]
                assert abs(phi[k][j] - expected) < 1e-4


def test_dirichlet_single_source_keeps_uniform_powered_voltage() -> None:
    payload = _poisson_request_payload()
    request = SimulationRequest.model_validate(payload)
    dirichlet_mask, dirichlet_values = build_dirichlet_mask_values(request, powered_voltage=1.0)

    assert dirichlet_mask[0][0] is True
    assert dirichlet_mask[0][1] is True
    assert math.isclose(dirichlet_values[0][0], 1.0, rel_tol=1e-9, abs_tol=1e-9)
    assert math.isclose(dirichlet_values[0][1], 1.0, rel_tol=1e-9, abs_tol=1e-9)


def test_dirichlet_multi_source_tag_mapping_weights_powered_cells() -> None:
    payload = _poisson_request_payload()
    payload["geometry"]["tags"] = [
        "showerhead",
        "bottom_pump",
        "dielectric_block",
        "powered_left",
        "powered_right",
    ]
    payload["geometry"]["grid"]["tag_mask"]["powered_left"] = [
        [True, False, False, False],
        [False, False, False, False],
        [False, False, False, False],
        [False, False, False, False],
    ]
    payload["geometry"]["grid"]["tag_mask"]["powered_right"] = [
        [False, True, False, False],
        [False, False, False, False],
        [False, False, False, False],
        [False, False, False, False],
    ]
    payload["process"]["rf_sources"] = [
        {
            "name": "left-hf",
            "surface_tag": "powered_left",
            "rf_power_W": 900.0,
            "frequency_Hz": 13_560_000.0,
            "phase_deg": 0.0,
        },
        {
            "name": "right-lf",
            "surface_tag": "powered_right",
            "rf_power_W": 100.0,
            "frequency_Hz": 2_000_000.0,
            "phase_deg": 0.0,
        },
    ]

    request = SimulationRequest.model_validate(payload)
    dirichlet_mask, dirichlet_values = build_dirichlet_mask_values(request, powered_voltage=1.0)

    assert dirichlet_mask[0][0] is True
    assert dirichlet_mask[0][1] is True
    assert math.isclose(dirichlet_values[0][0], 1.0, rel_tol=1e-9, abs_tol=1e-9)
    assert 0.2 < dirichlet_values[0][1] < 0.5
    assert dirichlet_values[0][0] > dirichlet_values[0][1]


def test_poisson_v1_sheath_and_ne_shapes() -> None:
    payload = _poisson_request_payload()
    request = SimulationRequest.model_validate(payload)
    result = run_simulation_poisson_v1(request, "test")

    sheath = result.sheath
    assert len(sheath.polyline_mm) == request.geometry.domain.nr
    for point in sheath.polyline_mm:
        assert 0.0 <= point.r_mm <= request.geometry.domain.r_max_mm
        assert 0.0 <= point.z_mm <= request.geometry.domain.z_max_mm

    mask = sheath.mask
    assert len(mask) == request.geometry.domain.nz
    assert all(len(row) == request.geometry.domain.nr for row in mask)
    for row in mask:
        for value in row:
            assert isinstance(value, bool)

    ne = result.fields.ne
    assert len(ne) == request.geometry.domain.nz
    assert all(len(row) == request.geometry.domain.nr for row in ne)
    for row in ne:
        for value in row:
            assert -1e-9 <= value <= 1.0 + 1e-9

    ne_meta = result.metadata.ne_solver
    assert ne_meta is not None
    assert ne_meta.method == "drift_diffusion_sg_v1"


def test_poisson_v1_deterministic_output() -> None:
    payload = _poisson_request_payload()
    request = SimulationRequest.model_validate(payload)

    result_a = run_simulation_poisson_v1(request, "test")
    result_b = run_simulation_poisson_v1(request, "test")

    _assert_close_grid(result_a.fields.E_mag, result_b.fields.E_mag)
    _assert_close_grid(result_a.fields.ne, result_b.fields.ne)

    assert result_a.sheath.polyline_mm == result_b.sheath.polyline_mm
    assert result_a.sheath.mask == result_b.sheath.mask


def test_ne_solver_fallback(monkeypatch) -> None:
    payload = _poisson_request_payload()
    request = SimulationRequest.model_validate(payload)

    monkeypatch.setattr(compute_poisson_v1, "D_E", 0.0)
    result = compute_poisson_v1.run_simulation_poisson_v1(request, "test")

    assert result.metadata.ne_solver is not None
    assert result.metadata.ne_solver.fallback_used is True

    eps = build_epsilon_map(request)
    dirichlet_mask, dirichlet_values = build_dirichlet_mask_values(
        request, powered_voltage=derive_powered_boundary_voltage(request)
    )
    domain = request.geometry.domain
    dr = domain.r_max_mm / (domain.nr - 1)
    dz = domain.z_max_mm / (domain.nz - 1)
    A, b = assemble_poisson_matrix(
        eps,
        dr,
        dz,
        domain.nz,
        domain.nr,
        dirichlet_mask,
        dirichlet_values,
    )
    phi = solve_phi(A, b, domain.nz, domain.nr)
    proxy = build_ne_proxy_from_phi(phi)
    grid = request.geometry.grid
    assert grid is not None
    proxy_masked = [
        [
            proxy[k][j] if grid.region_legend[grid.region_id[k][j]] == "plasma" else 0.0
            for j in range(domain.nr)
        ]
        for k in range(domain.nz)
    ]

    _assert_close_grid(result.fields.ne, proxy_masked)



def test_sheath_metrics_present_and_shapes() -> None:
    payload = _poisson_request_payload()
    request = SimulationRequest.model_validate(payload)
    result = run_simulation_poisson_v1(request, "test")

    metrics = result.sheath_metrics
    assert metrics is not None
    assert len(metrics.z_mm_by_r) == request.geometry.domain.nr
    for value in metrics.z_mm_by_r:
        assert 0.0 <= value <= request.geometry.domain.z_max_mm

    if metrics.thickness_mm_by_r is not None:
        assert len(metrics.thickness_mm_by_r) == request.geometry.domain.nr
        for value in metrics.thickness_mm_by_r:
            assert value >= 0.0
        assert metrics.thickness_mean_mm is not None
        assert metrics.thickness_min_mm is not None
        assert metrics.thickness_max_mm is not None
        assert math.isfinite(metrics.thickness_mean_mm)
        assert math.isfinite(metrics.thickness_min_mm)
        assert math.isfinite(metrics.thickness_max_mm)

    assert math.isfinite(metrics.z_mean_mm)
    assert math.isfinite(metrics.z_min_mm)
    assert math.isfinite(metrics.z_max_mm)


def test_baseline_delta_sheath_metrics() -> None:
    payload = _poisson_request_payload()
    payload["baseline"]["enabled"] = True
    request = SimulationRequest.model_validate(payload)
    result = run_simulation_poisson_v1(request, "test")

    compare = result.compare
    assert compare is not None
    assert compare.enabled is True
    assert compare.delta_sheath_thickness_mm is not None
    assert math.isfinite(compare.delta_sheath_thickness_mm)

    delta_metrics = compare.delta_sheath_metrics
    assert delta_metrics is not None
    assert len(delta_metrics.z_mm_by_r) == request.geometry.domain.nr
    if delta_metrics.thickness_mm_by_r is not None:
        assert len(delta_metrics.thickness_mm_by_r) == request.geometry.domain.nr


def test_insights_present_and_shapes() -> None:
    payload = _poisson_request_payload()
    request = SimulationRequest.model_validate(payload)
    result = run_simulation_poisson_v1(request, "test")

    insights = result.insights
    assert insights is not None
    nr = request.geometry.domain.nr
    assert len(insights.r_mm) == nr
    assert insights.r_mm == sorted(insights.r_mm)
    assert len(insights.sheath_z_mm_by_r) == nr
    for value in insights.sheath_z_mm_by_r:
        assert 0.0 <= value <= request.geometry.domain.z_max_mm

    _assert_1d_series(insights.r_mm)
    _assert_1d_series(insights.sheath_z_mm_by_r)

    if insights.sheath_thickness_mm_by_r is not None:
        assert len(insights.sheath_thickness_mm_by_r) == nr
        _assert_1d_series(insights.sheath_thickness_mm_by_r)
        for value in insights.sheath_thickness_mm_by_r:
            assert value >= 0.0

    if insights.E_on_sheath_by_r is not None:
        assert len(insights.E_on_sheath_by_r) == nr
        _assert_1d_series(insights.E_on_sheath_by_r)
        for value in insights.E_on_sheath_by_r:
            assert math.isfinite(value)
            assert value >= 0.0

    if insights.ne_on_sheath_by_r is not None:
        assert len(insights.ne_on_sheath_by_r) == nr
        _assert_1d_series(insights.ne_on_sheath_by_r)
        for value in insights.ne_on_sheath_by_r:
            assert -1e-9 <= value <= 1.0 + 1e-9


def test_viz_and_ion_proxy_present() -> None:
    payload = _poisson_request_payload()
    request = SimulationRequest.model_validate(payload)
    result = run_simulation_poisson_v1(request, "test")

    viz = result.viz
    assert viz is not None
    nr = request.geometry.domain.nr
    assert len(viz.r_mm) == nr
    assert len(viz.sheath_z_mm_by_r) == nr
    _assert_1d_series(viz.r_mm)
    _assert_1d_series(viz.sheath_z_mm_by_r)
    if viz.sheath_thickness_mm_by_r is not None:
        assert len(viz.sheath_thickness_mm_by_r) == nr
        _assert_1d_series(viz.sheath_thickness_mm_by_r)

    ion_proxy = result.ion_proxy
    assert ion_proxy is not None
    assert ion_proxy.ion_energy_proxy_rel_by_r is not None
    assert len(ion_proxy.ion_energy_proxy_rel_by_r) == nr
    _assert_1d_series(ion_proxy.ion_energy_proxy_rel_by_r)
    if ion_proxy.ion_flux_proxy_rel_by_r is not None:
        assert len(ion_proxy.ion_flux_proxy_rel_by_r) == nr
        _assert_1d_series(ion_proxy.ion_flux_proxy_rel_by_r)


def test_baseline_delta_viz_and_ion_proxy() -> None:
    payload = _poisson_request_payload()
    payload["baseline"]["enabled"] = True
    request = SimulationRequest.model_validate(payload)
    result = run_simulation_poisson_v1(request, "test")

    viz = result.viz
    assert viz is not None
    assert viz.delta_sheath_z_mm_by_r is not None
    assert len(viz.delta_sheath_z_mm_by_r) == request.geometry.domain.nr
    if viz.delta_sheath_thickness_mm_by_r is not None:
        assert len(viz.delta_sheath_thickness_mm_by_r) == request.geometry.domain.nr
        for value in viz.delta_sheath_thickness_mm_by_r:
            assert math.isfinite(value)

    compare = result.compare
    assert compare is not None
    assert compare.delta_ion_proxy is not None
    delta_ion = compare.delta_ion_proxy
    if delta_ion.ion_energy_proxy_rel_by_r is not None:
        assert len(delta_ion.ion_energy_proxy_rel_by_r) == request.geometry.domain.nr
        for value in delta_ion.ion_energy_proxy_rel_by_r:
            assert math.isfinite(value)
    if delta_ion.ion_flux_proxy_rel_by_r is not None:
        assert len(delta_ion.ion_flux_proxy_rel_by_r) == request.geometry.domain.nr
        for value in delta_ion.ion_flux_proxy_rel_by_r:
            assert math.isfinite(value)


def test_baseline_delta_insights() -> None:
    payload = _poisson_request_payload()
    payload["baseline"]["enabled"] = True
    request = SimulationRequest.model_validate(payload)
    result = run_simulation_poisson_v1(request, "test")

    compare = result.compare
    assert compare is not None
    assert compare.delta_insights is not None

    delta = compare.delta_insights
    nr = request.geometry.domain.nr
    assert len(delta.r_mm) == nr
    if delta.sheath_z_mm_by_r:
        assert len(delta.sheath_z_mm_by_r) == nr
    if delta.sheath_thickness_mm_by_r is not None:
        assert len(delta.sheath_thickness_mm_by_r) == nr
    if delta.E_on_sheath_by_r is not None:
        assert len(delta.E_on_sheath_by_r) == nr
        for value in delta.E_on_sheath_by_r:
            assert math.isfinite(value)
    if delta.ne_on_sheath_by_r is not None:
        assert len(delta.ne_on_sheath_by_r) == nr
        for value in delta.ne_on_sheath_by_r:
            assert math.isfinite(value)


def test_insights_warning_for_missing_powered_electrode() -> None:
    payload = _poisson_request_payload()
    payload["geometry"]["grid"]["region_legend"]["2"] = "plasma"
    request = SimulationRequest.model_validate(payload)
    result = run_simulation_poisson_v1(request, "test")

    metrics = result.sheath_metrics
    assert metrics is not None
    assert any("powered electrode" in msg for msg in metrics.warnings)

    insights = result.insights
    assert insights is not None
    assert any("powered electrode" in msg for msg in insights.warnings)


def test_insights_warns_when_ne_missing() -> None:
    payload = _poisson_request_payload()
    request = SimulationRequest.model_validate(payload)
    result = run_simulation_poisson_v1(request, "test")

    domain = request.geometry.domain
    r_values = [domain.r_max_mm * idx / (domain.nr - 1) for idx in range(domain.nr)]
    z_values = [domain.z_max_mm * idx / (domain.nz - 1) for idx in range(domain.nz)]

    fields = FieldGrid(E_mag=result.fields.E_mag, ne=None, emission=None)
    insights = compute_insights(request, fields, result.sheath_metrics, z_values, r_values)

    assert insights.ne_on_sheath_by_r is None
    assert any("ne field missing" in msg for msg in insights.warnings)


def test_cg_fallback_solves_spd() -> None:
    def matvec(vec):
        return [4.0 * vec[0] + 1.0 * vec[1], 1.0 * vec[0] + 3.0 * vec[1]]

    solution = cg_solve(matvec, [1.0, 2.0], tol=1e-12, maxiter=1000)
    assert abs(solution[0] - (1.0 / 11.0)) < 1e-6
    assert abs(solution[1] - (7.0 / 11.0)) < 1e-6


def test_transport_coefficients_are_positive() -> None:
    payload = _poisson_request_payload()
    request = SimulationRequest.model_validate(payload)
    coeff = derive_transport_coefficients(request)

    assert coeff.mu_e > 0.0
    assert coeff.D_e > 0.0
    assert coeff.Te_norm > 0.0
    assert coeff.Te_eV > 0.0
    assert coeff.k_s_wall > 0.0
    assert coeff.k_s_powered >= coeff.k_s_wall
    assert coeff.lambda_relax > 0.0


def test_te_estimate_increases_with_power_and_lower_pressure() -> None:
    high_payload = _poisson_request_payload()
    high_payload["process"]["pressure_Pa"] = 8.0
    high_payload["process"]["rf_power_W"] = 900.0
    high = SimulationRequest.model_validate(high_payload)

    low_payload = _poisson_request_payload()
    low_payload["process"]["pressure_Pa"] = 40.0
    low_payload["process"]["rf_power_W"] = 120.0
    low = SimulationRequest.model_validate(low_payload)

    assert estimate_te_eV(high) > estimate_te_eV(low)


def test_powered_boundary_voltage_tracks_power_pressure_and_gas() -> None:
    high_payload = _poisson_request_payload()
    high_payload["process"]["rf_power_W"] = 1500.0
    high_payload["process"]["pressure_Pa"] = 12.0
    high = SimulationRequest.model_validate(high_payload)

    low_payload = _poisson_request_payload()
    low_payload["process"]["rf_power_W"] = 120.0
    low_payload["process"]["pressure_Pa"] = 5_000.0
    low_payload["gas"]["mixture"] = [{"species": "SiH4", "fraction": 1.0}]
    low = SimulationRequest.model_validate(low_payload)

    assert derive_powered_boundary_voltage(high) > derive_powered_boundary_voltage(low)


def test_rf_sources_override_legacy_power_frequency_inputs() -> None:
    payload = _poisson_request_payload()
    payload["process"]["rf_power_W"] = 20.0
    payload["process"]["frequency_Hz"] = 1.0
    payload["process"]["rf_sources"] = [
        {
            "name": "hf",
            "surface_tag": None,
            "rf_power_W": 350.0,
            "frequency_Hz": 13_560_000.0,
            "phase_deg": 0.0,
        },
        {
            "name": "lf",
            "surface_tag": None,
            "rf_power_W": 250.0,
            "frequency_Hz": 2_000_000.0,
            "phase_deg": 180.0,
        },
    ]
    with_sources = SimulationRequest.model_validate(payload)

    legacy_payload = _poisson_request_payload()
    legacy_payload["process"]["rf_power_W"] = 20.0
    legacy_payload["process"]["frequency_Hz"] = 1.0
    legacy = SimulationRequest.model_validate(legacy_payload)

    assert estimate_te_eV(with_sources) > estimate_te_eV(legacy)


def test_ion_proxy_te_matches_estimator() -> None:
    payload = _poisson_request_payload()
    request = SimulationRequest.model_validate(payload)
    result = run_simulation_poisson_v1(request, "test")

    assert result.ion_proxy.Te_eV_used is not None
    assert math.isclose(result.ion_proxy.Te_eV_used, estimate_te_eV(request), rel_tol=1e-9, abs_tol=1e-9)


def test_pump_outlet_parameters_change_ne_solution() -> None:
    weak_payload = _poisson_request_payload()
    weak_payload["geometry"]["grid"]["tag_mask"]["bottom_pump"] = [
        [False, False, False, False],
        [False, False, False, False],
        [True, True, False, False],
        [False, False, False, False],
    ]
    weak_payload["flow_boundary"]["outlet"] = {
        "type": "sink",
        "surface_tag": "bottom_pump",
        "strength": 0.15,
        "throttle_percent": 20.0,
        "conductance_lps": 40.0,
        "target_pressure_Pa": 30.0,
    }

    strong_payload = _poisson_request_payload()
    strong_payload["geometry"]["grid"]["tag_mask"]["bottom_pump"] = [
        [False, False, False, False],
        [False, False, False, False],
        [True, True, False, False],
        [False, False, False, False],
    ]
    strong_payload["flow_boundary"]["outlet"] = {
        "type": "sink",
        "surface_tag": "bottom_pump",
        "strength": 2.0,
        "throttle_percent": 100.0,
        "conductance_lps": 320.0,
        "target_pressure_Pa": 5.0,
    }

    weak_request = SimulationRequest.model_validate(weak_payload)
    strong_request = SimulationRequest.model_validate(strong_payload)
    weak_result = run_simulation_poisson_v1(weak_request, "test")
    strong_result = run_simulation_poisson_v1(strong_request, "test")

    assert weak_result.metadata.ne_solver is not None
    assert strong_result.metadata.ne_solver is not None
    assert weak_result.metadata.ne_solver.bulk_loss is not None
    assert strong_result.metadata.ne_solver.bulk_loss is not None
    assert strong_result.metadata.ne_solver.bulk_loss > weak_result.metadata.ne_solver.bulk_loss

    weak_flat = [value for row in weak_result.fields.ne for value in row]
    strong_flat = [value for row in strong_result.fields.ne for value in row]
    max_delta = max(abs(a - b) for a, b in zip(weak_flat, strong_flat))
    assert max_delta > 1e-4


def test_inlet_direction_changes_ne_solution() -> None:
    inward_payload = _poisson_request_payload()
    inward_payload["flow_boundary"]["inlet"]["direction"] = "radial_inward"

    outward_payload = _poisson_request_payload()
    outward_payload["flow_boundary"]["inlet"]["direction"] = "radial_outward"

    inward_request = SimulationRequest.model_validate(inward_payload)
    outward_request = SimulationRequest.model_validate(outward_payload)
    inward_result = run_simulation_poisson_v1(inward_request, "test")
    outward_result = run_simulation_poisson_v1(outward_request, "test")

    inward_flat = [value for row in inward_result.fields.ne for value in row]
    outward_flat = [value for row in outward_result.fields.ne for value in row]
    max_delta = max(abs(a - b) for a, b in zip(inward_flat, outward_flat))
    assert max_delta > 1e-4


def test_inlet_emit_side_changes_ne_solution() -> None:
    left_payload = _poisson_request_payload()
    left_payload["geometry"]["grid"]["tag_mask"]["showerhead"] = [
        [False, False, False, False],
        [False, False, False, False],
        [False, False, False, False],
        [True, True, True, True],
    ]
    left_payload["flow_boundary"]["inlet"]["emit_side"] = "left"
    left_payload["flow_boundary"]["inlet"]["active_width_percent"] = 45.0

    right_payload = _poisson_request_payload()
    right_payload["geometry"]["grid"]["tag_mask"]["showerhead"] = [
        [False, False, False, False],
        [False, False, False, False],
        [False, False, False, False],
        [True, True, True, True],
    ]
    right_payload["flow_boundary"]["inlet"]["emit_side"] = "right"
    right_payload["flow_boundary"]["inlet"]["active_width_percent"] = 45.0

    left_request = SimulationRequest.model_validate(left_payload)
    right_request = SimulationRequest.model_validate(right_payload)
    left_result = run_simulation_poisson_v1(left_request, "test")
    right_result = run_simulation_poisson_v1(right_request, "test")

    left_flat = [value for row in left_result.fields.ne for value in row]
    right_flat = [value for row in right_result.fields.ne for value in row]
    max_delta = max(abs(a - b) for a, b in zip(left_flat, right_flat))
    assert max_delta > 1e-4


def test_rf_power_decade_changes_ne_solution() -> None:
    low_payload = _poisson_request_payload()
    low_payload["process"]["rf_power_W"] = 500.0

    high_payload = _poisson_request_payload()
    high_payload["process"]["rf_power_W"] = 5000.0

    low_request = SimulationRequest.model_validate(low_payload)
    high_request = SimulationRequest.model_validate(high_payload)
    low_result = run_simulation_poisson_v1(low_request, "test")
    high_result = run_simulation_poisson_v1(high_request, "test")

    low_flat = [value for row in low_result.fields.ne for value in row]
    high_flat = [value for row in high_result.fields.ne for value in row]
    max_delta = max(abs(a - b) for a, b in zip(low_flat, high_flat))
    assert max_delta > 1e-3
    assert sum(high_flat) > sum(low_flat)


def test_rf_frequency_changes_ne_solution() -> None:
    low_freq_payload = _poisson_request_payload()
    low_freq_payload["process"]["frequency_Hz"] = 2_000_000.0

    high_freq_payload = _poisson_request_payload()
    high_freq_payload["process"]["frequency_Hz"] = 40_000_000.0

    low_request = SimulationRequest.model_validate(low_freq_payload)
    high_request = SimulationRequest.model_validate(high_freq_payload)
    low_result = run_simulation_poisson_v1(low_request, "test")
    high_result = run_simulation_poisson_v1(high_request, "test")

    low_flat = [value for row in low_result.fields.ne for value in row]
    high_flat = [value for row in high_result.fields.ne for value in row]
    max_delta = max(abs(a - b) for a, b in zip(low_flat, high_flat))
    assert max_delta > 1e-4


def test_dc_bias_changes_boundary_and_ne_solution() -> None:
    base_payload = _poisson_request_payload()
    base_payload["process"]["dc_bias_V"] = 0.0

    dc_payload = _poisson_request_payload()
    dc_payload["process"]["dc_bias_V"] = -1200.0

    base_request = SimulationRequest.model_validate(base_payload)
    dc_request = SimulationRequest.model_validate(dc_payload)

    _, base_dirichlet = build_dirichlet_mask_values(
        base_request,
        powered_voltage=derive_powered_boundary_voltage(base_request),
        dc_offset=derive_dc_bias_offset(base_request),
    )
    _, dc_dirichlet = build_dirichlet_mask_values(
        dc_request,
        powered_voltage=derive_powered_boundary_voltage(dc_request),
        dc_offset=derive_dc_bias_offset(dc_request),
    )
    assert dc_dirichlet[0][0] < base_dirichlet[0][0]

    base_result = run_simulation_poisson_v1(base_request, "test")
    dc_result = run_simulation_poisson_v1(dc_request, "test")
    base_flat = [value for row in base_result.fields.ne for value in row]
    dc_flat = [value for row in dc_result.fields.ne for value in row]
    max_delta = max(abs(a - b) for a, b in zip(base_flat, dc_flat))
    assert max_delta > 1e-4


def test_power_absorption_density_spreads_across_geometry_tags_not_only_pump() -> None:
    payload = _pad_request_payload()
    request = SimulationRequest.model_validate(payload)
    result = run_simulation_poisson_v1(request, "test")

    assert result.fields is not None
    pad_field = result.fields.volume_loss_density
    assert pad_field is not None

    masks = payload["geometry"]["grid"]["tag_mask"]
    powered_mean = _tag_mean(pad_field, masks["powered_electrode_surface"])
    dielectric_mean = _tag_mean(pad_field, masks["dielectric_block"])
    pump_mean = _tag_mean(pad_field, masks["bottom_pump"])

    assert powered_mean > 0.0
    assert dielectric_mean > 0.0
    assert pump_mean <= 1e-12


def test_power_absorption_density_respects_material_overrides() -> None:
    low_payload = _pad_request_payload()
    low_payload["material"]["regions"] = [
        {"target_tag": "dielectric_block", "epsilon_r": 2.5, "wall_loss_e": 0.1}
    ]
    high_payload = copy.deepcopy(low_payload)
    high_payload["material"]["regions"] = [
        {"target_tag": "dielectric_block", "epsilon_r": 8.0, "wall_loss_e": 0.8}
    ]

    low_request = SimulationRequest.model_validate(low_payload)
    high_request = SimulationRequest.model_validate(high_payload)
    low_result = run_simulation_poisson_v1(low_request, "test-low")
    high_result = run_simulation_poisson_v1(high_request, "test-high")

    assert low_result.fields is not None and low_result.fields.volume_loss_density is not None
    assert high_result.fields is not None and high_result.fields.volume_loss_density is not None

    mask = low_payload["geometry"]["grid"]["tag_mask"]["dielectric_block"]
    low_mean = _tag_mean(low_result.fields.volume_loss_density, mask)
    high_mean = _tag_mean(high_result.fields.volume_loss_density, mask)
    assert high_mean > low_mean
