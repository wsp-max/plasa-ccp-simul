import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Circle as KCircle, Group, Layer, Line as KLine, Rect as KRect, Stage, Text as KText } from "react-konva";
import type StageType from "konva/lib/Stage";
import type { KonvaEventObject } from "konva/lib/Node";
import type { GeometryPoint, GeometryRole, GeometryShape, GeometryTool } from "../types/geometry";
import { CCP_MATERIAL_PRESETS, findMaterialPresetId } from "../utils/materialPresets";
import { buildGeometryPositionPoints, buildShapePlanarMetrics } from "../utils/geometryOverlayPoints";

type Domain = { r_max_mm: number; z_max_mm: number };

export type GeometryAnnotationLabel = {
  x: number;
  y: number;
  text: string;
  color?: string;
};

type Props = {
  domain: Domain;
  tool: GeometryTool;
  onToolChange: (tool: GeometryTool) => void;
  shapes: GeometryShape[];
  annotationShapes?: GeometryShape[];
  annotationLabels?: GeometryAnnotationLabel[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onShapesChange: (shapes: GeometryShape[]) => void;
  defaultMaterial: { epsilon_r: number; wall_loss_e: number };
  snapToGrid: boolean;
  snapStepMm: number;
};

type Mode = "move" | "edit";

type DraftDrag = {
  tool: "rect" | "circle" | "chamber";
  start: GeometryPoint;
  current: GeometryPoint;
  lockAspect: boolean;
  centerMode: boolean;
};

type HandleSpec =
  | { kind: "rect"; corner: "nw" | "ne" | "sw" | "se"; x: number; y: number }
  | { kind: "circle"; x: number; y: number }
  | { kind: "point"; index: number; x: number; y: number };

const TOOL_OPTIONS: { value: GeometryTool; label: string }[] = [
  { value: "select", label: "Select" },
  { value: "rect", label: "Rect" },
  { value: "circle", label: "Circle" },
  { value: "polyline", label: "Polyline" },
  { value: "chamber", label: "Chamber" },
];

const ROLE_OPTIONS: { value: GeometryRole; label: string; color: string }[] = [
  { value: "plasma", label: "Plasma", color: "#66a6b8" },
  { value: "solid_wall", label: "Solid Wall", color: "#5f7387" },
  { value: "chamber_wall", label: "Chamber Wall", color: "#4f6a7e" },
  { value: "powered_electrode", label: "RF Source", color: "#9a4fd1" },
  { value: "ground_electrode", label: "Ground Electrode", color: "#9ca8a0" },
  { value: "wafer", label: "Wafer", color: "#c08457" },
  { value: "dielectric", label: "Dielectric", color: "#4da1de" },
  { value: "showerhead", label: "Showerhead", color: "#3397b2" },
  { value: "pumping_port", label: "Pumping Port", color: "#2f7d8f" },
];

const PADDING = { left: 56, right: 20, top: 16, bottom: 42 };
const MIN_RECT = 0.5;
const MIN_RADIUS = 0.25;
const MAX_HISTORY = 80;

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const round = (value: number, digits = 3) => {
  const p = 10 ** digits;
  return Math.round(value * p) / p;
};

const isEditableTarget = (target: EventTarget | null) => {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  const name = target.tagName.toUpperCase();
  return name === "INPUT" || name === "TEXTAREA" || name === "SELECT" || target.isContentEditable;
};

const normalizeTag = (value: string) => {
  const compact = value.trim().toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "");
  return compact || "shape";
};

const cloneShape = (shape: GeometryShape): GeometryShape =>
  shape.type === "rect"
    ? { ...shape, material: { ...shape.material } }
    : shape.type === "circle"
      ? { ...shape, material: { ...shape.material } }
      : { ...shape, points: shape.points.map((p) => ({ ...p })), material: { ...shape.material } };

const cloneShapes = (shapes: GeometryShape[]) => shapes.map((s) => cloneShape(s));

const snapValue = (value: number, enabled: boolean, step: number) => {
  if (!enabled) {
    return value;
  }
  const safe = Math.max(0.05, step);
  return round(Math.round(value / safe) * safe, 3);
};

const snapPoint = (point: GeometryPoint, enabled: boolean, step: number): GeometryPoint => ({
  x: snapValue(point.x, enabled, step),
  y: snapValue(point.y, enabled, step),
});

const rgba = (hex: string, alpha: number) => {
  const raw = hex.replace("#", "");
  const source = raw.length === 3 ? raw.split("").map((ch) => `${ch}${ch}`).join("") : raw;
  const value = Number.parseInt(source, 16);
  if (!Number.isFinite(value)) {
    return `rgba(23,103,142,${alpha})`;
  }
  const r = (value >> 16) & 255;
  const g = (value >> 8) & 255;
  const b = value & 255;
  return `rgba(${r},${g},${b},${alpha})`;
};

const makeId = () => `shape-${Date.now()}-${Math.floor(Math.random() * 1000)}`;

const withMinRect = (x0: number, y0: number, x1: number, y1: number) => {
  let nx0 = x0;
  let ny0 = y0;
  let nx1 = x1;
  let ny1 = y1;
  if (Math.abs(nx1 - nx0) < MIN_RECT) {
    if (nx1 >= nx0) nx1 = nx0 + MIN_RECT;
    else nx0 = nx1 + MIN_RECT;
  }
  if (Math.abs(ny1 - ny0) < MIN_RECT) {
    if (ny1 >= ny0) ny1 = ny0 + MIN_RECT;
    else ny0 = ny1 + MIN_RECT;
  }
  return { x0: nx0, y0: ny0, x1: nx1, y1: ny1 };
};

