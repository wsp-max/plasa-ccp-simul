# Process Preset Library (Literature / Industry Inspired)

These presets are starting windows for trend simulations. Values are simplified to fit this simulator's gas/species and control model.

| Preset ID | Purpose | Reference |
|---|---|---|
| `pecvd-hp-ncsi` | High-pressure PECVD nc-Si:H (SiH4/Ar/H2) | Thin Solid Films / high-pressure PECVD SiH4-Ar-H2 window (2-8 Torr, 13.56 MHz): https://www.sciencedirect.com/science/article/abs/pii/S0040609000016035 |
| `pecvd-sinx` | SiNx:H deposition (SiH4/NH3/N2) | Microelectronics Reliability 50 (2010), PECVD SiNx:H using SiH4/NH3/N2: https://www.sciencedirect.com/science/article/abs/pii/S0026271410001836 |
| `pecvd-sio2` | SiO2 deposition (SiH4/Ar/N2O) | Thin Solid Films 797 (2024), SiH4/Ar/N2O PECVD SiO2: https://www.sciencedirect.com/science/article/abs/pii/S0040609024001494 |
| `dfccp-60-13` | Dual-frequency etch-like mode (60/13.56 MHz) | JVST A dual-frequency CCP etch study: https://doi.org/10.1116/1.4973299 |
| `dfccp-13-2` | Dual-frequency mode (13.56/2 MHz) | Vacuum dual-frequency plasma characterization: https://www.sciencedirect.com/science/article/abs/pii/S0042207X19308048 |
| `etch-ar-o2` | Ar/O2 etch/ash low-pressure mode | Dual-frequency Ar/O2 etch framework: https://arxiv.org/abs/2411.03146 |
| `o2-ashing` | O2-rich photoresist ashing template | Industrial O2 plasma ashing window reference: https://piescientific.com/Resource_pages/Resource_photoresist_ashing/ |
| `nitridation-n2-h2` | N2/H2 activation template | Industrial CCP pre-clean/activation operating window (vendor/application-note class) |

> Note: Final production recipes must be validated with chamber-specific hardware, diagnostics, and qualified simulation/metrology.
