# Image policies

## Baseline

Use Sharp as a pinned Node build dependency in the implemented converter. In the default path-preserving output mode ([output safety](safety.md)) images keep their source format unless a profile opts into conversion. PNG to WebP is an opt-in profile that preserves alpha and dimensions unless a resize profile explicitly permits changes; lossless WebP suits transparent character/UI artwork and backgrounds can opt into a lossy quality profile. `quality`/`alphaQuality` matter according to encoder mode; document that quality is not a lossy selector when lossless is active. Never flatten onto a background, crop, upscale, trim transparent margins or alter sprite-sheet cells by default.

Source originals remain in R2. If selected output is larger than the source and the policy permits PNG fallback, use the smaller original and emit its real extension/MIME in the manifest. If a strict WebP profile is selected, keep that output and report negative savings rather than silently break the declared format. Target policy schema must explicitly distinguish flexible `keepSmaller` and strict format profiles.

## Implemented converter

`build` converts the pinned originals; the library API includes
`convertOriginal` (the checked entry point, below), `assertConversionAllowed`, `profileSelectorFor`, `normalizedPolicyOf`, `derivativeKeyOf`,
`encoderFingerprint` and the plain encoder `encodeImage`. It uses Sharp 0.35.5 (libvips 8.18.7, libwebp 1.6.0),
pinned exactly. Developer hosts are Windows and WSL/Linux.

- **Checks before decoding.** Only the header is read first, without Sharp's own pixel limit,
  and checked in the order that gives the most useful remedy. Image profiles convert PNG
  originals only: any other format, and any animated image (a multi-page GIF or WebP, or a PNG
  with an `acTL` chunk before its first `IDAT`, which libvips would read as its first frame), is
  refused with the copy profile as the remedy. Then an image with more pixels than
  `limits.maxImagePixels` is refused before any pixel is decoded. The planned output must also
  fit this same limit before canvas allocation: `contain` counts the entire padded box, while
  `inside` counts the fitted image, without enlargement. PNG and WebP follow the same check,
  including cache reuse and build dry run; copy profiles do not decode or allocate a canvas and
  remain byte-preserving. Then a WebP output longer than
  16383 pixels on an edge (libwebp's limit), computed from the source and the resize box, is
  refused. Damaged or truncated pixel data fails while decoding (`failOn: 'error'`); a file cut
  after its last image data (only the end chunk missing) still decodes completely.
- **Alpha and geometry.** Lossless WebP without a resize keeps every pixel, alpha included, and
  also the colour of fully transparent pixels (`exact`), so the decoded RGBA equals the
  original's. A resize that scales resamples with premultiplied alpha: no hidden colour bleeds
  into visible pixels, and in lossless output fully transparent pixels become `0,0,0,0` (a box
  the image already fits does not resample, so hidden colour stays as without a resize; lossy
  output never promises hidden colour). Geometry changes only through an
  explicit resize, which fits the image into the box keeping its aspect ratio and never enlarges
  it; `contain` centres the image and pads the rest of the box with `0,0,0,0` (the output is
  always the box; an odd row or column of padding goes to the bottom or right), `inside` does
  not pad. Nothing is cropped, trimmed or flattened.
- **Colour.** Screen output is untagged sRGB: an embedded ICC profile is applied to convert the
  pixels to sRGB, then dropped (a `COLOUR_CONVERTED` notice says so; stored values can then
  differ from the original's while sRGB screens show the same colours; an sRGB profile leaves
  the samples as they are, yet is still reported). An original without an ICC profile is taken
  as sRGB and passes through unchanged; PNG `gAMA`, `cHRM` and `cICP` chunks are not applied.
  Output has 8 bits per sample, so a 16-bit original loses precision in any output format
  (`PRECISION_REDUCED`): each sample keeps its high byte. All other metadata (EXIF, XMP, text
  chunks, content credentials such as a C2PA `caBX` chunk) is dropped from converted output; a
  same-format PNG may carry the resolution chunk (`pHYs`) libvips writes. The copy profile keeps
  every byte, metadata included, so content credentials survive only a copy. EXIF orientation is
  not applied, so geometry never changes behind the policy's back.
- **Repeatability and identity.** The same input, policy and encoder give the same bytes (tested
  within one environment). The normalized policy spells out every configurable setting and the
  encoder settings this tool chooses (libwebp effort 4 and `exact`, PNG compression level 9, the
  `lanczos3` resize kernel, no enlargement, transparent padding). Sharp's other defaults (WebP
  preset, smart subsampling, near-lossless, PNG filtering, palette and interlacing) are left as
  they are and are covered by the Sharp version in the encoder fingerprint; what stays fixed in
  this tool's code (the decoder's strictness, the order of operations) is covered by the tool's transform version, raised whenever that code changes. The
  derivative cache key is the SHA-256 of the source hash, the policy and the encoder fingerprint
  (transform version; Sharp, libvips, libwebp, PNG library, lcms and zlib-ng versions; platform;
  CPU architecture), so a changed profile, an override on one asset or another encoder build
  never reuses an old derivative. With Sharp's prebuilt binaries every version is known; a
  separately installed libvips may report some as `unknown`. Identical bytes are not promised
  across fingerprints.

