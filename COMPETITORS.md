# Competitive Analysis

Honest read of the landscape as of May 2026. Each section: what they do, how they overlap with us, and what we can learn or defend against.

## Summary

Strong competitors exist in each axis individually, but no one is combining all three:

1. **Spatial canvas + collection** (Are.na, Milanote, Cosmos)
2. **AI curation / taste inference** (Mymind, Kive)
3. **Agentic shopping / browser action** (Phia, Pinterest Assistant, Operator)

The defensible wedge: a **private research assistant** that infers taste from a mixed-media canvas, names what's missing, scouts the open web, and stages results in a real browser.

---

## Direct moodboard / collection tools

### Are.na
- Cultural touchstone for link/image/text block-based collections.
- Community-driven, public-by-default.
- **Zero AI.** No taste inference, no scouting, no action.

### Milanote
- Visual moodboards with drag-drop, supports text/links/images/files.
- No agent layer.

### Cosmos.so
- "Home for your mind" — visual curation with neural search.
- **Cosmic Search:** semantic queries like *"soft lighting," "mid-century modern," "industrial textures"* — exactly the vocabulary shape we want our scout to use.
- Color palette filtering, image-to-search.
- **$15M Series A** — validates demand for "private inspiration board" category.
- Expanding into **social discovery and attribution** — their next ramp is *social*. Ours is *agentic*. Same starting point, divergent second move.
- Limitations: text-heavy / complex file types handled poorly. Image-first.
- **Steal:** their search-query vocabulary. Push our prompts toward this evocative-but-specific phrasing, not literal keywords.

### Pinterest
- See "existential threat" section below.

---

## AI-curated "second brain"

### Mymind
- Auto-tags saved items (images by color/style/mood, text, PDFs).
- Semantic search over your own collection.
- "Spaces" auto-populate from a tag/query — **but only from items already in your library.**
- "Serendipity" resurfaces forgotten saves.
- **Does not:** scout the open web, identify gaps, take browser action.
- No integrations, no collaboration — explicitly a private inbox.
- **Differentiation:** Mymind's flywheel ends at "rediscover what you saved." Ours starts there and adds the outbound loop. Could Mymind add scouting? Technically yes, but it cuts against their "calm, private, no overload" brand. A cultural moat may protect us.

### Kive
- **Cautionary tale.** Pivoted from "AI creative suite" → **"AI Product Photography for Consumer Brands."**
- The all-in-one moodboard + asset gen + brand library pitch didn't hold; they narrowed to e-commerce product photos.
- **Lesson:** "spatial AI moodboard" is too broad as a wedge. Pick one obsessive ICP — interior shoppers? wardrobe planners? travel? brand creatives writing briefs? — where the agentic loop is unmistakably valuable.

---

## Shopping / agentic competitors

### Phia
- Fashion-focused AI shopping agent. Founded by Phoebe Gates + Sophia Kianni.
- $8M raised, Chrome extension + iOS app, 350M-item search graph, 250M secondhand items.
- **Frame:** *utility* — "find the best price for this item."
- Identifies *known* items you point at. We discover *unknown* items from inferred taste.
- Building "a personalized shopping agent trained on transaction data" — could drift toward taste, but their wedge is so specific that broadening is hard.
- **Steal:** secondhand integration. For a taste-driven user, *"this Acne sweater also exists on Grailed for half"* is a magical moment.

### Pinterest — the existential threat
- **Pinterest Assistant** (rolling out 2026): conversational + visual search, *"show me shoes that would go with these pants."*
- **Styled for You:** AI collages from saved fashion pins → tap items → shoppable alternatives. Exactly our loop, minus the spatial canvas and browser staging.
- **Boards made for you:** auto-curates boards from saves and tastes. Their curate agent.
- Stated thesis: *"helping users know what to buy before they know what to ask for."* Almost verbatim our pitch.
- Rumored OpenAI acquisition target. Massive existing graph. Shopping integrations wired.

