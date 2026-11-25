# 3D Studio reference

Details behind the [README](../README.md).

## AI model generation (text / photos → 3D)

**✨ Generate** creates organic models (figurines, characters, sculpted decor) that are hard to
build with CAD, then makes them printable and adds them to the project as a part:

- **From text**: FLUX.1-schnell draws a clean reference image, TRELLIS turns it into 3D.
- **From photos**: 1-4 views of one object (front, side, back…); the background is removed automatically.
- **Detail** (low / medium / high) controls mesh density; **size** sets the longest side in mm.
- **Print-ready**: the GLB is converted to STL (Z up, scaled to your size, centred on the bed) and checked
  (closed mesh, bed fit). The GLB and reference image are kept next to it (`ai/<id>/`).
- **AI colours**: the model's texture is reduced to a few filament colours and painted onto the part.
- **Combine with CAD**: ask Claude to `import()` the AI mesh in `model.scad` to add a base, slot or LED pocket.
- Jobs run one at a time with live progress, cancel and retry.

The models run as free Hugging Face Spaces through the official Gradio client (optional dependency
`@gradio/client`). Anonymous use shares a tiny GPU quota that is often used up, so add a **free Hugging
Face access token** (huggingface.co → Settings → Access Tokens, type "read") in ✨ Generate → AI settings, or
set `HF_TOKEN`. The token is stored only in `3d-studio/.secrets.json` (git-ignored, owner-only permissions)
and is never sent to the browser. Other Spaces can be configured with `STUDIO_T2I_SPACE` / `STUDIO_I23D_SPACE`.
Generated models follow the licences of the models used (FLUX.1-schnell: Apache-2.0, TRELLIS: MIT).

## CAD engine: OpenSCAD

New projects use OpenSCAD when it is available (the server prints which engine it found).

- Claude writes `model.scad` with editable sizes in **OpenSCAD Customizer** form:
  `width = 80; // [50:1:140] Width across flats`, and a `part = "all"; // [all, body, lid]` selector.
- `studio.json` lists parts as `{ "id": "lid", "file": "build/lid.stl", "part": "lid" }`.
- **Saving a `.scad` file renders every part automatically** (about 1-3 s each, Manifold backend).
- The **Params** panel shows the Customizer values as sliders; Apply re-renders instantly, no AI turn.
- Render results and OpenSCAD errors (with line numbers) appear in the chat.
- Try the demo project `hex_pen_holder` (twisted hex pen holder with a removable divider).

OpenSCAD is GPL-licensed and always runs as a separate program; 3D Studio itself stays MIT.

Open http://localhost:4317. The studio listens on 127.0.0.1 only.

| Environment variable | Default | Meaning |
|---|---|---|
| `STUDIO_WORKSPACE` | the folder that holds `3d-studio` | Where projects live (one sub-folder each) |
| `STUDIO_PORT` | `4317` | Port |
| `STUDIO_BED` | `220x220x250` | Printer build volume in mm |
| `STUDIO_PRINTER` | `an FDM printer` | Printer name, told to Claude |
| `STUDIO_MODEL` | Claude Code's default | Model alias, e.g. `opus`, `sonnet` |

## Project format

Each project is a folder in the workspace. Claude maintains `studio.json`:

```json
{
  "name": "Brick lamp",
  "stage": "3d",
  "build": "make_brick.py",
  "params": { "length": { "value": 200, "unit": "mm", "min": 60, "max": 220, "label": "Length" } },
  "blueprints": [{ "id": "front", "name": "Front view", "file": "blueprints/front.svg" }],
  "parts": [
    { "id": "shell", "name": "Brick shell", "file": "shell.stl", "color": "#c0573a",
      "assembly": { "position": [0, 0, 60], "rotation": [180, 0, 0] } }
  ]
}
```

- **Blueprint sheets** are SVG with `viewBox` in millimetres. Dimensions are
  `<g class="dim" data-dim="length" data-value="200" data-unit="mm" data-label="Length">`, parts are
  `<g data-part="shell">`. The studio strips scripts, event handlers and external links before showing them.
- **Build scripts** read parameter values from the `STUDIO_PARAMS` environment variable (JSON).
- The studio keeps its own data in `<project>/.studio/` (comments, chat history, session id).
- A folder without `studio.json` still opens: each STL becomes a part.

## How it works

```
browser (chat · blueprint · three.js viewer)
      │  HTTP + server-sent events
server.mjs ── spawns `claude -p --input-format stream-json --output-format stream-json`
      │        per project, resumes its session, adds a <studio-context> block
      │        (tags, comments, measurements, dimension edits) to each message
      └── watches the workspace: new STL / SVG / studio.json → live reload
```

Permissions: Claude may read and edit files in the project and workspace, and run `python3`, `openscad`,
`ls`, `mkdir`, `cat`, `head` and `wc`. Other shell commands are refused. Edit the list in `server.mjs`.