The source/output pixel-budget validation does not raise `transformVersion`: it rejects work
before conversion and before derivative lookup, including warm caches. It changes no bytes for
an accepted source and policy. Changes to decoding, resizing or encoding still require a version
increase; a limit change alone is deliberately absent from the derivative key.

- **Failures.** Conversion failures are `INVALID_DATA` (exit 8) with `details.reason`:
  `IMAGE_UNREADABLE` (damaged, truncated or not the named format: the conversion streams the
  original once; only when it fails is the original decoded again on its own, in one sequential
  pass, to tell a damaged original from an encoder failure), `IMAGE_TOO_LARGE` (with the width,
  height and limit), `UNSUPPORTED_IMAGE_FORMAT` and `ANIMATION_UNSUPPORTED` (with the format),
  `WEBP_EDGE_TOO_LONG` (with the output size), `ENCODING_FAILED` (the original was decoded but the
  encoder could not write it with this profile) and `PROFILE_UNKNOWN` (the profile named by the
  asset's entry, a rule or `defaultProfile` is not defined; with the source and where the name came
  from); each message says what to change.

## Implemented profiles, fallback and savings

`profileSelectorFor(config)` compiles the profile rules once and picks an original's profile: its
`assets` entry's profile (pinned in the lock), else the first matching `profileRules` glob (ignoring
letter case), else `defaultProfile`; a name the config no longer defines fails with
`PROFILE_UNKNOWN`, never falling back to another profile. The derivative key comes from the
normalized policy, not from the profile's name, so an override on one asset changes its key, and the
same profile reached by an override or by a rule is one derivative. `convertOriginal` then produces
the output:

- **Copy** keeps the original's bytes (`copied`).
- **Same-format profiles** (a resize without `webp`) convert as above (`converted`).
- **Flexible WebP** (`keepSmaller: true`) keeps WebP only when it is strictly smaller than every
  same-format alternative: the untouched original whenever the profile's geometry leaves the image
  as it is (no resize, an `inside` box it already fits, or a `contain` box exactly its size; a
  smaller image in a `contain` box is padded, so its geometry changes), and the same resize written
  in the original's format whenever there is a resize. Otherwise the smallest alternative is kept
  (`kept-smaller`) with its real media type, for example `image/png`, which the manifest must use,
  and a `KEPT_SMALLER_FORMAT` notice. A kept untouched original is the one exception to the colour
  and metadata rules above: its bytes, colour profile and metadata are unchanged.
- **Strict WebP** (`keepSmaller: false`) keeps WebP even when it is larger; the declared format is
  never silently broken.

Any output other than a copy that is larger than its original carries a `SIZE_GREW` notice, a
strict WebP, a same-format resize or a padded box alike.