**Where Pinterest structurally cannot follow:**
1. **Private + ad-free** — their business model *is* the algorithmic engagement feed. A calm, non-social, no-ad surface cuts against $3B in ad revenue.
2. **Mixed media canvas** — emails, articles, screenshots, links, images together. Pinterest is pin-first; their data model resists this.
3. **Agentic browser hand-off** — they refer to retailer sites, they don't drive a real Chrome to stage a purchase.
4. **Spatial arrangement as signal** — *where* a user places a card encodes taste. Pinterest grids erase that.

### General-purpose agents (Operator, Computer Use, Multion, Daydream)
- General browser agents, not tied to a personal taste graph.
- Posture is "search for X," not "scout the gaps in an inferred taste."

---

## Strategic implications

### Stop pitching this as "AI moodboard"
Pinterest owns that mental real estate and will steamroll the category. Pitch as **"a private research assistant for things you want to buy / plan / make."**

### Lean on the four structural advantages
1. **Privacy** (the anti-Pinterest)
2. **Mixed media ingestion** (the anti-Are.na, anti-Pinterest)
3. **Agent stages in your browser** (the anti-everyone)
4. **Spatial layout as taste signal** — only one that genuinely *needs* a canvas

### Interrogate #4 hardest
If we can't articulate *why* spatial matters beyond aesthetics, drop the canvas — it's expensive to build and Pinterest's grid is already great. If we can (e.g., proximity = "goes together," columns = outfits, regions = rooms), make it **load-bearing in the agent's reasoning**, not just decoration. The `taste_profile` and `ScoutDispatch` prompts should consume layout, not just card contents.

### Pick a vertical
Kive's pivot is the warning. Candidates where the loop is most magical:
- Interior shopping (gaps = "you have warm wood + linen but no lighting plan")
- Wardrobe planning (gaps = "this jacket has nothing to pair with")
- Travel planning (gaps = "you've saved 3 Kyoto cards, no dinner reservation")
- Brand creative briefs (gaps = "your refs are all editorial, no product shots")

---

## Sources
- Mymind: [UseThisAI review](https://usethisai.com/tool/mymind/), [Kosmik alternatives roundup](https://www.kosmik.app/blog/mymind-alternatives), [Saner.ai review](https://blog.saner.ai/mymind-reviews/)
- Kive: [kive.ai](https://kive.ai/), [Skywork in-depth review](https://skywork.ai/skypage/en/Kive-In-depth-Review-(2025)-The-All-in-One-AI-Platform-for-a-New-Creative-Era/1976127051567001600)
- Cosmos: [$15M Series A — Pulse 2](https://pulse2.com/cosmos-15-million-series-a-closed-as-it-expands-social-discovery-and-attribution-features/), [Wix Studio review](https://www.wix.com/studio/blog/cosmos-app), [Subtech visual search review](https://subtech.it.com/is-the-cosmos-app-any-good-the-ultimate-visual-search-review/)
- Phia: [PR Newswire launch](https://www.prnewswire.com/news-releases/meet-phia-the-free-ai-shopping-tool-that-instantly-finds-you-the-best-price-on-fashion-founded-by-phoebe-gates-and-sophia-kianni-302436742.html), [TechCrunch founders interview](https://techcrunch.com/2025/10/29/phias-founders-on-how-ai-is-changing-online-shopping/), [DigitalCommerce360 raise coverage](https://www.digitalcommerce360.com/2025/09/18/phia-raises-8-million-to-scale-ai-shopping-platform/)
- Pinterest: [Pinterest Assistant launch — Social Media Today](https://www.socialmediatoday.com/news/pinterest-adds-ai-search-assistant-visual-spoken-queries/804304/), [PYMNTS — AI bet paying off](https://www.pymnts.com/news/social-commerce/2026/pinterests-ai-bet-on-visual-search-begins-paying-off-in-revenue/), [nekuda — OpenAI/Pinterest analysis](https://nekuda.substack.com/p/openai-to-buy-pinterest-heres-what)
