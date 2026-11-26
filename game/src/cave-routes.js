// A short, enclosed floor, a turn around a central outcrop, or a gallery with
// two routes. Each outline is reused by the cave surface, the mine lights and
// the collision system. Coordinates in a template are relative to its floor arc.
export function caveRoutes(start, end, kind, rng, fixed) {
  const dx = end[0] - start[0], dz = end[1] - start[1];
  const length = Math.hypot(dx, dz);
  if (fixed || length < 12 || kind === 'scree') return null;

  const main = kind === 'entry' || kind === 'main';
  const width = main ? 6.4 : kind === 'narrow' ? 2.9 : 4.8;
  const side = rng() < .5 ? -1 : 1;
  const depth = side * Math.min(17, length * (.36 + .10 * rng()));
  const pattern = Math.floor(rng() * 3);
  const segments = [];
  const point = (t, lateral, offset) => [
    start[0] + t * dx - depth * lateral * dz / length,
    start[1] + t * dz + depth * lateral * dx / length,
    start[2] + t * (end[2] - start[2]) + offset
  ];
  function passage(points, widths, heights, mode, tag) {
    for (let i = 1; i < points.length; i++) {
      segments.push({a:points[i-1], b:points[i], hw:widths[i-1], H:heights[i-1],
        mode, tag, first:i === 1, last:i === points.length-1});
    }
  }
  const bend = .70 + .34 * rng();
  const rise = Math.min(1, length/26);
  // Shallow missing floor around a tall lip; broad lower passage and a raised
  // side approach; or a dogleg that doubles back across the old alignment.
  const first = point(.23 + .08*rng(), bend, (pattern === 1 ? -1.7 : -.6)*rise);
  const next = point(.62 + .09*rng(), pattern === 2 ? -.42 : bend*1.14,
    (pattern === 0 ? 1.2 : -.35)*rise);
  const opening = pattern === 1 ? width*1.95 : width*(1.35 + .27*rng());
  passage([start,first,next,end],
    [width*.86, width*(pattern === 1 ? 1.32 : .93), width*.82],
    [width*1.19, opening, width*1.28], main ? 'main' : 'side', 'room');

  if (length >= 18 && (kind === 'entry' || length >= 30 || rng() < .55)) {
    const ledge = point(.28, -.72, (pattern === 1 ? 2.35 : 1.1)*rise);
    const sill = point(.66, pattern === 2 ? -1.42 : -.94, 1.1*rise);
    passage([start,ledge,sill,end], [3.2,3.65,3], [4.0,5.3,4.4], 'side', 'ledge');
  }
  return segments;
}
