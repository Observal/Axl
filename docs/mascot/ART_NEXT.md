<!-- SPDX-FileCopyrightText: 2026 Hari Srinivasan -->
<!-- SPDX-FileCopyrightText: 2026 Dheirav -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Mascot art: handover and next steps

Status: art complete and integrated into the terminal client. Read [ART.md](ART.md) first.

Updated: 2026-09-27

## Where things stand

- 21 states in 4 colours, 310 unique frames, in a 219 by 150 frame. Since 2026-09-23 the shipped art is the pose set at cell 5.8 (`rig/poses-5.8/`), because in real Kitty it reads better than the older 72 by 48 set at both normal and HiDPI cell sizes. The renderer draws every state at one scale: it used to size the source window from each pose's band and let the terminal stretch it into whole rows, which drew typing 27% larger than waiting and several states 15 to 20% larger. Typing's small raise now lives in the art (`animate.py`), because a renderer lift could only crop and stretch. Each atlas is about 290 KB. The purchased pack is not an input to anything that ships.
- Between poses, motion inside the creature is procedural (`alive()`, `gill_sway()` and `tail_sway()` in `animate.py`). `waiting`, `thinking` and `typing` swing the gill fans on the bob's period, lagging it, and sway the tail on a slower period; `success` trails its gills against the leap. Arms and legs only change where a state has a pose for it.
- Colours are palettes over one indexed atlas; see Colours in ART.md. Four ship, and four more are drafts in `mascot-source/colours.json`.
- States move through in-between poses rather than cutting between single poses.
- Outside the repository, a web player and a Python player implement the same contract, and a terminal demo shows placement, motion and typing at the composer.
- The runtime assets are committed under `packages/tui/assets/mascot/`: the manifest with every colour's palette, one indexed atlas and its mirrored copy, and the `small` half-block pack. The editable sources and the build scripts stay outside the repository.

## Integration steps, as built

All of these are done. Kept because the event mapping is the useful record.

