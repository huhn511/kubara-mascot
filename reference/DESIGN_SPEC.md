# kubara mascot: 3D design spec

Source of truth for `src/model/`. One parametric model drives both the game GLB (`dist/kubara.glb`) and the print files (`dist/print/`).

## 1. Reference material (all in `reference/`)

| File | Origin | What it shows |
|---|---|---|
| `kubara-capybara-profile.png` (350x460, RGBA) | https://kubara.io/mascots/kubara-capybara-profile.png, the image on `/community/` (shown twice there, once mirrored, as two mascots "talking") | **Sitting** capybara in left-facing profile, paws resting on its belly, sunglasses with the strap visible behind the head. |
| `kubara-catch-poses.png` (960x960, RGBA, 2x2 sprite sheet) | https://kubara.io/mascots/kubara-catch-poses.png, the waving "chill teaser" on the home page | 4 **standing** poses, all facing right: walk A, walk B, stride/jog (fists), cheer (arms up, mouth open). |
| `views/pose_*.png`, `views/profile_2x.png` | crops at 2x on white, made with headless Chrome | Enlarged views for close inspection. |
| `favicon.svg/.png`, `kubara_logo_light.svg/.png` | kubara.io `/_astro/` | Brand logo: the capybara head with sunglasses inside a rounded **heptagon** (Kubernetes-style 7 sides) with a black outline. The vector source gives the exact brand colours. |

I checked the GitHub org (kubara-io/kubara docs/images). It has no further mascot art, only a placeholder logo. No front or back view exists anywhere, so the hidden sides below are inferred.

## 2. Character description

- **Species:** a **capybara**, confirmed by the blunt boxy snout, the small round ears on top of the head, the barrel body, the stubby limbs and the absence of a tail. It is drawn as a chibi/cartoon biped standing upright, with a cool and relaxed attitude.
- **Signature accessory:** black **sunglasses** (wayfarer/"deal-with-it" style). Each lens has a flat top edge and a rounded bottom, with one white diagonal glint stripe. The lenses sit on the **sides** of the head, where capybara eyes are. A bridge crosses the forehead, the temple arms run back over or just in front of the ears, and they join a **strap** that wraps around the back of the head. Behind the head, below the rear ear, a short loose strap end sticks out (a small "hook" in every image). **No eyes are ever visible**, so the glasses are the eyes.
- **Head:** big and box-like. It is about 0.52 H long (back of skull to snout tip) and 0.40 H wide. The skull top is flat-ish and slopes into a long, blunt, rounded-rectangle snout. There is no neck: the back of the head flows straight into the back. A black **chin/jaw crease line** runs from under the snout back about two thirds of the head length, which separates head from chest at the front only.
- **Muzzle:** the front of the snout is a **darker teal patch** (an oval cap). In the logo it is brand `#0ABEBE`. Two small **nostril** dashes sit at the top of the muzzle, slanted slightly like "\ /". A short philtrum line runs down to a small "w"/cat-smile **mouth**. In the cheer pose the mouth opens wide (dark interior, pink tongue).
- **Ears:** two small half-round ears on top of the skull, set back toward the rear and wide apart. They have a slightly darker or concave inner area.
- **Body:** a pear/barrel shape, widest at the lower belly (about 0.56 H wide, about 0.50 H deep). The belly bulges slightly forward and the bottom is round, with the rump sitting just above the feet.
- **Arms:** short and stubby, from the shoulders at about 0.52 H. The paws are round mittens with 3 to 4 short finger grooves. At rest they hang down with the paws resting on the sides of the belly (profile image), or they make loose fists when walking.
- **Legs:** very short and thick (only about 0.12 H visible below the belly). The feet are rounded, longer than wide, with **3 toe grooves** at the front.
- **Tail:** none visible. Capybaras are effectively tailless. Do not add one.
- **Clothing/logos:** none on the mascot itself. The kubara heptagon logo is a good candidate for the print base (see §6).
- **Art style:** a flat 2-tone cel style with a **thick black outline** (about 2.5 to 3 % of figure height). The light fur is the main tone. A darker teal shade sits on the side and back away from the viewer, under the chin and on the muzzle. A thin **white rim highlight** runs along the lit silhouette edge (between the outline and the fur). No gradients and no texture.
- **Hidden back/sides (inferred):** one continuous smooth rounded back from the skull to the rump. The glasses strap crosses the back of the head horizontally at about 0.86 H, just below the ears, and has a short loose end on the character's **right** side (the side away from the viewer in the profile). The back is plain fur with no markings, and there is no tail.

