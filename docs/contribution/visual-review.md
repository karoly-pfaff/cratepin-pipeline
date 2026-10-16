# Visual review of lossy samples

Pixel tests prove what is exact; how lossy output looks needs a person. The lossy fixtures
(`sources/media/testing/lossy-fixtures.test-support.ts`: a smooth background, a soft-edged sprite and a
saturated scene) are encoded at qualities 50 and 82 and reviewed as panels:

```sh
CRATEPIN_VISUAL_REVIEW=<directory> node --test tests/media/lossy-review.review.test.mjs
```

writes, per sample, the original and the output over a checkerboard, the visible colour
difference amplified 8 times (weighted by alpha, as the metrics count it), the output's alpha,
4× zooms of the fixture's edges, the WebP itself and `samples.json`
with each output's SHA-256, its metrics and the encoder fingerprint.

The reviewer's decision goes into `sources/media/testing/reviewed-lossy-samples.json` as they gave it:
`decision` (`pending`, `approved` or `rejected`), the date, who reviewed and their own words.
Nobody else fills it in. Once approved, `sources/media/testing/lossy-quality.test.ts` fails when the same
encoder fingerprint produces other bytes for a reviewed sample, and a rejection for the current
encoder fails the suite; another encoder is held to the
[lossy tolerances](media-semantics.md#lossy-tolerances) only and needs a new review.
