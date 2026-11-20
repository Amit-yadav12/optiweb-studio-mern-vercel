# Test fixtures

Small image files used by the self-tests. Each was written once by a real
encoder (libvips, through `sharp`) and is committed, so the tests need no
image library: the app itself has none on the server.

| File | What it is |
| --- | --- |
| `photo-800x600.jpg` | Photo-like JPEG (gradients and noise), baseline, quality 92 |
| `progressive-320x240.jpg` | Progressive JPEG |
| `rotated-gps-240x160.jpg` | Stored 240 × 160 with EXIF orientation 6 (shown 160 × 240), a GPS block and an ICC profile. Quadrants as stored: red, green / blue, white |
| `alpha-320x200.png` | RGBA PNG: a soft disc on a fully transparent background |
| `flat-600x400.png` | Four solid blocks as a 4-bit palette PNG, 670 bytes. A lossy re-encode of it is larger |
| `lossy-400x300.webp` | Lossy WebP |
| `lossless-alpha-320x200.webp` | Lossless WebP with transparency |
| `small-400x300.avif`, `alpha-160x100.avif` | AVIF, opaque and with transparency |
| `still-200x150.gif` | Single-frame GIF |
| `animated-3f-60x40.gif`, `animated-3f-60x40.webp` | Three-frame animations |
| `image-200x150.tiff`, `two-page-60x40.tiff` | TIFF, one page and two pages |

Files that only need a particular header (an oversized PNG, an animated PNG, a
BMP, an SVG, a text file with an image's name) are built by the tests
themselves: see `scripts/lib/selftest-kit.mjs`.
