# Spawn generator: research on fair start and resource placement

Status: research notes, 2026-10-31. Input for `docs/SPAWN_GENERATOR.md`; nothing here is
implemented.

Question: which published or shipped metrics and algorithms for fair RTS start positions and
resource placement can be implemented in the Silica spawn generator? The generator has to:

- set a chosen enemy distance;
- keep 3-way fair, so no side sits between the other two;
- keep a target number of patches, with the same number near every start;
- give every side about the same resources in its likely territory;
- avoid exposed high-ground starts.

Silica terms used below: `R_b` = build radius around an HQ/Nest, `R_c` = chain range
(HQ-to-HQ), `a_r` = amount of patch r, `d_i(x)` = travel distance from start i to x. Human
sides mine Balterium, the alien side mines Biotics.

## Verification legend

Every formula carries one of these tags:

- **[V]**: read in the primary source during this research: the paper PDF, or the shipped
  or official script source.
- **[V2]**: read in a derivative copy of the primary source, such as a modded copy of a
  Firaxis Lua file or a third-party reference manual. Probably faithful, but not the
  original file.
- **[U]**: not verified. From memory, from a garbled extraction or from a secondary
  summary. Check before relying on it.
- **[D]**: derived here for Silica. Not from any source.

---

## 1. Academic sources

### 1.1 Liapis, Yannakakis, Togelius: area control, resource safety, exploration, balance

**Citations**
- A. Liapis, G. N. Yannakakis, J. Togelius, "Towards a Generic Method of Evaluating Game
  Levels", AIIDE 2013, pp. 30-36. https://ojs.aaai.org/index.php/AIIDE/article/view/12680 (this
  is the form generalised to any reference set). PDF read from
  https://antoniosliapis.com/papers/towards_a_generic_method_of_evaluating_game_levels.pdf
- A. Liapis, G. N. Yannakakis, J. Togelius, "Generating Map Sketches for Strategy Games",
  EvoApplications 2013, LNCS 7835. This is the strategy-map form used in the Sentient
  Sketchbook tool:
  https://antoniosliapis.com/papers/generating_map_sketches_for_strategy_games.pdf
- The Sentient Sketchbook FDG 2013 paper itself was not downloaded (the link returned HTML).
  Its user study is cited in the AIIDE paper: expert designers "deemed [these metrics] highly
  useful".

**Formulas [V]** (AIIDE 2013, eq. 1-2 and the unnumbered f/b formulas; the EvoApps paper,
eq. 3-8, is the same with bases and resources). `S_N` = reference tiles (bases, N of them),
`S_M` = target tiles (resources, M of them), `P` = number of passable tiles, and `d_{t,i}` =
distance from tile t to base i "using A* pathfinding" (EvoApps).

```
Safety of tile t for base i:
  s_{t,i} = min_{j≠i} max{ 0, (d_{t,j} − d_{t,i}) / (d_{t,j} + d_{t,i}) }                (1)

Exploration from base i (flood fill from i until j is found, E_ij = tiles covered):
  E_i = 1/(N−1) · Σ_{j≠i} E_ij / P                                                    (2)

Resource safety       f_s(S_N,S_M) = 1/M · Σ_k max_i s_{k,i}
Safe area             f_a(S_N)     = 1/P · Σ_i A_i     A_i = #tiles with s_{t,i} > C_s
Exploration           f_e(S_N)     = 1/N · Σ_i E_i
Resource balance      b_s = 1 − 1/(M·N·(N−1)) · Σ_k Σ_i Σ_{j≠i} |s_{k,i} − s_{k,j}|
Safe-area balance     b_a = 1 − 1/(N·(N−1)) · Σ_i Σ_{j≠i} |A_i − A_j| / max{A_i, A_j}
Exploration balance   b_e = 1 − 1/(N·(N−1)) · Σ_i Σ_{j≠i} |E_i − E_j| / max{E_i, E_j}

C_s = 0.35 ("creates a good ratio of contested areas in most maps").
Combined fitness used in the paper, e.g. F_s = f_s · b_s; several combined terms are summed.
```

**Mapping to Silica**
- `s_{r,i}` per patch is the **resource safety** of patch r for start i. It equals the
  generator's zoning ratio: with `r_i = d_i / min_{j≠i} d_j`,
  **`s = (1 − r)/(1 + r)`** [D]. So the v2 rule `home if r < 0.6` is `s > 0.25`,
  `fill r < 0.8` is `s > 0.111`, and Liapis' `C_s = 0.35` is `r < 0.481` (stricter than v2).
- `b_a` (pairwise relative difference over the max) is a simple bounded [0, 1] balance form.
  It applies to any per-side quantity: territory area, safe resource amount, buildable area.
- Weight `s` by patch amount (Liapis counts resource tiles; Silica patches differ in size):
  `R_i^safe = Σ_r a_r · [s_{r,i} > C_s]`.
- Exploration `E` (flood fill) matters little here because Silica start positions are known.
  Skip it.

**Caveats**
- The authors' own words: "the safety metric is problematic when more than two reference
  tiles are included in the set; in such cases, unsafe tiles can be equally far from two of
  these elements, while remaining elements may be much farther away". For 3-way, compute
  `s` against the **nearest** enemy only; the `min_{j≠i}` in (1) already does this. Squeeze
  needs its own metric (section 4.2).
- `s` cannot reach 1. The EvoApps paper notes `f_res` stays well below 1 even on good maps.
  Use relative comparisons, not absolute targets.
- EvoApps: "the safety metric underestimates the impact of chokepoints". Path distance on a
  slope-cost grid partly fixes this; a choke metric (1.5, section 4.7) covers the rest.
- Balance terms "are easily attainable" alone: maps with bases next to each other score
  perfect `b_a`/`b_e`. Always pair balance with a distance constraint.

### 1.2 Togelius et al.: multiobjective StarCraft and heightmap map generation

**Citations**
- J. Togelius, M. Preuss, N. Beume, S. Wessing, J. Hagelbäck, G. N. Yannakakis,
  "Multiobjective Exploration of the StarCraft Map Space", IEEE CIG 2010, pp. 265-272.
  https://www.um.edu.mt/library/oar/bitstream/123456789/29280/1/Multiobjective_exploration_of_the_starcraft_map_space_2010.pdf
