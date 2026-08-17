import { disableTypes } from 'image-size'

// image-size <=2.0.2 has known event-loop infinite loops in ICNS, JXL and
// HEIF/AVIF parsing, with no patched upstream release as of 2026-08-08.
// The platform only accepts PNG/JPEG/WebP/SVG assets for generated decks, so
// fail closed on the affected codecs before PptxGenJS handles any image.
export const DISABLED_UNSAFE_IMAGE_TYPES = ['icns', 'jxl', 'jxl-stream', 'heif'] as const

disableTypes([...DISABLED_UNSAFE_IMAGE_TYPES] as Parameters<typeof disableTypes>[0])
