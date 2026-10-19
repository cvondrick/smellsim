// In-app explanation of the physics, chemistry and sensor models.

export const HELP_HTML = /* html */ `
<h2 style="font-size:18px;color:#e6edf3;text-transform:none;letter-spacing:0">How smell moves, and what an e-nose sees</h2>
<p>This is a sealed room. Odor molecules are released from objects, carried by air currents, spread by turbulence,
and slowly removed by chemistry, surfaces and filters. A simulated Cyranose 320 samples the air at its snout.</p>

<h3>1. Getting smell into the air</h3>
<p>Every object has a <b>headspace</b>: the vapor concentration right at its surface (thousands of ppm of ethanol over
wine, a few ppb of geosmin over moss, almost nothing over glass or steel). Emission follows a mass-transfer law
<i>Q = k<sub>m</sub> A C<sub>headspace</sub></i>: airflow over the surface thins the boundary layer and raises
<i>k<sub>m</sub></i>, so a fan makes coffee smell stronger across the room. Some sources deplete (a cooling drink,
a drying spill) and some spray in puffs.</p>

<h3>2. How smell travels</h3>
<ul>
<li><b>Advection</b> dominates. Air is solved as an incompressible fluid on a voxel grid (stable fluids:
semi-Lagrangian advection + pressure projection) with walls, furniture, fans, ceiling fans, HVAC loops and purifiers.</li>
<li><b>Buoyancy</b>: heaters, candles, hot drinks and people (about 80 W each) make warm plumes that rise,
spread under the ceiling and stratify the room.</li>
<li><b>Turbulence</b> stirs and stretches plumes into filaments. Odor reaches a sniffer as intermittent bursts,
not a smooth gradient. Unresolved eddies are added as random swirls plus vorticity confinement.</li>
<li><b>Molecular diffusion</b> is tiny (about 0.1 cm<sup>2</sup>/s, so roughly 1 cm per second and only about
10 cm in a minute). On its own it would take hours to cross a room. Real rooms mix in minutes because the air moves.</li>
<li><b>People</b> walk on paths through the room, dragging wakes, adding body heat, breath humidity and
bioeffluents (acetone, isoprene, acids).</li>
</ul>

<h3>3. How smell decays in a closed room</h3>
<p>Dilution only spreads odor out. The total amount stays in the air unless something removes it:</p>
<ul>
<li><b>Ozone chemistry</b>: terpenes (limonene, pinene, linalool) react with indoor ozone over hours
(raise ozone in Room settings to speed it up).</li>
<li><b>Surface uptake</b>: sticky molecules (acids, amines, ammonia, vanillin, geosmin) sorb onto walls and fabric.</li>
<li><b>Filters</b>: activated carbon captures large organics well and small polar molecules poorly. HEPA filters
stop particles but <i>not</i> gases.</li>
</ul>
<p>Each compound decays at its own rate, so an aging plume changes character. The source legend shows the budget:
emitted = airborne + decayed + filtered.</p>

<h3>4. Human olfaction (for comparison)</h3>
<p>About 400 receptor types in the nose each respond to many odorants, and each odorant activates several receptors.
Odor identity is a combinatorial pattern across glomeruli in the olfactory bulb. Sensitivity varies enormously:
trimethylamine (fish) is noticed at about 30 ppt, while acetone needs about 40 ppm. The <i>Human nose</i> view shows the
odor activity value (concentration / threshold). Perceived intensity grows roughly logarithmically and
<b>adapts</b>: a constant smell fades within minutes.</p>

<h3>5. The Cyranose 320 e-nose</h3>
<p>The handheld Cyranose (Caltech/JPL technology, commercialized by Cyrano Sciences, now Sensigent) has 32
chemiresistors. Each one is carbon black dispersed in a different insulating polymer. Vapor partitions into the
polymer (<i>K</i> from linear solvation energy relationships), the film swells, conductive paths break (percolation),
and resistance rises. No single sensor identifies a compound; the <b>pattern</b> across all 32 does, much like
receptors in the nose.</p>
<ul>
<li><b>Measurement cycle</b>: a <span style="color:#ffd166">baseline</span> is drawn through the side inlet
(ambient air near the body), then a <span style="color:#4cf2ff">sample</span> through the snout tip, then a purge.
Tubing and the sensor chamber smooth and delay the signal; polymers respond in about 1 to 5 s.</li>
<li><b>Raw signal</b>: a 32 x T matrix of resistances (the heatmap).</li>
<li><b>Smellprint</b>: S<sub>i</sub> = (R<sub>max,i</sub> - R<sub>0,i</sub>) / R<sub>0,i</sub> from Savitzky-Golay
smoothed traces. R<sub>0</sub> is the baseline mean and R<sub>max</sub> is the sample peak.</li>
<li><b>PCA</b> of normalized, autoscaled smellprints shows which captures look alike.</li>
<li><b>Sensor model</b>: by default the 32 channels are fitted to the real Cyranose unit in the New York Smells
dataset. Every 4th channel (S3, S7, ...) is a non-sensing position on that unit, humidity dominates the real signal,
and inlet offsets and slow wander are drawn from real recordings. A literature polymer set is available as an alternative.</li>
<li><b>Confounds</b> are realistic. Water vapor swells hydrophilic polymers, so humid sources (coffee steam, plants,
a humidifier) can dominate the pattern. Faint materials give responses near the noise floor unless the snout almost
touches them. The PID reading (total VOC) is shown for comparison.</li>
</ul>

<h3>Controls</h3>
<p><span class="kbd">Space</span> run a measurement, <span class="kbd">L</span> live sniff, <span class="kbd">P</span> pause,
<span class="kbd">T</span> select the e-nose. Click objects to edit, <span class="kbd">R</span> rotate, <span class="kbd">Del</span> delete.
In walk mode: <span class="kbd">WASD</span> move, mouse look, scroll changes arm reach.</p>
<p class="muted" style="font-size:11px">Compound properties, polymer coefficients and headspace values are approximate, chosen
for plausible relative behavior. They are not calibrated to a specific instrument.</p>
`;
