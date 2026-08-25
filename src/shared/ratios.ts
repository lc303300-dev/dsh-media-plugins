/**
 * Canonical media ratio constants (single source of truth — no DSH imports).
 *
 * The 8 image ratios and 6 video ratios were previously duplicated across
 * adapters / registry-core / image-skill-core / image-project-core /
 * project-core / revision-core. They are declared once here and re-exported
 * by each consumer to prevent drift.
 *
 * @module dsh-media-plugins/shared/ratios
 */

/** Image output ratios (8 values; contract: never infer, never extend). */
export const IMAGE_RATIOS = ['21:9', '16:9', '3:2', '4:3', '1:1', '3:4', '2:3', '9:16'] as const

/** Video ratios (6 values). */
export const VIDEO_RATIOS = ['1:1', '3:4', '16:9', '4:3', '9:16', '21:9'] as const
