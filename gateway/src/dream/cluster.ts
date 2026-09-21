import type { MemoryEntry } from "../memory-entries";

export interface DerivedCluster {
  slug: string;
  title: string;
  members: string[];
}

export function deriveClusters(entries: MemoryEntry[]): DerivedCluster[] {
  const byPrefix = new Map<string, MemoryEntry[]>();
  for (const entry of entries) {
    const prefix = entry.slug.includes("/") ? entry.slug.slice(0, entry.slug.indexOf("/")) : "other";
    if (!byPrefix.has(prefix)) byPrefix.set(prefix, []);
    byPrefix.get(prefix)!.push(entry);
  }
  const clusters: DerivedCluster[] = [];
  for (const [prefix, group] of byPrefix) {
    const bySlug = new Map<string, MemoryEntry[]>();
    for (const entry of group) {
      if (!bySlug.has(entry.slug)) bySlug.set(entry.slug, []);
      bySlug.get(entry.slug)!.push(entry);
    }
    for (const [slug, members] of bySlug) {
      if (members.length < 2 && prefix === "notes") continue;
      const title = slug.split("/").filter(Boolean).pop()?.replace(/-/g, " ") ?? slug;
      clusters.push({
        slug: `meta/clusters/${slug.replace(/\//g, "-")}`,
        title,
        members: [slug],
      });
    }
  }
  return clusters;
}
