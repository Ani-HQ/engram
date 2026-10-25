// The production server and local preview share one public-page map.
export const PUBLIC_PAGE_FILES: Record<string, string> = {
  "/": "/home.html",
  "/app": "/index.html",
  "/app/": "/index.html",
  "/pricing": "/pricing.html",
  "/privacy": "/privacy.html",
  "/self-host": "/self-host.html",
  "/how-it-works": "/how-it-works.html",
  "/support": "/support.html",
  "/design-system": "/design-system.html",
};

export const INDEXABLE_PAGE_PATHS = ["/", "/how-it-works", "/pricing", "/self-host", "/privacy", "/support"] as const;
