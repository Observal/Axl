<!-- SPDX-FileCopyrightText: 2026 Hari Srinivasan -->
<!-- SPDX-FileCopyrightText: 2026 Dheirav -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Mascot art assets

Status: assets complete for 21 states, from our own poses (no third-party art), and integrated into the terminal client. Read [Limitations](#limitations) before relying on it: the text version, fullscreen and Windows Terminal each have gaps. See [ART_NEXT.md](ART_NEXT.md) for the remaining art gaps.

Updated: 2026-09-27

The mascot is a pixel-art axolotl in a 219 by 150 frame that reflects what the harness is doing. The frame is wide because every pose is at one scale, and the lying and swimming poses are wider than the upright ones are tall. The art is a set of poses on a pixel grid (cell 5.8), edited in Aseprite, with the eyes pure black; `pipeline/README.md` has the flow. Every client draws the same frames from the same manifest. Nothing here changes session semantics; a client that cannot draw the mascot omits it.

## Contents

- [Where the assets are](#where-the-assets-are)
- [States](#states)
- [The segment model](#the-segment-model)
- [Player contract](#player-contract)
- [How the client draws it](#how-the-client-draws-it)
- [Render packs](#render-packs)
- [Placement and motion](#placement-and-motion)
- [Colours](#colours)
- [Conventions](#conventions)
- [Regenerating](#regenerating)
- [Editing the art](#editing-the-art)
- [Verification](#verification)
- [Limitations](#limitations)

## Where the assets are

The runtime assets are committed under `packages/tui/assets/mascot/`: the manifest, one indexed atlas and its mirrored copy for the facing flip, and the `small` half-block pack, all in the first colour. Every other colour is a palette in the manifest (see [Colours](#colours)). The editable sources and the build scripts live outside the repository, beside it in `~/Code/Axl/`:

```text
pipeline/            Python with Pillow only; pipeline/README.md has the flow
mascot-source/       colours.json: the shipped colours and the drafts
rig/poses-5.8/       the Aseprite sources: art/ holds the poses, states/ the states edited frame by frame
rig/harness-5.8/     build output: atlas-Pink.png and its mirrored copy, axolotl.json,
                     anchors.json, small-Pink.json, and preview GIFs
```

The manifest and the atlases are the runtime truth. Everything else is derived from them or is a preview.

Provenance: the art is our own and is Apache-2.0 like the rest of the repository. It replaces art derived from a purchased itch.io pack, whose terms did not allow publishing it in a public repository. No pack art, and no pack-derived frame, is in the shipped assets.

## States

| State | Kind | Segments | Length | Hands off to | Harness meaning |
| --- | --- | --- | --- | --- | --- |
| `waking` | transition | in 24 | 2.6s | `waiting` | Session start |
| `waiting` | loop | loop 24 | 2.9s |  | Idle, awaiting input. Blinks once per loop |
| `idle` | loop | loop 24 | 2.9s |  | Backgrounded or long idle. Lying down, blinks |
| `thinking` | loop | loop 16 | 1.9s |  | Model reasoning before output |
| `typing` | loop | loop 12 | 0.8s |  | The user is typing. See the typing rule below |
| `working` | loop | in 18, loop 10 | 1.7s + 0.8s |  | Tool calls and other activity. Its loop is the swim stroke, and the sprite patrols while it plays |
| `swim` | loop | loop 10 | 0.8s |  | The swim stroke on its own. Nothing plays it by itself yet |
| `dash` | loop | loop 12 | 0.8s |  | Unused. Kept for a future travelling pose; typing dives under the bar and surfaces at the cursor instead |
| `file_change` | oneshot | in 7 | 0.6s | `working` | A file was written |
| `success` | oneshot | in 23 | 2.0s | `waiting` | Task completed |
| `ask` | loop | in 8, loop 12 | 0.8s + 1.4s |  | A permission or interaction request is waiting on the user. Held until it is answered |
| `blocked` | oneshot | in 17 | 2.1s | `waiting` | A sandbox violation |
| `nod` | oneshot | in 5 | 0.5s | `working` | A message was queued |
| `split` | oneshot | in 25 | 3.9s | `working` | Subagents spawned. Not triggered yet |
| `compact` | loop | in 7, loop 2, out 6 | 0.7s + 0.2s + 0.8s |  | Context compaction in progress |
| `clear` | oneshot | in 17 | 1.8s | `waiting` | `/clear`. Not triggered yet |
| `sass` | oneshot | in 24 | 2.7s | `waiting` | `/mascot sas`. Played only on request, never from an event |
| `error` | transition | in 12 | 1.9s | `severed` | A turn failed. Cut in two |
| `severed` | loop | loop 4 | 3.2s |  | Stopped after an error |
| `resume` | transition | in 17 | 2.7s | `working` | Retry after an error. Regrows, swims up |
| `dead` | loop | in 15, loop 1 | 1.7s + 0.4s |  | Gave up. Holds the last frame. Fires on `session.closed` with reason `failed`, and on an interrupt |

`kind` values:

- `loop`: holds for as long as the state lasts.
- `oneshot`: fires over whatever is running, then hands to `next`.
- `transition`: bridges two sustained states, then hands to `next`.

## The segment model

Every state is up to three segments: `in`, `loop`, `out`. A player plays `in` once, repeats `loop` until told to leave, and plays `out` on the way out. No asset encodes how long a state lasts. A 200 ms tool call and a 20 minute build both use `working`.

Two rules follow from this:

- A loop can be cut at any frame. Every transition therefore carries an impact frame at index 1 (a white flash or similar) so the cut is masked rather than smoothed. Do not wait for a loop to finish before starting an interrupt; that adds up to a whole loop of latency exactly when latency is unacceptable.
- `compact` is a held state, not a one-shot, because compaction takes as long as it takes. Play `compact`, and when compaction finishes leave it gracefully so the spring-out plays.

## Player contract

The player is `MascotPlayer` in `packages/tui/src/mascot.ts`:

```text
play(state)                       cut to the state now. Plays in, then loop or next.
play(state, { graceful: true })   finish the current loop cycle, play out if present, then switch.
tick(now) -> changed              advance the clock. True when the visible frame changed.
frameId()                         the atlas slot to draw.
```

It takes time only from `tick()`, in whole milliseconds, so a `play()` from an event handler cannot start a segment on a different clock. `packages/tui/test/mascot.test.ts` checks the order: in then loop, graceful then out then the pending state, transition then next, oneshot then next.

Priority rules the harness must apply:

- `typing` starts on the first keystroke and ends about 600 ms after the last. It only takes over from `waiting` or `idle`. While the harness is working, what it is doing matters more than what the user is doing.
- `file_change` is 0.6 s. Fire it once per burst of edits, not once per file, or it stutters.
- `error` is dramatic and 1.9 s. Reserve it for turns that fail. An interrupt plays `dead`, and a recoverable tool error plays nothing.

## How the client draws it

The client is five pieces in `packages/tui/src/`, and each is tested on its own:

- `mascot.ts`: the manifest parser and the player. The player only keeps time. It plays a state's `in`, `loop` and `out` segments in order, hands off to the state's `next`, and says which atlas frame to show.
- `mascot-director.ts`: maps session events onto states (a prompt is `thinking`, a tool call is `working`, a permission request is `ask`, and so on). It is the only piece that knows about the session.
- `mascot-actor.ts`: where the sprite sits in its strip, in cells. See [Placement and motion](#placement-and-motion).
- `mascot-render.ts`: the component that turns the frame and the placement into terminal rows, the Kitty renderer, the text pack loader, and the colour swaps.
- `mascot-sixel.ts`: the indexed PNG decoder and the sixel encoder.

`/mascot` turns it on. The app ticks it every 50 ms and repaints only when the frame or the placement changed. It picks a drawing when it is turned on, and again when the display mode changes:

1. Kitty graphics, when `media.ts` detects Kitty (from environment variables such as `KITTY_WINDOW_ID`) or `AXL_IMAGE_PROTOCOL=kitty` asks for it. The atlas is sent once and each frame is a placement of one rectangle of it, four rows tall.
2. Sixel, when the terminal lists sixel (`4`) in its device attributes and answers `CSI 16 t` with its cell size. The app asks for the cell size only when the mascot is turned on and waits up to 400 ms. If the answers come later it starts in text and switches to sixel when they arrive. Each frame is encoded from the atlas the first time it is drawn, four rows tall, and cached.
3. The half-block text pack otherwise, and always in fullscreen. It is converted to 256 colours at load when the terminal does not report 24-bit colour.

The Mascot section of `docs/terminal-compatibility.md` lists what each terminal gets.

## Render packs

The atlas is a plain PNG. The terminal packs pre-encode every frame as a string of escape sequences so drawing is one write.

| Pack | Glyphs | Cells (219x150 art) | Swim pose height | Fidelity |
| --- | --- | --- | --- | --- |
| `small` | half blocks (`▀`, `▄`) on art shrunk to 24 px tall, 1x2 per cell | 35x12 | 6 rows | Every pixel keeps its own colour |

The build emits only `small`, the pack the client uses. There is no sixel pack: the client encodes sixel frames from the atlas at run time.

Each JSON pack carries `frames` (one list of row strings per atlas slot), `cell`, `encoding`, and per-state and per-segment `crop` rows so a client can trim blank rows. Transparent cells emit `ESC[49m` and never paint a background, so the sprite composites over whatever is on screen.

The pack used to be sextants at 17x8, which need a font with Unicode 13 Symbols for Legacy Computing and drew as boxes without one. Half blocks are in every monospace font, so the pack now draws the same everywhere. The height was picked from recordings of the real client at 16, 20 and 24 px: 24 px (12 rows) keeps the face readable while still fitting above the composer.

The pack is built with 24-bit colour codes. When the terminal does not report 24-bit colour, the client rewrites each code once at load to the nearest of the 256 xterm colours (the 6x6x6 cube or the grey ramp, whichever is closer), so the frames still draw in one write.

Which drawing a client uses, and in which terminals, is in the Mascot section of `docs/terminal-compatibility.md`: Kitty graphics where detected, sixel where the terminal reports it and its cell size, and the `small` half-block pack everywhere else and always in fullscreen.

The sixel path (`packages/tui/src/mascot-sixel.ts`) decodes the indexed atlas once to palette indices and encodes each frame the first time it is drawn, four rows tall at the terminal's cell size, in the colour's palette. Each segment's `bottom_margin` moves the art down so its lowest pixel sits on the bottom of the strip. A sixel image is part of the text grid rather than a placement above it, so the strip is cleared and the frame drawn in one write, from the strip's last line, with the cursor saved and restored around it.

## Placement and motion

The mascot lives in a strip directly above the composer. Placement is `MascotActor`, and the rules are:

- The strip keeps one height for every state, so the composer never moves: four rows with Kitty or sixel, and the text pack's 12 rows otherwise. The art moves inside it.
- Its home is two columns from the left edge. Floor states (`severed`, `dead`, `idle`, `waking`, `error`) glide back there.
- `working` holds still through its coil wind-up and then patrols the strip end to end at 9 columns a second, turning at each edge.
- On the first keystroke, `typing` dives under the composer, moves to the cursor while hidden, and surfaces beside it with its arms on the composer's line. Swimming the distance in view could not keep up with typing. It follows the cursor while you type.
- The art faces one way. With Kitty and sixel the sprite is drawn from a mirrored atlas when it travels the other way. The text pack has no mirrored frames, so there it swims backwards when it heads right.
- With Kitty and sixel the lowest pixel of a pose sits exactly on the composer's line, because the build records the clear space under each segment (`bottom_margin`). The text pack can only place by whole rows.

## Colours

Four colours ship: Pink (the art's own palette), Albino, Purple and Deep_Sea, chosen with `/mascot <colour>`. Every colour is a palette swap of one set of frames, so geometry, frame indices, manifest and anchors are identical by construction. The atlas is an indexed PNG, and the manifest holds each colour's palette, index for index. The client draws a colour by rewriting the atlas's palette chunk and its checksum, and by swapping the colour codes in the glyph pack, so nothing is decoded and one set of art serves every colour. A user's own `atlas-<Colour>.png` still takes precedence.

The palettes come from `pipeline/colours.py`: every colour in the art belongs to a group (skin, blush, gill, eye, outline, or fixed for props), and a colour gives each group a new base that the group's colours follow, keeping their hue offset, share of saturation and place between the base and white or black. `mascot-source/colours.json` holds the groups, the shipped colours and drafts that are not built; the colour tool (`pipeline/colour_tool.py`) edits it on the live animation. Black, Blue, Brown and Red are drafts: their pure black eyes clashed with the body, and they have eye colours of their own to review.

Colour is the only spare channel in the set. It can encode which agent, or which kind of work. It cannot do both. Decide before spending it.

The palette is seventeen colours: sixteen shared by every pose, from a k-means over the downscaled set, plus pure black for the eyes and nothing else, because blinks, X eyes and accessory anchors find the eyes by it.

## Conventions

- Upright poses are conversational: `waiting`, `thinking`, `typing`. Horizontal poses are work: `working`, `file_change`, `error`, `compact`. A viewer learns this without being told. Keep it.
- The eyes are the only pure-black pixels in the art. Tooling relies on that to find them for X eyes and blinks.
- The severed edge is the body colour darkened to 45 percent with the hue held, never black.

## Regenerating

The build is a set of Python scripts (Pillow only) at `~/Code/Axl/pipeline/`, beside this repository and not tracked by it. By decision it stays outside the repository, like Aseprite itself; only the built assets are committed. Its README covers the whole flow.

```bash
AXL_POSES=../rig/poses-5.8 python3 build_mascot.py   # ../rig/harness-5.8/: atlas, mirrored atlas, axolotl.json, anchors.json, small pack
python3 preview_gifs.py                              # ../rig/harness-5.8/preview/<state>.gif and a contact sheet
```

Then copy `atlas-*.png`, `axolotl.json` and `small-*.json` from `rig/harness-5.8/` into `packages/tui/assets/mascot/`.

## Editing the art

The sources are Aseprite files in `rig/poses-5.8/`:

- `art/<pose>.aseprite` holds one pose each; frame 1 is the pose. States are built from these poses and the motion tables in `pipeline/animate.py`: a translation per frame, a column-wise wave for swimming, a squash for breathing, an eye redraw for a blink or X eyes. Change timing or travel there.
- `states/<state>.aseprite`, where one exists, is that state edited frame by frame, with a tag per segment (`in`, `loop`, `out`). The build takes such a state exactly as it is in the file, so changes to its poses or to `animate.py` no longer reach it until the file is deleted or exported again (`export_aseprite.py animations --force`).
- Props that animate over a pose (the question mark, sparkles, sweat drop, bubbles, impact marks) are `clean/<pose>-props.png`.

## Verification

- `build_mascot.py` prints how many frames carry an eye anchor. Poses with closed or X eyes (hurt, dead, success) have none by design; every open-eyed frame must.
- `packages/tui/test/mascot.test.ts` loads the bundled atlas and pack in every shipped colour and checks each recoloured PNG, so a broken asset or palette fails there. It needs Node 22 or newer.
- The GIFs in `rig/harness-5.8/preview/` are the review surface: in once, loop twice, out once, per state.

## Limitations

What the mascot does not do yet, or does worse in some terminals. The same list is in the pull request.

Drawing:

- **Windows Terminal leaves a slice behind.** After the screen scrolls, a slice of an older sixel frame can remain above the mascot until something redraws that row. The same bytes replayed in xterm.js leave nothing, so it looks specific to how Windows Terminal erases sixel images. It is not fixed.
- **Fullscreen is always text**, because the application scrolls the transcript itself and an image cannot follow it.
- **The text version is three times as tall.** It is 35 columns by 12 rows, where Kitty and sixel use 4 rows, so it takes much more room above the composer, which matters on a short terminal. 12 rows was chosen over 8 and 10 because the face stays readable.
- **The text version cannot face the other way** and can only place by whole rows, so it swims backwards when heading right and does not sit exactly on the composer's line.
- **256 colours are an approximation.** Close shades can land on the same xterm colour, so the shading flattens, most visibly in the pinks and the blush.
- **Detection is by signals the terminal gives.** Kitty is recognised from its environment variables, so Kitty over SSH without them gets text unless `AXL_IMAGE_PROTOCOL=kitty` is set. 24-bit colour is recognised from `COLORTERM`, `TERM` and known terminals; an unrecognised terminal gets 256 colours even if it could do more, and `COLORTERM=truecolor` fixes that.
- **Sixel waits on the terminal.** On a slow link the device attributes or cell size can arrive after 400 ms; the mascot then shows in text first and switches to sixel.
- **A dialog takes priority on a short terminal.** The mascot stays above a question, permission or picker dialog when both fit. When they do not, the dialog is drawn alone and the mascot comes back when it closes. The text version needs 12 rows for that, the images 4.
- **tmux and screen turn the Kitty path off.** Whether sixel works inside them depends on the multiplexer and has not been tested, so expect text.
- **Verified in two terminals only**: Kitty 0.32 under WSLg and Windows Terminal 1.24. Every other row in the terminal table is what the detection should pick, not something that was checked.

Behaviour:

- `split` (subagents) and `clear` are drawn but never triggered: there is no spawn event and no `/clear` command. Streaming a reply has no state of its own, since `typing` belongs to the user. See [ART_NEXT.md](ART_NEXT.md).
- It cannot show progress, which kind of work is running, or how many subagents there are.
- It is off in every new session; `/mascot` and the chosen colour are not remembered.
- Only the terminal client has it. The web client does not.
- Between poses, motion inside the creature is procedural: the gills, tail and body move, while arms and legs only change where a state has a pose for it.

