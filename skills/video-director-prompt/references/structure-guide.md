# Seedance 2.0 Prompt Structure Guide

Canonical reference derived from 2,366 real Seedance 2.0 prompts. Use this to write prompts that match proven patterns.

---

## Skeleton Template

```
[REQUIRED] One-sentence scene setup. Subject, location, mood.

[REQUIRED] Action description. What happens, in what order.

[REQUIRED] Camera: [shot type], [movement], [framing].

[OPTIONAL] Lighting: [quality and source].

[OPTIONAL] Style: [visual tone, color palette, era].

[OPTIONAL] Technical: [duration]s, [fps]fps, no subtitles.
```

**Required sections:** scene setup, action, camera movement.
**Optional sections:** lighting, style, technical specs (include when precision matters).

---

## Tech Spec Conventions

Append technical constraints at the end of any prompt. Use these exact phrasings:

| Spec       | Standard phrasing                  | Notes                              |
|------------|------------------------------------|------------------------------------|
| Duration   | `15 seconds`, `15s`                | 15s is the dominant standard (416/2366 prompts) |
| Frame rate | `24fps`                            | Most common (48 uses); also `30fps`, `60fps`    |
| Resolution | `high definition`                  | Use sparingly; model defaults are high          |
| Subtitles  | `no subtitles`                     | Explicit suppression; 16 prompts use this       |
| Combined   | `15 seconds, 24fps, no subtitles`  | Combine on one line at end of prompt            |

---

## Camera Language Glossary

Use these terms precisely. Vague camera direction produces inconsistent output.

- **tracking shot** — camera follows a moving subject, maintaining distance and framing
- **wide shot** — full scene in frame; establishes location and scale
- **POV** — camera represents the subject's eyes; first-person perspective
- **FPV (first-person view)** — kinetic, immersive; often used for fast-moving or drone-style sequences
- **handheld** — slight shake and drift; conveys urgency, intimacy, or realism
- **match cut** — cut that aligns action or shape across two scenes for visual continuity
- **bird's-eye** — directly overhead; flattens depth, emphasizes geometry and layout
- **close-up** — tight framing on face or object detail; heightens emotional or visual impact
- **pull back** — camera retreats from subject; reveals context, creates scale or isolation
- **shallow depth of field** — background blurred; isolates subject from environment

---

## Archetype A: Prose Narrative

**When to use:** single-scene, character-driven, or emotionally atmospheric content. Works best when timing does not need to be exact and mood carries more weight than beat structure.

**Template:**
```
In [location with atmosphere], [subject] [initial state or position].
[Camera movement] [shot type] as [subject] [primary action].
[Environmental detail that reinforces mood].
[Secondary action or reaction].
[Closing camera move or final framing].
```

**Example:**
```
In a fog-drenched harbor at dawn, a fisherman coils rope on a weathered dock.
A slow tracking shot follows him from behind as he walks toward the water's edge.
The masts of anchored boats cut silhouettes against the pale orange sky.
He pauses, looks out, his breath visible in the cold air.
The camera holds on his profile as the first light breaks the horizon.
```

---

## Archetype B: Timestamped Sequence

**When to use:** multi-beat action, product demos, dance or sports content, or any scene where specific timing control matters. Best when different shots need to hit at defined moments.

**Template:**
```
0:00–0:05: [Shot type]. [Subject] [action]. Camera [movement].
0:05–0:10: [Shot type]. [Transition or new angle]. [Action continues or shifts].
0:10–0:13: [Close-up or detail shot]. [Climax action].
0:13–0:15: [Final framing]. [Resolution or hold].
```

**Example:**
```
0:00–0:04: Ultra-wide establishing shot. A sprinter crouches in the starting blocks. Camera holds low and still.
0:04–0:09: FPV tracking shot launches forward as the sprinter explodes off the line.
0:09–0:13: Side-angle slow motion. Legs and arms in full extension, sweat visible mid-air.
0:13–0:15: Bird's-eye pull back. Runner crosses the finish line. Camera rises and holds.
15 seconds, 24fps, no subtitles.
```

---

## Archetype C: Bold-Header Structured

**When to use:** complex multi-element scenes, prompts shared with collaborators, content requiring precise control over multiple independent variables. The headers make each component reviewable in isolation.

**Template:**
```
**Subject/Character:** [Description, appearance, any reference image citation]
**Environment:** [Location, time of day, weather, background detail]
**Action:** [What the subject does, sequence of movements]
**Camera:** [Shot type, movement, lens style, any transitions]
**Style:** [Visual tone, color grading, era, film stock or digital look]
**Technical:** [Duration, fps, subtitle suppression if needed]
```

**Example:**
```
**Subject/Character:** A young woman in a red wool coat, late 20s, carrying a leather satchel. (@Image1)
**Environment:** A rainy Tokyo street at night. Neon reflections on wet pavement. Dense foot traffic.
**Action:** She pauses under a convenience store awning, checks her phone, then steps back into the rain.
**Camera:** Medium shot holds as she pauses. Slow zoom in to her face as she reads the phone. Pull back wide as she walks away.
**Style:** Cinematic, desaturated except for the warm red of her coat. Anamorphic lens flare on wet surfaces.
**Technical:** 15 seconds, 24fps, no subtitles.
```

---

## Reference Image Integration

Seedance 2.0 accepts reference images for character consistency and visual style matching.

**Citation patterns observed in the corpus:**

| Pattern | Usage context |
|---------|---------------|
| `@Image1` | Shorthand for first attached reference; use when one image is attached |
| `@img1`, `@img2` | Lowercase variant; use consistently within a single prompt |
| `@character_ref` | Named reference; clearer when multiple images serve different roles |
| `based on reference image (upper-body)` | Prose integration; specifies which part of the reference applies |

**Rules:**
- Cite the reference at the point where it applies, not only at the end.
- For character references, place the citation inside `**Subject/Character:**` or in the opening sentence of a prose prompt.
- Specify which aspect the reference governs when it is not the full subject: `face only`, `outfit`, `upper-body`, `color palette`.
- In timestamped sequences, re-cite the reference in any segment that introduces the character after a cut.

**Example integrations:**

Prose: `A woman (@Image1) with long dark hair walks through a market at dusk.`

Bold-header: `**Subject/Character:** Male lead, early 40s, stern expression. Use @character_ref for face and build.`

Timestamped: `0:00–0:05: Close-up on subject (@img1). Eyes open slowly. Warm backlight.`
