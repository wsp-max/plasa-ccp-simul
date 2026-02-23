export type PositiveRange = {
  min: number;
  max: number;
};

export type LogScaledGrid = {
  grid?: number[][];
  rawMin?: number;
  rawMax?: number;
  logMin?: number;
  logMax?: number;
};

export type LogColorbarTicks = {
  tickVals: number[];
  tickText: string[];
};

const POS_EPS = 1e-12;

export const getFiniteMinMax = (
  ...grids: Array<number[][] | undefined>
): PositiveRange | undefined => {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const grid of grids) {
    if (!grid) {
      continue;
    }
    for (const row of grid) {
      for (const value of row) {
        if (!Number.isFinite(value)) {
          continue;
        }
        if (value < min) {
          min = value;
        }
        if (value > max) {
          max = value;
        }
      }
    }
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    return undefined;
  }
  const safeMax = max > min ? max : min + 1e-9;
  return { min, max: safeMax };
};

export const getPositiveMinMax = (
  ...grids: Array<number[][] | undefined>
): PositiveRange | undefined => {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;

  for (const grid of grids) {
    if (!grid) {
      continue;
    }
    for (const row of grid) {
      for (const value of row) {
        if (!Number.isFinite(value) || value <= 0) {
          continue;
        }
        if (value < min) {
          min = value;
        }
        if (value > max) {
          max = value;
        }
      }
    }
  }

  if (!Number.isFinite(min) || !Number.isFinite(max) || max <= 0) {
    return undefined;
  }
  return { min, max };
};

const normalizeRange = (range: PositiveRange): PositiveRange => {
  const safeMin = Math.max(POS_EPS, range.min);
  let safeMax = Math.max(safeMin, range.max);
  if (safeMax <= safeMin * (1 + 1e-12)) {
    safeMax = safeMin * 10.0;
  }
  return { min: safeMin, max: safeMax };
};

const formatTickValue = (value: number) => {
  if (!Number.isFinite(value) || value <= 0) {
    return "-";
  }
  if (value >= 1e-2 && value < 1e3) {
    const fixed = Number(value.toPrecision(3));
    return String(fixed);
  }
  return value.toExponential(2).replace("e+", "e");
};

export const buildLogColorbarTicks = (
  logMin?: number,
  logMax?: number,
  rawMin?: number,
  rawMax?: number,
  requestedTickCount = 6
): LogColorbarTicks | undefined => {
  if (
    !Number.isFinite(logMin) ||
    !Number.isFinite(logMax) ||
    (logMax as number) <= (logMin as number)
  ) {
    return undefined;
  }
  const tickCount = Math.max(3, Math.min(9, Math.round(requestedTickCount)));
  const span = (logMax as number) - (logMin as number);
  const step = span / (tickCount - 1);

  const tickVals: number[] = [];
  const tickText: string[] = [];
  for (let i = 0; i < tickCount; i += 1) {
    const atStart = i === 0;
    const atEnd = i === tickCount - 1;
    const lv = atStart
      ? (logMin as number)
      : atEnd
        ? (logMax as number)
        : (logMin as number) + step * i;
    const rawValue = atStart && Number.isFinite(rawMin)
      ? (rawMin as number)
      : atEnd && Number.isFinite(rawMax)
        ? (rawMax as number)
        : 10 ** lv;
    tickVals.push(lv);
    tickText.push(formatTickValue(rawValue));
  }
  return { tickVals, tickText };
};

export const buildLogScaledGrid = (
  grid: number[][] | undefined,
  sharedRange?: PositiveRange,
  options?: { nonPositive?: "nan" | "min" }
): LogScaledGrid => {
  const range = sharedRange ?? getPositiveMinMax(grid);
  if (!range) {
    return {};
  }

  const safeRange = normalizeRange(range);
  const logMin = Math.log10(safeRange.min);
  const logMax = Math.log10(safeRange.max);

  if (!grid) {
    return {
      rawMin: safeRange.min,
      rawMax: safeRange.max,
      logMin,
      logMax,
    };
  }

  const mapped = grid.map((row) =>
    row.map((value) => {
      if (!Number.isFinite(value)) {
        return Number.NaN;
      }
      if (value <= 0) {
        if (options?.nonPositive === "min") {
          return logMin;
        }
        return Number.NaN;
      }
      const clipped = Math.min(safeRange.max, Math.max(safeRange.min, value));
      return Math.log10(clipped);
    })
  );

  return {
    grid: mapped,
    rawMin: safeRange.min,
    rawMax: safeRange.max,
    logMin,
    logMax,
  };
};
