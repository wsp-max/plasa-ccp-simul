import React from "react";

type TheoryPageProps = {
  onBackToSimulator: () => void;
};

const TheoryPage = ({ onBackToSimulator }: TheoryPageProps) => {
  return (
    <div className="theory-page">
      <header className="theory-header">
        <div>
          <h2>Applied Theory: Reduced CCP Fluid Model</h2>
          <p>
            This simulator is designed for fast trend analysis on 2D axisymmetric RF
            CCP reactors, not absolute process calibration.
          </p>
        </div>
        <button type="button" className="ghost-button theory-back" onClick={onBackToSimulator}>
          Back to Simulator
        </button>
      </header>

      <section className="theory-grid">
        <article className="theory-card">
          <h3>Electrostatics</h3>
          <p>
            Electric potential is solved on an r-z grid with a permittivity-aware
            Poisson equation:
          </p>
          <pre>{"div(epsilon * grad(phi)) = 0"}</pre>
          <p>
            Powered electrodes use RF-driven Dirichlet boundaries. Grounded
            electrodes and solids are pinned/handled as non-plasma boundaries.
          </p>
        </article>

        <article className="theory-card">
          <h3>Electron Transport (SG)</h3>
          <p>
            Electron continuity uses steady drift-diffusion with
            Scharfetter-Gummel face fluxes for robust sheath gradients:
          </p>
          <pre>{"div(Gamma_e) = S_ion - S_loss,   Gamma_e = -mu_e * n_e * grad(phi) - D_e * grad(n_e)"}</pre>
          <p>
            Transport coefficients are pressure/gas/power dependent through a
            reduced empirical model to keep runtime low. Local source/loss terms
            also include inlet-feed and pump-exhaust influence maps.
          </p>
        </article>

        <article className="theory-card">
          <h3>RF / Gas / Flow Coupling</h3>
          <p>
            Multi-source RF is collapsed into effective drive terms (power,
            frequency, phase coherence). DC bias is added as a powered-boundary
            offset. Gas mixture affects ionization,
            attachment, mobility, and effective Te.
          </p>
          <ul>
            <li>RF sources: weighted effective drive + coherence/spread factor</li>
            <li>DC bias: additional powered-electrode offset and sheath-coupling trend gain</li>
            <li>Gas mix: species-weighted ionization and transport factors</li>
            <li>Pump ports: throttle, conductance, target pressure, strength</li>
            <li>Inlet: selectable surface tag + direction + emit side + active width</li>
            <li>Localized inlet source map: only selected showerhead segment emits source</li>
            <li>Local density balance: feed/exhaust ratio and convective sink are applied per cell</li>
          </ul>
        </article>
      </section>

      <section className="theory-grid">
        <article className="theory-card">
          <h3>Sheath and Ion Trend Proxies</h3>
          <p>
            Sheath edge is extracted from potential drop criteria. Relative ion
            energy is estimated from sheath-to-electrode potential drop.
          </p>
          <pre>{"Gamma_i,rel ~ n_e,sheath * sqrt(Te / Mi)"}</pre>
          <p>
            This Bohm-style proxy is for radial trend comparison, not absolute ion
            flux certification.
          </p>
        </article>

        <article className="theory-card">
          <h3>Density Mapping for Stable Compare</h3>
          <p>
            Raw ne is converted to a bounded observable (0..1) with a request-level
            transfer curve so A/B legend locking remains meaningful.
          </p>
          <pre>{"ne_obs = ne_raw / (ne_raw + n_sat(request))"}</pre>
          <p>
            Saturation scale depends on pressure, gas factors, inlet flow, and pump
            strength.
          </p>
        </article>

        <article className="theory-card">
          <h3>Power Absorption Density (per volume)</h3>
          <p>
            The field previously exposed as <code>volume_loss_density</code> is interpreted as
            geometry-local absorbed power density per unit volume (relative), not a material
            "volume loss" term.
          </p>
          <pre>{"PAD_rel ~ |E_interface|_rel^2 * g_plasma(ne_near) * g_material(eps_r, wall_loss) * g_source * g_sink * g(RF,f,Vdc)"}</pre>
          <p>
            It is evaluated only on explicit geometry-tag regions (excluding chamber/common
            regions). Pump/outlet tags are excluded from absorbed-power display, so
            non-RF-contact exhaust regions do not inflate power maps.
          </p>
          <p>
            Interface coupling uses nearby-field sampling around each geometry cell, so
            conductive bodies with near-surface high field do not collapse to zero solely
            because their interior electric field is small.
          </p>
          <p>
            In Simulator/Compare maps, this layer is rendered with log-scale color mapping
            using each result's raw min/max range, with color intervals spaced in log
            domain for wide dynamic-range visibility.
          </p>
        </article>

        <article className="theory-card">
          <h3>Added Lightweight Density Physics</h3>
          <p>
            To improve visible density response without heavy runtime cost, the model
            applies extra local gains/losses on the ionization source term.
          </p>
          <ul>
            <li>Local feed-exhaust gain: inlet influence up, pump influence down</li>
            <li>Attachment-aware damping: electronegative mixtures increase local losses</li>
            <li>Frequency sheath-coupling gain: higher f shifts source toward sheath/edge trend</li>
            <li>DC sheath gain: |Vdc| and polarity modulate source/loss trend without heavy runtime</li>
            <li>Nonlinear E-source gain: stronger density response to RF power/frequency shifts</li>
          </ul>
        </article>

        <article className="theory-card">
          <h3>Frequency Trend Physics (Lightweight)</h3>
          <p>
            Frequency-dependent radial/axial gain profiles are applied to ionization
            source terms to capture practical CCP trend changes without heavy runtime.
          </p>
          <ul>
            <li>Higher frequency: stronger near-boundary coupling trend</li>
            <li>Lower frequency: deeper bulk coupling tendency</li>
            <li>Implemented as precomputed profile multipliers for speed</li>
          </ul>
        </article>

      </section>

      <section className="theory-card">
        <h3>Modeling Scope</h3>
        <ul>
          <li>Primary purpose: fast parametric what-if and A/B comparison.</li>
          <li>Includes practical knobs: RF, gas, pump, geometry, inlet direction/side.</li>
          <li>Not a full kinetic/chemistry/3D electromagnetic solver.</li>
        </ul>
      </section>

      <section className="theory-card">
        <h3>Default Reference Case on Load</h3>
        <ul>
          <li>300 mm CCP chamber, showerhead + top RF + grounded stage</li>
          <li>RF source: 500 W at 13.56 MHz</li>
          <li>Gas: CVD preset Ar 5000 / SiH4 200 sccm (editable)</li>
          <li>Pressure: 5 Torr, electrode gap: 5 mm baseline</li>
        </ul>
      </section>

      <section className="theory-card">
        <h3>Primary References</h3>
        <ul className="ref-list">
          <li>
            <a
              href="https://pmc.ncbi.nlm.nih.gov/articles/PMC4887238/"
              target="_blank"
              rel="noreferrer"
            >
              GEC RF Reference Cell design and standard operating range
            </a>
          </li>
          <li>
            <a
              href="https://doc.comsol.com/6.3/doc/com.comsol.help.models.plasma.ccp_benchmark/ccp_benchmark.html"
              target="_blank"
              rel="noreferrer"
            >
              CCP benchmark setup (13.56 MHz drift-diffusion framework)
            </a>
          </li>
          <li>
            <a
              href="https://www.sciencedirect.com/science/article/pii/S0021999122002583"
              target="_blank"
              rel="noreferrer"
            >
              Scharfetter-Gummel-based schemes for gas discharge modeling
            </a>
          </li>
          <li>
            <a
              href="https://pubmed.ncbi.nlm.nih.gov/17748002/"
              target="_blank"
              rel="noreferrer"
            >
              Bohm criterion foundations for sheath-entry ion flow
            </a>
          </li>
        </ul>
      </section>
    </div>
  );
};

export default TheoryPage;
