import type { GeometryShape } from "../types/geometry";

export type VolumeLossDensityResultRow = {
  tag: string;
  label: string;
  role: string;
  color: string;
  cells: number;
  volume_mm3: number;
  mean: number | null;
  max: number | null;
  absorbedPowerRel: number | null;
  // Backward-compat alias used by existing table bindings.
  sum: number | null;
};

export type VolumeLossDensityCompareRow = {
  tag: string;
  label: string;
  role: string;
  leftMean: number | null;
  rightMean: number | null;
  deltaMean: number | null;
  leftAbsorbed: number | null;
  rightAbsorbed: number | null;
  deltaAbsorbed: number | null;
  leftVolumeMm3: number;
  rightVolumeMm3: number;
  leftCells: number;
  rightCells: number;
};

const toShapeMap = (shapes: GeometryShape[]) => {
  const map = new Map<string, GeometryShape>();
  shapes.forEach((shape) => {
    const tag = shape.tag.trim();
    if (!tag || shape.group === "chamber") {
      return;
    }
    map.set(tag, shape);
  });
  return map;
};

const isExcludedTag = (tag: string) => {
  const normalized = tag.trim().toLowerCase();
  if (!normalized) {
    return true;
  }
  if (normalized.includes("chamber")) {
    return true;
  }
  if (
    normalized.includes("pump") ||
    normalized.includes("outlet") ||
    normalized.includes("exhaust")
  ) {
    return true;
  }
  return (
    normalized === "plasma" ||
    normalized === "solid_wall" ||
    normalized === "powered_electrode" ||
    normalized === "ground_electrode" ||
    normalized === "dielectric"
  );
};

const toValue = (value: number | null) =>
  value !== null && Number.isFinite(value) ? value : null;

const estimateStep = (axis: number[] | undefined, index: number) => {
  if (!axis || axis.length <= 1) {
    return 1.0;
  }
  const i = Math.max(0, Math.min(axis.length - 1, index));
  if (i === 0) {
    return Math.max(1e-9, Math.abs(axis[1] - axis[0]));
  }
  if (i === axis.length - 1) {
    return Math.max(1e-9, Math.abs(axis[i] - axis[i - 1]));
  }
  return Math.max(1e-9, 0.5 * Math.abs(axis[i + 1] - axis[i - 1]));
};

const cellVolumeMm3 = (
  rAxis: number[] | undefined,
  zAxis: number[] | undefined,
  j: number,
  k: number
) => {
  if (!rAxis || !zAxis || rAxis.length === 0 || zAxis.length === 0) {
    return 1.0;
  }
  const r = Math.max(0.0, rAxis[Math.min(rAxis.length - 1, Math.max(0, j))] ?? 0);
  const dr = estimateStep(rAxis, j);
  const dz = estimateStep(zAxis, k);
  // Axisymmetric ring-cell volume proxy in mm^3.
  return Math.max(1e-9, 2.0 * Math.PI * r * dr * dz);
};

export const buildVolumeLossDensityResultRows = (
  field: number[][] | undefined,
  tagMask: Record<string, boolean[][]> | undefined,
  shapes: GeometryShape[],
  rAxis?: number[],
  zAxis?: number[]
): VolumeLossDensityResultRow[] => {
  if (!field || field.length === 0 || !tagMask) {
    return [];
  }

  const nz = field.length;
  const nr = field[0]?.length ?? 0;
  if (nr <= 0) {
    return [];
  }

  const shapeMap = toShapeMap(shapes);
  const shapeTags = Array.from(shapeMap.keys()).filter((tag) => !isExcludedTag(tag));
  const tags =
    shapeTags.length > 0
      ? shapeTags
      : Object.keys(tagMask).filter((tag) => !isExcludedTag(tag));

  const rows = tags.map((tag) => {
    const mask = tagMask[tag];
    let weightedSum = 0.0;
    let volume = 0.0;
    let max = Number.NEGATIVE_INFINITY;
    let count = 0;

    if (mask) {
      const zLimit = Math.min(nz, mask.length);
      for (let k = 0; k < zLimit; k += 1) {
        const rowMask = mask[k];
        const xLimit = Math.min(nr, rowMask.length);
        for (let j = 0; j < xLimit; j += 1) {
          if (!rowMask[j]) {
            continue;
          }
          const value = field[k]?.[j];
          if (!Number.isFinite(value)) {
            continue;
          }
          const weight = cellVolumeMm3(rAxis, zAxis, j, k);
          weightedSum += value * weight;
          volume += weight;
          if (value > max) {
            max = value;
          }
          count += 1;
        }
      }
    }

    const shape = shapeMap.get(tag);
    const mean = volume > 0 ? weightedSum / volume : null;
    const absorbedPowerRel = volume > 0 ? weightedSum : null;
    return {
      tag,
      label: shape?.label ?? tag,
      role: shape?.role ?? "-",
      color: shape?.color ?? "#17678e",
      cells: count,
      volume_mm3: volume,
      mean: toValue(mean),
      max: toValue(count > 0 ? max : null),
      absorbedPowerRel: toValue(absorbedPowerRel),
      sum: toValue(absorbedPowerRel),
    };
  });

  return rows.sort((a, b) => a.tag.localeCompare(b.tag));
};

export const buildVolumeLossDensityCompareRows = (
  leftRows: VolumeLossDensityResultRow[],
  rightRows: VolumeLossDensityResultRow[]
): VolumeLossDensityCompareRow[] => {
  const leftMap = new Map(leftRows.map((row) => [row.tag, row]));
  const rightMap = new Map(rightRows.map((row) => [row.tag, row]));
  const tags = Array.from(new Set([...leftMap.keys(), ...rightMap.keys()])).sort((a, b) =>
    a.localeCompare(b)
  );

  return tags.map((tag) => {
    const left = leftMap.get(tag);
    const right = rightMap.get(tag);
    const leftMean = left?.mean ?? null;
    const rightMean = right?.mean ?? null;
    const leftAbsorbed = left?.absorbedPowerRel ?? null;
    const rightAbsorbed = right?.absorbedPowerRel ?? null;
    return {
      tag,
      label: right?.label ?? left?.label ?? tag,
      role: right?.role ?? left?.role ?? "-",
      leftMean,
      rightMean,
      deltaMean:
        leftMean !== null && rightMean !== null ? rightMean - leftMean : null,
      leftAbsorbed,
      rightAbsorbed,
      deltaAbsorbed:
        leftAbsorbed !== null && rightAbsorbed !== null
          ? rightAbsorbed - leftAbsorbed
          : null,
      leftVolumeMm3: left?.volume_mm3 ?? 0,
      rightVolumeMm3: right?.volume_mm3 ?? 0,
      leftCells: left?.cells ?? 0,
      rightCells: right?.cells ?? 0,
    };
  });
};

export const buildRadialMeanSeries = (
  field: number[][] | undefined
): number[] | undefined => {
  if (!field || field.length === 0 || field[0]?.length === 0) {
    return undefined;
  }
  const nz = field.length;
  const nr = field[0].length;
  const curve = Array.from({ length: nr }, () => 0);
  const counts = Array.from({ length: nr }, () => 0);
  for (let k = 0; k < nz; k += 1) {
    for (let j = 0; j < nr; j += 1) {
      const value = field[k]?.[j];
      if (!Number.isFinite(value)) {
        continue;
      }
      curve[j] += value;
      counts[j] += 1;
    }
  }
  return curve.map((value, idx) => (counts[idx] > 0 ? value / counts[idx] : 0));
};
