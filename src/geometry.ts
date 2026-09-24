export type Point = { id: string; x: number; y: number };
/** A graph edge. Endpoints are vertex ids and every edge is undirected. */
export type Edge = { id: string; a: string; b: string };
export type Calibration = { a: Point; b: Point };

export const distance = (a: Point, b: Point) => Math.hypot(b.x - a.x, b.y - a.y);

export function orthogonalPoint(origin: Point, target: Point): Point {
  const dx = target.x - origin.x; const dy = target.y - origin.y;
  const angle = Math.abs(Math.atan2(dy, dx)); const quarterTurn = Math.PI / 2; const tolerance = 8 * Math.PI / 180;
  if (Math.min(angle, Math.abs(Math.PI - angle)) <= tolerance) return { ...target, y: origin.y };
  if (Math.abs(quarterTurn - angle) <= tolerance) return { ...target, x: origin.x };
  return target;
}

export const edgeLength = (edge: Edge, points: Record<string, Point>) => {
  const a = points[edge.a]; const b = points[edge.b]; return a && b ? distance(a, b) : 0;
};

export type ClosedFace = { pointIds: string[]; areaPx: number };

/** Enumerates bounded faces in a planar straight-line graph. The exterior face is excluded. */
export function closedFaces(edges: Edge[], points: Record<string, Point>): ClosedFace[] {
  const neighbors = new Map<string, Set<string>>();
  for (const edge of edges) {
    if (!points[edge.a] || !points[edge.b] || edge.a === edge.b) continue;
    if (!neighbors.has(edge.a)) neighbors.set(edge.a, new Set());
    if (!neighbors.has(edge.b)) neighbors.set(edge.b, new Set());
    neighbors.get(edge.a)!.add(edge.b); neighbors.get(edge.b)!.add(edge.a);
  }
  const ordered = new Map<string, string[]>();
  neighbors.forEach((ids, id) => {
    const origin = points[id];
    ordered.set(id, [...ids].sort((a, b) => Math.atan2(points[a].y - origin.y, points[a].x - origin.x) - Math.atan2(points[b].y - origin.y, points[b].x - origin.x)));
  });
  const visited = new Set<string>(); const faces: ClosedFace[] = []; const halfEdge = (a: string, b: string) => `${a}>${b}`;
  neighbors.forEach((ids, start) => ids.forEach((nextStart) => {
    if (visited.has(halfEdge(start, nextStart))) return;
    const cycle: string[] = []; let previous = start; let current = nextStart; const first = halfEdge(previous, current);
    for (let safety = 0; safety <= edges.length * 2 + 2; safety += 1) {
      visited.add(halfEdge(previous, current)); cycle.push(previous);
      const options = ordered.get(current); if (!options?.length) break;
      const incoming = options.indexOf(previous); const next = options[(incoming - 1 + options.length) % options.length];
      previous = current; current = next;
      if (halfEdge(previous, current) !== first) continue;
      let twiceArea = 0;
      for (let i = 0; i < cycle.length; i += 1) { const a = points[cycle[i]]; const b = points[cycle[(i + 1) % cycle.length]]; twiceArea += a.x * b.y - b.x * a.y; }
      if (twiceArea > 0.001) faces.push({ pointIds: cycle, areaPx: twiceArea / 2 });
      break;
    }
  }));
  return faces;
}
