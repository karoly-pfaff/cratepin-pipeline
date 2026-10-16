# Media quality contracts

## Expected output, case by case

Each row is a promise a test checks: the image rows pixel by pixel in
`sources/media/testing/alpha-geometry-semantics.test.ts`, `colour-metadata-semantics.test.ts`,
`image-encoding.test.ts` and `special-media.test.ts`, lossy colour in `lossy-quality.test.ts`; the
copy rows in
`sources/building/assembly/output-assembly.test.ts`, `sources/verify/output-verification.test.ts` and
`tests/verify/output.test.mjs`.

| Case                                          | Expected output                                                                                               |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Lossless WebP, no resize                      | Decoded RGBA equals the original's, also the colour under alpha 0                                             |
| Lossy WebP, `alphaQuality` 100                | Every alpha value equal; from quality 80, colour within the [lossy tolerances](#lossy-tolerances)             |
| Lossy WebP, `alphaQuality` below 100          | Only alpha 0 and 255 promised; partial alpha may change                                                       |
| A resize that scales                          | No colour of a transparent pixel reaches a visible one; in lossless output alpha 0 becomes `0,0,0,0`          |
| A box the image already fits                  | Not resampled: hidden colour kept as without a resize; padding `0,0,0,0`                                      |
| Opaque original, lossless WebP                | No alpha channel; a `contain` box with padding has one                                                        |
| `contain`, image smaller than the box         | Centred, padding exactly `0,0,0,0`, an odd row or column to the bottom or right                               |
| `inside`                                      | Each side rounded to the nearest pixel, never 0; never enlarged                                               |
| EXIF orientation                              | Not applied: the stored geometry stays, the tag is dropped                                                    |
| Pixel art resized without an exact-pixel role | Smoothed with the policy's kernel (`lanczos3`); no nearest-neighbour option: give it a sprite role, no resize |
| Sprite, atlas, mask, data roles               | Every sample equal, hidden colour and partial alpha included; anything else refused                           |
| Animated image (any `acTL`, even one frame)   | Refused with `ANIMATION_UNSUPPORTED`; the copy profile keeps it byte for byte                                 |
| Display P3 or another ICC profile             | Converted to untagged sRGB within ±1 of the colour the art was made in; alpha unchanged                       |
| sRGB-tagged original                          | Samples unchanged; `COLOUR_CONVERTED` still reported                                                          |
| 16-bit original                               | Each sample's high byte (`value >> 8`); `PRECISION_REDUCED`                                                   |
| `gAMA`, `cHRM` chunks                         | Not applied: stored samples kept                                                                              |
| Text, XMP, EXIF, C2PA, gamma metadata         | Dropped from converted output; kept byte for byte by the copy profile                                         |
| Copied audio and print masters                | The original's bytes in the manifest, the published output and after `verify`                                 |
| Copied SVG and data files                     | The original's bytes in the manifest and the staged output                                                    |

## Lossy tolerances

Lossy WebP is judged by decoded pixels (`sources/media/testing/lossy-quality.test.ts`). Colour error is
weighted by the original's alpha and pixels the original makes fully transparent do not count.
At every quality tested (50, 80, 82, 90) the geometry and, with `alphaQuality` 100, every alpha
value stay exact; below 100 no fully transparent pixel becomes visible and no opaque one
see-through. From quality 80 the colour stays within these limits, set with a margin beyond the
values the pinned encoder (Sharp 0.35.5, libwebp 1.6.0) measured at quality 82:

| Kind of art (fixture)                     | Least PSNR | Most mean error | Most error of 99.9 % | Measured at 82      |
| ----------------------------------------- | ---------- | --------------- | -------------------- | ------------------- |
| Smooth background (512×256 gradient)      | 42 dB      | 1.5             | 8                    | 44.95 dB, 1.08, 5   |
| Soft-edged sprite (128² disc, alpha)      | 42 dB      | 1.5             | 9                    | 44.45 dB, 1.12, 6   |
| Saturated scene with hard edges (256×128) | 26 dB      | 4.5             | 112                  | 27.46 dB, 3.67, 107 |

Errors are on the 0–255 scale. No higher quality may raise the mean error by more than 0.25 over any lower one.
The smooth background is easy for the encoder at any quality (it still passes these limits at
50), so it guards against gross damage; the sprite and the scene tell qualities apart. Saturated
colour along hard edges bleeds under the encoder's 4:2:0 chroma subsampling: there 99.9 % of
samples stay within about 107 and the largest single difference is about 150, at every quality
tested. Keep UI,
text and line art lossless. A person reviews the actual samples; the decision and the hashes of
the reviewed outputs are recorded in [visual review](visual-review.md). Once
approved, a test fails when the same encoder produces other bytes; a rejection for the current
encoder fails the suite.
