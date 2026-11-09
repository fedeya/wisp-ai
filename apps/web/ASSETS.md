# Website assets

## Background and app icon

`public/barrens-hero-v1.avif` is a generated illustrative background,
1536 × 1024, 348,836 bytes. It is encoded from `barrens-crisp.webp` with
Sharp AVIF quality 85 / effort 6. Next Image serves it unoptimized, eager
and high priority. The chat interface is rendered with React and CSS.

`wisp.png` is the original generated Wisp app icon. The favicon and Apple
touch icons are resized derivatives.

## Item icons

`public/items/*.jpg` are WoW item/spell icons served by the Wowhead/ZAM CDN,
locally cached so visitors do not request that CDN. Blizzard game artwork is
third-party content, separate from the repository's code license.
Source URL pattern: https://wow.zamimg.com/images/wow/icons/large/{icon}.jpg

Mapping: vest=inv_chest_fur, linen=inv_fabric_linen_01,
feather=inv_feather_01, ore=inv_ore_copper_01, meat=inv_misc_food_14,
potion=inv_potion_51, wand=inv_wand_01, frost=spell_frost_frostbolt02,
fire=spell_fire_flamebolt, helm=inv_helmet_29, boots=inv_boots_05,
robe=inv_chest_cloth_04, staff=inv_staff_13, ring=inv_jewelry_ring_03,
book=inv_misc_book_09.

Item stats and auction amounts in the landing are illustrative Forever examples,
not live prices or a complete item database. No extracted game models are included.

The aliases `vest` and `feather` use `vest-fur.jpg` and `feather-light.jpg`.
Use new filenames when replacing icons to invalidate optimized-image caches.

## AI provider marks

`public/providers/{openai,claude-color,gemini-color,openrouter}.svg` are locally
served SVG marks from `@lobehub/icons-static-svg` 1.102.0 (Lobe Icons):
https://github.com/lobehub/lobe-icons

Source URL pattern:
https://cdn.jsdelivr.net/npm/@lobehub/icons-static-svg@1.102.0/icons/{name}.svg

The source MIT license is retained at `public/providers/LICENSE`. Brand marks
remain third-party trademarks. Claude/Gemini keep their color marks; OpenAI and
OpenRouter use the set's monochrome marks, displayed light on the dark page.
These assets are decorative alongside visible provider names, lazy-loaded,
self-hosted, and add no runtime icon dependency or remote browser request.

## Social card

The localized 1200 × 630 Open Graph / Twitter card is rendered with Next ImageResponse.
It reuses the homepage chat styling and locally cached item icons. social-barrens.jpg
is a 1200 × 630 JPEG derivative of barrens-crisp.webp (Sharp quality 90), used only
by the social image renderer. No extra asset is loaded by the landing itself.

The social headline uses self-hosted Gelasio Regular and Italic, a Georgia-like
serif from https://github.com/SorkinType/Gelasio/tree/main/fonts/ttf.
The SIL Open Font License is retained beside the fonts in src/assets/fonts/OFL.txt.
Only the social image loads these fonts; the homepage continues to use Georgia.
Supporting text uses the Geist Regular font bundled with Next's image renderer.
