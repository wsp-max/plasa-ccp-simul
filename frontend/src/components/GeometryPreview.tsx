import type { GeometryShape } from "../types/geometry";

type GeometryPreviewProps = {
  title: string;
  domain: { r_max_mm: number; z_max_mm: number };
  shapes: GeometryShape[];
  annotationShapes?: GeometryShape[];
};

const GeometryPreview = ({
  title,
  domain,
  shapes,
  annotationShapes = [],
}: GeometryPreviewProps) => {
  const width = Math.max(1, domain.r_max_mm);
  const height = Math.max(1, domain.z_max_mm);
  const toY = (y: number) => height - y;

  const renderShape = (shape: GeometryShape, key: string, annotation = false) => {
    const strokeWidth = Math.max(0.2, shape.strokeWidth);
    const stroke = shape.color;
    const fill =
      shape.type === "line"
        ? "none"
        : annotation
          ? "none"
          : shape.color;
    const fillOpacity = annotation ? 0 : shape.group === "chamber" ? 0.08 : 0.24;
    const opacity = annotation ? 0.85 : 1.0;
    const dash = annotation ? "2 2" : undefined;

    if (shape.type === "rect") {
      const x0 = Math.min(shape.x0, shape.x1);
      const x1 = Math.max(shape.x0, shape.x1);
      const y0 = Math.min(shape.y0, shape.y1);
      const y1 = Math.max(shape.y0, shape.y1);
      return (
        <rect
          key={key}
          x={x0}
          y={toY(y1)}
          width={Math.max(0.2, x1 - x0)}
          height={Math.max(0.2, y1 - y0)}
          stroke={stroke}
          strokeWidth={strokeWidth}
          strokeDasharray={dash}
          fill={fill}
          fillOpacity={fillOpacity}
          opacity={opacity}
        />
      );
    }

    if (shape.type === "circle") {
      return (
        <circle
          key={key}
          cx={shape.cx}
          cy={toY(shape.cy)}
          r={Math.max(0.2, shape.r)}
          stroke={stroke}
          strokeWidth={strokeWidth}
          strokeDasharray={dash}
          fill={fill}
          fillOpacity={fillOpacity}
          opacity={opacity}
        />
      );
    }

    const points = shape.points.map((point) => `${point.x},${toY(point.y)}`).join(" ");
    if (shape.type === "line") {
      return (
        <polyline
          key={key}
          points={points}
          stroke={stroke}
          strokeWidth={strokeWidth}
          strokeDasharray={dash}
          fill="none"
          opacity={opacity}
          strokeLinejoin="round"
          strokeLinecap="round"
        />
      );
    }

    return (
      <polygon
        key={key}
        points={points}
        stroke={stroke}
        strokeWidth={strokeWidth}
        strokeDasharray={dash}
        fill={fill}
        fillOpacity={fillOpacity}
        opacity={opacity}
        strokeLinejoin="round"
      />
    );
  };

  return (
    <article className="plot-card geometry-preview-card">
      <h3>{title}</h3>
      <div className="geometry-preview-head">
        <span>Read-only geometry snapshot</span>
        <span className="geometry-preview-domain">
          r {width.toFixed(0)} mm | z {height.toFixed(0)} mm
        </span>
      </div>
      <div className="geometry-preview-frame">
        <svg
          className="geometry-preview-svg"
          viewBox={`0 0 ${width} ${height}`}
          preserveAspectRatio="xMidYMid meet"
          role="img"
          aria-label="Read-only geometry preview"
        >
          <rect x={0} y={0} width={width} height={height} fill="#f7fbff" />
          {shapes.map((shape) => renderShape(shape, `shape-${shape.id}`))}
          {annotationShapes.map((shape, idx) =>
            renderShape(shape, `annotation-${shape.id}-${idx}`, true)
          )}
        </svg>
      </div>
    </article>
  );
};

export default GeometryPreview;
