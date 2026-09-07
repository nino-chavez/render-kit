# Photo-led sports social composition

Nino approved this approach on 2026-09-07 with “lock the approach in” after reviewing the v2 Flickday and Let’s Pepper studies. This is the shared composition guidance for continuing that work. The consumer’s brand and content standard remains authoritative.

## Approved direction

Build the composition around the real photograph. Give the athlete a foreground position, let selected typography pass behind or in front of the subject, and use background photography to establish depth. Large type, a restrained photographic echo, a displaced silhouette, or a torn print can support that structure. Choose effects for the photograph and message; do not stack every effect into every asset.

Flickday **Rally Echo** and Let’s Pepper **Open Air** are the selected reference layouts. Keep the other v2 concepts as alternatives, not as individually approved defaults. Rectangular photo strips with text beside them did not meet the brief for this work; do not substitute them for the integrated photo-and-type approach.

Use the consumer’s actual colors, fonts, marks, and sourced copy. The Season Suite public previews informed composition, not brand identity. Do not reproduce their artwork or imply that the purchased bundle was used.

## Preserve the photograph and editable source

- Keep the original downloaded photograph unchanged. Record its source URL and SHA-256 alongside the render.
- Reveal the original pixels through a foreground mask. Do not regenerate the athlete’s identity, pose, face, clothing, hands, or equipment. Inspect the mask against the original photograph, especially fingers, hair, limbs, and the ball.
- The v2 studies used image generation only to produce black-and-white segmentation masks. Mask generation is a preparation method, not a requirement for every future asset. Preserve each mask and its hash with its source photo.
- Align the mask and photo to exactly the same displayed geometry. These studies use CSS luminance masks with `mask-mode: luminance` and `mask-size: 100% 100%`; embed the mask as a data URL when rendering local HTML to avoid file-origin mask loading failures.
- Keep type, shapes, layers, crop positions, and campaign copy editable in HTML/CSS plus the data payload. Package local photos, masks, fonts, and the render command with the source. Export through Render Kit.

## Compose for the placement

Feed exports are 1080 × 1350. Story exports are 1080 × 1920. Recompose the story for its taller space and platform controls rather than stretching the feed. Keep the message, action, and important anatomy readable at phone size. Use overlap deliberately; a title crossing a leg can work while a title hiding a face can defeat the photograph.

When exploring a new direction, compare genuinely different compositions on the same content. Recoloring one layout is not a meaningful comparison. Continuing an approved layout does not require reopening the whole direction each time.

## Review the rendered result

Inspect the actual feed and story PNGs at native size and around 390 pixels wide. Compare them with the selected baseline and the original photograph. Check subject edges, photo-mask alignment, type hierarchy, cropping, important copy, and story safe areas. A source inspection or successful render cannot establish visual quality. Apply the consumer’s existing judged-render and independent review requirements.

The selected baseline hashes and editable sources are recorded in each consumer’s `photo-studies-v2/provenance.json`:

- Flickday: `flickday-assets/social/photo-studies-v2/` — Rally Echo feed and story.
- Let’s Pepper: `scripts/story-assets/photo-studies-v2/` — Open Air feed and story.

## Keep approval scope explicit

Record `design_approach` separately from `publication`. The current decision approves the photo-led social composition approach; it does not approve all alternatives, every future asset, new factual claims, or publication. Preserve photo permissions, factual checks, brand checks, and final human review from the consumer’s standard. Nothing in this contract publishes an asset or authorizes posting.
