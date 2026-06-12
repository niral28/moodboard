# Product

## Pitch

Pinterest shows you what an algorithm thinks you want; ChatGPT can do anything, but only one thing at a time. We're a private canvas where you drop anything you're curious about — outfits, trips, stocks, screenshots — and a swarm of small agents scouts the gaps, finds similar content, and acts in your own browser. Your data, your taste, your terms.

## Thesis

Chat is single-threaded; a canvas lets one user direct many small agents working in parallel. The next consumer AI surface is not "chat with one assistant" but "drop things on a board and watch agents resolve them." The product is a **generalist primitive** — like Notion's blocks or Figma's frames — that accepts any content type and lets users discover applications we didn't anticipate.

The wedge isn't a vertical; it's the *primitive itself*. Pinterest is a vertical bundle (fashion + home + wedding + recipes). We're a horizontal substrate.

## Target user (early adopters, not eventual market)

**Multi-app savers** — people who already collect inspiration across Instagram, TikTok, Pinterest, screenshots, Notes, browser bookmarks, and feel the chaos of it. They self-identify; we don't need to invent a persona.

Likely first cohorts (in order of demo-ability):
1. **Trip planners** — high-intent, time-bounded, mixed-media inputs (photos + links + research)
2. **Fashion-obsessed savers** — high-frequency, affiliate-friendly, "save more than they buy"
3. **Researchers / hobbyists / writers** — taste-driven information collection (stocks, recipes, design references)

We don't pick one ICP — we pick which demo and which channel to lead with. The product accepts all of them on day one.

**Who they're not (yet):**
- Teams / collaborators — that's a v2 architectural fork (privacy moat)
- B2B / professional creatives — different needs, Kive's lane
- General consumers without an existing save-things habit — they don't feel the pain

## What we are not

- Not a moodboard app (Are.na, Milanote own that)
- Not a social discovery platform (Pinterest, Cosmos own that)
- Not a price-comparison shopping agent (Phia owns that)
- Not a general AI assistant (ChatGPT, Operator own that)
- Not a developer tool / agent framework (Codex, OpenClaw own that)

## The four moats

1. **Private** — your taste profile lives on your machine, not in someone's ad-targeting cloud
2. **Mixed-media canvas** — emails, screenshots, links, images, photos all on one surface
3. **Local browser agent** — the agent acts in your own Chrome session, logged in as you
4. **Canvas as multi-agent UI** — N parallel agents on N cards, with spatial layout encoding intent

No competitor combines all four.

## User stories

### Primary (hackathon demo): "Jeans + Japan"

> I saw a pair of jeans I love at the store. I'm taking a trip to Tokyo and Kyoto in late June. I drop a photo of the jeans plus a few cards about the trip. The canvas infers the climate, my style direction, and the missing pieces. Scouts find tops, shoes, and outerwear that work with the jeans for warm-humid summer travel. I click one I like — Chrome opens with it in my cart, logged in as me, ready to checkout.

**Why this is the lead demo:**
- All four moats fire in 60 seconds
- Mixed media (photo + text) tests taste inference
- Trip context tests gap analysis
- The Chrome-staging moment is the killer screenshot
- Trip is a high-intent trigger that justifies signup; ongoing wardrobe curation is the retention loop

### Secondary: "Friends trip board"

> Four friends plan a Lisbon trip. Instead of dumping IG reels into a group chat that scrolls away, they drop them on a shared board. The canvas pulls out places / restaurants / vibes, finds similar ones they missed, and gives them one place to converge.

**Status: real but architecturally forking.** Multi-user breaks the privacy moat (data lives on a server, not your machine). Two paths: local-first multiplayer (Linear / Figma model — expensive but preserves the moat), or "shareable snapshot" (softer collab, no real-time sync). Decide after solo product retention data.

### Tertiary: "Stock watchlist"

> An investor drops tickers on a canvas. Cards show latest news and trend signals. Scouts suggest adjacent companies — peer movers, suppliers, competitors — based on what's already on the board.

**Status: works on day one as a generalist surface, won't be marketed.** Proves the canvas-as-primitive thesis: the same product handles taste-driven information curation, not just shopping. The risk in *marketing* it is the news-dashboard half is commoditized (Bloomberg), but the *scout* (suggesting peers based on what you hold) is genuinely novel and runs on the same pipeline as the shopping case. We let users discover this; we don't sell it.

## Demo flow (primary story)

1. User signs up → onboarding seeds a few demo cards (e.g., Kyoto)
2. User drops a jeans photo onto the canvas
3. User adds 2–3 trip cards ("Tokyo June", "Kyoto temples", "Linen / minimal")
4. User hits Tick Pipeline
5. Curate agent → infers taste profile + identifies gaps ("no warm-weather tops", "no walking shoes")
6. Orchestrate agent → dispatches scouts for each gap with search hints derived from the taste profile
7. Scout agents → return 3 candidates each, populated as cards on the canvas
8. User clicks a candidate → Stage agent launches their real Chrome (persistent profile), navigates to the product, screenshots, leaves the tab open
9. User completes the purchase manually in their already-logged-in browser

## Product principles

- **Action over recommendation.** The canvas doesn't just show — it stages purchases.
- **One agent, many tools.** The user doesn't pick from a menu of agent types. They describe intent; the agent picks tools.
- **Spatial intent is real intent.** Where a card sits, what it's grouped with, encodes meaning the agent uses.
- **The user always closes the loop.** The agent stages; the user clicks "buy." No autonomous spending. Trust is the product.
- **No social, no ads, no algorithm.** This is anti-Pinterest by design.

## Monetization

The generalist play complicates this — affiliate works great for fashion/shopping cards, weakly for trip planning, and not at all for stocks or screenshots. Options, in order of likelihood:

- **Affiliate on staged purchases** (LTK, Shopstyle Collective, retailer programs — 5–15% cuts). Strong revenue tail from shopping cards even if they're not the only use case. Most competitors are pre-revenue or charging $7/mo, so even partial affiliate is a structural advantage.
- **Subscription** ($7–15/mo) for power features (unlimited cards, premium scouts, multi-board, browser agent automations). Notion / Mymind / Are.na pattern.
- **Hybrid:** free tier with affiliate-monetized shopping, paid tier removes limits for non-shopping use cases.

Decide once we see which use cases dominate in actual usage.

## Open questions

- **Multi-user / collaboration:** if we add it, do we go local-first (expensive) or shared-export (compromised)? Decide after retention data on solo product.
- **iOS / desktop / extension:** the local browser agent makes web/desktop the natural surface. Mobile is a wish-list capture surface only (Share-to-Canvas), not a primary app.
- **Wardrobe ingestion:** if the user uploads photos of clothes they already own, the gap analysis is dramatically better. Worth a flow.
- **IG/TikTok ingestion:** legally and technically painful. oEmbed + user-pasted URLs only; never scrape.
- **Onboarding length:** a great first scout requires ~5–10 cards of context. How do we get there in <2 minutes without feeling like a survey?

## Out of scope (for now)

- Returns management, sizing, fit prediction
- Resale (Grailed/Depop integration) — interesting v2 with Phia-style secondhand graph
- Creator/influencer features
- Brand-side tooling
- Team/enterprise
