# Research notes: smell transport, olfaction, and the Cyranose 320

These notes summarize the background reading behind the simulator and how each idea maps onto the
code. Numbers are order-of-magnitude values meant to keep the simulation physically plausible, not
calibrated constants.

## 1. How odor gets into the air

- An object's **headspace** is the vapor concentration right at its surface. For volatile liquids it
  approaches the saturation vapor pressure scaled by mole fraction and activity (Raoult/Henry):
  thousands of ppm of ethanol over wine, tens of ppm of limonene over citrus peel. Solids and dry
  materials (wood, paper, plastics, fabric) off-gas sub-ppm levels; metals and glass are essentially
  odorless (the "metallic" smell of brass is skin lipids oxidized to 1-octen-3-one).
- Emission into the room is limited by the boundary layer over the surface:
  `Q = k_m * A * C_headspace`, with `k_m` of order mm/s in still air that grows with air speed
  (roughly with the square root of velocity for laminar boundary layers). A fan blowing over coffee
  raises its emission rate.
- Finite sources deplete. A cooling drink or a drying spill emits less over time. Perfumes "dry down"
  as volatile top notes leave first.

Code: `src/chem/sourceTypes.ts` (headspace compositions), `World.emitSources` in `src/sim/world.ts`.

## 2. How odor moves through a room

| Process | Scale | Notes |
| --- | --- | --- |
| Molecular diffusion | D about 0.05-0.2 cm^2/s (Schmidt number about 1) | Spreads ~1 cm in 1 s, ~10 cm in 1 min, ~1 m in hours. Negligible at room scale. |
| Advection by air currents | 0.05-0.2 m/s background indoors, 1-4 m/s near fans and diffusers | Dominant transport. |
| Turbulent mixing | eddy diffusivity about 1e-3 to 1e-2 m^2/s | Stretches plumes into thin filaments. Concentration at a point is intermittent, with spikes and gaps. |
| Buoyancy | warm plumes rise at ~0.1-0.5 m/s | People (~80 W), heaters, candles and hot drinks create convective plumes and stratification. |

- Odor plumes are **filamentous and intermittent**: high-concentration strands separated by clean
  air. An animal or a sensor sees bursts, not a smooth gradient. This is why plume statistics matter
  more for odor search than mean concentration (Crimaldi et al.; mouse and lobster plume studies).
- In a **closed room** nothing leaves. Dilution only redistributes odor, so concentrations approach
  the well-mixed limit `C = M / V` unless something removes it.

Code: incompressible stable-fluids solver on a voxel grid (`src/sim/fluid.ts`). It does
semi-Lagrangian advection (RK2), red-black SOR pressure projection with obstacles, vorticity
confinement, random sub-grid eddies, Boussinesq buoyancy, and explicit eddy diffusion. Odor and
water-vapor fields get a mass fixer that keeps exact conservation, and the temperature field gets
exact energy conservation.

## 3. How odor decays indoors

- **Gas-phase chemistry**: terpenes react with indoor ozone (typically 5-30 ppb indoors). For
  limonene, k(O3) is about 2e-16 cm^3/s, giving a lifetime of a few hours at 15 ppb. For linalool,
  k(O3) is about 4e-16 cm^3/s. The products (formaldehyde, secondary organic aerosol) are not
  modeled.
- **Surface uptake**: polar, sticky molecules (organic acids, amines, ammonia, semivolatiles such as
  vanillin and geosmin) sorb to walls, carpets and fabric. The loss rate is `v_d * (A/V)`, with
  deposition velocity `v_d` up to ~1e-4 m/s and surface-to-volume ratio `A/V` about 2-3 m^-1.
- **Filtration**: activated carbon captures large, polarizable organics well and small polar
  molecules (formaldehyde, ammonia) poorly. HEPA filters remove particles, not gases.
- **Perception decay**: people adapt to a constant odor within minutes, and sensitivity recovers in
  clean air.

Code: per-(source, decay-class) tracer channels so every compound decays at its own rate
(`World.createChannels`), ventilation loops with filter efficiency (`World.ventilate`), and
adaptation in `src/chem/perception.ts`.

## 4. Human olfaction

- Humans have about 400 functional olfactory receptor types. Each olfactory sensory neuron expresses
  one receptor, and all neurons with the same receptor converge on the same glomerulus in the
  olfactory bulb, forming a stereotyped map.
- Coding is **combinatorial**. Each odorant activates several receptors, and each receptor responds
  to several odorants. Recent imaging at low concentrations suggests glomeruli are often more
  narrowly tuned than the classic picture (eLife 2023). Binary glomerular codes can explain a lot of
  discrimination behavior (Koulakov, Gelperin, Rinberg).
- Detection thresholds span more than 8 orders of magnitude: trimethylamine about 30 ppt, geosmin
  about 5 ppt, acetone about 40 ppm. The **odor activity value** (OAV = concentration / threshold)
  predicts which compounds dominate a smell. Perceived intensity grows roughly logarithmically
  (Fechner/Stevens).
- Odorant **sorptiveness** (volatility, water solubility) shapes where odorants deposit along the
  nasal airflow path. Only about 10% of inspired air reaches the olfactory cleft. Sniff duration
  matters more than sniff strength (Keyhani et al.; Dalton and Yang).

Code: the "Human nose" view (OAV volume), the human-nose panel at the snout, and thought bubbles for
people in the room.

## 5. The Cyranose 320 electronic nose