1. Assets live in `packages/tui/assets/mascot/`: the manifest, one atlas and its mirrored copy, and the `small` pack, all in the first colour. The other colours are palettes in the manifest.
2. Ported as `mascot.ts` (player), `mascot-actor.ts` (placement), `mascot-director.ts` (event mapping) and `mascot-render.ts` (pack and atlas rendering). The player takes its time only from `tick()`, so a `play()` from an event handler cannot start a segment on a different clock; the Python reference drifts because it accumulates float seconds, and matching it required integer milliseconds.
3. Event mapping as implemented. `split`, `clear`, `dash` and `swim` are unmapped (`swim` plays as working's loop), see below:

   | Event | State |
   | --- | --- |
   | session attached | `waking`, then `waiting` |
   | user keystroke, from `waiting` or `idle` | `typing` |
   | prompt submitted | `thinking` |
   | tool call started | `working` |
   | file written | `file_change` (once per burst) |
   | turn completed cleanly | `success`, then `waiting` |
   | subagents spawned | `split`, unmapped: no spawn event exists |
   | `/compact` sent, then `context.compacted` | `compact`, left gracefully so the spring-out plays |
   | `/clear` | `clear`, unmapped: the terminal has no `/clear` yet |
   | `permission.requested`, `interaction.requested` | `ask`, held until the matching `resolved`, then `working` |
   | `sandbox.violation` | `blocked`, then `waiting` |
   | `queue.enqueued` | `nod`, then `working` |
   | turn failed | `error`, then `severed` |
   | interrupt (turn ends `aborted`) | `dead` |
   | retry after failure | `resume` |
   | gave up | `dead`, on `session.closed` with reason `failed` |

   `typing` and `file_change` carry the priority rules in `ART.md`. Apply them in the mapping, not in the player.
4. Render pack chosen per terminal capability: the Kitty image path where available and not fullscreen, sixel where the terminal reports it, and the `small` half-block pack otherwise. The source is rebuilt when the display mode changes.
5. `packages/tui/test/mascot.test.ts` feeds scripted event sequences and asserts the states and frame ids the player yields.

## Why the mascot lives in the TUI and not in an extension

`AGENTS.md` asks that first-party features use the same public extension API as
third-party ones, and that disabling a feature removes its UI and background
work. The mascot does not follow that rule. It is wired into `packages/tui`
directly, with its own timer. This was investigated and is deliberate: the
public extension API cannot carry it today, and the changes that would make it
possible are not cosmetic.

**A widget cannot emit a graphics escape.** `ExtensionWidgetsComponent` passes
every `TerminalLine` through `sanitizeTerminalText` and then collapses
whitespace (`packages/tui/src/extension-ui.ts`). Feeding it a Kitty placement
escape returns an empty string: the escape is stripped entirely, and the
whitespace collapse would also destroy the indent that positions the sprite.
That is the boundary working as intended. `AGENTS.md` says to treat extension
packages as untrusted input, and stripping escapes is what stops an extension
performing terminal injection. Exempting extensions from it is a security
decision, and being first-party is not a reason: the same document says
first-party features use the same public API as third-party ones.

**There is no input event.** `TerminalExtensionEventInput` is `session.event`,
`working.start` and `working.end`. A keystroke in the composer is not a
canonical event, so an extension cannot know the user is typing, and the
`typing` state could not be driven at all.

Moving the mascot therefore needs two capability-contract additions: a trusted
widget surface whose rows bypass sanitisation, and a terminal input event. Both
belong in the protocol and need design agreement first.

Until then the mascot stays a presentation concern of the terminal client,
which has precedent: `packages/tui/src/media.ts` renders inline images by
emitting graphics escapes directly, for the same reason. Splitting the feature,
with the player and director in an extension and rendering left behind, would
scatter it for no gain.

## States with no trigger yet

- **`split`** means subagents spawned, and that is the right trigger, but no event
  exists for it. The protocol carries `child.result` for a child finishing, not
  a child starting, so firing on it would play "spawned" at the moment one ends.
  Ordinary sessions also have no model-visible subagent capability by default,
  and child sessions are roadmap phase 8. Add a `child.started` event with that
  work, then map it here. Unmapped until then.
- **`dash`** is a held travelling pose kept for future use. Typing dives under
  the bar and surfaces at the cursor instead of crossing in view, so nothing
  plays it today.
- **`swim`** is the stroke on its own. It is also the loop of `working`, so the
  patrol already swims: the actor holds still through the coil wind-up and
  travels once the stroke starts. Nothing plays `swim` by itself yet.
- **`clear`** is drawn for `/clear` wiping the context, and the terminal has no
  such command yet.

`compact` has no start event either (`context.compacted` is appended when
compaction finishes), so `/compact` calls `compactionStarted()` itself, and a
compaction that fails ends it too, since no event would.

## Art gaps still open

Ranked by how much they will matter in use. Blocked on the user, once first here, has its own state now (`ask`):

1. **Progress.** `working` looks the same at 2 s and 2 min. Preferred idea: the sprite's position across the strip is the progress bar, since it already patrols. Only use it when the harness has a real percentage. For unknown totals, use an elapsed cue instead, such as slowly drifting lower, rather than a fake bar.
2. **Streaming a reply.** No state since `typing` moved to the user. Either accept `working` or draw one.
3. **Which kind of work.** Read, write, shell, and web all look the same. Colour could carry this but is the only spare channel.
4. **Magnitude.** One-line and 400-line edits both fire the same `file_change`.

## Smaller items

- `dead` holds one frame at 400 ms. It reads as frozen after a few seconds. A slow breathing loop would be better.
- `typing` is the working pose pecking, with the sweat drop sliding; a drawn typing pose with hands on keys would read better.
- `file_change` at 0.6 s is longer than most edits take. Coalesce.

## What was tried and dropped

- Rotating the sprite for a spin: shreds a 32 px outline. Replaced by the leap in `success`.
- Alpha fades: the terminal packs have no alpha. `clear` dissolves pixel by pixel instead.
- Braille as the default terminal pack: exact silhouette but dotted.
- Sextants as the default terminal pack: solid and compact (17x8), but a font without Unicode 13's legacy computing symbols drew boxes, and that cannot be detected. Replaced on 2026-09-27 by half blocks at 35x12, which every font has.
- Per-state row cropping in the terminal: the mascot changed height between states. A fixed strip is calmer.
