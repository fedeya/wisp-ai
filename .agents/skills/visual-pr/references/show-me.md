# Structural visual conventions

Pick the smallest view that makes the change understandable; keep prose brief and ground labels in source.

## Behavior or control flow

```diff
 on(direction)
-  check each view's special cases
+  resolve a visible geometric neighbor
+  focus it, or delegate the unconsumed edge to the host
```

## Data ownership

```text
Layout → visible PanelId + Rect registry
Input  → editing widget OR directional resolver
Focus  → panel selection + eligible origin memory
```

These are example sketches, not a claim about every PR. Verify names and behavior in the actual diff.

## Other useful shapes

- A shallow tree for changed file responsibilities, not every file.
- A component tree with relevant hooks/state and module boundaries.
- Small type/API/SQL contracts when compatibility matters.
- A Mermaid sequence/flow diagram for interactions that text cannot explain as clearly.

Use complete target blocks when most of a structure is new or omission hides ownership/order. Prefer diff when a reviewer needs to understand what changed. Keep each view near the text it supports.

## UI evidence

For UI changes, show the real compiled application with isolated dummy data at relevant widths. Screenshots illustrate states; recordings demonstrate interactions. Label proposals or illustrative HTML explicitly and never present them as execution evidence. Keep agent fixtures, terminal harnesses and temporary media outside Git; publish only authorized, sanitized evidence through an accessible supported destination. Local paths are not remotely accessible URLs.

### Real terminal video evidence

- Record the actual built executable through a PTY, preserving output bytes and monotonic event timestamps in an asciicast-style file; show the exact source SHA. Keep isolated pass/intentional-failure fixtures and renderer dependencies in scratch, not the repository.
- Replay captured ANSI through a terminal emulator such as pyte and rasterize with Pillow into ffmpeg H.264/yuv420p MP4 with faststart. Use readable font sizes and sufficient terminal rows to retain the complete diagnostic and exit code; hold meaningful states long enough to read. Never replace actual command output or timings with invented screen content.
- Verify the MP4 with ffprobe and a full decode, then extract frames from the encoded video itself for visual inspection; inspecting only renderer input images does not verify the final artifact.
- Private GitHub CLI API authentication does not imply browser attachment authentication. If browser attachment authentication is unavailable, return the absolute MP4 path to the user with that blocker; do not improvise public hosting, releases, tags, or local links in the PR body.
