// Short counter text for public profiles and share cards: 950, 12K, 1.2B.
// Values are truncated, never rounded up, so a label cannot overstate a count.
const UNITS: [number, string][] = [[1e12, "T"], [1e9, "B"], [1e6, "M"], [1e3, "K"]];

export function compactNumber(value: number): string {
  const number = Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
  for (const [size, suffix] of UNITS) {
    if (number < size) continue;
    const digits = number < size * 10 ? 1 : 0;
    const factor = 10 ** digits;
    // Divide the scaled integer so 2.3B does not floor to 2.2B through 2.29999.
    return (Math.floor((number * factor) / size) / factor).toFixed(digits).replace(/\.0$/, "") + suffix;
  }
  return number.toLocaleString("en-US");
}