- J. Togelius, M. Preuss, N. Beume, S. Wessing, J. Hagelbäck, G. N. Yannakakis, C. Grappiolo,
  "Controllable procedural map generation via multiobjective evolution", Genetic Programming
  and Evolvable Machines 14 (2013) 245-277, DOI 10.1007/s10710-012-9174-5. This is the
  extended version; it adds a heightmap-based generic strategy game and **3-player** maps.
  https://um.edu.mt/library/oar/bitstream/123456789/22906/3/ControllableProceduralMapGeneration.pdf

**Formulas [V]** (2010 paper, StarCraft section; "distance" = number of cells on the A*
shortest path). All objectives are normalised to [0, 1] and maximised.

```
fb0 base space:     fraction of the 5×5 cells around a base that are passable and reachable
                    within 5 A* steps; mean over bases.         (hard constraint: fb0 ≥ 0.5)
fb1 base distance:  min_{i<j} d(b_i, b_j) / (map width + map height)
                    (penalty: if fb1 < 0.5 subtract 0.5 − fb1 from every objective)
fr1 closest resource: per base, the distance to its closest mineral / gas;
                    fr1 = min over bases / max over bases.
fr2 resource ownership: each resource is owned by its closest base, split equally on ties;
                    fr2 = mean owned fraction (1 = every resource clearly assigned).
fr3 resource safety: D_j = {dist(r_j, b_i) | i = 1..n};
                    fr3 = min{s_gas, s_minerals}, s = mean over resources of std(D_j).
fr4 resource fairness: 1 − (max − min) of the distance from each base to its nearest resource.
fp1 choke points:   mean over base-to-base shortest paths of the narrowest path width
                    (width scanned orthogonally to the path direction until impassable).
fp2 path overlap:   mean number of base-to-resource paths using each cell.
```

Heightmap game (2013, section 6.1) **[V]**: A* edge cost = **5 + |Δ elevation|** between
neighbouring cells. Then:

```
f0 base distance: mean weighted distance between bases.
f1 base on ground: f1 = 1 − Σ_i h_i^B / N_B   (h_i^B = elevation of base i, normalised).
   Motivation quoted: "Bases should all be placed on the same elevation to avoid unfair
   advantages".
f3 resource distance: 1 − (max D_R − min D_R), where D_R = distance from each base to its
   nearest resource.
```

3-player placement **[V]** (2013, section 5): bases are generated in polar coordinates; "each
base is forced to be within its own arc of the circle, meaning that for three bases each
base is placed within its own 120 degree arc", with radius between 1/2 and 1 of the map
radius.

**Mapping to Silica**
- `fr1`/`fr4` (nearest resource equal for everyone) is the simplest starting-kit check.
  `SPAWN_GENERATOR.md` H4/H5 (ring counts) is a stricter version of it.
- `f1` matches the Silica brief directly: equal and low base elevation. Measure
  `h_i − mean(h)` as an elevation difference between starts, not as absolute height.
- The 120° arc parameterisation is a cheap way to make 3-way candidates triangle-like before
  scoring.
- `fb0` is the counterpart of S9 (buildable fraction within `R_b`).

**Caveats**
- The user study: the human testers did not find base fairness valuable as a graded
  objective, while resource fairness and choke points did correlate with perceived quality
  (Kendall tau around −0.4, n = 10 maps, not significant). Base placement rules work best as
  constraints.
- `fp2` normalisation was "inadequate", in the authors' words. Do not reuse it as written.
- `fr3` as written rewards resources whose base distances differ a lot, which a patch next
  to one base also satisfies. Liapis' `s` is the cleaner version.

### 1.3 Barros & Togelius: evolving start positions on a fixed map (closest to our problem)

**Citation**: G. A. B. Barros, J. Togelius, "Balanced Civilization Map Generation based on
Open Data", IEEE CEC 2015, pp. 1482-1489. PDF:
https://researcher.itu.dk/ws/files/81828754/Barros2015Balanced.pdf

This paper's setup matches ours: **terrain and resources are given, only the start positions
are evolved** (12+88 ES, cascading elitism: sort by `f_DB`, drop half, by `f_OR`, drop half,
by `f_BPR`, drop half).

**Formulas [V]** (eq. 1-3 as printed; the printed notation is sloppy, see caveats):

```
f_DB = 1 − sqrt( Σ_{pairs} (meandist − d_ij/d_max)² / n )   if d_min > threshold, else 0
       meandist = (Σ d_ij / d_max) / n         d_max = map diagonal
       ("1 minus the standard deviation of distances between bases")

f_BPR = 1 − sqrt( Σ_i (bigMean − mean_i)² / n ),  mean_i = Σ_{j=1..q_R} d(i→j)/d_max
       ("standard deviation of average of the average distances between resources and bases")

f_OR  = 1 − sqrt( Σ_i ( Σ_i s_i / q_OR − s_i )² / n )   if q_OR ≠ 0, else 0
       s_i = safe resources owned by base i, q_OR = total owned resources.
       A safe resource is "closest to i than to all other bases, and ... guarded by base i
       itself, in the sense that any other player who tries to get to it has to pass by i
       first".
```

**Mapping to Silica**
- `f_DB` is an **equal-distance** objective: low spread of enemy-pair distances. Combined
  with a target value `d*` it gives the "settable distance" requirement (section 4.1).
- The "guarded" definition of a safe resource is the most useful idea here: the enemy's
  shortest path to the patch passes through (or near) my base. This is stronger than
  "nearer to me". It can be computed from Dijkstra predecessor trees [D]: patch r is guarded
  by i if the enemy's shortest path to r enters the disc of radius `R_b` around i.

**Caveats**
- As printed, `bigMean` is a sum, not a mean, and the `f_OR` inner term mixes a share with a
  count. The intent is clearly "1 − standard deviation of per-player safe-resource shares";
  implement that, not the literal print.
- Distances here are likely Euclidean on a tile grid. The paper does not say A*; marked
  [U].

### 1.4 Lara-Cabrera, Cotta, Fernández-Leiva: simulation-based balance (Planet Wars)

