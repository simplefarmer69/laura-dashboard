export function Sparkline({
  values,
  width = 160,
  height = 40,
  className = "stroke-[var(--sb-green)]",
}: {
  values: number[];
  width?: number;
  height?: number;
  className?: string;
}) {
  if (values.length < 2) {
    return (
      <div
        className="flex items-center text-xs text-muted-foreground"
        style={{ width, height }}
      >
        collecting history…
      </div>
    );
  }
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const step = width / (values.length - 1);
  const points = values
    .map((v, i) => `${(i * step).toFixed(1)},${(height - ((v - min) / span) * (height - 4) - 2).toFixed(1)}`)
    .join(" ");
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className="overflow-visible">
      <polyline fill="none" strokeWidth={1.5} className={className} points={points} />
    </svg>
  );
}