const getBounds = (shape: GeometryShape) => {
  if (shape.type === "rect") {
    return {
      x0: Math.min(shape.x0, shape.x1),
      x1: Math.max(shape.x0, shape.x1),
      y0: Math.min(shape.y0, shape.y1),
      y1: Math.max(shape.y0, shape.y1),
    };
  }
  if (shape.type === "circle") {
    return { x0: shape.cx - shape.r, x1: shape.cx + shape.r, y0: shape.cy - shape.r, y1: shape.cy + shape.r };
  }
  const xs = shape.points.map((p) => p.x);
  const ys = shape.points.map((p) => p.y);
  return { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
};

const clampPoint = (point: GeometryPoint, domain: Domain): GeometryPoint => ({
  x: clamp(point.x, 0, domain.r_max_mm),
  y: clamp(point.y, 0, domain.z_max_mm),
});

const constrainAxisLine = (anchor: GeometryPoint, point: GeometryPoint): GeometryPoint => {
  const dx = point.x - anchor.x;
  const dy = point.y - anchor.y;
  if (Math.abs(dx) >= Math.abs(dy)) {
    return { x: point.x, y: anchor.y };
  }
  return { x: anchor.x, y: point.y };
};

const constrainSquare = (anchor: GeometryPoint, point: GeometryPoint): GeometryPoint => {
  const dx = point.x - anchor.x;
  const dy = point.y - anchor.y;
  const span = Math.max(Math.abs(dx), Math.abs(dy));
  const signX = dx === 0 ? (dy >= 0 ? 1 : -1) : Math.sign(dx);
  const signY = dy === 0 ? (dx >= 0 ? 1 : -1) : Math.sign(dy);
  return {
    x: anchor.x + signX * span,
    y: anchor.y + signY * span,
  };
};

const moveShape = (shape: GeometryShape, dx: number, dy: number): GeometryShape => {
  if (shape.type === "rect") {
    return { ...shape, x0: shape.x0 + dx, x1: shape.x1 + dx, y0: shape.y0 + dy, y1: shape.y1 + dy };
  }
  if (shape.type === "circle") {
    return { ...shape, cx: shape.cx + dx, cy: shape.cy + dy };
  }
  return { ...shape, points: shape.points.map((p) => ({ x: p.x + dx, y: p.y + dy })) };
};

const clampShape = (shape: GeometryShape, domain: Domain): GeometryShape => {
  if (shape.type === "rect") {
    const fixed = withMinRect(shape.x0, shape.y0, shape.x1, shape.y1);
    return {
      ...shape,
      x0: clamp(fixed.x0, 0, domain.r_max_mm),
      x1: clamp(fixed.x1, 0, domain.r_max_mm),
      y0: clamp(fixed.y0, 0, domain.z_max_mm),
      y1: clamp(fixed.y1, 0, domain.z_max_mm),
    };
  }
  if (shape.type === "circle") {
    const cx = clamp(shape.cx, 0, domain.r_max_mm);
    const cy = clamp(shape.cy, 0, domain.z_max_mm);
    const maxRadius = Math.max(MIN_RADIUS, Math.min(cx, domain.r_max_mm - cx, cy, domain.z_max_mm - cy));
    return { ...shape, cx, cy, r: clamp(shape.r, MIN_RADIUS, maxRadius) };
  }
  return { ...shape, points: shape.points.map((p) => clampPoint(p, domain)) };
};

const snapShape = (shape: GeometryShape, enabled: boolean, step: number): GeometryShape => {
  if (!enabled) {
    return shape;
  }
  if (shape.type === "rect") {
    return {
      ...shape,
      x0: snapValue(shape.x0, true, step),
      x1: snapValue(shape.x1, true, step),
      y0: snapValue(shape.y0, true, step),
      y1: snapValue(shape.y1, true, step),
    };
  }
  if (shape.type === "circle") {
    return {
      ...shape,
      cx: snapValue(shape.cx, true, step),
      cy: snapValue(shape.cy, true, step),
      r: Math.max(MIN_RADIUS, snapValue(shape.r, true, step)),
    };
  }
  return { ...shape, points: shape.points.map((p) => snapPoint(p, true, step)) };
};

const GeometryEditor = ({
  domain,
  tool,
  onToolChange,
  shapes,
  annotationShapes = [],
  annotationLabels = [],
  selectedId,
  onSelect,
  onShapesChange,
  defaultMaterial,
  snapToGrid,
  snapStepMm,
}: Props) => {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const stageWrapRef = useRef<HTMLDivElement | null>(null);
  const stageRef = useRef<StageType | null>(null);

  const [stageSize, setStageSize] = useState({ width: 920, height: 520 });
  const [mode, setMode] = useState<Mode>("move");
  const [keyboardActive, setKeyboardActive] = useState(false);
  const [cursor, setCursor] = useState<GeometryPoint | null>(null);
  const [draftDrag, setDraftDrag] = useState<DraftDrag | null>(null);
  const [draftPolyline, setDraftPolyline] = useState<GeometryPoint[] | null>(null);
  const [clipboard, setClipboard] = useState<GeometryShape | null>(null);

  const historyRef = useRef<GeometryShape[][]>([]);
  const historyIndexRef = useRef(-1);
  const localWriteRef = useRef(false);
  const knownStateRef = useRef("");

  const selected = useMemo(() => shapes.find((shape) => shape.id === selectedId) ?? null, [selectedId, shapes]);

  const plot = useMemo(() => {
    const width = Math.max(220, stageSize.width - PADDING.left - PADDING.right);
    const height = Math.max(220, stageSize.height - PADDING.top - PADDING.bottom);
    return { x: PADDING.left, y: PADDING.top, width, height };
  }, [stageSize.height, stageSize.width]);

  const toCanvasX = useCallback(
    (r: number) => plot.x + (clamp(r, 0, domain.r_max_mm) / Math.max(1e-9, domain.r_max_mm)) * plot.width,
    [domain.r_max_mm, plot]
  );
  const toCanvasY = useCallback(
    (z: number) =>
      plot.y +
      plot.height -
      (clamp(z, 0, domain.z_max_mm) / Math.max(1e-9, domain.z_max_mm)) * plot.height,
    [domain.z_max_mm, plot]
  );
  const toDomainX = useCallback(
    (x: number) => ((x - plot.x) / Math.max(1e-9, plot.width)) * domain.r_max_mm,
    [domain.r_max_mm, plot.width, plot.x]
  );
  const toDomainY = useCallback(
    (y: number) =>
      ((plot.y + plot.height - y) / Math.max(1e-9, plot.height)) * domain.z_max_mm,
    [domain.z_max_mm, plot.height, plot.y]
  );
  const pxToDx = useCallback((dxPx: number) => (dxPx / Math.max(1e-9, plot.width)) * domain.r_max_mm, [domain.r_max_mm, plot.width]);
  const pxToDy = useCallback(
    (dyPx: number) => (-dyPx / Math.max(1e-9, plot.height)) * domain.z_max_mm,
    [domain.z_max_mm, plot.height]
  );
  const toCanvasRect = useCallback(
    (x0: number, y0: number, x1: number, y1: number) => {
      const cx0 = toCanvasX(x0);
      const cx1 = toCanvasX(x1);
      const cy0 = toCanvasY(y0);
      const cy1 = toCanvasY(y1);
      return {
        x: Math.min(cx0, cx1),
        y: Math.min(cy0, cy1),
        width: Math.max(1, Math.abs(cx1 - cx0)),
        height: Math.max(1, Math.abs(cy1 - cy0)),
      };
    },
    [toCanvasX, toCanvasY]
  );

  const ensureTag = useCallback(
    (base: string, ignoreId?: string) => {
      const seed = normalizeTag(base);
      const used = new Set(
        shapes.filter((shape) => shape.id !== ignoreId).map((shape) => normalizeTag(shape.tag))
      );
      if (!used.has(seed)) {
        return seed;
      }
      let idx = 2;
      while (used.has(`${seed}_${idx}`)) {
        idx += 1;
      }
      return `${seed}_${idx}`;
    },
    [shapes]
  );

  const roleColor = useCallback((role: GeometryRole) => ROLE_OPTIONS.find((option) => option.value === role)?.color ?? "#4da1de", []);

  const commit = useCallback(
    (next: GeometryShape[], recordHistory = true, nextSelected: string | null = selectedId) => {
      const cloned = cloneShapes(next);
      if (recordHistory) {
        const branch = historyRef.current.slice(0, historyIndexRef.current + 1);
        branch.push(cloned);
        historyRef.current = branch.length > MAX_HISTORY ? branch.slice(branch.length - MAX_HISTORY) : branch;
        historyIndexRef.current = historyRef.current.length - 1;
      }
      localWriteRef.current = true;
      knownStateRef.current = JSON.stringify(cloned);
      onShapesChange(cloned);
      onSelect(nextSelected);
    },
    [onSelect, onShapesChange, selectedId]
  );

  useEffect(() => {
    const current = JSON.stringify(shapes);
    if (localWriteRef.current) {
      localWriteRef.current = false;
      knownStateRef.current = current;
      return;
    }
    if (knownStateRef.current === current) {
      return;
    }
    knownStateRef.current = current;
    historyRef.current = [cloneShapes(shapes)];
    historyIndexRef.current = 0;
  }, [shapes]);

  useEffect(() => {
    if (!stageWrapRef.current) {
      return;
    }
    const update = () => {
      if (!stageWrapRef.current) {
        return;
      }
      const width = Math.max(320, Math.floor(stageWrapRef.current.clientWidth));
      const height = clamp(Math.floor(width * 0.56), 260, 700);
      setStageSize((prev) => (prev.width === width && prev.height === height ? prev : { width, height }));
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(stageWrapRef.current);
    return () => observer.disconnect();
  }, []);

  const getPointer = useCallback((): GeometryPoint | null => {
    const stage = stageRef.current;
    if (!stage) {
      return null;
    }
    const pointer = stage.getPointerPosition();
    if (!pointer) {
      return null;
    }
    const domainPoint = clampPoint({ x: toDomainX(pointer.x), y: toDomainY(pointer.y) }, domain);
    return snapPoint(domainPoint, snapToGrid, snapStepMm);
  }, [domain, snapStepMm, snapToGrid, toDomainX, toDomainY]);

  const normalizePoint = useCallback(
    (point: GeometryPoint) => snapPoint(clampPoint(point, domain), snapToGrid, snapStepMm),
    [domain, snapStepMm, snapToGrid]
  );

  const resolveRectBounds = useCallback(
    (start: GeometryPoint, current: GeometryPoint, centerMode: boolean) => {
      if (centerMode) {
        const spanX = Math.abs(current.x - start.x);
        const spanY = Math.abs(current.y - start.y);
        const cornerA = normalizePoint({ x: start.x - spanX, y: start.y - spanY });
        const cornerB = normalizePoint({ x: start.x + spanX, y: start.y + spanY });
        return {
          x0: Math.min(cornerA.x, cornerB.x),
          x1: Math.max(cornerA.x, cornerB.x),
          y0: Math.min(cornerA.y, cornerB.y),
          y1: Math.max(cornerA.y, cornerB.y),
        };
      }
      return {
        x0: Math.min(start.x, current.x),
        x1: Math.max(start.x, current.x),
        y0: Math.min(start.y, current.y),
        y1: Math.max(start.y, current.y),
      };
    },
    [normalizePoint]
  );

  const updateShape = useCallback(
    (shapeId: string, updater: (shape: GeometryShape) => GeometryShape, recordHistory = true) => {
      const next = shapes.map((shape) => {
        if (shape.id !== shapeId) {
          return cloneShape(shape);
        }
        return clampShape(snapShape(updater(cloneShape(shape)), snapToGrid, snapStepMm), domain);
      });
      commit(next, recordHistory, shapeId);
    },
    [commit, domain, shapes, snapStepMm, snapToGrid]
  );

  const focusEditor = useCallback(() => {
    setKeyboardActive(true);
    rootRef.current?.focus();
  }, []);

  const undo = useCallback(() => {
    if (historyIndexRef.current <= 0) {
      return;
    }
    historyIndexRef.current -= 1;
    const snapshot = cloneShapes(historyRef.current[historyIndexRef.current]);
    localWriteRef.current = true;
    knownStateRef.current = JSON.stringify(snapshot);
    onShapesChange(snapshot);
    if (selectedId && !snapshot.some((shape) => shape.id === selectedId)) {
      onSelect(null);
    }
  }, [onSelect, onShapesChange, selectedId]);

  const redo = useCallback(() => {
    if (historyIndexRef.current >= historyRef.current.length - 1) {
      return;
    }
    historyIndexRef.current += 1;
    const snapshot = cloneShapes(historyRef.current[historyIndexRef.current]);
    localWriteRef.current = true;
    knownStateRef.current = JSON.stringify(snapshot);
    onShapesChange(snapshot);
  }, [onShapesChange]);

  const deleteSelected = useCallback(() => {
    if (!selectedId) {
      return;
    }
    commit(shapes.filter((shape) => shape.id !== selectedId), true, null);
  }, [commit, selectedId, shapes]);

  const copySelected = useCallback(() => {
    if (!selected) {
      return;
    }
    setClipboard(cloneShape(selected));
  }, [selected]);

  const duplicateFrom = useCallback(
    (source: GeometryShape) => {
      const offset = Math.max(0.5, snapStepMm * 2);
      const moved = clampShape(snapShape(moveShape(cloneShape(source), offset, offset), snapToGrid, snapStepMm), domain);
      const copy = { ...moved, id: makeId(), tag: ensureTag(`${source.tag}_copy`), label: `${source.label} Copy` };
      if (copy.group === "chamber") {
        const others = shapes.filter((shape) => shape.group !== "chamber").map((shape) => cloneShape(shape));
        commit([...others, copy], true, copy.id);
        return;
      }
      commit([...cloneShapes(shapes), copy], true, copy.id);
    },
    [commit, domain, ensureTag, shapes, snapStepMm, snapToGrid]
  );

  const pasteShape = useCallback(() => {
    const source = clipboard ?? selected;
    if (!source) {
      return;
    }
    duplicateFrom(source);
  }, [clipboard, duplicateFrom, selected]);
  const finalizeDrag = useCallback(() => {
    if (!draftDrag) {
      return;
    }
    const start = draftDrag.start;
    const end =
      draftDrag.lockAspect && (draftDrag.tool === "rect" || draftDrag.tool === "chamber")
        ? normalizePoint(constrainSquare(start, draftDrag.current))
        : draftDrag.current;
    if (draftDrag.tool === "rect" || draftDrag.tool === "chamber") {
      const { x0, x1, y0, y1 } = resolveRectBounds(start, end, draftDrag.centerMode);
      if (Math.abs(x1 - x0) < MIN_RECT && Math.abs(y1 - y0) < MIN_RECT) {
        setDraftDrag(null);
        return;
      }
      const shape: GeometryShape =
        draftDrag.tool === "chamber"
          ? {
              id: makeId(),
              tag: "chamber",
              label: "Chamber",
              color: "#66a6b8",
              strokeWidth: 0.36,
              group: "chamber",
              role: "plasma",
              type: "rect",
              x0,
              y0,
              x1,
              y1,
              material: { enabled: false, epsilon_r: defaultMaterial.epsilon_r, wall_loss_e: defaultMaterial.wall_loss_e },
            }
          : {
              id: makeId(),
              tag: ensureTag("dielectric_region"),
              label: "Dielectric Region",
              color: roleColor("dielectric"),
              strokeWidth: 0.34,
              group: "structure",
              role: "dielectric",
              type: "rect",
              x0,
              y0,
              x1,
              y1,
              material: { enabled: true, epsilon_r: defaultMaterial.epsilon_r, wall_loss_e: defaultMaterial.wall_loss_e },
            };

      if (draftDrag.tool === "chamber") {
        const others = shapes.filter((shapeRow) => shapeRow.group !== "chamber").map((row) => cloneShape(row));
        commit([...others, shape], true, shape.id);
      } else {
        commit([...cloneShapes(shapes), shape], true, shape.id);
      }
      setDraftDrag(null);
      onToolChange("select");
      return;
    }

    const radius = Math.sqrt((end.x - start.x) ** 2 + (end.y - start.y) ** 2);
    if (radius < MIN_RADIUS) {
      setDraftDrag(null);
      return;
    }

    const shape: GeometryShape = {
      id: makeId(),
      tag: ensureTag("dielectric_circle"),
      label: "Dielectric Circle",
      color: roleColor("dielectric"),
      strokeWidth: 0.34,
      group: "structure",
      role: "dielectric",
      type: "circle",
      cx: start.x,
      cy: start.y,
      r: radius,
      material: { enabled: true, epsilon_r: defaultMaterial.epsilon_r, wall_loss_e: defaultMaterial.wall_loss_e },
    };
    commit([...cloneShapes(shapes), shape], true, shape.id);
    setDraftDrag(null);
    onToolChange("select");
  }, [
    commit,
    defaultMaterial.epsilon_r,
    defaultMaterial.wall_loss_e,
    draftDrag,
    ensureTag,
    normalizePoint,
    onToolChange,
    resolveRectBounds,
    roleColor,
    shapes,
  ]);

  const finalizePolyline = useCallback(() => {
    if (!draftPolyline || draftPolyline.length < 2) {
      return;
    }
    let shape: GeometryShape;
    if (draftPolyline.length === 2) {
      shape = {
        id: makeId(),
        tag: ensureTag("line_wall"),
        label: "Solid Wall Line",
        color: roleColor("solid_wall"),
        strokeWidth: 0.42,
        group: "structure",
        role: "solid_wall",
        type: "line",
        points: draftPolyline.map((point) => ({ ...point })),
        material: { enabled: false, epsilon_r: defaultMaterial.epsilon_r, wall_loss_e: defaultMaterial.wall_loss_e },
      };
    } else {
      shape = {
        id: makeId(),
        tag: ensureTag("poly_region"),
        label: "Polygon Region",
        color: roleColor("dielectric"),
        strokeWidth: 0.34,
        group: "structure",
        role: "dielectric",
        type: "polygon",
        points: draftPolyline.map((point) => ({ ...point })),
        material: { enabled: true, epsilon_r: defaultMaterial.epsilon_r, wall_loss_e: defaultMaterial.wall_loss_e },
      };
    }
    commit([...cloneShapes(shapes), shape], true, shape.id);
    setDraftPolyline(null);
    onToolChange("select");
  }, [commit, defaultMaterial.epsilon_r, defaultMaterial.wall_loss_e, draftPolyline, ensureTag, onToolChange, roleColor, shapes]);

  const handleStageDown = useCallback(
    (event: KonvaEventObject<MouseEvent>) => {
      focusEditor();
      const point = getPointer();
      if (!point) {
        return;
      }
      const targetName = event.target.name();
      const onBackground = event.target === event.target.getStage() || targetName === "workspace-bg";
      if (!onBackground) {
        return;
      }
      if (tool === "select") {
        onSelect(null);
        return;
      }
      if (tool === "polyline") {
        const lockAxis = event.evt.shiftKey;
        setDraftPolyline((prev) => {
          const base = prev ?? [];
          if (!lockAxis || base.length === 0) {
            return [...base, point];
          }
          const constrained = normalizePoint(constrainAxisLine(base[base.length - 1], point));
          return [...base, constrained];
        });
        onSelect(null);
        return;
      }
      if (tool === "rect" || tool === "circle" || tool === "chamber") {
        setDraftDrag({
          tool,
          start: point,
          current: point,
          lockAspect: event.evt.shiftKey,
          centerMode: event.evt.altKey,
        });
        onSelect(null);
      }
    },
    [focusEditor, getPointer, normalizePoint, onSelect, tool]
  );

  const handleStageMove = useCallback((event: KonvaEventObject<MouseEvent>) => {
    const point = getPointer();
    if (!point) {
      return;
    }

    if (draftDrag) {
      const lockAspect = event.evt.shiftKey;
      const centerMode = event.evt.altKey;
      const adjustedPoint =
        lockAspect && (draftDrag.tool === "rect" || draftDrag.tool === "chamber")
          ? normalizePoint(constrainSquare(draftDrag.start, point))
          : point;
      setCursor(adjustedPoint);
      setDraftDrag({
        ...draftDrag,
        current: adjustedPoint,
        lockAspect,
        centerMode,
      });
      return;
    }

    if (tool === "polyline" && draftPolyline && draftPolyline.length > 0 && event.evt.shiftKey) {
      const constrained = normalizePoint(constrainAxisLine(draftPolyline[draftPolyline.length - 1], point));
      setCursor(constrained);
      return;
    }
    setCursor(point);
  }, [draftDrag, draftPolyline, getPointer, normalizePoint, tool]);

  const handleStageUp = useCallback(() => {
    if (draftDrag) {
      finalizeDrag();
    }
  }, [draftDrag, finalizeDrag]);

  const handleDragEnd = useCallback(
    (shape: GeometryShape, event: KonvaEventObject<DragEvent>) => {
      const dx = pxToDx(event.target.x());
      const dy = pxToDy(event.target.y());
      const duplicateRequested = Boolean((event.evt as MouseEvent).altKey);
      event.target.position({ x: 0, y: 0 });
      if (Math.abs(dx) < 1e-6 && Math.abs(dy) < 1e-6) {
        return;
      }
      if (duplicateRequested && shape.group !== "chamber") {
        const moved = clampShape(
          snapShape(moveShape(cloneShape(shape), dx, dy), snapToGrid, snapStepMm),
          domain
        );
        const copy = {
          ...moved,
          id: makeId(),
          tag: ensureTag(`${shape.tag}_copy`),
          label: `${shape.label} Copy`,
        };
        commit([...cloneShapes(shapes), copy], true, copy.id);
        return;
      }
      updateShape(shape.id, (current) => moveShape(current, dx, dy), true);
    },
    [
      commit,
      domain,
      ensureTag,
      pxToDx,
      pxToDy,
      shapes,
      snapStepMm,
      snapToGrid,
      updateShape,
    ]
  );

  const handles = useMemo<HandleSpec[]>(() => {
    if (!selected || mode !== "edit") {
      return [];
    }
    if (selected.type === "rect") {
      return [
        { kind: "rect", corner: "nw", x: selected.x0, y: selected.y0 },
        { kind: "rect", corner: "ne", x: selected.x1, y: selected.y0 },
        { kind: "rect", corner: "sw", x: selected.x0, y: selected.y1 },
        { kind: "rect", corner: "se", x: selected.x1, y: selected.y1 },
      ];
    }
    if (selected.type === "circle") {
      return [{ kind: "circle", x: selected.cx + selected.r, y: selected.cy }];
    }
    return selected.points.map((point, index) => ({ kind: "point", index, x: point.x, y: point.y }));
  }, [mode, selected]);

  const handleDragHandle = useCallback(
    (handle: HandleSpec, point: GeometryPoint, recordHistory: boolean) => {
      if (!selected) {
        return;
      }
      if (handle.kind === "rect") {
        updateShape(
          selected.id,
          (shape) => {
            if (shape.type !== "rect") {
              return shape;
            }
            let x0 = shape.x0;
            let y0 = shape.y0;
            let x1 = shape.x1;
            let y1 = shape.y1;
            if (handle.corner === "nw") {
              x0 = point.x;
              y0 = point.y;
            } else if (handle.corner === "ne") {
              x1 = point.x;
              y0 = point.y;
            } else if (handle.corner === "sw") {
              x0 = point.x;
              y1 = point.y;
            } else {
              x1 = point.x;
              y1 = point.y;
            }
            const fixed = withMinRect(x0, y0, x1, y1);
            return { ...shape, ...fixed };
          },
          recordHistory
        );
        return;
      }
      if (handle.kind === "circle") {
        updateShape(
          selected.id,
          (shape) => {
            if (shape.type !== "circle") {
              return shape;
            }
            const r = Math.sqrt((point.x - shape.cx) ** 2 + (point.y - shape.cy) ** 2);
            return { ...shape, r: Math.max(MIN_RADIUS, r) };
          },
          recordHistory
        );
        return;
      }
      updateShape(
        selected.id,
        (shape) => {
          if (shape.type !== "polygon" && shape.type !== "line") {
            return shape;
          }
          const points = shape.points.map((entry, index) => (index === handle.index ? point : entry));
          return { ...shape, points };
        },
        recordHistory
      );
    },
    [selected, updateShape]
  );
  const applyTagPatch = useCallback(
    (patch: Partial<GeometryShape>) => {
      if (!selected) {
        return;
      }
      updateShape(selected.id, (shape) => {
        const next = { ...shape, ...patch } as GeometryShape;
        if (patch.tag !== undefined) {
          next.tag = ensureTag(patch.tag, selected.id);
        }
        return next;
      }, true);
    },
    [ensureTag, selected, updateShape]
  );

  const applyMaterialPatch = useCallback(
    (patch: Partial<GeometryShape["material"]>) => {
      if (!selected) {
        return;
      }
      updateShape(selected.id, (shape) => ({ ...shape, material: { ...shape.material, ...patch } }), true);
    },
    [selected, updateShape]
  );

  const applyNumberPatch = useCallback(
    (field: string, value: number) => {
      if (!selected || !Number.isFinite(value)) {
        return;
      }
      updateShape(
        selected.id,
        (shape) => {
          if (shape.type === "rect" && (field === "x0" || field === "x1" || field === "y0" || field === "y1")) {
            return { ...shape, [field]: value } as GeometryShape;
          }
          if (shape.type === "circle" && (field === "cx" || field === "cy" || field === "r")) {
            return { ...shape, [field]: value } as GeometryShape;
          }
          if ((shape.type === "polygon" || shape.type === "line") && field.startsWith("p.")) {
            const [, rawIndex, axis] = field.split(".");
            const index = Number(rawIndex);
            if (!Number.isInteger(index) || index < 0 || index >= shape.points.length) {
              return shape;
            }
            const points = shape.points.map((p, i) => (i === index ? { ...p, [axis]: value } : p));
            return { ...shape, points };
          }
          return shape;
        },
        true
      );
    },
    [selected, updateShape]
  );

  const autoChamber = useCallback(() => {
    const nonChamber = shapes.filter((shape) => shape.group !== "chamber");
    const marginR = Math.max(3, domain.r_max_mm * 0.06);
    const marginZ = Math.max(3, domain.z_max_mm * 0.08);
    let x0 = marginR;
    let x1 = domain.r_max_mm - marginR;
    let y0 = marginZ;
    let y1 = domain.z_max_mm - marginZ;
    if (nonChamber.length > 0) {
      const bounds = nonChamber.map((shape) => getBounds(shape));
      x0 = clamp(Math.min(...bounds.map((b) => b.x0)) - marginR * 0.5, 0, domain.r_max_mm);
      x1 = clamp(Math.max(...bounds.map((b) => b.x1)) + marginR * 0.5, 0, domain.r_max_mm);
      y0 = clamp(Math.min(...bounds.map((b) => b.y0)) - marginZ * 0.7, 0, domain.z_max_mm);
      y1 = clamp(Math.max(...bounds.map((b) => b.y1)) + marginZ * 1.1, 0, domain.z_max_mm);
    }
    const fixed = withMinRect(x0, y0, x1, y1);
    const chamber: GeometryShape = {
      id: makeId(),
      tag: "chamber",
      label: "Chamber",
      color: "#66a6b8",
      strokeWidth: 0.36,
      group: "chamber",
      role: "plasma",
      type: "rect",
      x0: fixed.x0,
      y0: fixed.y0,
      x1: fixed.x1,
      y1: fixed.y1,
      material: { enabled: false, epsilon_r: defaultMaterial.epsilon_r, wall_loss_e: defaultMaterial.wall_loss_e },
    };
    commit([...cloneShapes(nonChamber), chamber], true, chamber.id);
  }, [commit, defaultMaterial.epsilon_r, defaultMaterial.wall_loss_e, domain.r_max_mm, domain.z_max_mm, shapes]);

  const selectedPreset = useMemo(() => {
    if (!selected) {
      return "custom";
    }
    return findMaterialPresetId(selected.material.epsilon_r, selected.material.wall_loss_e, selected.role);
  }, [selected]);

  const selectedPositionPoints = useMemo(() => {
    if (!selected) {
      return [];
    }
    return buildGeometryPositionPoints([selected], selected.id);
  }, [selected]);

  const selectedPlanarMetrics = useMemo(() => {
    if (!selected) {
      return null;
    }
    return buildShapePlanarMetrics(selected, selected.material.wall_loss_e);
  }, [selected]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!keyboardActive || isEditableTarget(event.target)) {
        return;
      }
      const withCtrl = event.ctrlKey || event.metaKey;
      const key = event.key.toLowerCase();
      if (withCtrl && key === "z" && !event.shiftKey) {
        event.preventDefault();
        undo();
        return;
      }
      if ((withCtrl && key === "y") || (withCtrl && event.shiftKey && key === "z")) {
        event.preventDefault();
        redo();
        return;
      }
      if (withCtrl && key === "c") {
        event.preventDefault();
        copySelected();
        return;
      }
      if (withCtrl && key === "v") {
        event.preventDefault();
        pasteShape();
        return;
      }
      if (key === "delete" || key === "backspace") {
        event.preventDefault();
        deleteSelected();
        return;
      }
      if (key === "escape") {
        event.preventDefault();
        setDraftDrag(null);
        setDraftPolyline(null);
        onSelect(null);
        return;
      }
      if (tool === "polyline" && key === "enter") {
        event.preventDefault();
        finalizePolyline();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [copySelected, deleteSelected, finalizePolyline, keyboardActive, onSelect, pasteShape, redo, tool, undo]);

  const xTicks = useMemo(() => Array.from({ length: 9 }, (_, i) => (domain.r_max_mm * i) / 8), [domain.r_max_mm]);
  const yTicks = useMemo(() => Array.from({ length: 7 }, (_, i) => (domain.z_max_mm * i) / 6), [domain.z_max_mm]);

  const gridTicks = useMemo(() => {
    const step = Math.max(0.1, snapToGrid ? snapStepMm : Math.max(domain.r_max_mm, domain.z_max_mm) / 24);
    const x: number[] = [];
    const y: number[] = [];
    for (let value = 0; value <= domain.r_max_mm + 1e-9; value += step) {
      x.push(round(value, 4));
      if (x.length > 260) break;
    }
    for (let value = 0; value <= domain.z_max_mm + 1e-9; value += step) {
      y.push(round(value, 4));
      if (y.length > 260) break;
    }
    return { x, y };
  }, [domain.r_max_mm, domain.z_max_mm, snapStepMm, snapToGrid]);

  const renderShape = (shape: GeometryShape) => {
    const active = shape.id === selectedId;
    const strokeWidth = active ? 2 : Math.max(1.1, shape.strokeWidth * 2.7);
    const fill = shape.type === "line" ? undefined : rgba(shape.color, shape.group === "chamber" ? 0.06 : 0.16);
    const dash = shape.group === "chamber" ? [8, 6] : undefined;
    const draggable = active && mode === "move" && tool === "select";
    const click = (event: KonvaEventObject<MouseEvent>) => {
      event.cancelBubble = true;
      onSelect(shape.id);
      focusEditor();
    };

    if (shape.type === "rect") {
      const rect = toCanvasRect(shape.x0, shape.y0, shape.x1, shape.y1);
      return (
        <Group key={shape.id} draggable={draggable} onDragEnd={(event) => handleDragEnd(shape, event)}>
          <KRect x={rect.x} y={rect.y} width={rect.width} height={rect.height} stroke={shape.color} strokeWidth={strokeWidth} fill={fill} dash={dash} onMouseDown={click} onTouchStart={click} />
        </Group>
      );
    }

    if (shape.type === "circle") {
      const x = toCanvasX(shape.cx);
      const y = toCanvasY(shape.cy);
      const radius = Math.max(1, (shape.r / Math.max(1e-9, domain.r_max_mm)) * plot.width);
      return (
        <Group key={shape.id} draggable={draggable} onDragEnd={(event) => handleDragEnd(shape, event)}>
          <KCircle x={x} y={y} radius={radius} stroke={shape.color} strokeWidth={strokeWidth} fill={fill} dash={dash} onMouseDown={click} onTouchStart={click} />
        </Group>
      );
    }

    const points = shape.points.flatMap((point) => [toCanvasX(point.x), toCanvasY(point.y)]);
    return (
      <Group key={shape.id} draggable={draggable} onDragEnd={(event) => handleDragEnd(shape, event)}>
        <KLine points={points} stroke={shape.color} strokeWidth={strokeWidth} fill={shape.type === "polygon" ? fill : undefined} closed={shape.type === "polygon"} lineJoin="round" lineCap="round" dash={dash} onMouseDown={click} onTouchStart={click} />
      </Group>
    );
  };

  const renderAnnotationShape = (shape: GeometryShape) => {
    const strokeWidth = Math.max(1.2, shape.strokeWidth * 2.4);
    if (shape.type === "rect") {
      const rect = toCanvasRect(shape.x0, shape.y0, shape.x1, shape.y1);
      return (
        <KRect
          key={`annotation-${shape.id}`}
          x={rect.x}
          y={rect.y}
          width={rect.width}
          height={rect.height}
          stroke={shape.color}
          strokeWidth={strokeWidth}
          dash={[8, 5]}
          fillEnabled={false}
          listening={false}
        />
      );
    }
    if (shape.type === "circle") {
      const x = toCanvasX(shape.cx);
      const y = toCanvasY(shape.cy);
      const radius = Math.max(1, (shape.r / Math.max(1e-9, domain.r_max_mm)) * plot.width);
      return (
        <KCircle
          key={`annotation-${shape.id}`}
          x={x}
          y={y}
          radius={radius}
          stroke={shape.color}
          strokeWidth={strokeWidth}
          dash={[8, 5]}
          fillEnabled={false}
          listening={false}
        />
      );
    }
    const points = shape.points.flatMap((point) => [toCanvasX(point.x), toCanvasY(point.y)]);
    return (
      <KLine
        key={`annotation-${shape.id}`}
        points={points}
        stroke={shape.color}
        strokeWidth={strokeWidth}
        dash={[8, 5]}
        lineJoin="round"
        lineCap="round"
        closed={shape.type === "polygon"}
        fillEnabled={false}
        listening={false}
      />
    );
  };
  const boundsText = selected
    ? (() => {
        const b = getBounds(selected);
        return `x=${round(b.x0, 2)}..${round(b.x1, 2)} mm, z=${round(b.y0, 2)}..${round(b.y1, 2)} mm`;
      })()
    : "Select a geometry to edit.";

  return (
    <div ref={rootRef} className="geometry-editor" tabIndex={0} onFocus={() => setKeyboardActive(true)} onBlur={() => setKeyboardActive(false)}>
      <section className="geometry-canvas">
        <div className="geometry-toolbar top">
          <div className="tool-palette">
            {TOOL_OPTIONS.map((option) => (
              <button key={option.value} type="button" className={`palette-button ${tool === option.value ? "active" : ""}`} onClick={() => onToolChange(option.value)}>
                {option.label}
              </button>
            ))}
          </div>
          <div className="tool-palette mode-palette">
            <button type="button" className={`palette-button ${mode === "move" ? "active" : ""}`} onClick={() => setMode("move")}>Move Mode</button>
            <button type="button" className={`palette-button ${mode === "edit" ? "active" : ""}`} onClick={() => setMode("edit")}>Edit Mode</button>
          </div>
        </div>

        <div className="geometry-toolbar">
          <div className="geometry-toolbar-actions">
            <button type="button" className="ghost-button" onClick={autoChamber}>Auto Chamber</button>
            <button type="button" className="ghost-button" onClick={undo}>Undo (Ctrl+Z)</button>
            <button type="button" className="ghost-button" onClick={redo}>Redo</button>
            <button type="button" className="ghost-button" onClick={copySelected} disabled={!selected}>Copy</button>
            <button type="button" className="ghost-button" onClick={pasteShape} disabled={!clipboard && !selected}>Paste</button>
            <button type="button" className="ghost-button" onClick={() => selected && duplicateFrom(selected)} disabled={!selected}>Duplicate</button>
            <button type="button" className="ghost-button" onClick={deleteSelected} disabled={!selected}>Delete</button>
            <button type="button" className="ghost-button" onClick={() => commit([], true, null)} disabled={shapes.length === 0}>Clear</button>
            {tool === "polyline" ? (
              <>
                <button type="button" className="ghost-button" onClick={finalizePolyline} disabled={!draftPolyline || draftPolyline.length < 2}>Finish Polyline</button>
                <button type="button" className="ghost-button" onClick={() => setDraftPolyline(null)} disabled={!draftPolyline}>Cancel Polyline</button>
              </>
            ) : null}
          </div>
        </div>

        <div className="geometry-toolbar">
          <span className="geometry-hint">
            {cursor ? `Cursor r=${round(cursor.x, 2)} mm, z=${round(cursor.y, 2)} mm` : "Move cursor to read r-z"}
            {" | "}
            Snap {snapToGrid ? `ON (${round(snapStepMm, 3)} mm)` : "OFF"}
            {" | "}
            {boundsText}
          </span>
        </div>

        <div ref={stageWrapRef} className="geometry-workbench">
          <Stage width={stageSize.width} height={stageSize.height} ref={stageRef} onMouseDown={handleStageDown} onMouseMove={handleStageMove} onMouseUp={handleStageUp} onDblClick={() => tool === "polyline" && finalizePolyline()}>
            <Layer listening={false}>
              <KRect name="workspace-bg" x={plot.x} y={plot.y} width={plot.width} height={plot.height} fill="#f7fbff" stroke="#9ec1d5" strokeWidth={1} />
              {gridTicks.x.map((tick) => (
                <KLine key={`gx-${tick}`} points={[toCanvasX(tick), plot.y, toCanvasX(tick), plot.y + plot.height]} stroke={tick === 0 ? "#8cb4cb" : "rgba(63,95,117,0.17)"} strokeWidth={tick === 0 ? 1.1 : 1} />
              ))}
              {gridTicks.y.map((tick) => (
                <KLine key={`gy-${tick}`} points={[plot.x, toCanvasY(tick), plot.x + plot.width, toCanvasY(tick)]} stroke={tick === 0 ? "#8cb4cb" : "rgba(63,95,117,0.17)"} strokeWidth={tick === 0 ? 1.1 : 1} />
              ))}
              {xTicks.map((tick) => (
                <Group key={`xt-${tick}`}>
                  <KLine points={[toCanvasX(tick), plot.y + plot.height, toCanvasX(tick), plot.y + plot.height + 5]} stroke="#5f7387" strokeWidth={1} />
                  <KText x={toCanvasX(tick) - 12} y={plot.y + plot.height + 8} text={`${round(tick, 0)}`} fontSize={10} fill="#5f7387" />
                </Group>
              ))}
              {yTicks.map((tick) => (
                <Group key={`yt-${tick}`}>
                  <KLine points={[plot.x - 5, toCanvasY(tick), plot.x, toCanvasY(tick)]} stroke="#5f7387" strokeWidth={1} />
                  <KText x={8} y={toCanvasY(tick) - 6} text={`${round(tick, 0)}`} fontSize={10} fill="#5f7387" />
                </Group>
              ))}
              <KText x={plot.x + plot.width - 70} y={plot.y + plot.height + 24} text="r (mm)" fontSize={11} fill="#3f5f75" />
              <KText x={8} y={plot.y - 12} text="z (mm)" fontSize={11} fill="#3f5f75" />
            </Layer>

            <Layer>
              <KRect name="workspace-bg" x={plot.x} y={plot.y} width={plot.width} height={plot.height} fill="rgba(0,0,0,0)" />
              {shapes.map((shape) => renderShape(shape))}
              {annotationShapes.map((shape) => renderAnnotationShape(shape))}
              {draftDrag ? (
                draftDrag.tool === "circle" ? (
                  <KCircle x={toCanvasX(draftDrag.start.x)} y={toCanvasY(draftDrag.start.y)} radius={Math.max(1, (Math.sqrt((draftDrag.current.x - draftDrag.start.x) ** 2 + (draftDrag.current.y - draftDrag.start.y) ** 2) / Math.max(1e-9, domain.r_max_mm)) * plot.width)} stroke="#17678e" strokeWidth={1.6} dash={[6, 5]} fill={rgba("#17678e", 0.12)} />
                ) : (
                  (() => {
                    const previewCurrent =
                      draftDrag.lockAspect
                        ? normalizePoint(constrainSquare(draftDrag.start, draftDrag.current))
                        : draftDrag.current;
                    const previewBounds = resolveRectBounds(
                      draftDrag.start,
                      previewCurrent,
                      draftDrag.centerMode
                    );
                    const previewRect = toCanvasRect(
                      previewBounds.x0,
                      previewBounds.y0,
                      previewBounds.x1,
                      previewBounds.y1
                    );
                    return (
                      <KRect
                        x={previewRect.x}
                        y={previewRect.y}
                        width={previewRect.width}
                        height={previewRect.height}
                        stroke="#17678e"
                        strokeWidth={1.6}
                        dash={[6, 5]}
                        fill={rgba("#17678e", 0.12)}
                      />
                    );
                  })()
                )
              ) : null}

              {draftPolyline && draftPolyline.length > 0 ? (
                <>
                  <KLine points={[...draftPolyline, ...(cursor ? [cursor] : [])].flatMap((p) => [toCanvasX(p.x), toCanvasY(p.y)])} stroke="#17678e" strokeWidth={1.6} dash={[5, 4]} lineJoin="round" lineCap="round" />
                  {draftPolyline.map((point, index) => (
                    <KCircle key={`draft-${index}`} x={toCanvasX(point.x)} y={toCanvasY(point.y)} radius={4} fill="#17678e" />
                  ))}
                </>
              ) : null}
            </Layer>

            <Layer listening={false}>
              {annotationLabels
                .filter(
                  (item) =>
                    Number.isFinite(item.x) &&
                    Number.isFinite(item.y) &&
                    item.text.trim().length > 0
                )
                .map((item, idx) => (
                  <KText
                    key={`annotation-label-${idx}`}
                    x={toCanvasX(item.x) + 6}
                    y={toCanvasY(item.y) - 14}
                    text={item.text}
                    fontSize={10}
                    fontStyle="bold"
                    fill={item.color ?? "#113f59"}
                    listening={false}
                  />
                ))}
            </Layer>

            <Layer>
              {handles.map((handle, idx) => (
                <KCircle
                  key={`handle-${idx}`}
                  x={toCanvasX(handle.x)}
                  y={toCanvasY(handle.y)}
                  radius={5}
                  fill="#ffffff"
                  stroke="#17678e"
                  strokeWidth={1.5}
                  draggable
                  onMouseDown={(event) => {
                    event.cancelBubble = true;
                    focusEditor();
                  }}
                  onDragMove={(event) => {
                    const point = snapPoint(clampPoint({ x: toDomainX(event.target.x()), y: toDomainY(event.target.y()) }, domain), snapToGrid, snapStepMm);
                    handleDragHandle(handle, point, false);
                  }}
                  onDragEnd={(event) => {
                    const point = snapPoint(clampPoint({ x: toDomainX(event.target.x()), y: toDomainY(event.target.y()) }, domain), snapToGrid, snapStepMm);
                    handleDragHandle(handle, point, true);
                  }}
                />
              ))}
            </Layer>
            <Layer listening={false}>
              {selectedPositionPoints.map((point, idx) => (
                <Group key={`pos-point-${idx}`}>
                  <KCircle
                    x={toCanvasX(point.x)}
                    y={toCanvasY(point.y)}
                    radius={3.6}
                    fill={point.color || "#ef476f"}
                    stroke="#ffffff"
                    strokeWidth={1}
                  />
                  <KText
                    x={toCanvasX(point.x) + 5}
                    y={toCanvasY(point.y) - 14}
                    text={`${point.label ?? `P${idx}`} (${round(point.x, 1)}, ${round(point.y, 1)})`}
                    fontSize={10}
                    fill="#0a4a66"
                  />
                </Group>
              ))}
            </Layer>
          </Stage>
        </div>
      </section>
      <aside className="geometry-panel">
        <section className="geometry-list">
          <div className="geometry-list-header">
            <strong>Geometries</strong>
            <span>{shapes.length}</span>
          </div>
          {shapes.map((shape) => (
            <button key={shape.id} type="button" className={`geometry-item ${shape.id === selectedId ? "active" : ""}`} onClick={() => { onSelect(shape.id); focusEditor(); }}>
              <span className="legend-swatch" style={{ backgroundColor: shape.color }} />
              <span className="geometry-label">{shape.label}</span>
              <span className="geometry-type">{shape.type}/{shape.role}</span>
            </button>
          ))}
          {shapes.length === 0 ? <p className="geometry-empty">No geometry yet.</p> : null}
        </section>

        <section className="geometry-detail">
          {!selected ? (
            <p className="geometry-empty-panel">Select a geometry to edit.</p>
          ) : (
            <>
              <div className="geometry-detail-header">
                <strong>{selected.label}</strong>
                <span className="geometry-type">{selected.type}</span>
              </div>

              <label className="geometry-field"><span>Label</span><input value={selected.label} onChange={(event) => applyTagPatch({ label: event.target.value })} /></label>
              <label className="geometry-field"><span>Tag</span><input value={selected.tag} onChange={(event) => applyTagPatch({ tag: event.target.value })} /></label>

              <label className="geometry-field">
                <span>Role</span>
                <select value={selected.role} onChange={(event) => {
                  const role = event.target.value as GeometryRole;
                  applyTagPatch({ role, color: roleColor(role) });
                }}>
                  {ROLE_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                </select>
              </label>

              <div className="geometry-material">
                <label><span>Color</span><input type="color" value={selected.color} onChange={(event) => applyTagPatch({ color: event.target.value })} /></label>
                <label><span>Stroke(mm)</span><input type="number" min={0.1} step={0.02} value={selected.strokeWidth} onChange={(event) => applyTagPatch({ strokeWidth: Number(event.target.value) })} /></label>
              </div>

              {selected.group !== "chamber" ? (
                <>
                  <label className="geometry-field checkbox-field"><span>Material enabled</span><input type="checkbox" checked={selected.material.enabled} onChange={(event) => applyMaterialPatch({ enabled: event.target.checked })} /></label>
                  <label className="geometry-field">
                    <span>Material preset</span>
                    <select value={selectedPreset} onChange={(event) => {
                      const preset = CCP_MATERIAL_PRESETS.find((item) => item.id === event.target.value);
                      if (!preset) return;
                      applyMaterialPatch({ enabled: true, epsilon_r: preset.epsilon_r, wall_loss_e: preset.wall_loss_e });
                    }}>
                      <option value="custom">Custom</option>
                      {CCP_MATERIAL_PRESETS.filter((item) => item.roles.includes(selected.role)).map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
                    </select>
                  </label>
                  <div className="geometry-material">
                    <label><span>Epsilon r</span><input type="number" min={1} step={0.01} value={selected.material.epsilon_r} onChange={(event) => applyMaterialPatch({ epsilon_r: Number(event.target.value) })} /></label>
                    <label><span>Wall loss</span><input type="number" min={0} max={1} step={0.01} value={selected.material.wall_loss_e} onChange={(event) => applyMaterialPatch({ wall_loss_e: Number(event.target.value) })} /></label>
                  </div>
                </>
              ) : null}

              {selected.type === "rect" ? (
                <div className="geometry-material">
                  <label><span>x0</span><input type="number" value={selected.x0} onChange={(event) => applyNumberPatch("x0", Number(event.target.value))} /></label>
                  <label><span>x1</span><input type="number" value={selected.x1} onChange={(event) => applyNumberPatch("x1", Number(event.target.value))} /></label>
                  <label><span>y0</span><input type="number" value={selected.y0} onChange={(event) => applyNumberPatch("y0", Number(event.target.value))} /></label>
                  <label><span>y1</span><input type="number" value={selected.y1} onChange={(event) => applyNumberPatch("y1", Number(event.target.value))} /></label>
                </div>
              ) : null}

              {selected.type === "circle" ? (
                <div className="geometry-material">
                  <label><span>cx</span><input type="number" value={selected.cx} onChange={(event) => applyNumberPatch("cx", Number(event.target.value))} /></label>
                  <label><span>cy</span><input type="number" value={selected.cy} onChange={(event) => applyNumberPatch("cy", Number(event.target.value))} /></label>
                  <label><span>r</span><input type="number" min={MIN_RADIUS} value={selected.r} onChange={(event) => applyNumberPatch("r", Number(event.target.value))} /></label>
                </div>
              ) : null}

              {(selected.type === "polygon" || selected.type === "line") ? (
                <div className="geometry-point-list">
                  {selected.points.map((point, index) => (
                    <div key={`${selected.id}-p-${index}`} className="geometry-material">
                      <label><span>p{index} x</span><input type="number" value={point.x} onChange={(event) => applyNumberPatch(`p.${index}.x`, Number(event.target.value))} /></label>
                      <label><span>p{index} y</span><input type="number" value={point.y} onChange={(event) => applyNumberPatch(`p.${index}.y`, Number(event.target.value))} /></label>
                    </div>
                  ))}
                </div>
              ) : null}

              {selectedPlanarMetrics ? (
                <div className="geometry-metrics">
                  <div className="geometry-metrics-head">Planar Metrics</div>
                  <div className="geometry-metrics-grid">
                    <span>Length (mm)</span>
                    <strong>{round(selectedPlanarMetrics.width_mm, 3)}</strong>
                    <span>Height (mm)</span>
                    <strong>{round(selectedPlanarMetrics.height_mm, 3)}</strong>
                    <span>Area proxy (mm^2)</span>
                    <strong>{round(selectedPlanarMetrics.area_proxy_mm2, 4)}</strong>
                    <span>Power Absorption Density proxy</span>
                    <strong>
                      {selectedPlanarMetrics.loss_density_proxy === null
                        ? "-"
                        : round(selectedPlanarMetrics.loss_density_proxy, 8)}
                    </strong>
                  </div>
                </div>
              ) : null}

              <p className="geometry-note">Draw by dragging/clicking on canvas. Shift: axis-lock line / square rect. Alt+drag: center draw, and in Move mode duplicates selected geometry.</p>
            </>
          )}
        </section>
      </aside>
    </div>
  );
};

export default GeometryEditor;