**Citations**
- R. Lara-Cabrera, C. Cotta, A. J. Fernández-Leiva, "A Procedural Balanced Map Generator with
  Self-Adaptive Complexity for the Real-Time Strategy Game Planet Wars", EvoApplications
  2013, LNCS 7835, pp. 274-283. DOI 10.1007/978-3-642-37192-9_28 (paywalled; full text not
  read).
- Slides by the authors: https://www.slideshare.net/slideshow/present-evogames/18353258
- Follow-ups: "A Self-Adaptive Evolutionary Approach to the Evolution of Aesthetic Maps for a
  RTS Game" (read: https://riuma.uma.es/bitstreams/6efc3b50-72f9-4560-971e-7cb2d8a0cc84/download),
  which uses graph measures of the sphere-of-influence graph and is not about balance. A 2014
  dynamism paper exists (CORE blocked the download).

**Method [V from slides, formula partly U]**: every candidate map is played by **3 bots × 3
matches** (Google AI Challenge 2010 bots, 400-turn limit). The fitness is averaged over the
`N_m` matches and is built from `K_i` (percentage of occupied planets), `t_i` (number of
turns), `P̄_i` (mean difference in planet counts between the two players) and `S̄_i` (mean
difference in ship counts). The structure is roughly
`fitness ≈ 1/N_m · Σ_i K_i·t_i / (P̄_i + S̄_i + 1)`: long, contested games with small
material differences score high. The exact constants were garbled in the slide OCR, so this
is **[U]**. A 2023 survey (arXiv 2311.04710) names its indicators "territorial imbalance,
growth imbalance, enemy imbalance".

**Mapping to Silica**: this is the **validation** layer, not a generator term. The local
dedicated server already runs headless AI rounds (headless-vanilla-3way survey, 2026-10-28).
A generated layout can be accepted only if headless rounds show no systematic winner and
small income-curve differences per side. Measure the income or resource-curve imbalance per
side over time, the counterpart of `P̄ + S̄`.

**Caveats**: the bots' skill and style bias the result. The method is costly: minutes per
map in Silica, against milliseconds for direct metrics. Use it offline on the top
candidates only.

### 1.5 Terrain analysis: BWTA, BWTA2, BWEM, Taunt (regions and chokepoints)

**Citations**
- L. Perkins, "Terrain Analysis in Real-Time Strategy Games: An Integrated Approach to Choke
  Point Detection and Region Decomposition", AIIDE 2010.
  https://ojs.aaai.org/index.php/AIIDE/article/view/12405 (the PDF was behind bot protection;
  the algorithm description below comes from Richoux 2022). Reported to match 97 % of the
  choke points human participants identified.
- A. Uriarte, S. Ontañón, "Improving Terrain Analysis and Applications to RTS Game AI", AIIDE
  2016 workshop, https://ojs.aaai.org/index.php/AIIDE/article/view/12889 (BWTA2; "at least 10
  times faster" than BWTA).
- F. Richoux, "Terrain Analysis in StarCraft 1 and 2 as Combinatorial Optimization",
  arXiv 2205.08683, https://ar5iv.labs.arxiv.org/html/2205.08683 (describes BWTA and BWTA2,
  and adds "Taunt").
- BWEM (Brood War Easy Map), community fork source:
  https://github.com/N00byEdge/BWEM-community/blob/HEAD/BWEM/src/mapImpl.cpp

**BWTA [V2 via Richoux]**
1. Build a Voronoi diagram (medial axis) of the walkable polygons. Each point's radius is
   the distance to the nearest obstacle.
2. Prune leaves whose parent lies farther from the obstacle than the leaf does.
3. Choke points are Voronoi nodes whose radius is smaller than their neighbours' (local
   minima of clearance). Regions are the areas between chokes.
4. Merge regions by area and choke radius. Richoux notes the merge criteria are not given
   numerically and the result depends on merge order.

**BWEM altitude watershed [V, source code]**: this is the simplest form to implement on a
grid.
1. `altitude` = distance from each walkable cell to the nearest non-walkable cell,
   computed by a Dijkstra or brushfire pass from the "seaside" cells.
2. Visit the cells in **descending altitude**. Each cell either starts a new area, joins its
   neighbouring area, or sits where two areas meet.
3. Where two areas A_small and A_big meet, they **merge** if any of these holds:
   ```
   size(A_small) < 80   or   highestAltitude(A_small) < 80
   or  altitude(cur)/highestAltitude(A_big)   ≥ 0.90
   or  altitude(cur)/highestAltitude(A_small) ≥ 0.90
   or  cur is within 3 tiles of a start location
   ```
   (units: mini-tiles of 8 px, altitudes in px). Otherwise `cur` becomes part of the
   frontier between them, and frontiers are the chokepoints.
4. A choke's width is about twice the altitude at its frontier cells [D].

**Taunt [V2 via Richoux]**: splits walkable land by height level and buildability, then
solves a small constraint problem per area. The objective is to minimise separation length
(`Σ v_i·length_i`) and to equalise region areas (`Σ (mean_area − area_i)²`), with the
constraint "one resource cluster per region".

**Mapping to Silica**
- Silica has no navmesh export, but the 15 m height grid plus the masks gives "walkable" =
  slope ≤ `s_max` and mask valid. BWEM's watershed on that grid gives regions and chokes in
  one O(n log n) pass.
- Per start, count the **entrances** into its home region and their widths. "Exposed"
  starts have many or wide entrances (section 4.7).
- Taunt's equal-area-with-one-cluster objective works for the patch selection step: one kept
  cluster per region, regions of similar size.

**Caveats**: StarCraft has binary walkability, while Silica has continuous slopes and
hover/air units. The thresholds (80, 0.90) are in StarCraft pixel units and need tuning;
scale 80 px to about 2-3 grid cells of clearance.

### 1.6 PSMAGE (Uriarte & Ontañón 2013)

**Citation**: A. Uriarte, S. Ontañón, "PSMAGE: Balanced Map Generation for StarCraft", IEEE
CIG 2013, DOI 10.1109/CIG.2013.6633644. Source and draft paper:
https://github.com/albertouri/psmage (`docs/psmage.tex`).

