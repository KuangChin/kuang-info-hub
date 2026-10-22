export function Sparkline({ data, positive }: { data: number[]; positive: boolean }) {
  const width = 94;
  const height = 34;
  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min || 1;
  const points = data.map((value, index) => `${(index / (data.length - 1)) * width},${height - ((value - min) / range) * (height - 4) - 2}`).join(" ");
  const id = `gradient-${data.join("-")}`;
  return (
    <svg className="sparkline" viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={positive ? "#67e8a5" : "#ff7c8e"} stopOpacity=".32" />
          <stop offset="1" stopColor={positive ? "#67e8a5" : "#ff7c8e"} stopOpacity="0" />
        </linearGradient>
      </defs>
      <polygon points={`0,${height} ${points} ${width},${height}`} fill={`url(#${id})`} />
      <polyline points={points} fill="none" stroke={positive ? "#67e8a5" : "#ff7c8e"} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
