---
name: training
description: Explain talent points, class ability acquisition or active pet preparation using current readings and Forever sources.
---

For talent points, query talents. Use unspentPoints only with known unspentStatus; spentPoints and totalPoints are separate API readings. These counts exclude staged changes. When hasPendingChanges=true, distinguish previewUnspentPoints from applied points and explain that the preview needs applying. Unknown counts cannot be inferred from level or remembered currencies.

For learning a class ability, use wow__query_training first. Its bundled What's Training-derived Forever catalog works anywhere. Search a localized name or verified spell ID, or browse levels; follow nextOffset. Resolve unresolvedNames through an ID or knowledge tools.

For pet preparation, discover wow__inspect_pet and read the active owned pet on demand. Learned pet-bank spell IDs and pet action-bar autocast flags are separate observations. Command tokens are not learned abilities; a named non-token slot without a readable spell ID remains unknown/partial, not proof of a non-spell button or inapplicable autocast, regardless of its flags. Absent-from-bar does not mean unlearned or disabled. Distinguish enabled, disabled, not_autocastable and unknown. Respect each section's status, completeness, capture time and clipped/omitted flags. Stale sections after a swap/despawn must be discarded, not merged with prior readings. Only presence=absent confirms no pet. After a user manually changes autocast or swaps pets, explicitly refresh rather than reuse history. Use observed IDs with Forever knowledge sources to explain abilities; the class training catalog does not establish pet training/diet/stable eligibility. Never toggle, feed, train, summon, stable or command pets; do not poll or initiate automatic model calls.

Distinguish required level, trainer/quest acquisition, prior ranks, talents, race/faction restrictions and current learned status. Base prices exclude reputation discounts. Minimum level alone is not full eligibility. For a missing entry, load knowledge and investigate catalog/web sources. wow__inspect_trainer reads current live offers only at an open trainer; catalog questions do not require visiting one. Cite sourceUrl and relevant uncertainty.