**Method [V, draft paper]**: Voronoi polygons from random seed points, region elevation
assigned, then **mirror over x and y** "in order to get a balanced map like those used in
StarCraft competitions". The draft contains no balance metrics; a co-author comment even
says "We need metrics that support this claim". The published version reportedly adds
evaluation metrics **[U, not read]**.

**Relevance**: low. Balance by symmetry does not apply to fixed Silica terrain. The
Voronoi-of-seeds idea is useful only for visualising territory.

### 1.7 Influence maps (territory as a soft field)

**Citation**: D. Mark, "Modular Tactical Influence Maps", Game AI Pro 2, ch. 30 (2015).
https://www.gameaipro.com/GameAIPro2/GameAIPro2_Chapter30_Modular_Tactical_Influence_Maps.pdf

**Formulas [V]**

```
(30.1) Influence = MaxValue − MaxValue · (Distance / MaxDistance)        linear
(30.2) Influence = MaxValue − MaxValue · (Distance / MaxDistance)²
(30.3) Influence = MaxValue − MaxValue · (Distance / MaxDistance)⁴        "threat" shape
```

Influences from several sources add. Where obstacles matter, "swap the linear distance
calculation code with a call to the pathfinding system", i.e. precompute path distances with
Dijkstra from each source.

**Mapping to Silica [D]**: a soft territory weight per patch. One option is the Luce/softmax
share `w_i(r) = exp(−d_i(r)/τ) / Σ_j exp(−d_j(r)/τ)`. Another is the normalised 30.2 field,
`w_i(r) = I_i(r) / Σ_j I_j(r)` with `MaxDistance = d*`. Soft weights make the territory
metric continuous, which suits the search (no jumps when a patch flips owner). Hard Voronoi
(argmin) stays the display model.

---

## 2. Shipped game scripts

### 2.1 Civilization V: `AssignStartingPlots.lua` (Bob Thomas, Firaxis 2010)

