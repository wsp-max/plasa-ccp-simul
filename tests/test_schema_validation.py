"""Schema validation tests for simulation requests."""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from schemas import SimulationRequest, SimulationResponse


def _base_request() -> dict:
    return {
        "meta": {"request_id": "test"},
        "geometry": {
            "axisymmetric": True,
            "coordinate_system": "r-z",
            "domain": {"r_max_mm": 100.0, "z_max_mm": 200.0, "nr": 4, "nz": 4},
            "tags": ["showerhead", "bottom_pump", "liner", "powered_electrode_surface"],
            "grid": {
                "schema": "mask_v1",
                "nr": 4,
                "nz": 4,
                "region_id": [
                    [0, 0, 1, 1],
                    [0, 0, 1, 1],
                    [2, 2, 1, 1],
                    [2, 2, 1, 1],
                ],
                "region_legend": {
                    "0": "plasma",
                    "1": "solid_wall",
                    "2": "powered_electrode",
                },
                "tag_mask": {
                    "showerhead": [
                        [True, True, False, False],
                        [True, True, False, False],
                        [False, False, False, False],
                        [False, False, False, False],
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
            "wall_temperature_K": 300.0,
        },
        "material": {
            "default": {"epsilon_r": 3.9, "wall_loss_e": 0.2},
            "regions": [],
        },
        "impedance": {"delta_percent": 5.0},
        "baseline": {"enabled": False},
    }


def test_valid_request_passes() -> None:
    payload = _base_request()
    SimulationRequest.model_validate(payload)


def test_gas_mixture_must_sum_to_one() -> None:
    payload = _base_request()
    payload["gas"]["mixture"] = [
        {"species": "Ar", "fraction": 0.5},
        {"species": "O2", "fraction": 0.4},
    ]
    with pytest.raises(ValidationError):
        SimulationRequest.model_validate(payload)


def test_pressure_must_be_positive() -> None:
    payload = _base_request()
    payload["process"]["pressure_Pa"] = 0.0
    with pytest.raises(ValidationError):
        SimulationRequest.model_validate(payload)


def test_geometry_domain_requires_positive_extents() -> None:
    payload = _base_request()
    payload["geometry"]["domain"]["r_max_mm"] = 0.0
    with pytest.raises(ValidationError):
        SimulationRequest.model_validate(payload)


def test_material_constraints() -> None:
    payload = _base_request()
    payload["material"]["default"]["epsilon_r"] = 0.0
    with pytest.raises(ValidationError):
        SimulationRequest.model_validate(payload)

    payload = _base_request()
    payload["material"]["default"]["wall_loss_e"] = 1.5
    with pytest.raises(ValidationError):
        SimulationRequest.model_validate(payload)


def test_impedance_delta_percent_range() -> None:
    payload = _base_request()
    payload["impedance"]["delta_percent"] = 120.0
    with pytest.raises(ValidationError):
        SimulationRequest.model_validate(payload)


def test_rf_power_and_frequency_constraints() -> None:
    payload = _base_request()
    payload["process"]["rf_power_W"] = -1.0
    with pytest.raises(ValidationError):
        SimulationRequest.model_validate(payload)

    payload = _base_request()
    payload["process"]["frequency_Hz"] = 0.0
    with pytest.raises(ValidationError):
        SimulationRequest.model_validate(payload)


def test_dc_bias_is_bounded() -> None:
    payload = _base_request()
    payload["process"]["dc_bias_V"] = -1200.0
    SimulationRequest.model_validate(payload)

    low_payload = _base_request()
    low_payload["process"]["dc_bias_V"] = -6000.0
    with pytest.raises(ValidationError):
        SimulationRequest.model_validate(low_payload)

    high_payload = _base_request()
    high_payload["process"]["dc_bias_V"] = 6000.0
    with pytest.raises(ValidationError):
        SimulationRequest.model_validate(high_payload)


def test_rf_sources_accepts_up_to_three_sources() -> None:
    payload = _base_request()
    payload["process"]["rf_sources"] = [
        {
            "name": "src-1",
            "surface_tag": "powered_electrode_surface",
            "rf_power_W": 200.0,
            "frequency_Hz": 13_560_000.0,
            "phase_deg": 0.0,
        },
        {
            "name": "src-2",
            "surface_tag": "powered_electrode_surface",
            "rf_power_W": 150.0,
            "frequency_Hz": 2_000_000.0,
            "phase_deg": 90.0,
        },
        {
            "name": "src-3",
            "surface_tag": None,
            "rf_power_W": 50.0,
            "frequency_Hz": 400_000.0,
            "phase_deg": -45.0,
        },
    ]
    SimulationRequest.model_validate(payload)


def test_rf_sources_rejects_more_than_three_sources() -> None:
    payload = _base_request()
    payload["process"]["rf_sources"] = [
        {
            "name": f"src-{idx}",
            "surface_tag": "powered_electrode_surface",
            "rf_power_W": 100.0,
            "frequency_Hz": 13_560_000.0,
            "phase_deg": 0.0,
        }
        for idx in range(4)
    ]
    with pytest.raises(ValidationError):
        SimulationRequest.model_validate(payload)


def test_rf_source_tag_must_exist_in_geometry_tags() -> None:
    payload = _base_request()
    payload["process"]["rf_sources"] = [
        {
            "name": "src-1",
            "surface_tag": "missing_powered_tag",
            "rf_power_W": 100.0,
            "frequency_Hz": 13_560_000.0,
            "phase_deg": 0.0,
        }
    ]
    with pytest.raises(ValidationError):
        SimulationRequest.model_validate(payload)


def test_uniform_must_be_true() -> None:
    payload = _base_request()
    payload["flow_boundary"]["inlet"]["uniform"] = False
    with pytest.raises(ValidationError):
        SimulationRequest.model_validate(payload)


def test_inlet_direction_must_be_known_literal() -> None:
    payload = _base_request()
    payload["flow_boundary"]["inlet"]["direction"] = "invalid-direction"
    with pytest.raises(ValidationError):
        SimulationRequest.model_validate(payload)


def test_inlet_emit_side_must_be_known_literal() -> None:
    payload = _base_request()
    payload["flow_boundary"]["inlet"]["emit_side"] = "invalid-side"
    with pytest.raises(ValidationError):
        SimulationRequest.model_validate(payload)


def test_inlet_active_width_percent_is_bounded() -> None:
    low_payload = _base_request()
    low_payload["flow_boundary"]["inlet"]["active_width_percent"] = 4.9
    with pytest.raises(ValidationError):
        SimulationRequest.model_validate(low_payload)

    high_payload = _base_request()
    high_payload["flow_boundary"]["inlet"]["active_width_percent"] = 101.0
    with pytest.raises(ValidationError):
        SimulationRequest.model_validate(high_payload)


def test_surface_tag_required() -> None:
    payload = _base_request()
    payload["flow_boundary"]["inlet"]["surface_tag"] = ""
    with pytest.raises(ValidationError):
        SimulationRequest.model_validate(payload)


def test_flow_boundary_accepts_multiple_outlets() -> None:
    payload = _base_request()
    payload["geometry"]["tags"] = [
        "showerhead",
        "bottom_pump",
        "side_pump",
        "liner",
        "powered_electrode_surface",
    ]
    payload["flow_boundary"] = {
        "inlet": {
            "type": "surface",
            "surface_tag": "showerhead",
            "uniform": True,
            "total_flow_sccm": 10.0,
        },
        "outlets": [
            {
                "type": "sink",
                "surface_tag": "bottom_pump",
                "strength": 1.0,
                "throttle_percent": 85.0,
                "conductance_lps": 220.0,
                "target_pressure_Pa": 8.0,
            },
            {
                "type": "sink",
                "surface_tag": "side_pump",
                "strength": 0.6,
                "throttle_percent": 72.0,
                "conductance_lps": 180.0,
                "target_pressure_Pa": 10.0,
            },
        ],
    }
    SimulationRequest.model_validate(payload)


def test_flow_boundary_rejects_outlet_and_outlets_together() -> None:
    payload = _base_request()
    payload["flow_boundary"]["outlets"] = [
        {"type": "sink", "surface_tag": "bottom_pump", "strength": 1.0}
    ]
    with pytest.raises(ValidationError):
        SimulationRequest.model_validate(payload)


def test_flow_boundary_outlets_tag_must_exist() -> None:
    payload = _base_request()
    payload["flow_boundary"] = {
        "inlet": {
            "type": "surface",
            "surface_tag": "showerhead",
            "uniform": True,
            "total_flow_sccm": 10.0,
        },
        "outlets": [
            {"type": "sink", "surface_tag": "ghost_pump", "strength": 0.8},
        ],
    }
    with pytest.raises(ValidationError):
        SimulationRequest.model_validate(payload)


def test_legacy_payload_still_validates() -> None:
    payload = _base_request()
    payload["flow_boundary"] = {
        "inlet_sccm": 10.0,
        "outlet_pressure_Pa": 12.0,
        "wall_temperature_K": 300.0,
    }
    payload["material"] = {"epsilon_r": 3.9, "wall_loss_e": 0.2}
    SimulationRequest.model_validate(payload)


def test_material_regions_require_override() -> None:
    payload = _base_request()
    payload["material"]["regions"] = [{"target_tag": "liner"}]
    with pytest.raises(ValidationError):
        SimulationRequest.model_validate(payload)


def test_flow_boundary_tag_must_exist_in_geometry_tags() -> None:
    payload = _base_request()
    payload["geometry"]["tags"] = ["bottom_pump", "showerhead"]
    payload["flow_boundary"]["inlet"]["surface_tag"] = "missing_tag"
    with pytest.raises(ValidationError):
        SimulationRequest.model_validate(payload)


def test_material_region_tag_must_exist_in_geometry_tags() -> None:
    payload = _base_request()
    payload["geometry"]["tags"] = ["liner", "bottom_pump", "showerhead"]
    payload["material"]["regions"] = [{"target_tag": "ghost", "epsilon_r": 4.2}]
    with pytest.raises(ValidationError):
        SimulationRequest.model_validate(payload)


def test_geometry_grid_shape_mismatch() -> None:
    payload = _base_request()
    payload["geometry"]["grid"]["region_id"] = payload["geometry"]["grid"]["region_id"][:-1]
    with pytest.raises(ValidationError):
        SimulationRequest.model_validate(payload)


def test_region_id_requires_legend() -> None:
    payload = _base_request()
    payload["geometry"]["grid"]["region_id"][0][0] = 99
    with pytest.raises(ValidationError):
        SimulationRequest.model_validate(payload)


def test_tag_mask_shape_mismatch() -> None:
    payload = _base_request()
    payload["geometry"]["grid"]["tag_mask"]["showerhead"] = [
        [True, False],
        [False, True],
    ]
    with pytest.raises(ValidationError):
        SimulationRequest.model_validate(payload)


def test_tag_mask_requires_known_tag() -> None:
    payload = _base_request()
    payload["geometry"]["grid"]["tag_mask"] = {
        "ghost": [
            [True, True, False, False],
            [True, True, False, False],
            [False, False, False, False],
            [False, False, False, False],
        ]
    }
    with pytest.raises(ValidationError):
        SimulationRequest.model_validate(payload)


def test_response_with_insights_validates() -> None:
    request = SimulationRequest.model_validate(_base_request())

    metadata = {
        "request_id": "resp-test",
        "eta": 0.95,
        "geometry": request.geometry.model_dump(),
        "process": request.process.model_dump(),
        "gas": request.gas.model_dump(),
        "flow_boundary": request.flow_boundary.model_dump(),
        "material": request.material.model_dump(),
        "impedance": request.impedance.model_dump(),
    }
    grid = {"r_mm": [0.0, 1.0], "z_mm": [0.0, 1.0]}
    sheath = {
        "polyline_mm": [
            {"r_mm": 0.0, "z_mm": 0.2},
            {"r_mm": 1.0, "z_mm": 0.3},
        ],
        "mask": [[True, True], [False, False]],
    }
    insights = {
        "r_mm": [0.0, 1.0],
        "sheath_z_mm_by_r": [0.2, 0.3],
        "sheath_thickness_mm_by_r": [0.2, 0.3],
        "E_on_sheath_by_r": [1.0, 1.1],
        "ne_on_sheath_by_r": [0.5, 0.6],
        "summary": {"e_on_sheath_mean": 1.05, "thickness_mean_mm": 0.25},
        "warnings": [],
    }
    delta_insights = {
        "r_mm": [0.0, 1.0],
        "sheath_z_mm_by_r": [0.01, 0.02],
        "sheath_thickness_mm_by_r": [0.01, 0.02],
        "E_on_sheath_by_r": [0.1, 0.1],
        "ne_on_sheath_by_r": [0.02, 0.02],
        "summary": {"e_on_sheath_mean": 0.1, "thickness_mean_mm": 0.02},
        "warnings": [],
    }

    viz = {
        "r_mm": [0.0, 1.0],
        "sheath_z_mm_by_r": [0.2, 0.3],
        "sheath_thickness_mm_by_r": [0.2, 0.3],
        "delta_sheath_z_mm_by_r": [0.01, 0.02],
        "delta_sheath_thickness_mm_by_r": [0.01, 0.02],
        "warnings": [],
    }
    ion_proxy = {
        "ion_energy_proxy_rel_by_r": [0.1, 0.2],
        "ion_flux_proxy_rel_by_r": [0.01, 0.02],
        "Te_eV_used": 3.0,
        "Mi_amu_used": 40.0,
        "warnings": [],
    }
    response = {
        "request_id": "resp-test",
        "stored": False,
        "size_bytes": 123,
        "result": {
            "metadata": metadata,
            "grid": grid,
            "sheath": sheath,
            "insights": insights,
            "viz": viz,
            "ion_proxy": ion_proxy,
            "compare": {"enabled": True, "delta_insights": delta_insights},
        },
        "storage": {"backend": "inline"},
    }

    SimulationResponse.model_validate(response)