- It is a handheld instrument with a **32-element NoseChip** array. Each element is a chemiresistor:
  conductive carbon black dispersed in a different insulating polymer, deposited between two
  electrodes. The technology came from the Caltech/JPL work of Nate Lewis's group and was
  commercialized by Cyrano Sciences, then Smiths Detection; Sensigent sells it today.
- **Transduction**: vapor partitions into the polymer, the film swells, conductive carbon pathways
  break, and resistance rises. The relationship follows percolation theory, so films near their
  percolation threshold are most sensitive. Responses are linear over wide ranges and reversible.
  Detection limits run from ppb for semivolatiles to ppm for volatiles.
- **Selectivity** comes from different polymer/vapor partition coefficients. These can be predicted
  with linear solvation energy relationships (LSER):
  `log K = c + eE + sS + aA + bB + lL`, using Abraham descriptors of the vapor. No single sensor is
  selective. The pattern across all 32 identifies the sample.
- **Pneumatics and cycle**: an internal pump has low, medium and high flow (roughly 50, 120 and
  180 mL/min). There are two air paths: the **snout** (sample inlet) and a **side purge/baseline
  inlet**, which pulls ambient air through the chamber to the exhaust. A typical cycle is baseline
  purge (about 10 s), sample draw (10-60 s), idle/snout removal (about 3 s), then air-intake and
  sample-gas purges (30-40 s). Published studies vary these settings. Substrate temperature is
  user-set.
- **Features**: the raw output is resistance over time for 32 channels (a T x 32 matrix). The
  standard **smellprint** is `S_i = (R_max,i - R_0,i) / R_0,i`, with R_0 the baseline mean and R_max
  the peak during sampling, often after Savitzky-Golay smoothing. On-board and PC methods include
  PCA, CDA, KNN and SIMCA.
- **Known confounds**: humidity and temperature shift baselines. Water swells hydrophilic polymers
  strongly. Sensors drift over time, and units differ from one another.

Code: `src/device/sensors.ts` covers LSER partitioning with van 't Hoff temperature correction,
swelling, percolation, sorption kinetics, drift and noise. `src/device/cyranose.ts` covers the two
inlets, tube and chamber mixing volumes, the phase machine and smellprints. `src/device/analysis.ts`
covers SG filtering, smellprints and PCA. The polymer set in `src/chem/polymers.ts` is a plausible
stand-in, because the NoseChip formulations are proprietary.

## 6. New York Smells (Columbia)

A dataset of about 7,000 paired smell and image samples from about 3,500 objects, recorded indoors
and outdoors across NYC with a camera mounted on a Cyranose 320. Its protocol uses a 10 s baseline
through the side inlet followed by snout samples. The raw signal is resistances over time
(`baseline_raw`, `sample_raw`) plus a smellprint. Models trained on the raw signal outperform the
hand-crafted smellprint, and contrastive vision-olfaction pretraining helps. The simulator's
material sources (timber, paper, cardboard, leather, thermoplastic, foliage, brick, moss, brass,
steel, glass, wax) follow its material taxonomy.

## Sources

- Sensigent, Cyranose 320 brochure: https://www.sensigent.com/img/pdf/Cyranose%20320%20brochure.pdf
- Sensigent, Cyranose 320 datasheet: https://sensigent.com/img/pdf/Cyranose%20320-1p.pdf
- NASA Spinoff, electronic nose: https://spinoff.nasa.gov/node/10243
- University of Warwick, Cyranose sensing principle and response formula: https://warwick.ac.uk/research/rtp/warwick-scientific-services/sectors/biosensors/smithdetectioncyrano/
- Lonergan et al. (Lewis group), Array-based vapor sensing using chemically sensitive carbon black-polymer resistors: https://resolver.caltech.edu/CaltechAUTHORS:20180319-153251654
- Severin, Caltech thesis on carbon black-polymer composite detectors: https://thesis.caltech.edu/5142/
- Cyranose parameter settings in published studies: https://bmccancer.biomedcentral.com/articles/10.1186/s12885-018-4235-7/tables/4 and https://pmc.ncbi.nlm.nih.gov/articles/PMC3292139/table/t1-sensors-10-04675
- LSER models for polymer-coated vapor sensors (PNNL): https://www.pnnl.gov/publications/method-estimating-polymer-coated-acoustic-wave-vapor-sensor-reponses and https://stacks.cdc.gov/view/cdc/194865
- Crimaldi et al., odor plume structure: https://bechtel.colorado.edu/~crimaldi/publications/crimaldi_EFM_2002.pdf
- Odor plume intermittency and olfactory search: https://pmc.ncbi.nlm.nih.gov/articles/PMC8127944 and https://journal.frontiersin.org/article/10.3389/fncel.2021.633757
- Glomerular tuning at low concentration (eLife 2023): https://elifesciences.org/articles/80470.pdf
- Koulakov, Gelperin, Rinberg, binary glomerular code: https://repository.cshl.edu/id/eprint/23072/
- Air/mucus partitioning of odorants: https://pmc.ncbi.nlm.nih.gov/articles/PMC3913860/table/T1
- Keyhani et al., nasal odorant transport model: https://acnpsearch.tweb-dev.unibo.it/singlejournalindex/6838425
- Turbulent and laminar sniffing CFD (UPenn): https://upenn-test.atmire.com/entities/publication/c8bc688e-c146-4219-9279-e3a63fcbcbbb
- Gaussian plume and puff dispersion basics: https://www.csun.edu/~vchsc006/469/gauss.htm
- New York Smells: https://smell.cs.columbia.edu, https://arxiv.org/abs/2511.20544, https://github.com/cvondrick/new-york-smells
