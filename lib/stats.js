// Small statistics helpers used by APM percentile reporting.

// Compute percentiles (0-100) on a numeric array. Always returns an array.
export function extentPercentiles(values, pcts) {
  const sorted = [...values].sort((a, b) => a - b);
  return pcts.map((p) => {
    if (!sorted.length) return null;
    const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
    return sorted[idx];
  });
}
