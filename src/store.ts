import { create } from "zustand";
import type { Calibration, Edge, Point } from "./geometry";

export type Units = "m" | "cm" | "mm";
export type Tool = "calibrate" | "draw";
export type Document = { points: Record<string, Point>; edges: Edge[]; activePointId: string | null; calibration: Calibration | null; ppm: number | null; refLength: number; units: Units; orthogonal: boolean };
const emptyDocument: Document = { points: {}, edges: [], activePointId: null, calibration: null, ppm: null, refLength: 4, units: "m", orthogonal: true };
const clone = (document: Document): Document => structuredClone(document);
const uid = (prefix: string) => `${prefix}-${crypto.randomUUID()}`;
const hasEdge = (document: Document, a: string, b: string) => document.edges.some((edge) => (edge.a === a && edge.b === b) || (edge.a === b && edge.b === a));
const normalizeDocument = (saved: Document | (Omit<Document, "edges" | "activePointId"> & { paths?: { pointIds: string[] }[]; activePathId?: string | null })): Document => {
  if ("edges" in saved && Array.isArray(saved.edges)) return saved;
  const legacy = saved as Omit<Document, "edges" | "activePointId"> & { paths?: { pointIds: string[] }[] };
  const edges: Edge[] = [];
  for (const path of legacy.paths ?? []) for (let i = 1; i < path.pointIds.length; i += 1) {
    const a = path.pointIds[i - 1]; const b = path.pointIds[i];
    if (a !== b && !edges.some((edge) => (edge.a === a && edge.b === b) || (edge.a === b && edge.b === a))) edges.push({ id: uid("edge"), a, b });
  }
  return { ...legacy, edges, activePointId: null };
};

type Store = {
  document: Document; past: Document[]; future: Document[]; tool: Tool;
  setTool: (tool: Tool) => void; setUnits: (units: Units) => void; setRefLength: (length: number) => void; toggleOrthogonal: () => void;
  addDrawingClick: (point: Omit<Point, "id">, hitId: string | null) => void; insertPointOnEdge: (edgeId: string, point: Omit<Point, "id">) => string;
  movePoint: (id: string, point: Omit<Point, "id">) => void; removePoint: (id: string, squashRecentEdits?: number) => void; setCalibration: (a: Point, b: Point) => void;
  cancelDraft: () => void; undo: () => void; redo: () => void; reset: () => void; restore: (document: Document) => void;
};

export const useFloorplanStore = create<Store>((set, get) => {
  const commit = (mutate: (next: Document) => void) => { const current = get().document; const next = clone(current); mutate(next); set({ document: next, past: [...get().past, current], future: [] }); };
  return {
    document: emptyDocument, past: [], future: [], tool: "calibrate",
    setTool: (tool) => { if (tool !== "draw") get().cancelDraft(); set({ tool }); },
    setUnits: (units) => commit((next) => { next.units = units; }), setRefLength: (length) => commit((next) => { next.refLength = length; next.ppm = next.calibration && length > 0 ? Math.hypot(next.calibration.b.x - next.calibration.a.x, next.calibration.b.y - next.calibration.a.y) / length : null; }), toggleOrthogonal: () => commit((next) => { next.orthogonal = !next.orthogonal; }),
    addDrawingClick: (position, hitId) => commit((next) => { const pointId = hitId ?? uid("point"); if (!hitId) next.points[pointId] = { ...position, id: pointId }; if (next.activePointId && next.activePointId !== pointId && !hasEdge(next, next.activePointId, pointId)) next.edges.push({ id: uid("edge"), a: next.activePointId, b: pointId }); next.activePointId = hitId && hitId === next.activePointId ? null : pointId; }),
    insertPointOnEdge: (edgeId, position) => { const pointId = uid("point"); commit((next) => { const index = next.edges.findIndex((edge) => edge.id === edgeId); if (index < 0) return; const edge = next.edges[index]; next.points[pointId] = { ...position, id: pointId }; next.edges.splice(index, 1, { id: uid("edge"), a: edge.a, b: pointId }, { id: uid("edge"), a: pointId, b: edge.b }); }); return pointId; },
    movePoint: (id, point) => commit((next) => { if (next.points[id]) next.points[id] = { ...point, id }; }),
    removePoint: (id, squashRecentEdits = 0) => { const remove = (next: Document) => { const incident = next.edges.filter((edge) => edge.a === id || edge.b === id); const neighbors = [...new Set(incident.map((edge) => edge.a === id ? edge.b : edge.a))]; next.edges = next.edges.filter((edge) => edge.a !== id && edge.b !== id); delete next.points[id]; if (neighbors.length === 2 && !hasEdge(next, neighbors[0], neighbors[1])) next.edges.push({ id: uid("edge"), a: neighbors[0], b: neighbors[1] }); if (next.activePointId === id) next.activePointId = null; }; if (!squashRecentEdits) { commit(remove); return; } const { document, past } = get(); const next = clone(document); remove(next); const baseIndex = Math.max(0, past.length - squashRecentEdits); const base = past[baseIndex]; set({ document: next, past: base ? [...past.slice(0, baseIndex), base] : past, future: [] }); },
    setCalibration: (a, b) => commit((next) => { next.calibration = { a, b }; next.ppm = next.refLength > 0 ? Math.hypot(b.x - a.x, b.y - a.y) / next.refLength : null; }),
    cancelDraft: () => { if (get().document.activePointId) commit((next) => { next.activePointId = null; }); }, undo: () => { const { past, document, future } = get(); const previous = past.at(-1); if (previous) set({ document: previous, past: past.slice(0, -1), future: [document, ...future] }); }, redo: () => { const { past, document, future } = get(); const next = future[0]; if (next) set({ document: next, past: [...past, document], future: future.slice(1) }); }, reset: () => set({ document: clone(emptyDocument), past: [], future: [], tool: "calibrate" }), restore: (document) => { const normalized = normalizeDocument(document); set({ document: normalized, past: [], future: [], tool: normalized.ppm ? "draw" : "calibrate" }); },
  };
});