## 3. Palette (sampled programmatically from the PNGs, with brand values from the logo SVG)

| Token | Hex | Used on | Source |
|---|---|---|---|
| `fur` | **#9BE0DF** | body, head, arms, legs, ears (outer) | median of the light fur pixels (profile #9BE0DF, poses #94DFE0, logo #A0E6E6) |
| `fur_shade` | **#21B3B4** | muzzle, ear_inner, (optional) foot soles | profile shade #21B3B4, poses #44B5BC, logo #0ABEBE |
| `ink` | **#0A0F0F** | glasses frame and lenses, strap, nostrils, mouth line, toe/finger grooves, game outline | art #020303, logo #000A0A; slightly lifted so PBR still shows form |
| `glint` | **#FCFDFD** | lens glint stripes (also the game rim light colour) | sampled white |
| `mouth_inside` | #3A1414 | open-mouth variant only | estimate |
| `tongue` | #F07073 | open-mouth variant only | sampled pink (cheer pose) |
| `brand_teal` | #0ABEBE | print base plate (optional) | logo SVG |

Game PBR suggestion: metalness 0 and roughness about 0.8 for fur, 0.3 for the lenses, with flat colours. Toon option: a `MeshToonMaterial` with a 2-step gradient plus an inverted-hull outline in `ink`.
Print filaments (Bambu AMS, 4 slots): light mint/aqua (fur), turquoise (fur_shade), black (ink), white (glint).

## 4. Coordinate frame and proportions

- Y-up, units in metres, **total height H = 1.0** (ground to the top of the ears), origin = the point on the ground plane between the feet, character faces **+Z**.
- **`_l` = the character's left = +X**; `_r` = −X.
- The proportions are measured from the standing sprites (with the cheer pose as the front reference and walk A as the side reference), normalised to H:

| Landmark | Y | Notes |
|---|---|---|
| top of ears | 1.00 | |
| top of skull | 0.91 | |
| glasses / eye line | 0.84 | |
| snout centre | 0.75 | snout tip at z ≈ +0.33 |
| chin crease (head/body seam at front) | 0.60 | ≈ 2.5 heads tall (head ≈ 0.31 without ears, 0.40 with) |
| shoulders | 0.52 | |
| widest belly | 0.33 | half-width 0.28, half-depth 0.25 |
| crotch / rump bottom | 0.12 | |
| ankles | 0.06 | |
| ground | 0.00 | |

Overall bounding box (idle pose): x ≈ ±0.31 (paws), z ≈ −0.25 … +0.34 (snout tip).

## 5. Part list (GLB node names)

The hierarchy is `kubara` (root, at the origin) → `body` → {`head` → {...}, `arm_l`, `arm_r`}, plus `leg_l` and `leg_r` under `body`.
Each node's **origin is its pivot**, given in world coordinates for the rest pose. Geometry values are world-space centres and radii for the idle pose. "SDF" means signed-distance primitive blended with smooth-min (k = blend radius).

