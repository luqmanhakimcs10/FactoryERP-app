/**
 * The little trend line on a metric card.
 *
 * Draws a REAL series — it takes numbers and plots them. There is no decorative
 * mode and no placeholder shape: a card with no history renders no sparkline at
 * all rather than an invented squiggle, because a chart is read as evidence and
 * a fake one is a lie told in a convincing format.
 *
 * Deliberately axis-less and label-less. It answers "which way and how steadily",
 * which is all 90x40 pixels can honestly carry; the exact figure is the number
 * printed beside it.
 */
import React from 'react';
import { View } from 'react-native';
import Svg, { Path, Circle, Defs, LinearGradient, Stop } from 'react-native-svg';

interface Props {
  /** Oldest to newest. Fewer than two points draws nothing. */
  data: number[];
  color: string;
  width?: number;
  height?: number;
}

export function Sparkline({ data, color, width = 92, height = 40 }: Props) {
  if (!data || data.length < 2) return null;

  const min = Math.min(...data);
  const max = Math.max(...data);
  // A flat series would divide by zero and collapse onto one edge; 1 keeps it
  // on the centre line, which is what "no change" should look like.
  const span = max - min || 1;
  const stepX = width / (data.length - 1);
  // Inset so the stroke and the end dot are not clipped by the viewBox.
  const pad = 4;
  const usable = height - pad * 2;

  const points = data.map((v, i) => ({
    x: i * stepX,
    y: pad + usable - ((v - min) / span) * usable,
  }));

  const line = points
    .map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(2)},${p.y.toFixed(2)}`)
    .join(' ');
  // The same path closed down to the baseline, for the soft fill beneath it.
  const area = `${line} L${width},${height} L0,${height} Z`;
  const last = points[points.length - 1];
  const id = `spark-${color.replace(/[^a-z0-9]/gi, '')}`;

  return (
    // Explicit box + clip: react-native-web gives an <svg> no intrinsic size in
    // a flex row, so without this the chart escaped the card's padding and read
    // as a stray diagonal rule rather than a trend line.
    <View pointerEvents="none" style={{ width, height, overflow: 'hidden' }}>
      <Svg width={width} height={height} viewBox={`0 0 ${width} ${height}`}>
        <Defs>
          <LinearGradient id={id} x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0" stopColor={color} stopOpacity={0.22} />
            <Stop offset="1" stopColor={color} stopOpacity={0} />
          </LinearGradient>
        </Defs>
        <Path d={area} fill={`url(#${id})`} />
        <Path
          d={line}
          stroke={color}
          strokeWidth={2}
          fill="none"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <Circle cx={last.x} cy={last.y} r={3} fill={color} />
      </Svg>
    </View>
  );
}

export default Sparkline;
