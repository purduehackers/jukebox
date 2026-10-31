# Phase 4C: font assets and QR dependencies

Additive shared dependency proposal: `@fontsource/inconsolata` self-hosts the
reference dashboard body face (OFL, package includes license); `qrcode-generator`
(MIT) encodes actual request URLs locally with no external QR service.

The user supplied PolySans Slim, PolySans Slim Italic, and PixelHackers on
2026-10-30 specifically for this display. These replace the earlier proposed
Whyte/trial font reuse. The attached PixelHackers SHA-256 matches the reference
repo's file: `807b347bf51b4f51927906a7c3f4b124524239679798cfa9992c715a9b59b0db`.
Files are kept under display/assets; no edits to the reference repo. No shader
dependency: user selected envelope A rather than the warp options.

Validation: fontTools inspects all three supplied WOFF2 files; dependency build
and QR encoding are covered by the display checks in the implementation commit.
Integration owner must retain these dependencies/assets when merging the display.
