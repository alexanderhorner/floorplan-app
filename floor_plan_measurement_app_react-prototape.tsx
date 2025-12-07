import React, { useEffect, useMemo, useRef, useState } from "react";

// Floor Plan Measurement App
// Upload a floor plan image, calibrate with the scale bar, then measure.
// Trackpad-friendly controls and localStorage persistence.

// ---------------------------------
// Helpers placed first to avoid hoist quirks
// ---------------------------------
function clamp(v: number, min: number, max: number) {
  return Math.min(max, Math.max(min, v));
}

// Types
type Line = { id: string; x1: number; y1: number; x2: number; y2: number };
type Mode = "calibrate" | "measure";
type Units = "m" | "cm" | "mm";
type SavedState = {
  img?: { dataUrl: string; name?: string; w: number; h: number };
  ppm: number | null; // pixels per meter
  refLength: number; // meters
  units: Units;
  lines: Line[];
  calLine: Line | null;
  zoom: number;
  offset: { x: number; y: number };
};

const LS_KEY = "fp-measurement-state-v8";

export default function FloorPlanMeasurementApp() {
  // Elements
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);

  // Image state
  const [imgInfo, setImgInfo] = useState<{
    w: number;
    h: number;
    name?: string;
  } | null>(null);
  const [imgDataUrl, setImgDataUrl] = useState<string | null>(null);
  const [hasImage, setHasImage] = useState(false);

  // View transform
  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const zoomRef = useRef(zoom);
  useEffect(() => {
    zoomRef.current = zoom;
  }, [zoom]);
  const offsetRef = useRef(offset);
  useEffect(() => {
    offsetRef.current = offset;
  }, [offset]);

  // Modes and interactions
  const [mode, setMode] = useState<Mode>("calibrate"); // start in calibrate
  const [isDragging, setIsDragging] = useState(false);
  const [isPanning, setIsPanning] = useState(false);
  const [dragStartWorld, setDragStartWorld] = useState<{
    x: number;
    y: number;
  } | null>(null);
  const [tempLine, setTempLine] = useState<Line | null>(null);
  const [panStart, setPanStart] = useState<{
    x: number;
    y: number;
    ox: number;
    oy: number;
  } | null>(null);
  const [shiftDown, setShiftDown] = useState(false);
  const [spaceDown, setSpaceDown] = useState(false);

  // Measurement state
  const [ppm, setPPM] = useState<number | null>(null); // pixels per meter
  const [refLength, setRefLength] = useState<number>(4);
  const [units, setUnits] = useState<Units>("m");
  const [lines, setLines] = useState<Line[]>([]);
  const [calLine, setCalLine] = useState<Line | null>(null);

  // Misc
  const dpr = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;

  // Unit helpers
  const unitFactor = useMemo(() => {
    if (units === "m") return 1;
    if (units === "cm") return 100;
    return 1000; // mm
  }, [units]);
  const fmtLength = (meters: number | undefined) => {
    if (meters == null || Number.isNaN(meters)) return "";
    const v = meters * unitFactor;
    const decimals = units === "m" ? 2 : 0;
    return `${v.toFixed(decimals)} ${units}`;
  };

  // Geometry helpers
  const lengthPx = (l: Line) => Math.hypot(l.x2 - l.x1, l.y2 - l.y1);
  const screenToWorld = (sx: number, sy: number) => ({
    x: (sx - offsetRef.current.x) / zoomRef.current,
    y: (sy - offsetRef.current.y) / zoomRef.current,
  });
  const screenToWorldWith = (
    sx: number,
    sy: number,
    z: number,
    off: { x: number; y: number }
  ) => ({ x: (sx - off.x) / z, y: (sy - off.y) / z });

  // Resize canvas to container
  useEffect(() => {
    const resize = () => {
      const canvas = canvasRef.current;
      const parent = containerRef.current;
      if (!canvas || !parent) return;
      const rect = parent.getBoundingClientRect();
      canvas.width = Math.max(1, Math.floor(rect.width * dpr));
      canvas.height = Math.max(1, Math.floor(rect.height * dpr));
      canvas.style.width = `${rect.width}px`;
      canvas.style.height = `${rect.height}px`;
      draw();
    };
    resize();
    const ro = new ResizeObserver(resize);
    if (containerRef.current) ro.observe(containerRef.current);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dpr, zoom, offset, lines, tempLine, calLine, ppm, units, hasImage]);

  // Keyboard
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Shift") setShiftDown(true);
      if (e.key === " ") {
        e.preventDefault();
        setSpaceDown(true);
      }
      if (e.key === "2") setMode("calibrate");
      if (e.key === "3") setMode("measure");
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z")
        setLines((prev) => prev.slice(0, -1));
      if (e.key === "Escape") {
        setTempLine(null);
        setPanStart(null);
        setIsPanning(false);
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === "Shift") setShiftDown(false);
      if (e.key === " ") setSpaceDown(false);
    };
    window.addEventListener("keydown", onKeyDown, { capture: true });
    window.addEventListener("keyup", onKeyUp, { capture: true });
    return () => {
      window.removeEventListener(
        "keydown",
        onKeyDown as any,
        { capture: true } as any
      );
      window.removeEventListener(
        "keyup",
        onKeyUp as any,
        { capture: true } as any
      );
    };
  }, []);

  // Persistence save
  const savePending = useRef(false);
  const snapshotAndSave = () => {
    if (!hasImage) return;
    const state: SavedState = {
      img:
        imgDataUrl && imgInfo
          ? {
              dataUrl: imgDataUrl,
              name: imgInfo.name,
              w: imgInfo.w,
              h: imgInfo.h,
            }
          : undefined,
      ppm,
      refLength,
      units,
      lines,
      calLine,
      zoom: zoomRef.current,
      offset: offsetRef.current,
    };
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(state));
    } catch {}
  };
  useEffect(() => {
    if (!hasImage) return;
    if (savePending.current) return;
    savePending.current = true;
    requestAnimationFrame(() => {
      savePending.current = false;
      snapshotAndSave();
    });
  }, [
    imgDataUrl,
    imgInfo,
    ppm,
    refLength,
    units,
    lines,
    calLine,
    zoom,
    offset,
    hasImage,
  ]);

  // Persistence load on mount
  useEffect(() => {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (!raw) return;
      const s: SavedState = JSON.parse(raw);
      setUnits(s.units ?? "m");
      setPPM(s.ppm ?? null);
      setRefLength(s.refLength ?? 4);
      setLines(Array.isArray(s.lines) ? s.lines : []);
      setCalLine(s.calLine ?? null);
      setZoom(s.zoom ?? 1);
      setOffset(s.offset ?? { x: 0, y: 0 });
      if (s.img?.dataUrl) {
        const img = new Image();
        img.onload = () => {
          imgRef.current = img;
          setImgInfo({ w: img.width, h: img.height, name: s.img?.name });
          setImgDataUrl(s.img!.dataUrl);
          setHasImage(true);
          requestAnimationFrame(() => fitImageToView());
          draw();
        };
        img.src = s.img.dataUrl;
      }
    } catch {}
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Dynamic recalibration
  useEffect(() => {
    if (calLine && refLength > 0) setPPM(lengthPx(calLine) / refLength);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refLength, calLine]);

  // Image upload: fast preview via ObjectURL, persist via DataURL
  const onFile = (file: File) => {
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      alert("Please select an image file.");
      return;
    }
    try {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        URL.revokeObjectURL(url);
        imgRef.current = img;
        setImgInfo({ w: img.width, h: img.height, name: file.name });
        setHasImage(true);
        setMode("calibrate");
        setLines([]);
        setCalLine(null);
        requestAnimationFrame(() => fitImageToView());
        draw();
      };
      img.onerror = () => alert("Could not load the selected image");
      img.src = url;

      const reader = new FileReader();
      reader.onload = () => setImgDataUrl(reader.result as string);
      reader.readAsDataURL(file);
    } catch (err) {
      console.error(err);
      alert("Image load failed.");
    }
  };

  const fitImageToView = () => {
    const tryFit = (attempt: number) => {
      const img = imgRef.current;
      const parent = containerRef.current;
      if (!img || !parent) return;
      const rect = parent.getBoundingClientRect();
      if ((rect.width < 2 || rect.height < 2) && attempt < 10) {
        requestAnimationFrame(() => tryFit(attempt + 1));
        return;
      }
      const zw = rect.width / img.width;
      const zh = rect.height / img.height;
      let z = Math.min(zw, zh) * 0.95;
      if (!Number.isFinite(z) || z <= 0) z = 1;
      const ox = (rect.width - img.width * z) / 2;
      const oy = (rect.height - img.height * z) / 2;
      setZoom(z);
      setOffset({ x: ox, y: oy });
    };
    tryFit(0);
  };

  // Drag and drop
  const handleDrop: React.DragEventHandler<HTMLDivElement> = (e) => {
    e.preventDefault();
    const f = e.dataTransfer.files?.[0];
    if (f) onFile(f);
  };

  // Zoom helpers
  const ZOOM_MIN = 0.05,
    ZOOM_MAX = 20;
  const computeZoomAroundPoint = (
    zoom0: number,
    off0: { x: number; y: number },
    cx: number,
    cy: number,
    factor: number
  ) => {
    const newZoom = clamp(zoom0 * factor, ZOOM_MIN, ZOOM_MAX);
    const worldBefore = screenToWorldWith(cx, cy, zoom0, off0);
    const newOffset = {
      x: cx - worldBefore.x * newZoom,
      y: cy - worldBefore.y * newZoom,
    };
    return { newZoom, newOffset };
  };
  const zoomAt = (factor: number, mx?: number, my?: number) => {
    const canvas = canvasRef.current;
    const rect = canvas?.getBoundingClientRect();
    const cx = mx ?? (rect ? rect.width / 2 : 0);
    const cy = my ?? (rect ? rect.height / 2 : 0);
    const { newZoom, newOffset } = computeZoomAroundPoint(
      zoomRef.current,
      offsetRef.current,
      cx,
      cy,
      factor
    );
    setZoom(newZoom);
    setOffset(newOffset);
  };

  // Safari gestures
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    let prevScale = 1;
    const onGestureStart = (e: any) => {
      e.preventDefault();
      prevScale = 1;
    };
    const onGestureChange = (e: any) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const cx = rect.width / 2;
      const cy = rect.height / 2; // center fallback
      const factor = (e.scale || 1) / (prevScale || 1);
      prevScale = e.scale || 1;
      zoomAt(factor, cx, cy);
    };
    const onGestureEnd = (e: any) => {
      e.preventDefault();
    };
    el.addEventListener("gesturestart", onGestureStart, {
      passive: false,
    } as any);
    el.addEventListener("gesturechange", onGestureChange, {
      passive: false,
    } as any);
    el.addEventListener("gestureend", onGestureEnd, { passive: false } as any);
    return () => {
      el.removeEventListener("gesturestart", onGestureStart as any);
      el.removeEventListener("gesturechange", onGestureChange as any);
      el.removeEventListener("gestureend", onGestureEnd as any);
    };
  }, []);

  // Wheel: pan by default, zoom when ctrlKey (Mac pinch path). Prevent page scroll.
  const wheelAccumRef = useRef(0);
  const wheelRafRef = useRef<number | null>(null);
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const rect = el.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      if (e.ctrlKey) {
        const sens = 0.02; // tuned for macOS
        wheelAccumRef.current += -e.deltaY * sens;
        if (!wheelRafRef.current) {
          wheelRafRef.current = requestAnimationFrame(() => {
            const dz = wheelAccumRef.current;
            wheelAccumRef.current = 0;
            wheelRafRef.current = null;
            const factor = Math.exp(dz);
            const { newZoom, newOffset } = computeZoomAroundPoint(
              zoomRef.current,
              offsetRef.current,
              mx,
              my,
              factor
            );
            setZoom(newZoom);
            setOffset(newOffset);
          });
        }
      } else {
        setOffset((o) => ({ x: o.x - e.deltaX, y: o.y - e.deltaY }));
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel as any);
  }, []);

  // Touch pinch via Pointer Events
  const pointers = useRef(
    new Map<number, { x: number; y: number; type: string }>()
  );
  const pinch = useRef<null | {
    startZoom: number;
    startOffset: { x: number; y: number };
    startWorld: { x: number; y: number };
    startDist: number;
  }>(null);
  const onPointerDown: React.PointerEventHandler<HTMLCanvasElement> = (e) => {
    if (e.pointerType !== "touch") return;
    const el = e.currentTarget as HTMLCanvasElement;
    el.setPointerCapture(e.pointerId);
    pointers.current.set(e.pointerId, {
      x: e.clientX,
      y: e.clientY,
      type: e.pointerType,
    });
    if (pointers.current.size === 2) {
      const pts = Array.from(pointers.current.values());
      const mid = {
        x: (pts[0].x + pts[1].x) / 2,
        y: (pts[0].y + pts[1].y) / 2,
      };
      const rect = el.getBoundingClientRect();
      const cx = mid.x - rect.left;
      const cy = mid.y - rect.top;
      const dx = pts[0].x - pts[1].x;
      const dy = pts[0].y - pts[1].y;
      const dist = Math.hypot(dx, dy);
      const startZoom = zoomRef.current;
      const startOffset = offsetRef.current;
      const startWorld = screenToWorldWith(cx, cy, startZoom, startOffset);
      pinch.current = { startZoom, startOffset, startWorld, startDist: dist };
    }
  };
  const onPointerMove: React.PointerEventHandler<HTMLCanvasElement> = (e) => {
    if (e.pointerType !== "touch") return;
    if (!pointers.current.has(e.pointerId)) return;
    pointers.current.set(e.pointerId, {
      x: e.clientX,
      y: e.clientY,
      type: e.pointerType,
    });
    if (pointers.current.size === 2 && pinch.current) {
      const el = e.currentTarget as HTMLCanvasElement;
      const rect = el.getBoundingClientRect();
      const pts = Array.from(pointers.current.values());
      const mid = {
        x: (pts[0].x + pts[1].x) / 2,
        y: (pts[0].y + pts[1].y) / 2,
      };
      const dx = pts[0].x - pts[1].x;
      const dy = pts[0].y - pts[1].y;
      const dist = Math.hypot(dx, dy);
      const factor = dist / pinch.current.startDist;
      const cx = mid.x - rect.left;
      const cy = mid.y - rect.top;
      const newZoom = clamp(
        pinch.current.startZoom * factor,
        ZOOM_MIN,
        ZOOM_MAX
      );
      const newOffset = {
        x: cx - pinch.current.startWorld.x * newZoom,
        y: cy - pinch.current.startWorld.y * newZoom,
      };
      setZoom(newZoom);
      setOffset(newOffset);
    }
  };
  const onPointerUp: React.PointerEventHandler<HTMLCanvasElement> = (e) => {
    if (e.pointerType !== "touch") return;
    pointers.current.delete(e.pointerId);
    if (pointers.current.size < 2) pinch.current = null;
  };
  const onPointerCancel: React.PointerEventHandler<HTMLCanvasElement> = (e) => {
    if (e.pointerType !== "touch") return;
    pointers.current.delete(e.pointerId);
    pinch.current = null;
  };

  // Mouse: draw and pan
  const handleMouseDown: React.MouseEventHandler<HTMLCanvasElement> = (e) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    const wantsPan = spaceDown || e.button === 1 || e.button === 2;
    if (wantsPan) {
      setIsPanning(true);
      setPanStart({
        x: sx,
        y: sy,
        ox: offsetRef.current.x,
        oy: offsetRef.current.y,
      });
      setIsDragging(true);
      return;
    }
    if (!imgRef.current) return;
    const { x, y } = screenToWorld(sx, sy);
    setDragStartWorld({ x, y });
    setTempLine({ id: "temp", x1: x, y1: y, x2: x, y2: y });
    setIsDragging(true);
  };
  const handleMouseMove: React.MouseEventHandler<HTMLCanvasElement> = (e) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    if (isPanning && panStart && isDragging) {
      const dx = sx - panStart.x;
      const dy = sy - panStart.y;
      setOffset({ x: panStart.ox + dx, y: panStart.oy + dy });
      draw();
      return;
    }
    if (!isDragging || !dragStartWorld) return;
    let { x, y } = screenToWorld(sx, sy);
    if (shiftDown) {
      const dx = Math.abs(x - dragStartWorld.x);
      const dy = Math.abs(y - dragStartWorld.y);
      if (dx > dy) y = dragStartWorld.y;
      else x = dragStartWorld.x;
    }
    setTempLine((prev) => (prev ? { ...prev, x2: x, y2: y } : null));
    draw();
  };
  const handleMouseUp: React.MouseEventHandler<HTMLCanvasElement> = () => {
    if (isPanning) {
      setIsDragging(false);
      setIsPanning(false);
      setPanStart(null);
      return;
    }
    setIsDragging(false);
    if (!tempLine || !dragStartWorld) {
      setTempLine(null);
      return;
    }
    const lp = lengthPx(tempLine);
    if (mode === "calibrate") {
      if (!refLength || refLength <= 0) {
        alert("Set a positive reference length first.");
      } else if (lp < 2) {
        alert("Reference line is too short.");
      } else {
        const nextPPM = lp / refLength;
        setPPM(nextPPM);
        setCalLine({ ...tempLine });
      }
      setTempLine(null);
      setMode("measure");
      return;
    }
    if (mode === "measure") {
      if (!ppm) {
        alert("Calibrate first (draw the reference scale).");
      } else if (lp >= 2) {
        setLines((prev) => [...prev, { ...tempLine, id: `m-${Date.now()}` }]);
      }
      setTempLine(null);
      return;
    }
    setTempLine(null);
  };

  const handleDoubleClick: React.MouseEventHandler<HTMLCanvasElement> = (e) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const f = e.altKey ? 1 / 1.5 : 1.5;
    zoomAt(f, mx, my);
  };
  const handleContextMenu: React.MouseEventHandler<HTMLCanvasElement> = (e) => {
    e.preventDefault();
  };

  // Drawing
  const draw = () => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    const img = imgRef.current;
    if (!canvas || !ctx) return;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.scale(dpr, dpr);
    ctx.translate(offsetRef.current.x, offsetRef.current.y);
    ctx.scale(zoomRef.current, zoomRef.current);
    ctx.fillStyle = "#f8fafc";
    ctx.fillRect(
      -offsetRef.current.x / zoomRef.current - 10000,
      -offsetRef.current.y / zoomRef.current - 10000,
      20000,
      20000
    );
    if (img) {
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(img, 0, 0);
    }
    const drawLine = (l: Line, color = "#22c55e", dashed = false) => {
      ctx.save();
      if (dashed) ctx.setLineDash([8 / zoomRef.current, 8 / zoomRef.current]);
      ctx.lineWidth = 2 / zoomRef.current;
      ctx.strokeStyle = color;
      ctx.beginPath();
      ctx.moveTo(l.x1, l.y1);
      ctx.lineTo(l.x2, l.y2);
      ctx.stroke();
      ctx.fillStyle = color;
      const r = 4 / zoomRef.current;
      ctx.beginPath();
      ctx.arc(l.x1, l.y1, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.beginPath();
      ctx.arc(l.x2, l.y2, r, 0, Math.PI * 2);
      ctx.fill();
      const meters =
        l === calLine ? refLength : ppm ? lengthPx(l) / ppm : undefined;
      if (meters != null) {
        const cx = (l.x1 + l.x2) / 2;
        const cy = (l.y1 + l.y2) / 2;
        const label = fmtLength(meters);
        ctx.font = `${Math.max(
          10,
          14 / Math.min(1, zoomRef.current)
        )}px ui-sans-serif`;
        const pad = 4 / zoomRef.current;
        const tw = ctx.measureText(label).width;
        const th = 18 / zoomRef.current;
        ctx.fillStyle = "rgba(15,23,42,0.85)";
        ctx.fillRect(
          cx - tw / 2 - pad,
          cy - th / 2 - pad,
          tw + pad * 2,
          th + pad * 2
        );
        ctx.fillStyle = "white";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(label, cx, cy + 0.5 / zoomRef.current);
      }
      ctx.restore();
    };
    if (calLine) drawLine(calLine, "#f59e0b");
    for (const l of lines) drawLine(l, "#22c55e");
    if (tempLine)
      drawLine(tempLine, mode === "calibrate" ? "#f59e0b" : "#0ea5e9", true);
    ctx.restore();
  };

  useEffect(() => {
    draw();
  });

  // Export
  const exportPNG = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const link = document.createElement("a");
    link.download = `floorplan-annotated-${Date.now()}.png`;
    link.href = canvas.toDataURL("image/png");
    link.click();
  };

  const reset = () => {
    setLines([]);
    setCalLine(null);
    setPPM(null);
    setMode("calibrate");
  };
  const zoomToFit = () => fitImageToView();

  // Self-tests (console only)
  useEffect(() => {
    console.assert(clamp(10, 0, 5) === 5, "clamp upper");
    console.assert(clamp(-2, 0, 5) === 0, "clamp lower");
    const l: Line = { id: "t", x1: 0, y1: 0, x2: 3, y2: 4 };
    console.assert(Math.abs(lengthPx(l) - 5) < 1e-9, "lengthPx 3-4-5");
    const z0 = 1.2;
    const off0 = { x: 100, y: 50 };
    const cx = 200,
      cy = 300;
    const wb = screenToWorldWith(cx, cy, z0, off0);
    const { newZoom, newOffset } = computeZoomAroundPoint(
      z0,
      off0,
      cx,
      cy,
      1.5
    );
    const wa = screenToWorldWith(cx, cy, newZoom, newOffset);
    console.assert(
      Math.hypot(wb.x - wa.x, wb.y - wa.y) < 1e-9,
      "zoom keeps world point"
    );
    // Extra: fmtLength sanity
    const prevUnits = units; // snapshot
    // m
    if (prevUnits !== "m") setUnits("m");
    console.assert(fmtLength(1) === "1.00 m", "fmt meters");
    setUnits("cm");
    console.assert(fmtLength(1) === "100 cm", "fmt cm");
    setUnits("mm");
    console.assert(fmtLength(1) === "1000 mm", "fmt mm");
    setUnits(prevUnits);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const canvasCursor =
    isPanning || spaceDown
      ? isDragging
        ? "grabbing"
        : "grab"
      : mode === "measure" || mode === "calibrate"
      ? "crosshair"
      : "default";

  return (
    <div className="w-full h-full min-h-[560px] flex flex-col text-slate-900">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2 p-3 border-b bg-white/80 backdrop-blur supports-backdrop-filter:bg-white/60">
        <label className="inline-flex items-center gap-2 px-3 py-2 rounded-xl border hover:bg-slate-50 cursor-pointer">
          <input
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(e) => {
              const f = e.currentTarget.files?.[0];
              if (f) onFile(f);
              e.currentTarget.value = "";
            }}
          />
          <span className="font-medium">Upload floor plan</span>
        </label>

        <div className="w-px h-6 bg-slate-200" />

        <div className="flex items-center gap-1 rounded-xl border bg-white overflow-hidden">
          <button
            onClick={() => setMode("calibrate")}
            className={`px-3 py-2 ${
              mode === "calibrate"
                ? "bg-amber-500 text-white"
                : "hover:bg-amber-50"
            }`}
          >
            Calibrate (2)
          </button>
          <button
            onClick={() => setMode("measure")}
            className={`px-3 py-2 ${
              mode === "measure"
                ? "bg-emerald-600 text-white"
                : "hover:bg-emerald-50"
            }`}
          >
            Measure (3)
          </button>
        </div>

        <div className="w-px h-6 bg-slate-200" />

        <div className="flex items-center gap-2">
          <span className="text-sm text-slate-600">Ref length:</span>
          <input
            type="number"
            step={0.01}
            value={refLength}
            onChange={(e) => setRefLength(parseFloat(e.target.value))}
            className="w-24 px-2 py-1 rounded-lg border"
          />
          <span className="text-xs text-slate-500">m</span>
        </div>

        <div className="w-px h-6 bg-slate-200" />

        <div className="flex items-center gap-2">
          <span className="text-sm text-slate-600">Units:</span>
          <select
            className="px-2 py-1 rounded-lg border"
            value={units}
            onChange={(e) => setUnits(e.target.value as Units)}
          >
            <option value="m">meters</option>
            <option value="cm">cm</option>
            <option value="mm">mm</option>
          </select>
        </div>

        <div className="ml-auto flex items-center gap-2">
          <div className="flex items-center gap-1 rounded-xl border bg-white overflow-hidden">
            <button
              title="Zoom out"
              onClick={() => zoomAt(1 / 1.15)}
              className="px-3 py-2 hover:bg-slate-50"
            >
              −
            </button>
            <div className="w-px h-5 bg-slate-200" />
            <button
              title="Zoom in"
              onClick={() => zoomAt(1.15)}
              className="px-3 py-2 hover:bg-slate-50"
            >
              +
            </button>
          </div>
          <button
            onClick={zoomToFit}
            className="px-3 py-2 rounded-xl border bg-white hover:bg-slate-50"
          >
            Fit
          </button>
          <button
            onClick={() => setLines((prev) => prev.slice(0, -1))}
            className="px-3 py-2 rounded-xl border bg-white hover:bg-slate-50"
          >
            Undo
          </button>
          <button
            onClick={reset}
            className="px-3 py-2 rounded-xl border bg-white hover:bg-slate-50"
          >
            Reset
          </button>
          <button
            onClick={exportPNG}
            className="px-3 py-2 rounded-xl border bg-white hover:bg-slate-50"
          >
            Export PNG
          </button>
        </div>
      </div>

      {/* Status bar */}
      <div className="flex flex-wrap items-center gap-4 px-3 py-2 text-sm border-b bg-slate-50">
        <span>
          Mode: <b className="font-semibold capitalize">{mode}</b>
        </span>
        <span>|</span>
        <span>
          Scale:{" "}
          <b className="font-semibold">
            {ppm ? `${ppm.toFixed(2)} px/m` : "not set"}
          </b>
        </span>
        <span>|</span>
        <span>
          Image:{" "}
          <b className="font-semibold">
            {imgInfo
              ? `${imgInfo.w}×${imgInfo.h}${
                  imgInfo.name ? ` (${imgInfo.name})` : ""
                }`
              : "none"}
          </b>
        </span>
        <span>|</span>
        <span>
          Lines: <b className="font-semibold">{lines.length}</b>
        </span>
        <span className="ml-auto text-slate-500">
          Tip: Two finger scroll to pan • Pinch to zoom • Space+drag to pan • ⌥
          double click to zoom out
        </span>
      </div>

      {/* Canvas */}
      <div
        ref={containerRef}
        onDrop={handleDrop}
        onDragOver={(e) => e.preventDefault()}
        className="relative flex-1 bg-slate-100 overflow-hidden"
        style={{ overscrollBehavior: "contain" }}
      >
        {!hasImage && (
          <div className="absolute inset-0 grid place-items-center pointer-events-none select-none">
            <div className="text-center text-slate-600">
              <div className="text-lg font-semibold">
                Upload a floor plan image to begin
              </div>
              <div className="text-sm mt-1">
                Draw the scale in <b>Calibrate</b>, then switch to Measure to
                annotate dimensions.
              </div>
              <div className="text-sm">Or drag and drop an image here.</div>
            </div>
          </div>
        )}
        <canvas
          ref={canvasRef}
          className="block w-full h-full"
          style={{ cursor: canvasCursor as any, touchAction: "none" }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerCancel}
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onDoubleClick={handleDoubleClick}
          onContextMenu={handleContextMenu}
        />
      </div>

      {/* Measurements list */}
      <div className="border-t bg-white px-3 py-2 text-sm">
        {lines.length === 0 ? (
          <div className="text-slate-500">No measurements yet.</div>
        ) : (
          <div className="flex flex-wrap gap-2">
            {lines.map((l, i) => (
              <span
                key={l.id}
                className="px-2 py-1 rounded-lg border bg-slate-50"
              >
                #{i + 1}: {ppm ? fmtLength(lengthPx(l) / ppm) : "?"}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
