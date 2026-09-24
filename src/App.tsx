import type React from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { GlobalWorkerOptions, getDocument, type PDFPageProxy, type RenderTask } from "pdfjs-dist";
import pdfWorker from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { closedFaces, distance, edgeLength, orthogonalPoint, type Point } from "./geometry";
import { useFloorplanStore, type Document, type Tool, type Units } from "./store";

const LS_KEY = "floorplan-measurement-v9";
const HIT_RADIUS = 10;
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
type View = { zoom: number; offset: { x: number; y: number } };
type ImageInfo = { dataUrl: string; name: string; width: number; height: number };
type BackgroundInfo = ImageInfo & { kind?: "image" | "pdf" };

GlobalWorkerOptions.workerSrc = pdfWorker;

export default function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const pdfCanvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const pdfPageRef = useRef<PDFPageProxy | null>(null);
  const pdfRenderRef = useRef<RenderTask | null>(null);
  const pdfRenderTimerRef = useRef<number | null>(null);
  const renderedPdfViewRef = useRef<View | null>(null);
  const [imageInfo, setImageInfo] = useState<BackgroundInfo | null>(null);
  const [pdfRevision, setPdfRevision] = useState(0);
  const [fileError, setFileError] = useState<string | null>(null);
  const [isLoadingFile, setIsLoadingFile] = useState(false);
  const [hydrated, setHydrated] = useState(false);
  const [view, setView] = useState<View>({ zoom: 1, offset: { x: 0, y: 0 } });
  const viewRef = useRef(view);
  const [pointerWorld, setPointerWorld] = useState<Point | null>(null);
  const [hoveredPointId, setHoveredPointId] = useState<string | null>(null);
  const [hoveredSegment, setHoveredSegment] = useState<string | null>(null);
  const [calibrationStart, setCalibrationStart] = useState<Point | null>(null);
  const [spaceDown, setSpaceDown] = useState(false);
  const interaction = useRef<null | {
    kind: "pan" | "point"; pointerId: number; startScreen: { x: number; y: number };
    startOffset?: { x: number; y: number }; pointId?: string; startPoint?: Point;
    currentPoint?: Point; moved: boolean; inserted?: boolean;
  }>(null);
  const touches = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<null | { distance: number; zoom: number; world: Point }>(null);

  const document = useFloorplanStore((state) => state.document);
  const tool = useFloorplanStore((state) => state.tool);
  const past = useFloorplanStore((state) => state.past);
  const future = useFloorplanStore((state) => state.future);
  const actions = useFloorplanStore();
  const { points, edges, activePointId, calibration, ppm, refLength, units, orthogonal } = document;
  useEffect(() => { viewRef.current = view; }, [view]);

  const activePoint = activePointId ? points[activePointId] : null;
  const loops = useMemo(() => closedFaces(edges, points), [edges, points]);
  const totalArea = ppm ? loops.reduce((sum, loop) => sum + loop.areaPx / (ppm * ppm), 0) : 0;
  const worldToScreen = useCallback((point: Pick<Point, "x" | "y">) => ({ x: point.x * viewRef.current.zoom + viewRef.current.offset.x, y: point.y * viewRef.current.zoom + viewRef.current.offset.y }), []);
  const screenToWorld = useCallback((x: number, y: number): Point => ({ id: "pointer", x: (x - viewRef.current.offset.x) / viewRef.current.zoom, y: (y - viewRef.current.offset.y) / viewRef.current.zoom }), []);
  const eventScreen = (event: { currentTarget: HTMLCanvasElement; clientX: number; clientY: number }) => { const rect = event.currentTarget.getBoundingClientRect(); return { x: event.clientX - rect.left, y: event.clientY - rect.top }; };
  const pointAt = useCallback((screen: { x: number; y: number }) => {
    let best: { id: string; distance: number } | null = null;
    for (const point of Object.values(points)) { const p = worldToScreen(point); const d = Math.hypot(p.x - screen.x, p.y - screen.y); if (d <= HIT_RADIUS && (!best || d < best.distance)) best = { id: point.id, distance: d }; }
    return best?.id ?? null;
  }, [points, worldToScreen]);
  const segmentAt = useCallback((screen: { x: number; y: number }) => {
    let best: { edgeId: string; point: Point; distance: number } | null = null;
    for (const edge of edges) {
      const a = points[edge.a]; const b = points[edge.b]; if (!a || !b) continue;
      const sa = worldToScreen(a); const sb = worldToScreen(b); const dx = sb.x - sa.x; const dy = sb.y - sa.y; const lengthSquared = dx * dx + dy * dy;
      if (!lengthSquared) continue;
      const t = clamp(((screen.x - sa.x) * dx + (screen.y - sa.y) * dy) / lengthSquared, 0, 1);
      const projection = { x: sa.x + t * dx, y: sa.y + t * dy }; const d = Math.hypot(screen.x - projection.x, screen.y - projection.y);
      if (d <= 7 && (!best || d < best.distance)) best = { edgeId: edge.id, point: { id: "segment", x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y) }, distance: d };
    }
    return best;
  }, [edges, points, worldToScreen]);
  const snappedPoint = useCallback((raw: Point, hitId: string | null, origin?: Point | null) => {
    if (hitId && points[hitId]) return points[hitId];
    return orthogonal && origin ? orthogonalPoint(origin, raw) : raw;
  }, [orthogonal, points]);

  const fitImage = useCallback(() => {
    const container = containerRef.current; if (!imageInfo || !container) return;
    const rect = container.getBoundingClientRect(); const zoom = Math.min(rect.width / imageInfo.width, rect.height / imageInfo.height) * 0.94;
    setView({ zoom, offset: { x: (rect.width - imageInfo.width * zoom) / 2, y: (rect.height - imageInfo.height * zoom) / 2 } });
  }, [imageInfo]);
  const loadImage = useCallback((info: ImageInfo) => {
    pdfPageRef.current = null; renderedPdfViewRef.current = null; setImageInfo({ ...info, kind: "image" });
  }, []);
  useEffect(() => { if (imageInfo) requestAnimationFrame(fitImage); }, [fitImage, imageInfo]);
  const openImage = useCallback((dataUrl: string, name: string) => {
    const probe = new Image();
    probe.onload = () => { actions.reset(); actions.setTool("calibrate"); loadImage({ dataUrl, name, width: probe.width, height: probe.height }); };
    probe.onerror = () => setFileError("This image could not be opened.");
    probe.src = dataUrl;
  }, [actions, loadImage]);
  const onFile = async (file: File) => {
    setFileError(null);
    const isPdf = file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");
    if (!isPdf && !file.type.startsWith("image/")) { setFileError("Choose an image or PDF floor plan."); return; }
    setIsLoadingFile(true);
    try {
      if (!isPdf) { openImage(await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(new Error("Unable to read image.")); reader.readAsDataURL(file); }), file.name); return; }
      const dataUrl = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(new Error("Unable to read PDF.")); reader.readAsDataURL(file); });
      const pdf = await getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
      const page = await pdf.getPage(1);
      const viewport = page.getViewport({ scale: 1 });
      pdfPageRef.current = page; setPdfRevision((revision) => revision + 1);
      actions.reset(); actions.setTool("calibrate"); setImageInfo({ kind: "pdf", dataUrl, name: file.name, width: viewport.width, height: viewport.height });
    } catch {
      setFileError("This PDF could not be rendered. Try a different file or convert it to an image.");
    } finally { setIsLoadingFile(false); }
  };

  const resetFloorplan = useCallback(() => {
    actions.reset();
    pdfPageRef.current = null;
    renderedPdfViewRef.current = null;
    setImageInfo(null);
    setPdfRevision(0);
    setFileError(null);
    setView({ zoom: 1, offset: { x: 0, y: 0 } });
    setPointerWorld(null);
    setHoveredPointId(null);
    setHoveredSegment(null);
    setCalibrationStart(null);
    interaction.current = null;
    touches.current.clear();
    pinch.current = null;
    localStorage.removeItem(LS_KEY);
  }, [actions]);

  useEffect(() => {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) { setHydrated(true); return; }
    try { const saved = JSON.parse(raw) as { document: Document; image: BackgroundInfo | null; view: View }; if (saved.document) actions.restore(saved.document); if (saved.view) setView(saved.view); if (saved.image) { if (saved.image.kind === "pdf") setImageInfo(saved.image); else loadImage(saved.image); } }
    catch { localStorage.removeItem(LS_KEY); }
    finally { setHydrated(true); }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => { if (hydrated) localStorage.setItem(LS_KEY, JSON.stringify({ document, image: imageInfo, view })); }, [document, hydrated, imageInfo, view]);
  useEffect(() => {
    if (!imageInfo || imageInfo.kind !== "pdf" || pdfPageRef.current) return;
    let cancelled = false;
    void (async () => { try { const bytes = new Uint8Array(await (await fetch(imageInfo.dataUrl)).arrayBuffer()); const page = await (await getDocument({ data: bytes }).promise).getPage(1); if (!cancelled) { pdfPageRef.current = page; setPdfRevision((revision) => revision + 1); } } catch { if (!cancelled) setFileError("This saved PDF could not be restored."); } })();
    return () => { cancelled = true; };
  }, [imageInfo]);
  useEffect(() => {
    const page = pdfPageRef.current; const canvas = pdfCanvasRef.current; const container = containerRef.current;
    if (!page || !canvas || !container || imageInfo?.kind !== "pdf") return;
    let cancelled = false;
    const previous = renderedPdfViewRef.current;
    if (previous) {
      const scale = view.zoom / previous.zoom;
      const translateX = view.offset.x - previous.offset.x * scale;
      const translateY = view.offset.y - previous.offset.y * scale;
      canvas.style.transform = `matrix(${scale}, 0, 0, ${scale}, ${translateX}, ${translateY})`;
    }
    if (pdfRenderTimerRef.current) window.clearTimeout(pdfRenderTimerRef.current);
    pdfRenderRef.current?.cancel();
    const render = async () => {
      const dpr = window.devicePixelRatio || 1; const rect = container.getBoundingClientRect();
      const renderView = view;
      const viewport = page.getViewport({ scale: renderView.zoom * dpr });
      canvas.width = Math.ceil(rect.width * dpr); canvas.height = Math.ceil(rect.height * dpr);
      canvas.style.width = `${rect.width}px`; canvas.style.height = `${rect.height}px`; canvas.style.transform = "none";
      const context = canvas.getContext("2d"); if (!context) return;
      const task = page.render({ canvas, canvasContext: context, viewport, transform: [1, 0, 0, 1, renderView.offset.x * dpr, renderView.offset.y * dpr] });
      pdfRenderRef.current = task;
      await task.promise;
      if (pdfRenderRef.current === task) { pdfRenderRef.current = null; renderedPdfViewRef.current = renderView; }
    };
    pdfRenderTimerRef.current = window.setTimeout(() => { void render().catch(() => { if (!cancelled) setFileError("This PDF could not be rendered."); }); }, 120);
    return () => { cancelled = true; if (pdfRenderTimerRef.current) window.clearTimeout(pdfRenderTimerRef.current); pdfRenderRef.current?.cancel(); };
  }, [imageInfo, pdfRevision, view]);

  const formatLength = useCallback((meters: number) => units === "m" ? `${meters.toFixed(2)} m` : units === "cm" ? `${(meters * 100).toFixed(0)} cm` : `${(meters * 1000).toFixed(0)} mm`, [units]);
  const formatArea = (sqm: number) => `${sqm.toFixed(2)} m²`;

  const draw = useCallback(() => {
    const canvas = canvasRef.current; if (!canvas) return;
    const ctx = canvas.getContext("2d"); if (!ctx) return;
    const dpr = window.devicePixelRatio || 1; const rect = canvas.getBoundingClientRect();
    if (canvas.width !== Math.round(rect.width * dpr) || canvas.height !== Math.round(rect.height * dpr)) { canvas.width = Math.round(rect.width * dpr); canvas.height = Math.round(rect.height * dpr); }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, rect.width, rect.height);
    const screenPoint = (id: string) => { const dragged = interaction.current?.pointId === id ? interaction.current.currentPoint : null; const point = dragged ?? points[id]; return point ? { x: point.x * view.zoom + view.offset.x, y: point.y * view.zoom + view.offset.y } : null; };
    const label = (text: string, x: number, y: number, accent = false) => { ctx.save(); ctx.font = "600 12px ui-sans-serif, system-ui"; const width = ctx.measureText(text).width + 14; ctx.fillStyle = accent ? "rgba(5, 150, 105, .94)" : "rgba(15, 23, 42, .88)"; ctx.beginPath(); ctx.roundRect(x - width / 2, y - 12, width, 24, 7); ctx.fill(); ctx.fillStyle = "white"; ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.fillText(text, x, y); ctx.restore(); };
    const stroke = (a: { x: number; y: number }, b: { x: number; y: number }, color: string, dashed = false) => { ctx.save(); ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.setLineDash(dashed ? [7, 6] : []); ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke(); ctx.restore(); };
    if (calibration) { const a = worldToScreen(calibration.a); const b = worldToScreen(calibration.b); stroke(a, b, "#f59e0b"); label(`${refLength} m reference`, (a.x + b.x) / 2, (a.y + b.y) / 2); }
    edges.forEach((edge) => { const a = screenPoint(edge.a); const b = screenPoint(edge.b); if (!a || !b) return; stroke(a, b, "#059669"); if (ppm) label(formatLength(edgeLength(edge, points) / ppm), (a.x + b.x) / 2, (a.y + b.y) / 2); });
    if (calibrationStart && pointerWorld) stroke(worldToScreen(calibrationStart), worldToScreen(snappedPoint(pointerWorld, hoveredPointId, calibrationStart)), "#f59e0b", true);
    if (activePoint && pointerWorld) stroke(worldToScreen(activePoint), worldToScreen(snappedPoint(pointerWorld, hoveredPointId, activePoint)), "#0284c7", true);
    Object.values(points).forEach((point) => { const p = screenPoint(point.id); if (!p) return; ctx.beginPath(); ctx.arc(p.x, p.y, point.id === hoveredPointId ? 6 : 4.5, 0, Math.PI * 2); ctx.fillStyle = point.id === hoveredPointId ? "#0f172a" : "white"; ctx.fill(); ctx.lineWidth = 2; ctx.strokeStyle = "#059669"; ctx.stroke(); });
    if (hoveredSegment && pointerWorld) { const p = worldToScreen(pointerWorld); ctx.beginPath(); ctx.arc(p.x, p.y, 5, 0, Math.PI * 2); ctx.fillStyle = "white"; ctx.fill(); ctx.lineWidth = 2; ctx.strokeStyle = "#0284c7"; ctx.stroke(); }
  }, [activePoint, calibration, calibrationStart, edges, formatLength, hoveredPointId, hoveredSegment, loops, pointerWorld, points, ppm, refLength, snappedPoint, view, worldToScreen]);
  useEffect(() => { const observer = new ResizeObserver(draw); if (containerRef.current) observer.observe(containerRef.current); draw(); return () => observer.disconnect(); }, [draw]);

  const zoomAt = useCallback((factor: number, center?: { x: number; y: number }) => {
    const rect = canvasRef.current?.getBoundingClientRect(); const c = center ?? { x: (rect?.width ?? 0) / 2, y: (rect?.height ?? 0) / 2 };
    setView((current) => { const world = { x: (c.x - current.offset.x) / current.zoom, y: (c.y - current.offset.y) / current.zoom }; const zoom = clamp(current.zoom * factor, 0.05, 20); return { zoom, offset: { x: c.x - world.x * zoom, y: c.y - world.y * zoom } }; });
  }, []);
  useEffect(() => {
    const canvas = canvasRef.current; if (!canvas) return;
    const wheel = (event: WheelEvent) => { event.preventDefault(); const rect = canvas.getBoundingClientRect(); if (event.ctrlKey || event.metaKey) zoomAt(Math.exp(-event.deltaY * 0.01), { x: event.clientX - rect.left, y: event.clientY - rect.top }); else setView((current) => ({ ...current, offset: { x: current.offset.x - event.deltaX, y: current.offset.y - event.deltaY } })); };
    canvas.addEventListener("wheel", wheel, { passive: false }); return () => canvas.removeEventListener("wheel", wheel);
  }, [zoomAt]);
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      // Escape must be intercepted before focused controls or other listeners can act on it.
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        setCalibrationStart(null);
        actions.cancelDraft();
        return;
      }

      const editingField = event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement;
      if (!editingField && event.key === " " && !event.repeat) { event.preventDefault(); setSpaceDown(true); }
      if (event.key === "Enter") { setCalibrationStart(null); actions.cancelDraft(); }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") { event.preventDefault(); if (event.shiftKey) actions.redo(); else actions.undo(); }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "y") { event.preventDefault(); actions.redo(); }
      if (editingField) return;
      if (event.key.toLowerCase() === "c") actions.setTool("calibrate");
      if (event.key.toLowerCase() === "d" && ppm) actions.setTool("draw");
    };
    const keyup = (event: KeyboardEvent) => { if (event.key === " ") setSpaceDown(false); };
    window.addEventListener("keydown", keydown, { capture: true });
    window.addEventListener("keyup", keyup);
    return () => {
      window.removeEventListener("keydown", keydown, { capture: true });
      window.removeEventListener("keyup", keyup);
    };
  }, [actions, ppm]);

  const onPointerDown: React.PointerEventHandler<HTMLCanvasElement> = (event) => {
    const screen = eventScreen(event);
    if (event.pointerType === "touch") { touches.current.set(event.pointerId, { x: event.clientX, y: event.clientY }); event.currentTarget.setPointerCapture(event.pointerId); if (touches.current.size === 2) { const [a, b] = [...touches.current.values()]; const rect = event.currentTarget.getBoundingClientRect(); const center = { x: (a.x + b.x) / 2 - rect.left, y: (a.y + b.y) / 2 - rect.top }; pinch.current = { distance: Math.hypot(a.x - b.x, a.y - b.y), zoom: viewRef.current.zoom, world: screenToWorld(center.x, center.y) }; } return; }
    const wantsPan = spaceDown || event.button === 1 || event.button === 2;
    if (wantsPan) { event.currentTarget.setPointerCapture(event.pointerId); interaction.current = { kind: "pan", pointerId: event.pointerId, startScreen: screen, startOffset: viewRef.current.offset, moved: false }; return; }
    if (!imageInfo || event.button !== 0) return;
    const hitId = pointAt(screen);
    if (tool === "draw" && hitId) { event.currentTarget.setPointerCapture(event.pointerId); interaction.current = { kind: "point", pointerId: event.pointerId, pointId: hitId, startPoint: points[hitId], currentPoint: points[hitId], startScreen: screen, moved: false }; return; }
    const raw = screenToWorld(screen.x, screen.y);
    if (tool === "draw" && ppm) { const segment = segmentAt(screen); if (segment) { const pointId = actions.insertPointOnEdge(segment.edgeId, segment.point); event.currentTarget.setPointerCapture(event.pointerId); interaction.current = { kind: "point", pointerId: event.pointerId, pointId, startPoint: { ...segment.point, id: pointId }, currentPoint: { ...segment.point, id: pointId }, startScreen: screen, moved: false, inserted: true }; return; } actions.addDrawingClick(snappedPoint(raw, null, activePoint), null); return; }
    if (tool === "calibrate") { if (!calibrationStart) setCalibrationStart(raw); else { const end = snappedPoint(raw, null, calibrationStart); if (distance(calibrationStart, end) > 1 && refLength > 0) { actions.setCalibration(calibrationStart, end); actions.setTool("draw"); } setCalibrationStart(null); } }
  };
  const onPointerMove: React.PointerEventHandler<HTMLCanvasElement> = (event) => {
    const screen = eventScreen(event);
    if (event.pointerType === "touch") { if (!touches.current.has(event.pointerId)) return; touches.current.set(event.pointerId, { x: event.clientX, y: event.clientY }); if (touches.current.size === 2 && pinch.current) { const [a, b] = [...touches.current.values()]; const rect = event.currentTarget.getBoundingClientRect(); const center = { x: (a.x + b.x) / 2 - rect.left, y: (a.y + b.y) / 2 - rect.top }; const zoom = clamp(pinch.current.zoom * Math.hypot(a.x - b.x, a.y - b.y) / pinch.current.distance, 0.05, 20); setView({ zoom, offset: { x: center.x - pinch.current.world.x * zoom, y: center.y - pinch.current.world.y * zoom } }); } return; }
    const current = interaction.current;
    if (current?.pointerId === event.pointerId) { const delta = { x: screen.x - current.startScreen.x, y: screen.y - current.startScreen.y }; if (Math.hypot(delta.x, delta.y) > 3) current.moved = true; if (current.kind === "pan" && current.startOffset) setView((v) => ({ ...v, offset: { x: current.startOffset!.x + delta.x, y: current.startOffset!.y + delta.y } })); if (current.kind === "point" && current.startPoint) { current.currentPoint = { ...current.startPoint, x: current.startPoint.x + delta.x / viewRef.current.zoom, y: current.startPoint.y + delta.y / viewRef.current.zoom }; setPointerWorld(current.currentPoint); } return; }
    const hitId = pointAt(screen); const segment = hitId ? null : segmentAt(screen); setHoveredPointId(hitId); setHoveredSegment(segment?.edgeId ?? null); setPointerWorld(segment?.point ?? screenToWorld(screen.x, screen.y));
  };
  const endPointer: React.PointerEventHandler<HTMLCanvasElement> = (event) => { if (event.pointerType === "touch") { touches.current.delete(event.pointerId); if (touches.current.size < 2) pinch.current = null; return; } const current = interaction.current; if (current?.pointerId === event.pointerId) { if (current.kind === "point" && current.pointId) { if (current.moved && current.currentPoint) actions.movePoint(current.pointId, current.currentPoint); else if (!current.inserted && ppm) actions.addDrawingClick(points[current.pointId], current.pointId); } interaction.current = null; } };

  const cursor = spaceDown ? "grab" : (hoveredPointId || hoveredSegment) && tool === "draw" ? "pointer" : "crosshair";
  const toolButton = (value: Tool, label: string, shortcut: string, disabled = false) => <button disabled={disabled} onClick={() => actions.setTool(value)} className={`rounded-lg px-3 py-2 text-sm font-semibold transition ${tool === value ? "bg-slate-900 text-white shadow" : "text-slate-600 hover:bg-slate-100"} disabled:cursor-not-allowed disabled:opacity-35`} title={`${label} (${shortcut})`}>{label}<span className="ml-1 text-xs opacity-60">{shortcut}</span></button>;

  return <main className="flex h-dvh flex-col overflow-hidden bg-slate-100 text-slate-900">
    <header className="z-10 flex flex-wrap items-center gap-3 border-b border-slate-200 bg-white px-4 py-3 shadow-sm">
      <label className="cursor-pointer rounded-lg bg-emerald-600 px-3 py-2 text-sm font-semibold text-white shadow hover:bg-emerald-700">{isLoadingFile ? "Opening…" : "Open floor plan"}<input className="hidden" type="file" accept="image/*,application/pdf,.pdf" onChange={(event) => { const file = event.target.files?.[0]; if (file) void onFile(file); event.target.value = ""; }} /></label>
      <nav className="flex rounded-xl border border-slate-200 bg-slate-50 p-1" aria-label="Tools">{toolButton("calibrate", "Calibrate", "C")}{toolButton("draw", "Draw", "D", !ppm)}</nav>
      <label className="flex items-center gap-2 text-sm text-slate-600">Reference<input aria-label="Reference length in meters" className="w-20 rounded-lg border border-slate-200 px-2 py-1.5" type="number" min="0.01" step="0.01" value={refLength} onChange={(event) => actions.setRefLength(Number(event.target.value))} />m</label>
      <button onClick={actions.toggleOrthogonal} className={`rounded-lg border px-3 py-2 text-sm font-semibold ${orthogonal ? "border-blue-200 bg-blue-50 text-blue-700" : "border-slate-200 text-slate-500"}`} aria-pressed={orthogonal}>90° lock {orthogonal ? "on" : "off"}</button>
      <div className="ml-auto flex items-center gap-1"><button aria-label="Undo" disabled={!past.length} onClick={actions.undo} className="toolbar-button">↶ <span>Undo</span></button><button aria-label="Redo" disabled={!future.length} onClick={actions.redo} className="toolbar-button">↷ <span>Redo</span></button><button aria-label="Zoom out" onClick={() => zoomAt(1 / 1.15)} className="toolbar-button">−</button><button aria-label="Zoom in" onClick={() => zoomAt(1.15)} className="toolbar-button">+</button><button onClick={fitImage} className="toolbar-button">Fit</button><button onClick={resetFloorplan} className="rounded-lg px-3 py-2 text-sm font-semibold text-rose-600 hover:bg-rose-50" title="Clear floor plan and start over">Clear</button></div>
    </header>
    <section className="flex items-center gap-4 border-b border-slate-200 bg-slate-50 px-4 py-2 text-sm"><span className={`font-semibold ${ppm ? "text-emerald-700" : "text-amber-700"}`}>{ppm ? `Scale ${ppm.toFixed(2)} px/m` : "Calibrate before measuring"}</span><span>{edges.length} lines</span><span>{loops.length} closed {loops.length === 1 ? "area" : "areas"}</span><strong className="rounded-lg bg-emerald-100 px-2.5 py-1 text-emerald-800">Total {formatArea(totalArea)}</strong><select aria-label="Display units" className="rounded-lg border border-slate-200 bg-white px-2 py-1" value={units} onChange={(event) => actions.setUnits(event.target.value as Units)}><option value="m">meters</option><option value="cm">centimeters</option><option value="mm">millimeters</option></select><span className="ml-auto hidden text-slate-500 xl:inline">Click to draw · click a point to connect · drag to move · double-click to remove · Enter to finish · Space-drag to pan</span></section>
    <div ref={containerRef} className="relative min-h-0 flex-1 overflow-hidden bg-slate-200" onDrop={(event) => { event.preventDefault(); const file = event.dataTransfer.files[0]; if (file) void onFile(file); }} onDragOver={(event) => event.preventDefault()}>
      {!imageInfo && <div className="pointer-events-none absolute inset-0 z-10 grid place-items-center"><div className="rounded-2xl border border-slate-200 bg-white/90 px-8 py-6 text-center shadow-xl backdrop-blur"><h1 className="text-xl font-bold">Open or drop a floor plan</h1><p className="mt-2 text-sm text-slate-500">Images and PDFs supported. PDFs open on their first page, then calibrate a known distance to trace rooms.</p>{fileError && <p className="mt-3 text-sm font-medium text-rose-600">{fileError}</p>}</div></div>}
      {imageInfo && fileError && <div className="absolute left-4 top-4 z-10 rounded-lg bg-rose-50 px-3 py-2 text-sm font-medium text-rose-700 shadow">{fileError}</div>}
      {imageInfo?.kind === "image" && <img src={imageInfo.dataUrl} alt="Floor plan" className="pointer-events-none absolute left-0 top-0 max-w-none origin-top-left" style={{ width: imageInfo.width, height: imageInfo.height, transform: `translate(${view.offset.x}px, ${view.offset.y}px) scale(${view.zoom})` }} />}
      {imageInfo?.kind === "pdf" && <canvas ref={pdfCanvasRef} className="pointer-events-none absolute left-0 top-0 origin-top-left" />}
      <canvas ref={canvasRef} className="absolute inset-0 z-[1] block h-full w-full" style={{ cursor, touchAction: "none" }} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={endPointer} onPointerCancel={endPointer} onDoubleClick={(event) => { const id = pointAt(eventScreen(event)); if (id && tool === "draw") actions.removePoint(id, 2); }} onPointerLeave={() => { setPointerWorld(null); setHoveredPointId(null); setHoveredSegment(null); }} onContextMenu={(event) => event.preventDefault()} />
    </div>
    <footer className="flex min-h-12 items-center gap-2 overflow-x-auto border-t border-slate-200 bg-white px-4 py-2 text-sm">{loops.length ? loops.map((face, index) => <span key={face.pointIds.join("-")} className="whitespace-nowrap rounded-lg border border-emerald-200 bg-emerald-50 px-2.5 py-1 text-emerald-800">Area {index + 1}: {formatArea(face.areaPx / (ppm! * ppm!))}</span>) : <span className="text-slate-500">Connect lines into an enclosed boundary to calculate its area.</span>}</footer>
  </main>;
}
