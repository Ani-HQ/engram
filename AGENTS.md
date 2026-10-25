# Frontend design contract

For changes to any app view, public page, interaction, graphic or loading state:

- Read `docs/DESIGN-SYSTEM.md` and inspect `/design-system` locally first.
- Use `web/design-system.css` semantic tokens and existing primitives. Reuse
  `web/design-system.js` for shared visual elements.
- If a needed pattern is missing, contribute it to the design system and its
  gallery before using it in a product page. Do not add an independent visual
  language or duplicate a component in a feature stylesheet.
- Keep layout rules in the owning surface stylesheet; put reusable color, type,
  spacing, radius, state, motion and component decisions in the design system.
- Include loading, empty, error, success, focus, disabled and narrow-screen states
  where applicable. Respect reduced motion and keep keyboard actions immediate.
- Use local runtime assets. Preserve CSP, authentication, workspace pinning and
  truthful distinctions between observed activity and agent reports.
- Check the local result in a browser at desktop and mobile widths. Update the
  design-system documentation/gallery when the shared pattern changes.

Public copy uses `.agents/product-marketing-context.md`. Do not invent product
capabilities, customer proof, pricing, privacy guarantees or security claims.