| Part | Parent | Pivot (x,y,z) | Shape suggestion (world coords, rest pose) | Colour |
|---|---|---|---|---|
| `body` | kubara | (0, 0.14, 0) hips | Smooth-min (k 0.08) of: ellipsoid C(0,0.33,0.01) R(0.28,0.24,0.25) lower belly; ellipsoid C(0,0.47,−0.01) R(0.23,0.17,0.21) chest; ellipsoid C(0,0.18,−0.01) R(0.22,0.10,0.20) rump. The chest top tucks under the head (overlap with head ≥ 0.05 so the union is solid). Belly front max z ≈ +0.26. | fur |
| `head` | body | (0, 0.60, −0.03) neck | Smooth-min (k 0.06) of: cranium ellipsoid C(0,0.765,−0.03) R(0.20,0.15,0.19); snout = rounded box C(0,0.745,0.17) half(0.15,0.115,0.15) corner r 0.09, tilted 5° nose-down; snout tip z ≈ +0.33. Underside: blend the snout bottom into the chest with ≤ 45° slope (see print notes). Jaw crease: a shallow groove (0.012 deep, 0.015 wide) along the chin from z +0.26 to z −0.02 at y ≈ 0.605 (game: optional ink line). | fur |
| `muzzle` | head | (0, 0.745, 0.30) | Colour cap = the snout geometry intersected with half-space z > 0.27 (the oval front face of the snout, about 0.24 w × 0.20 h), shell ≥ 0.02 thick. | fur_shade |
| `nostril_l` / `nostril_r` | head | (±0.045, 0.80, 0.325) | Capsule length 0.04, r 0.011, lying on the muzzle surface, rotated ±25° so they form "\ /". Inset half into the surface. | ink |
| `mouth` | head | (0, 0.70, 0.32) | Tube r 0.010 following the muzzle surface: philtrum (0,0.77)→(0,0.715), then two arcs to (±0.05, 0.705) curling up at the ends ("w" smile). Inset half. | ink |
| `ear_l` / `ear_r` | head | (±0.135, 0.90, −0.10) ear base | Flattened sphere C(±0.14, 0.94, −0.10) R(0.058, 0.058, 0.032), yawed ±20° outward, lower 30 % buried in the skull. Top reaches y 1.00. | fur |
| `ear_inner_l` / `ear_inner_r` | ear_* | same as ear | Disc R(0.034, 0.034, 0.012) on the front face of the ear, inset 0.006 (concave look). | fur_shade |
| `glasses` | head | (0, 0.86, 0.12) bridge centre | Group node, frame only: bridge (curved capsule over the forehead from lens to lens, r 0.016, at y 0.87, z ≈ +0.15) + temples (capsules from each lens rear edge back to z −0.10 at y 0.865) + strap (a band 0.03 tall × 0.016 thick, hugging the skull at y 0.855 around the back at z ≈ −0.215, passing just **below/in front of** the ears) + `strap_tail` (a short capsule 0.06 × r 0.014 sticking back and down at (−0.12, 0.85, −0.22), the character's right side). All are offset 0.008 outside the head surface (so they read as raised) and embedded ≥ 0.01. | ink |
| `lens_l` / `lens_r` | glasses | (±0.165, 0.84, 0.07) | "D" shape: flat top edge, rounded bottom. Width 0.15, height 0.12, thickness 0.03, gently curved to follow the head. Faces outward-forward: yaw ±50° from +Z, so the lenses read well from both front and side. The top edge is level with the bridge. The lens sits proud of the head by 0.02 and is embedded 0.01. | ink |
| `glint_l` / `glint_r` | lens_* | lens centre | A diagonal stripe on the outer lens face, width 0.028, running from the upper-front to the lower-rear corner, clipped to the lens outline. Game: a separate thin mesh 0.003 proud. Print: a 0.008-deep (0.6 mm) inlay region of the lens. | glint |
| `arm_l` / `arm_r` | body | (±0.215, 0.52, 0.01) shoulder | Upper arm = capsule from the shoulder to (±0.265, 0.36, 0.10), r 0.055 → 0.048; it starts inside the body. | fur |
| `hand_l` / `hand_r` (paw) | arm_* | (±0.265, 0.36, 0.10) wrist | Flattened sphere C(±0.255, 0.32, 0.135) R(0.058, 0.055, 0.048), with 3 finger grooves on the front/bottom (0.006 deep, ink in the game). **Rest pose: the paw touches/overlaps the belly side** (as in the profile art). | fur |
| `leg_l` / `leg_r` | body | (±0.14, 0.14, 0) hip | Capsule from the hip to (±0.15, 0.06, 0.02), r 0.08; merges into the foot. | fur |
| `foot_l` / `foot_r` | leg_* | (±0.15, 0.06, 0.02) ankle | Ellipsoid C(±0.15, 0.04, 0.05) R(0.08, 0.05, 0.115), **cut flat at y = 0** (the sole). Toes point forward to z ≈ +0.165, slight 5° outward splay. 3 toe grooves across the front top (0.006 deep). Optional sole colour fur_shade. | fur |
| `print_base` | (print only, not in GLB) | (0,0,0) | Rounded **heptagon** (like the kubara logo) with circumradius 0.33, thickness 0.035, corner radius 0.04, one flat edge at the back. The figure sits on top of it (the print shifts the figure up by the base thickness). Optional engraved "kubara" on the front edge, 0.006 deep. | ink or brand_teal |

Optional variant parts (off by default): `mouth_open` (an open-mouth cavity with `tongue`, for the cheer animation).

**Triangle budget (game, ≤ 30k total):** body 7k, head 7k, muzzle 1k, ears 2 × 0.6k, glasses (frame + lenses + glints) 3k, arms + hands 2 × 1.8k, legs + feet 2 × 1.8k, small ink details 1k. Decimate the level-set output per part to hit these numbers.

**Pose presets (parameters on the model):**
- `idle` (default, used for both print and game): standing straight, arms hanging forward-down with the paws on the belly sides, head straight.
- `sit` (the community-page picture, optional): body tilted back 10°, legs rotated 85° at the hips so the feet point forward with the soles facing +Z, the rump resting on the ground at y 0, paws on the belly. Very stable for printing.
- `cheer` (arms up about 140° at the shoulders, `mouth_open`) and `walk` are for game animation only, done by rotating the part pivots.

## 6. Notes for 3D printing (default 80 mm tall, so 1 unit = 80 mm and 0.015 units = 1.2 mm)

- **Minimum feature:** 0.015 units (1.2 mm). Every value above is at or above this: strap 0.03 × 0.016, nostril/mouth tubes 0.02–0.022 diameter, glint 0.028 wide. Do not shrink these when scaling the print below 80 mm. Instead, clamp them to 1.2 mm absolute.
- **Single shell (`kubara.stl`):** the boolean union of all parts (and `print_base` if enabled). All accessories are embedded ≥ 0.01 into the fur, so nothing floats or forms zero-thickness contacts. Paws and the strap tail must overlap the body/head.
- **Multi-colour parts (`parts/*.stl`, 3MF):** group by colour. **fur** = body ∪ head ∪ ears ∪ arms ∪ hands ∪ legs ∪ feet minus every other colour group. **fur_shade** = muzzle ∪ ear_inner (∪ soles). **ink** = glasses frame ∪ lenses ∪ nostrils ∪ mouth (∪ base), minus glint. **glint** = glint stripes. Subtract neighbours so the groups do not overlap, and keep one shared coordinate frame. Inlays (nostrils, mouth, glints, ear_inner) should go ≥ 0.6 mm deep so the colour survives a face-on top layer.
- **Flat bottom:** the feet are cut flat at y = 0. Each foot is ≈ 13 × 18 mm, which is printable without a base, but the heavy forward head (snout tip at z +0.33 versus toes at +0.165) makes it top-heavy. Default to **`print_base` on** (2.8 mm heptagon) for adhesion and stability, as an option.
- **Overhangs:** the underside of the snout/chin is the main overhang. Blend the snout bottom into the chest with ≤ 45° (smooth-min k ≈ 0.06) and keep the jaw crease as a shallow groove rather than an undercut. Also blend the ear undersides, the arm undersides and the belly-to-leg fold. A small amount of tree support under the chin is acceptable.
- **Fragile bits to avoid:** no free-standing strap tail (lay it flat against the head), no separated fingers (grooves only), no gap between arm and body thinner than 2 mm (in the idle pose they touch, so fuse them).
- No outlines or rim light in print. The colour regions alone carry the look.

## 7. Notes for the game (three.js)

- Keep the silhouette **chunky**: big head, wide flat-topped skull, oversized sunglasses. These read at small sizes. Do not add thin details beyond what is listed.
- Separate nodes with pivots at the joints (listed above), so `head` can bob/turn, `arm_*` can swing/wave (the site's own wave animation rotates about the bottom of the body ±4°, which suits an idle sway on `body`), and `leg_*` can step.
- Recreating the 2D art look: inverted-hull outline (backfaces, `ink`, about 0.008 units thick, i.e. the outline shell grown along the normals), a 2-tone toon ramp (fur → a fur_shade-ish shadow), and an optional fresnel rim in `glint` white. Flat colours, no textures needed.
- Materials: one material per palette token (`fur`, `fur_shade`, `ink`, `glint`) shared across parts, with GLB material names matching the tokens.