**Source [V2]**: the Community Patch copy, which keeps the Firaxis header ("Regional division
concept: Bob Thomas; Division algorithm concept: Ed Beach; Center bias concept: Bob
Thomas"):
https://github.com/LoneGazebo/Community-Patch-DLL/blob/master/(1)%20Community%20Patch/Core%20Files/Overrides/Includes/AssignStartingPlots.lua
Some values carry "BT" balance-tweak comments dated 1/26/2011. CP may have changed other
details.

**Algorithm**

1. **Fertility per plot** (`MeasureStartPlacementFertilityOfPlot`): mountain −2, snow −1,
   oasis 4, flood plains 5. Otherwise the terrain value (grass 3, plains 4, tundra 2,
   coast 2, desert 1), plus 1 for hills, −1 for jungle, −2 for marsh, −1 for ice, +1 for a
   river side, +1 for fresh water, and +2 for coastal land (optional).
2. **Divide into regions of equal total fertility** (`DivideIntoRegions`): this is a
   recursive axis-aligned cut, a KD tree on fertility mass.
   - If `n % 3 == 0`, `ChopIntoThreeRegions`: cut at 33 % of the fertility, then cut the
     remainder at 48.5 %.
   - If `n` is even, cut at 49.5 %.
   - If `n` is odd and not a multiple of 3, cut at `firstSubdivisions/(n + 0.1)`.
   - The cut runs across the longer side ("bTaller"), adding row by row until the running
     fertility sum ≥ target. The targets deliberately undershoot to compensate for overshoot.
3. **Start inside each region with centre bias**: candidates in the central 34 % of the
   region's width/height are tried first (`centerBias = 34`), then the central 67 %
   (`middleBias = 67`), then the rest.
4. **Candidate score** (`EvaluateCandidatePlot`): counts food, production, "good" and junk
   tiles in rings 1-3 with minimum requirements (e.g. `minFoodMiddle = 4`, `maxJunk = 9`).
   Lookup tables have diminishing returns: middle-ring food `{0,2,5,10,20,25,28,30,32,34,35}`,
   production `{0,10,20,25,30,35}`, and production is capped by food (`if food·2 < prod`).
   +40 if coastal. Sum = inner + middle + outer ring scores.
5. **Soft distance between civs, "impact and ripple"** (`PlaceImpactAndRipples`): each
   placed start writes 99 at its plot and ripples `{97, 95, 92, 89, 69, 57, 24, 15}` on rings
   1..8. A later candidate with bias b > 0 is disqualified from the first pass and scored
   `score − floor(score·b/100)` as a fallback. The comment: civs are kept "at least 9 tiles
   away ... whenever and wherever a reasonable candidate plot exists", with "the bias
   becoming very heavy inside 7 plots, and all but prohibitive inside 5". It also explains
   why a Civ IV formula for min distance from map size and civ count was dropped: it "was
   chock full of faulty assumptions".
6. **Normalisation after placement** (`NormalizeStartLocation`): weak starts get bonus
   resources added in two rings (e.g. at least three native 2-food tiles, one in the first
   ring).

**Mapping to Silica**
- Step 2 is a **constructive** way to meet "each side's prospective territory has about the
  same resources". Run the cuts on the Balterium amount (humans) or a harvest-rate-weighted
  mass. For 3-way, use one cut at 1/3 and then 1/2 of the remainder, then place each start
  near its region's centre. It can seed the search or serve as a baseline. Axis-aligned
  cuts ignore terrain, so check the result with geodesic territory.
- Step 5 is a good **soft-penalty shape** for "settable distance": a hard floor plus a steep
  penalty band, not a single hard cut.
- Step 6 corresponds to `patch_overrides`. After choosing patches, top up the poorer side's
  amounts rather than adding patches (Civ V adds bonus resources; we can raise amounts).

**Caveats**: Civ's fertility measures food and production land, not mineable deposits. The
lookup tables are tuned for Civ yields; copy the shape (diminishing returns) and not the
numbers.

### 2.2 Civilization VI: `AssignStartingPlots.lua`

**Source [V2]**: two mod copies of the Firaxis file. They agree on the functions below.
- https://github.com/kevincoghlan/distant-multiplayer-start/blob/master/Override/AssignStartingPlots.lua
- https://github.com/puj/Civ6Tweaks (Override/AssignStartingPlots.lua)

Not compared against the shipped game file.

**Algorithm**
- `__WeightedFertility(plot)`: sum over the radius-3 window of
  `StartPositioner.GetPlotFertility` (C++, not visible). Adjustments: +100 if the start plot
  is on a river, snow without resource −10, ice −20, impassable −5, any feature −2, a
  strategic resource of the current era ±modifier +10, an off-map or edge-row plot −20.
- `__SetStartMajor`: sort candidates by fertility. Take the first one that is not
  impassable or water and passes `__MajorCivBuffer`. That buffer is a **hard minimum
  distance** `START_DISTANCE_MAJOR_CIVILIZATION` (default 9; minus 2 on water maps) to every
  placed major. The plot must also pass luxury and strategic checks. A fallback score
  tracks how many checks the best failing plot passed.
- `__AddResourcesBalanced` (balanced resources option): every major start gets the
  strategics of its era if missing. Then luxuries are added while "fertility left" ≥ 250,
  and bonus resources while it is ≥ 75. In both copies `iHighestFertility` is computed but
  **unused**: the top-up is driven by each start's own fertility, not by its gap to the
  best start. This looks like a bug or leftover **[V2]**.

**Mapping**: the takeaways are a hard minimum distance plus a quality sort, and a
guaranteed minimum kit (every start has each needed resource type nearby). The pattern is
"sort by quality, accept the first that passes all hard buffers, keep the best partial
failure as fallback". `SPAWN_GENERATOR.md` §6.4 (relaxation ladder) already follows it.

### 2.3 Age of Empires II: random map scripts (RMS)

**Sources**
- Forgotten Empires, "RMS Features" (official, DE):
  https://www.forgottenempires.net/age-of-empires-ii-definitive-edition/rms-features **[V]**
- Racket `aoe2-rms` reference, which mirrors the community RMS guide with defaults:
  https://docs.racket-lang.org/aoe2-rms/attributes.html **[V2]**
- Baltic script "for Forgotten Empires" (WololoKingdoms copy):
  https://github.com/SiegeEngineers/WololoKingdoms/blob/master/resources/gamedata_x1/54203.bina
  **[V]**

**Player placement**
- `create_player_lands { land_percent P  base_size B  other_zone_avoidance_distance A
  [circle_radius R V] [set_zone_by_team] }`.
- `land_percent` is the share of the map the lands grow to cover; for player lands "the
  percentage is divided equally between all players".
- `base_size` is the "square radius of the initially placed land origin, before any growth"
  (default 3, giving a 7×7 tile origin). It is also the minimum distance to the map edge.
- `other_zone_avoidance_distance` is the number of tiles from a land of another zone at
  which growth stops. It also keeps random origins apart.
- `circle_radius R V` "positions player lands in a circle with equal distance to the
  center". R is a percentage of map width (FE page: 0-50), V the per-player variance.
- `grouped_by_team`: "distance between team members is double the base-size".

**Resource kit per player: the distance-band pattern.** The objects use
`set_place_for_every_player` with `set_gaia_object_only`, which "places the object(s) as a
personal object for each player land". Distances are measured "from the origin of player
lands"; they are **square** (Chebyshev) unless `set_circular_placement` is used. For grouped
objects the distance applies to the group centre. Baltic:

| block | count | min-max tiles from land origin |
|---|---|---|
| near gold | 7 | 12-16 |
| medium gold | 4 | 18-26 |
| far gold | 4 | 25-35 |
| near stone | 5 | 14-18 |
| far stone | 4 | 20-26 |

The script places extra neutral gold separately with `number_of_groups`. Other attributes:
`find_closest` ("closest free tile to the center of the land", Euclidean),
`set_avoid_player_start_areas` (default 13 tiles when given without a value), and
`enable_balanced_elevation`, which "removes the bias of hill placement towards the bottom
(south) of the map".

**Mapping to Silica**
- The AoE2 pattern is **identical per-player kits in distance bands**, then shared extras
  placed under spacing constraints.
- In Silica, the bands are `ring0 = [0, R_b]` (minable from the start HQ),
  `ring1 = (R_b, R_b + R_c]` (one chain step) and `ring2`. `SPAWN_GENERATOR.md` §4.3 already
  has this structure; AoE2 is the shipped precedent for strict per-band equality.
- `circle_radius` with equal angles is the AoE2 version of "settable distance": for n
  players on a circle of radius ρ, the enemy distance is `2ρ·sin(π/n)` (√3·ρ for n = 3) [D].
  Silica vanilla does the same (ring radius `0.5 × half-extent × U(0.8, 1.2)`).

**Caveats**: AoE2 **creates** resources; Silica can only **keep or remove** fixed patches
(and change amounts). Exact equality is therefore not always reachable, and the generator
needs tolerances plus amount top-ups.

### 2.4 0 A.D.: `rmgen` / `rmgen-common`

**Source [V]**, 0 A.D. master:
- `binaries/data/mods/public/maps/random/rmgen-common/player.js`
- `rmgen-common/gaia_entities.js`
- `rmgen2/gaia.js`

https://github.com/0ad/0ad/tree/master/binaries/data/mods/public/maps/random

**Algorithms**
- `playerPlacementCircle(radius, startAngle)`: `distributePointsOnCircle(numPlayers, ...)`
  places players at equal angles on a circle.
- `playerPlacementRandom`: rejection sampling. Each position must be at least
  `fractionToTiles(0.25)` (a quarter of the map size; the code comment says "a quarter of
  the map diameter") from every other, and at most `centre.x − fractionToTiles(0.08)` from
  the centre. After 500 failed attempts it resets; every 25 resets the min distance is
  multiplied by 0.95. It gives up after 500 resets.
- `groupPlayersByArea`: over all permutations of the chosen locations, it picks the one
  minimising the summed ally distance (team grouping).
- `placePlayerBaseMines`: **identical per-player starting mines**. Every mine sits at
  `distance` (default 12) from the CC, with the angle between mines drawn from [π/6, π/3],
  and up to 75 tries to find a valid arc.
- `createBalancedMines` ("in such a way that it should be relatively fair"): large mines
  with `avoidClasses(clMine, scaleByMapSize(25, 50))`, then small clusters with 18-35, then a
  few random small ones with 5. Metal large count = `max(scaleByMapSize(1, 9),
  1.8·nPlayers − 0.8)`. This is **Poisson-disc spacing, not per-player equalisation**.
- `markPlayerAvoidanceArea` exists because "Bluffs might surround playerbases either
  entirely or unfairly": terrain features are explicitly kept off start areas.

**Mapping to Silica**
- Rejection sampling with progressive relaxation (×0.95 per 25 resets) is a simple way to
  meet a target distance. The generator's relaxation ladder generalises it.
- Mirror 0 A.D.'s split: **per-player kit exact, shared resources only spaced**. Kept
  contested Balterium needs a minimum spacing, the counterpart of `avoidClasses(clMine, …)`.
  The v2 rule "150 m spread" is that.

**Caveats**: like AoE2, 0 A.D. spawns resources; its "balanced" mines rely on statistics, not
on a per-player guarantee.

---

## 3. Board games and terrain exposure

### 3.1 Settlers of Catan: production rate, not stock

**Source [V]**: CATAN 25th-anniversary rules and Almanac (Catan GmbH):
https://cdn.shopify.com/s/files/1/0024/8617/3749/files/catan-25th-rules_eng-200313.pdf
The Almanac says "6" and "8" "each have 5 dots, because there are 5 ways to roll these
numbers on the 2 dice". The variable set-up places the lettered number tokens in a fixed
spiral order.

**Formula [V, from the dice arithmetic in the rules]**: `pips(n) = 6 − |n − 7|`,
`P(n) = pips(n)/36`. The expected yield of a settlement spot is `Σ_{adjacent hexes} pips/36`
per roll, per resource type.

**Practitioner balance rules [U]**: these appear in community generators, not in the text
read here.
- No two red numbers (6/8) adjacent.
- Bounded pips per intersection.
- Each resource type's total pips within a band.
- Snake-order initial placement (2nd round in reverse order).

Academic: Hwang & Kaneko, "Automatic map generation for Settlers of Catan" (IPSJ 2017,
Japanese, not read) and a BRKGA thesis (UFC 2023, Portuguese, not read).

**Mapping to Silica [D]**
- Catan balances **production rate**, not total stock. In Silica the early game is
  rate-limited: harvesters per refinery, travel distance from patch to refinery.
- Weight patches near the start by an early-game income rate, e.g. min(throughput cap,
  amount) per patch discounted by distance to the nearest valid refinery spot. Do not weight
  by `resources_max` alone.
- Snake order corresponds to a **sequential, alternating patch pick**: when assigning
  contested patches, alternate sides and reverse the order every round. `SPAWN_GENERATOR.md`
  §4.2 step 3 alternates already; reversing removes the first-pick advantage.

### 3.2 Exposure and visibility: slope, TPI, viewshed, openness

**Slope [V]**: Esri, "How Slope works":
https://doc.esri.com/en/arcgis-pro/latest/tool-reference/spatial-analyst/how-slope-works.html
On a 3×3 window a..i around centre e:

```
dz/dx = ((c + 2f + i)·4/wght1 − (a + 2d + g)·4/wght2) / (8·x_cellsize)
dz/dy = ((g + 2h + i)·4/wght3 − (a + 2b + c)·4/wght4) / (8·y_cellsize)
rise_run = sqrt((dz/dx)² + (dz/dy)²)
slope_deg = atan(rise_run) · 57.29578
```

The weights are 4 when all neighbours are valid, which gives the classic
`((c+2f+i) − (a+2d+g)) / (8·cellsize)`. The Esri page does not cite it; it is usually
attributed to Horn (1981), "Hill shading and the reflectance map", Proc. IEEE 69(1)
**[U attribution]**.

**Topographic Position Index (TPI) [V2]**: Weiss (2001) poster "Topographic Position and
Landforms Analysis" (ESRI UC); Jenness (2003) ArcView TPI extension. Implemented in the R
package `landform`: https://rdrr.io/cran/landform/src/R/landform.R and its manual
https://search.r-project.org/CRAN/refmans/landform/html/landform.html

```
TPI(p)  = z(p) − mean{ z(q) : q in neighbourhood(p) }     (focal cell excluded by default)
TPI_std = (TPI − mean TPI) / sd TPI       ("global" standardisation is the package default)
Slope-position classes (thresholds t1 = 0.5, t2 = 1 SD; slope.thr = 5°):
  valley ≤ −1 < lower slope ≤ −0.5 < {flat if slope ≤ 5°, middle slope otherwise} < 0.5
  < upper slope ≤ 1 < ridge
10-class landforms combine a small-scale (default 3) and a large-scale (default 7) TPI.
```

**Viewshed [V]**: GRASS `r.viewshed`, https://grass.osgeo.org/grass-stable/manuals/r.viewshed.html
- Observer height default 1.75 map units above terrain; target height default 0.
- `-b` boolean output; optional curvature and refraction (coefficient 0.14286).
- Line-sweep algorithm, O(n log n) against O(n^1.5) for the standard method (Haverkort,
  Toma, Zhuang, "Computing Visibility on Terrains in External Memory", ACM JEA 13, 2009).

**Openness [U]**: Yokoyama, Shirasawa, Pike, "Visualizing Topography by Openness", PE&RS
68(3) 2002. Positive openness is the mean, over 8 (or more) azimuths, of the zenith angle to
the highest terrain within radial distance L. High values mean a dominant, exposed spot;
low values mean an enclosed one. It is implemented in SAGA `ta_lighting 5` (8 sectors by
default, https://saga-gis.sourceforge.io/saga_tool_doc/9.12.0/ta_lighting_5.html). The
exact formula was not read.

**Mapping to Silica [D]**
- "Exposed high-ground start" has three parts:
  - **elevated relative to surroundings**: TPI at a scale of about `R_b`;
  - **visible from a large area**: viewshed fraction;
  - **approachable from many directions**: many or wide entrances (1.5).
- Viewshed reciprocity: with equal eye heights, "cells that can see the HQ" equals "cells
  the HQ can see". One sweep from the HQ with observer height = target height (unit height,
  ~3 m) gives the visible-from area.
- Standardising TPI by its map-global SD makes the ±0.5/±1 thresholds transfer across maps.
  The current draft (`SPAWN_GENERATOR.md` §5.3) uses a fixed 15 m divisor instead.

---

## 4. Synthesis for Silica

### 4.1 Distance model

- Use travel distance on a slope-cost grid for anything about **contest** (who gets there
  first): safety, territory, enemy separation. Togelius 2013 used `5 + |Δh|` per step; the
  draft uses `len·(1 + k·(s/s0)²)`. Both are fine; keep one and document it.
- Use the game's own rule for **reach** (what a side can build to). If Silica checks chain
  and build radii in 2D Euclidean, then hop count
  `hop_i(r) = 0 if |r − HQ_i| ≤ R_b else ceil((|r − HQ_i| − R_b)/R_c)` [D], using the BFS
  tree from `expansion.js` for multi-hop.
- Two different distances is not a contradiction: reach decides what can be owned, travel
  decides who can defend it.

### 4.2 3-way geometry: squeeze

The triangle-angle rule (draft H3, 35-100°) is Euclidean. A path-distance version uses the
**detour ratio** [D]:

```
ρ_i = (d_ij + d_ik) / d_jk          j, k = the other two starts, d = travel distance
```

`ρ_i → 1` means i lies on the path between j and k: squeezed. For Euclidean distances the
law of sines gives exactly `ρ_i = cos((θ_j − θ_k)/2) / sin(θ_i/2)`, with θ the triangle
angles [D]. Reference values for an isosceles triangle (θ_j = θ_k):

| θ_i | 60° | 77° | 90° | 100° | 120° | 180° |
|---|---|---|---|---|---|---|
| ρ_i | 2.00 | 1.60 | 1.41 | 1.31 | 1.15 | 1.00 |

So "max angle 100°" ≈ `min_i ρ_i ≥ 1.3`, and the detour ratio also catches squeeze caused by
terrain that the angle rule misses. A complementary check is the geodesic-Voronoi **border
lengths** `L_ij`. In a fair 3-way all three pairs share a border; squeeze shows as
`L_jk ≈ 0` (j and k do not touch, i separates them). Score `min L / max L` [D].

### 4.3 Where the draft (SPAWN_GENERATOR.md) already matches the sources

| draft rule | source precedent |
|---|---|
| zones by `r = d_own/d_enemy` (home < 0.6) | Liapis safety `s = (1−r)/(1+r)`, C_s = 0.35 ⇔ r < 0.48 |
| H4/H5 ring counts equal | AoE2 `set_place_for_every_player` distance bands; 0 A.D. identical base mines; Togelius fr1/fr4 |
| H2 distance floor + equal pair distances | Civ VI hard buffer; Civ V impact/ripple; Barros `f_DB` |
| H3 triangle 35-100° | Togelius 2013 120° arcs; detour ratio (4.2) is the geodesic generalisation |
| S8 exposure, `highground` | Togelius 2013 `f1` base on ground; TPI (Weiss); viewshed |
| S9 buildable fraction | Togelius `fb0` base space |
| §6.4 relaxation ladder | 0 A.D. ×0.95 per 25 resets; Civ VI fallback score |
| `patch_overrides` top-up | Civ V `NormalizeStartLocation`, Civ VI `__AddResourcesBalanced` |

Not yet in the draft: amount-weighted **resource safety balance** (Liapis `b_s`/`b_a` on
`R_i^safe`); the **guarded** safe-resource notion (Barros); the **detour ratio** (4.2);
**entrances and chokes** of the home region (BWEM); **rate-weighted** patch value (Catan);
**simulation** validation (Lara-Cabrera); equal-fertility **region cuts** as a constructive
seed (Civ V).

---

## 5. Recommended metric set for our generator (ranked)

Ranking = expected effect on perceived fairness ÷ implementation cost. The normalisation
follows the draft's convention where a penalty is used: 1.0 = "a player would notice".
Balance indices are in [0, 1], 1 = perfect.

### M1. Enemy separation at target distance (hard band + soft equality)
- Source: Togelius `fb1`, Barros `f_DB`, Civ VI buffer, Civ V ripple.
- `d_ij` = travel distance between enemy starts; `d*` = setting.
- Hard rule: `d_ij ≥ 0.85·d*` for every enemy pair.
- Soft penalty:
  ```
  P_sep = Σ_pairs |d_ij − d*| / (0.15·d*)  +  CV(d) / 0.10
  CV(d) = std(d_ij) / mean(d_ij)      (3-way only; Barros' f_DB = 1 − std of normalised d)
  ```
- Normalisation: by `d*`, not the map diagonal, so the setting stays meaningful across map
  sizes.

### M2. 3-way squeeze: detour ratio + border balance (hard + soft)
- Source: Liapis' caveat on >2 bases; Togelius 120° arcs; [D].
- Detour ratio (4.2): `S_sq = min_i (ρ_i − 1)`, which is 1 for equilateral and 0 for
  collinear. Hard rule: `S_sq ≥ 0.3` (≈ max angle 100°).
- Soft penalty: `(0.6 − S_sq)⁺ / 0.2`.
- Border balance: `B = min_{i<j} L_ij / max_{i<j} L_ij` over the geodesic-Voronoi borders on
  playable cells; soft penalty `(0.5 − B)⁺ / 0.2`.
- Normalisation: ρ is already a ratio of distances, and L is normalised by max L.

### M3. Starting kit equality per distance band (hard)
- Source: AoE2 per-player bands, 0 A.D. base mines, Togelius `fr1`/`fr4`.
- For each human start i and band k ∈ {ring0 = [0, R_b], ring1 = (R_b, R_b+R_c],
  ring2 = (R_b+R_c, R_b+2R_c]}: count `n_i^k` and amount `A_i^k` of kept Balterium. The
  alien side gets the same for Biotics with the Nest radius.
- Hard rule: `n_i^0` equal for all humans (both human radii under the Sol/Cent swap).
- Ring1: count ±1; ring2: count ±2. Amounts: `min_i A_i^k / max_i A_i^k ≥ 0.9`.
- Normalisation: amounts by the per-band mean.
- `nearest`: `fr1 = min_i d_i^near / max_i d_i^near ≥ 0.85`, where `d_i^near` = distance
  to the nearest kept patch.

### M4. Amount-weighted resource safety balance (soft)
- Source: Liapis `s`, `b_a`; Barros `f_OR`.
- Formulas:
  ```
  s_{r,i}   = min_{j≠i, j enemy} max(0, (d_j(r) − d_i(r)) / (d_j(r) + d_i(r)))
  R_i^safe  = Σ_{r of i's resource type} v_r · [s_{r,i} > C_s]       C_s = 0.35 (tune 0.25-0.35)
  b_safe    = 1 − 1/(N(N−1)) · Σ_i Σ_{j≠i} |R_i^safe − R_j^safe| / max(R_i^safe, R_j^safe)
  penalty   = (1 − b_safe) / 0.10
  ```
- `v_r` = patch value (M5 note: rate-weighted).
- Also report the **contested fraction** `C = Σ v_r·[max_i s_{r,i} ≤ C_s] / Σ v_r` as a pace
  knob, not a fairness term: high C means fast, aggressive games (Liapis).
- Alien vs human: compare in harvest-minutes, as in draft S2.

### M5. Prospective-territory resources (soft, continuous)
- Source: influence maps (Mark), Civ V equal-fertility regions, Taunt equal areas; [D].
- Formulas:
  ```
  w_i(r) = exp(−d_i(r)/τ) / Σ_j exp(−d_j(r)/τ)          τ ≈ 0.15·d*   (soft Voronoi)
  T_i    = Σ_r v_r · w_i(r) · γ^{hop_i(r)}               γ ≈ 0.7 per extra HQ hop
  b_terr = min_i T_i / max_i T_i
  penalty = (1 − b_terr) / 0.10
  ```
- `v_r` = early income value of the patch, e.g. `min(a_r, cap)·exp(−d_ref(r)/λ)` with
  `d_ref` = distance to the nearest valid refinery spot (Catan lesson: rate, not stock).
- Normalisation: ratio, so independent of the total amount on the map.
- Optional constructive seed: Civ V style recursive cuts that split the total `v` mass into
  N equal parts, with a start near each part's centre (central 34 % first).

### M6. Start exposure: TPI + visible-from area + elevation parity (hard reject + soft)
- Source: Togelius `f1`; Weiss/Jenness TPI; GRASS viewshed; [D] combination.
- Formulas:
  ```
  TPI_std(p) = (z_p − mean_{q: 100 m ≤ |q−p| ≤ R_b} z_q − μ_TPI) / σ_TPI    (map-global μ, σ at that scale)
  V(p)       = |{q : R_1 ≤ |q−p| ≤ R_2, line of sight q→p with 3 m eye/target}| / |annulus|
  O(p)       = fraction of the annulus with z_q > z_p + 5 m that sees p   (overlooked from above)
  ```
- Hard reject: `TPI_std > 1` (Weiss "ridge" class) at scale `R_b`.
- Soft per start: `E_p = 0.4·max(0, TPI_std)/1 + 0.4·V/0.5 + 0.2·O/0.2`.
- Parity: `|z_i − z_j| ≤ 15 m` between enemy starts (Togelius "same elevation"), and
  `ΔE / 0.3`.
- `R_1`, `R_2` ≈ 100 m, 600 m (the draft's ranges).

### M7. Home-region entrances (soft; needs the region builder)
- Source: BWEM watershed, BWTA, Togelius `fp1`.
- Build regions with BWEM's altitude watershed on the walkable grid (walkable = mask valid
  and slope ≤ s_max; merge thresholds rescaled).
- For each start's region: entrance count `k_i` and total entrance width `W_i` (≈ 2 ×
  frontier altitude). Alternative without regions [D]: count passable connected arcs on the
  geodesic ring at `d = R_b + R_c/2`.
- Penalty: `|k_i − k_j| / 1 + |W_i − W_j| / (0.3·mean W)`.
- Also counts towards exposure: more entrances means a more exposed start.

### M8. Validation by headless AI rounds (offline gate, not a search term)
- Source: Lara-Cabrera et al. 2013.
- For the presented top N, run headless AI rounds per layout with sides rotated over the
  start positions.
- Record per side the income curve, territory over time and the winner.
- Accept if no position wins significantly more than 1/N. The imbalance index is
  `mean_t |income_i(t) − mean_j income_j(t)| / mean income`, the counterpart of `P̄ + S̄`
  in their fitness.

**Implementation order**: M1, M3, M2, M4 and M6 use only distance fields, ring counts,
heights and LOS, all inputs the draft already plans. M5 replaces or augments the draft's
hard-Voronoi S1/S2. M7 needs a new builder. M8 needs server time.

---

## 6. Unverified or partly verified items

- Sentient Sketchbook FDG 2013 paper: not downloaded. The formulas come from the AIIDE 2013
  and EvoApps 2013 papers, which were both read.
- Perkins (BWTA) and Uriarte & Ontañón (BWTA2): AAAI PDFs blocked. The algorithm comes
  from Richoux 2022's description.
- PSMAGE: only the draft LaTeX on GitHub was read; the published metrics were not.
- Lara-Cabrera 2013 fitness: exact constants not read (slide OCR garbled), structure only.
- Barros & Togelius: printed formulas have notation errors; the intent is reconstructed.
  Whether distances are A* or Euclidean is not stated.
- Civ VI: read from two mod copies, not the shipped file. The unused `iHighestFertility`
  may be a modder artefact.
- Civ V: read from the Community Patch copy (Firaxis header intact); CP may have changed
  details.
- AoE2: semantics come from the official FE page plus the Racket reference, not from
  Zetnus' DE guide. The Baltic numbers come from a WololoKingdoms copy of the FE script.
- Catan: "no adjacent 6/8", the per-intersection pip limits and the snake-order details
  were not confirmed in the official Almanac text.
- Horn (1981) attribution of the slope kernel: not cited on the Esri page.
- TPI thresholds come from the R `landform` package documentation, not the Weiss poster.
- Openness formula (Yokoyama 2002): not read.
- Everything tagged [D] (the safety ↔ r conversion, the detour ratio and its law-of-sines
  form, hop counts, soft-Voronoi territory, the exposure combination) is our own derivation
  and has not been playtested.
