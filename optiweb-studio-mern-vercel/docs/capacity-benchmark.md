# Capacity benchmark

`npm run bench:capacity` drives the direct-upload pipeline through the HTTP API with the default limits and generated sample files, one scenario per process, and reports processing time and peak memory.

## What these numbers are

They were measured on development and CI machines, with storage on local disk. They are **not** measurements of a Vercel function. They show how the image library behaves at the configured limits on one x86-64 core, which is the shape of a Hobby function (1 vCPU, 2 GB), and they are the basis for the limits. Upload and download times are not reported: on a loopback connection they say nothing about a real network.

Sample files are photo-like JPEGs (a colour gradient with noise) padded with ignorable metadata to an exact size, so "25 MB" is exactly 26,214,400 bytes. Images are converted to WebP at quality 80 unless stated. "Transform" is the time spent converting; "whole job" adds reading the source from storage and writing the result. Peak memory is the peak resident memory of the whole test process, which also holds the API server and the upload it sends, so the conversion alone needs somewhat less.

## Development sandbox

Intel Xeon 2.60 GHz, 2 logical CPUs, 3.8 GB RAM, Node 22.22.3, sharp 0.35.5 (libvips 8.18.7). One image at a time, one encoder thread. Database: in-memory stand-in.

| Scenario | Files | Input | Megapixels | Result | Transform | Whole job | Output | Peak memory |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 MB, first run in the process | 1 | 1 MB | 2.2 MP | completed | 0.4 s | 0.4 s | 0.6 MB | 202 MB |
| 1 MB, second run | 1 | 1 MB | 2.2 MP | completed | 0.4 s | 0.4 s | 0.6 MB | 202 MB |
| 5 MB | 1 | 5 MB | 8.6 MP | completed | 1.5 s | 1.5 s | 2.4 MB | 322 MB |
| 10 MB | 1 | 10 MB | 11.8 MP | completed | 2.0 s | 2.0 s | 3.3 MB | 391 MB |
| 20 MB | 1 | 20 MB | 19.4 MP | completed | 3.3 s | 3.4 s | 5.4 MB | 455 MB |
| 25 MB, first run | 1 | 25 MB | 38.9 MP | completed | 6.8 s | 6.8 s | 10.8 MB | 749 MB |
| 25 MB, second run | 1 | 25 MB | 38.9 MP | completed | 6.5 s | 6.5 s | 10.8 MB | 749 MB |
| 40 MP JPEG → WebP | 1 | 18.6 MB | 40 MP | completed | 7.0 s | 7.1 s | 12.2 MB | 800 MB |
| 40 MP JPEG → JPEG | 1 | 18.6 MB | 40 MP | completed | 6.9 s | 6.9 s | 8.4 MB | 800 MB |
| 40 MP JPEG → AVIF | 1 | 18.6 MB | 40 MP | refused: AVIF output is limited to 16 MP | 0.0 s | 0.1 s | – | – |
| 12 MP transparent PNG → WebP | 1 | 1.2 MB | 12 MP | completed | 2.4 s | 2.5 s | 0.5 MB | 523 MB |
| 16 MP JPEG → AVIF | 1 | 6 MB | 15.4 MP | completed | 13.4 s | 13.4 s | 2.6 MB | 665 MB |
| 10 mixed files in one job (25, 20, 2 × 10, 3 × 5, 3 × 1 MB) | 10 | 83 MB | 89.5 MP | completed | 15.6 s | 15.8 s | 24.9 MB | 595 MB |
| Two jobs at once, 3 × 10 MB each | 6 | 60 MB | – | 6 of 6 converted, one job per worker run | – | 12.3 s | – | 413 MB |
| Corrupt JPEG + PNG whose header claims 900 MP + one valid file | 3 | 0.6 MB | – | partial: two rejected, one converted | 0.2 s | 0.3 s | 0.3 MB | 176 MB |
| File of 25 MB + 1 byte | – | – | – | refused when the job is created (413) | – | – | – | – |
| Text sent as PNG | 1 | – | – | rejected by its signature when the upload is confirmed | – | – | – | – |

Every run succeeded on the first attempt (no retries). The first and second run in a process took the same time: loading the image library is not a measurable part of a conversion.

## What follows from it

- **Memory.** A 40 MP image peaks at about 0.8 GB, inside a 2 GB function. That holds because files are converted one at a time; two 40 MP images at once would not be safe, so the worker never does that.
- **AVIF.** In an earlier isolated measurement on the same machine, encoding the 40 MP image as AVIF took 63 seconds and 1.4 GB. That is why AVIF output is limited to 16 MP (13 seconds, 0.7 GB here), and why the multi-candidate policies skip the AVIF candidate above 12 MP.
- **Time.** The largest allowed job that is realistic, 10 files and 83 MB, took 16 seconds here. A worker run has 240 seconds, and one encode has a limit of 120 seconds, so there is room for a slower CPU.
- **Pixels, not bytes, decide the cost.** A 100-byte PNG that claims 900 MP is rejected from its header in milliseconds, before any pixel is decoded.

## Not measured

- A Vercel function: cold start, its CPU, its memory accounting, and the network between the function and the Blob store.
- Real upload and download speeds.
- More than two jobs at once, or sustained load.
