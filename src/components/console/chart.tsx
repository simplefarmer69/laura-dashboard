"use client";

export interface ChartPoint {
  label: string;
  value: number;
}

/**
 * Dependency-free SVG line/area chart with a y axis, sized by its container.
 * Designed for small daily series (grade, market cap) that grow over weeks.
 */
export function LineChart({
  points,
  height = 180,
  color = "var(--sb-accent)",
  format = (v: number) => v.toFixed(0),
  yMin,
  yMax,
  emptyLabel = "Collecting daily history…",
}: {
  points: ChartPoint[];
  height?: number;
  color?: string;
  format?: (v: number) => string;
  yMin?: number;
  yMax?: number;
  emptyLabel?: string;
}) {
  const width = 640;
  const padL = 56;
  const padR = 12;
  const padT = 12;
  const padB = 26;
  if (points.length === 0) {
    return (
      <div className="flex items-center justify-center text-xs text-muted-foreground" style={{ height }}>
        {emptyLabel}
      </div>
    );
  }
  const values = points.map((p) => p.value);
  const lo = yMin ?? Math.min(...values);
  const hi = yMax ?? Math.max(...values);
  const span = hi - lo || Math.abs(hi) * 0.1 || 1;
  const innerW = width - padL - padR;
  const innerH = height - padT - padB;
  const x = (i: number) => padL + (points.length === 1 ? innerW / 2 : (i / (points.length - 1)) * innerW);
  const y = (v: number) => padT + innerH - ((v - lo) / span) * innerH;
  const path = points.map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join(" ");
  const area = `${path} L${x(points.length - 1).toFixed(1)},${(padT + innerH).toFixed(1)} L${x(0).toFixed(1)},${(padT + innerH).toFixed(1)} Z`;
  const ticks = [lo, lo + span / 2, hi];
  const labelEvery = Math.max(1, Math.ceil(points.length / 6));

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="h-auto w-full" role="img">
      {ticks.map((t, i) => (
        <g key={i}>
          <line x1={padL} x2={width - padR} y1={y(t)} y2={y(t)} stroke="rgba(150,196,222,0.1)" strokeDasharray="2 4" />
          <text x={padL - 8} y={y(t) + 3} textAnchor="end" fontSize="10" fill="var(--muted-foreground)" fontFamily="var(--font-mono)">
            {format(t)}
          </text>
        </g>
      ))}
      <path d={area} fill={color} opacity={0.08} />
      <path d={path} fill="none" stroke={color} strokeWidth={1.75} />
      {points.map((p, i) => (
        <g key={i}>
          <circle cx={x(i)} cy={y(p.value)} r={points.length > 40 ? 1.5 : 2.5} fill={color} />
          {i % labelEvery === 0 && (
            <text x={x(i)} y={height - 8} textAnchor="middle" fontSize="10" fill="var(--muted-foreground)" fontFamily="var(--font-mono)">
              {p.label}
            </text>
          )}
        </g>
      ))}
    </svg>
  );
}
