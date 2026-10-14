import { memo } from 'react';
import { BaseEdge, EdgeLabelRenderer, type Edge as RfEdge, type EdgeProps } from '@xyflow/react';
import type { Edge } from '@mihato/domain';
import { color } from '@mihato/ui-tokens';
import { cn } from '@/lib/cn';
import { useDesigner } from './context';
import { edgeLabel, ELSE, estimateSize, positionOf } from './model';
import { routeEdge, type Rect } from './route';

export type FlowEdgeData = { edge: Edge };
export type FlowEdge = RfEdge<FlowEdgeData, 'link'>;

/** Màu mũi tên phải là mã màu thật (React Flow dựng thẻ <marker> theo từng màu), lấy từ bộ token. */
export const EDGE_COLOR = { normal: color.border, selected: color.primary, error: color.text, warning: color.warnText } as const;

function LinkEdgeView({ id, source, target, data, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, selected, markerEnd }: EdgeProps<FlowEdge>) {
  const { def, edgeIssue, select, readOnly, sizeOf } = useDesigner();
  // Các nút khác là vật cản: đường nối đi vòng qua chúng thay vì chạy khuất phía sau.
  const obstacles: Rect[] = [];
  for (const n of def.nodes) {
    if (n.id === source || n.id === target) continue;
    obstacles.push({ ...positionOf(def, n.id), ...(sizeOf(n.id) ?? estimateSize(n)) });
  }
  const { path, labelX, labelY } = routeEdge({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition }, obstacles);
  const issue = edgeIssue(id);
  const label = data ? edgeLabel(def, data.edge) : null;
  const stroke = selected ? EDGE_COLOR.selected : issue?.level === 'error' ? EDGE_COLOR.error : issue?.level === 'warning' ? EDGE_COLOR.warning : EDGE_COLOR.normal;
  const approved = data?.edge.outcome === 'approved';
  const isBranch = data?.edge.branch !== undefined && data.edge.branch !== ELSE;

  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        markerEnd={markerEnd}
        interactionWidth={24}
        style={{ stroke, strokeWidth: selected || issue ? 2.5 : 1.5, strokeDasharray: issue?.level === 'error' ? '6 4' : undefined }}
      />
      {label ? (
        <EdgeLabelRenderer>
          <button
            type="button"
            tabIndex={-1}
            data-edge-label={id}
            onClick={() => select({ nodes: [], edges: [id] })}
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`, pointerEvents: 'all' }}
            className={cn(
              'nodrag nopan absolute max-w-40 truncate rounded-md border px-1.5 py-0.5 text-xs font-medium',
              selected ? 'border-primary' : 'border-hairline',
              approved ? 'bg-primary-tint text-on-primary-tint' : isBranch ? 'bg-gold-tint text-gold' : 'bg-surface text-ink-sub',
              readOnly && 'cursor-default',
            )}
          >
            {label}
          </button>
        </EdgeLabelRenderer>
      ) : null}
    </>
  );
}

/** Đường nối tự vẽ: cong mềm, có mũi tên, có nhãn kết quả duyệt hoặc tên nhánh. Bấm vào nhãn cũng là chọn đường nối. */
export const LinkEdge = memo(LinkEdgeView);
