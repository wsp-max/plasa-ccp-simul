import React, { useEffect, useMemo, useState } from "react";

type NumberInputProps = Omit<
  React.InputHTMLAttributes<HTMLInputElement>,
  "type" | "value" | "defaultValue" | "onChange"
> & {
  value: number;
  onValueChange: (next: number) => void;
};

const toFiniteNumber = (value: number | string | undefined) => {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }
  if (value.trim() === "") {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

const clampNumber = (value: number, min?: number, max?: number) => {
  const lower = min ?? -Infinity;
  const upper = max ?? Infinity;
  return Math.max(lower, Math.min(upper, value));
};

const NumberInput = ({
  value,
  onValueChange,
  min,
  max,
  onBlur,
  onFocus,
  onWheel,
  ...rest
}: NumberInputProps) => {
  const [draft, setDraft] = useState(() =>
    Number.isFinite(value) ? String(value) : ""
  );
  const [editing, setEditing] = useState(false);

  const minValue = useMemo(() => toFiniteNumber(min), [min]);
  const maxValue = useMemo(() => toFiniteNumber(max), [max]);

  useEffect(() => {
    if (editing) {
      return;
    }
    setDraft(Number.isFinite(value) ? String(value) : "");
  }, [editing, value]);

  const commit = () => {
    const trimmed = draft.trim();
    if (trimmed === "") {
      setDraft(Number.isFinite(value) ? String(value) : "");
      return;
    }

    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed)) {
      setDraft(Number.isFinite(value) ? String(value) : "");
      return;
    }

    const clamped = clampNumber(parsed, minValue, maxValue);
    if (clamped !== value) {
      onValueChange(clamped);
    }
    setDraft(String(clamped));
  };

  return (
    <input
      {...rest}
      type="number"
      value={draft}
      min={min}
      max={max}
      onFocus={(event) => {
        setEditing(true);
        onFocus?.(event);
      }}
      onBlur={(event) => {
        setEditing(false);
        commit();
        onBlur?.(event);
      }}
      onChange={(event) => {
        const nextDraft = event.target.value;
        setDraft(nextDraft);
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          commit();
          (event.currentTarget as HTMLInputElement).blur();
          return;
        }
        if (event.key === "Escape") {
          event.preventDefault();
          setDraft(Number.isFinite(value) ? String(value) : "");
          (event.currentTarget as HTMLInputElement).blur();
        }
      }}
      onWheel={(event) => {
        onWheel?.(event);
      }}
    />
  );
};

export default NumberInput;