Every result reports `sourceBytes`, `outputBytes` and `savedBytes` (source minus output, zero or
negative when nothing was saved; no percentage target) and, unless it is a copy, the output's
`dimensions` and the original's `sourceDimensions`. Lossless and lossy, resizing and copying are
always the profile's explicit choice: nothing is cropped, enlarged or flattened implicitly, and
lossy WebP keeps transparency. With `lossless: true` the pixels are kept exactly (apart from the
colour and precision rules above), and `quality` becomes a compression-effort trade-off: it can
change the bytes and their size, never the pixels.

The example config shows role profiles: lossless WebP artwork, a lossy background, a fixed
512×512 actor box and strict lossless UI.

## Implemented special media

`assertConversionAllowed`, which `convertOriginal` runs first, refuses an image profile where
what it would do breaks the original's meaning, reading at most the image's header (no pixel is
decoded); the copy profile always keeps the exact bytes. The role is not part of the derivative
key, so the derivative cache runs this check before it looks anything up. `encodeImage` is the
plain encoder: it makes the format, animation and size checks but no media-type or role check. Each refusal is `INVALID_DATA` with its reason and
a message naming the copy profile as the remedy (`"profile": "copy"` in the asset's entry, or a
profile rule or `defaultProfile` that picks copy for it):

- **Not an image** (`MEDIA_NOT_IMAGE`, with the media type): voice, effects, music, fonts, video
  and data files are never read as images, so an image profile that a broad rule assigns to them
  fails instead of producing something else.
- **Already compressed or animated images**: the encoder's own header checks refuse JPEG, WebP,
  GIF and other non-PNG originals (`UNSUPPORTED_IMAGE_FORMAT`) and animated GIF, WebP or PNG
  (`ANIMATION_UNSUPPORTED`), also for the roles below (these reasons come first), so they are
  only copied: a lossy original is never compressed again and no frame is dropped.
- **Exact-pixel roles** `sprite`, `atlas`, `mask` and `data` (`ROLE_NEEDS_EXACT_PIXELS`, with the
  role): their pixels are coordinates, indices or values, not a picture. Only lossless WebP
  without a resize is accepted, and only for an 8-bit, untagged, non-palette PNG, whose samples it
  stores unchanged. `details.changes` lists every reason that applies, comma separated:
  `RESIZE`, `NOT_LOSSLESS_WEBP`, `COLOUR_PROFILE` (it would be converted to sRGB),
  `HIGH_PRECISION` (more than 8 bits per sample would become 8), `PALETTE` (indices would become
  colours) and `LOW_BIT_DEPTH` (fewer than 8 bits would be widened). Margins are never trimmed,
  so cells keep their coordinates.
- **Copy-only role** `print-master` (`ROLE_NEEDS_COPY`): the pinned full-resolution master is
  kept with its bytes, colour profile and metadata. Any image profile, also one a rule assigns,
  is refused rather than replacing it with a screen version. A print pipeline reads the pinned
  original bytes: through `pull`, a restored source file, or the byte copy a build publishes
  (verify proves it equals the original), never a screen version. One source has
  one role and one profile, so a screen version of the same artwork is a second source path with
  its own role and profile; identical bytes are stored once (a `DUPLICATE_CONTENT` notice).

These checks run when an original is converted, not when the config loads: a config, scan and
push accept any role with any profile.

Roles are free slugs; only the ones named here change what a profile may do.

## Resources

A build converts at most limits.imageConcurrency images at once (default 2, bounded by --concurrency). Each conversion holds its verified original, decoded pixels and encoded candidates in memory. Lower imageConcurrency and maxImagePixels for memory-constrained hosts. The default maxImagePixels is 8192²; large lossless conversions can require several GiB. Images exceeding this budget are refused before decoding or output-canvas allocation. Copy profiles stream the original without image decoding.

The derivative cache key includes source hash, normalized policy and encoder fingerprint. Different platforms or encoder builds may produce different bytes; each fingerprint uses separate derivatives. No cross-platform byte identity is promised.

PNG and opt-in WebP are production image outputs. AVIF and responsive multi-resolution profiles are unavailable in the production configuration. Audio conversion is unavailable; voice, effects and music are copied unchanged.
