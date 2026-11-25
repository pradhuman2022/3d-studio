# 3D Studio: product notes (v2)

## Who it is for
Makers and small product sellers who design 3D-printable products (lamps, enclosures, inserts,
decor) by talking to Claude, and print on a hobby FDM printer (here: Anycubic Kobra 2 Neo, PLA).

## The problems with designing by text, and the feature for each

| Problem | Feature |
|---|---|
| "Which part do you mean?" Products have several parts; text is ambiguous. | **Projects with parts** (`studio.json`), **@part tags** in chat (autocomplete, click a part to tag it). |
| "Change *this* spot." Words can't point at a place on a model. | **Pin comments**: click the model, write a note; the pin stores part, exact point (mm), surface direction and a region radius. Claude receives them as precise data. |
| "Is it the right size?" | **Measure tool** (two clicks: distance + dX/dY/dZ). **Editable measurements**: type the size you want, Claude changes the model. **Editable part size** (W × D × H) in the inspector. |
| Waiting for AI to change one number. | **Parameter panel**: when a generator exposes settings, editing them re-runs the script directly in seconds: no AI turn, no plan usage. |
| Multi-part assemblies are hard to read. | **Assembled / Print-layout views**, **explode slider**, per-part colour (filament), visibility, isolate, per-part checks. |
| Losing context between sessions. | **Saved conversation per project** (resumes the same Claude session after a restart), saved comments. |
| Repeating the same requests. | **Quick actions** on a selected part (thinner, round edges, add a hole, check printability, explain). |

## How a request reaches Claude
Every message carries a context block assembled by the studio: the active project, tagged parts
(file, size, placement), referenced comments (point, normal, radius, text) and measurements
(points, current and target distance). The chat shows the person's words and chips; Claude gets
the precise data.

## Data model (per project folder)
- `studio.json`: owned by Claude. Project name, `build` script, `params`, and `parts`
  (id, name, file, color, assembly position/rotation, notes).
- `.studio/comments.json`: pins and their status (open / resolved).
- `.studio/history.jsonl` + `.studio/session.json`: the conversation and its Claude session.
- Folders without `studio.json` still open: each STL becomes a part.

## Roadmap (after v2)
1. Versions: snapshot each change, compare v2 vs v3 side by side, restore.
2. Slicer integration: real print time and grams per part (Orca/Prusa CLI).
3. Printability analysis in the viewer: overhang heat-map, thin-wall warnings.
4. Constraints: "these two holes stay 40 mm apart" kept across edits.
5. Share: export a project (STLs + 3MF + render) for customers or print services.
6. Product mode: Agent SDK + API key backend for other users.
