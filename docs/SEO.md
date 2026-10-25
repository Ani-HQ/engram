# Search and public content

This local redesign gives Engram a public home at `/`; the private app remains at
`/app`. Indexable pages explain shared agent memory, setup, pricing, self-hosting,
privacy and support. The app, authorization and design-system gallery are not
search landing pages.

Public routes are shared by production and preview in `gateway/src/site-routes.ts`.
Each public page has a descriptive title, one primary heading, a description,
its canonical URL and local social artwork. `/sitemap.xml` contains only the
canonical public pages. `/robots.txt` references that sitemap and avoids crawling
service endpoints. Missing pages return an actual 404; this is not an access
control mechanism. Private data remains protected by authentication.

Update the route map, sitemap, internal links and page metadata together when
adding a public page. Make meaningful text and links available in the HTML;
decorative SVGs supplement the explanation. Do not invent ratings, customer proof,
schema claims or search traffic. No analytics service was added by this redesign.

The social SVG and PNG are generated from design-system colors by
`bun deploy/render-social-card.ts`. Keep artwork changes in the shared system.

Implementation references: [Google's sitemap guidance](https://developers.google.com/search/docs/crawling-indexing/sitemaps/build-sitemap),
[canonical URL guidance](https://developers.google.com/search/docs/crawling-indexing/consolidate-duplicate-urls)
and [descriptive title guidance](https://developers.google.com/search/docs/appearance/title-link).
Search Console submission and measured indexing/performance outcomes are separate
post-release checks; no result is claimed before those checks.
