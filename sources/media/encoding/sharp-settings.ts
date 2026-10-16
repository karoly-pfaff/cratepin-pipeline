import sharp from 'sharp';

// libvips keeps recently used operations and open files in a process-wide cache (by default up
// to 50 MB, 20 files, 100 operations). Every conversion here reads each original once, so the
// cache only holds memory that the next conversion cannot use: it is switched off before any
// image is probed or converted.
sharp.cache(false);

/** Threads libvips uses for one image: its default, one per CPU core; reported, not tuned. */
export function libvipsThreadsPerImage(): number {
  return sharp.concurrency();
}
