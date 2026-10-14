import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type ReactNode } from 'react';
import {
  Background,
  BackgroundVariant,
  MarkerType,
  MiniMap,
  Panel,
  ReactFlow,
  useNodesInitialized,
  useReactFlow,
  type Connection,
  type EdgeChange,
  type FinalConnectionState,
  type IsValidConnection,
  type NodeChange,
  type OnBeforeDelete,
  type OnDelete,
} from '@xyflow/react';
import { LayoutPanelLeft, Maximize, Redo2, Undo2, ZoomIn, ZoomOut } from 'lucide-react';
import { color } from '@mihato/ui-tokens';
import { fmt, vi } from '@mihato/i18n';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/toast';
import { Tooltip } from '@/components/ui/tooltip';
import { useDesigner } from './context';
import { EDGE_COLOR, LinkEdge, type FlowEdge } from './flow-edge';
import { StepNode, type FlowNode } from './flow-node';
import { autoLayout } from './layout';
import { addEdge, canConnect, estimateSize, findNode, frameAll, isBlank, nodeKindLabel, nodeTitle, READABLE_ZOOM, removeElements, setPositions, sourceHandleOf, type AddableKind, type Size, type XY } from './model';

const t = vi.admin.designer.editor;

/** Kiểu dữ liệu kéo thả của khối nút từ cột trái. */
export const PALETTE_MIME = 'application/x-mihato-buoc';
const ADDABLE: readonly string[] = ['task', 'approval', 'contribute', 'condition', 'timer', 'notify', 'end'];

const NODE_TYPES = { step: StepNode };
const EDGE_TYPES = { link: LinkEdge };
const FIT_OPTIONS = { padding: 0.12, maxZoom: 1 };
const DELETE_KEYS = ['Backspace', 'Delete'];

function marker(stroke: string) {
  return { type: MarkerType.ArrowClosed, color: stroke, width: 18, height: 18 };
}

export type CanvasProps = {
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  /** thả một khối từ cột trái vào khung vẽ, tại toạ độ sơ đồ */
  onDropKind: (kind: AddableKind, at: XY) => void;
  /** nội dung phủ lên khung vẽ (ví dụ trình đơn "bước kế tiếp") */
  children?: ReactNode;
};

function ToolButton({ label, onClick, disabled, children, testId }: { label: string; onClick: () => void; disabled?: boolean; children: ReactNode; testId?: string }) {
  return (
    <Tooltip content={label} side="bottom">
      <Button variant="ghost" size="icon-sm" aria-label={label} disabled={disabled} onClick={onClick} data-testid={testId}>
        {children}
      </Button>
    </Tooltip>
  );
}

/** Khung vẽ (SPEC 9.3): kéo, nối, chọn, xoá, thu phóng, bản đồ nhỏ, tự sắp xếp. Bản vẽ là nguồn duy nhất; React Flow chỉ hiển thị. */
export function Canvas({ canUndo, canRedo, onUndo, onRedo, onDropKind, children }: CanvasProps) {
  const { def, readOnly, selection, select, change, edgeIssue, openQuickAdd } = useDesigner();
  const rf = useReactFlow<FlowNode, FlowEdge>();

  // Kích thước React Flow đã đo, giữ lại để nút không bị đo lại (nháy) mỗi lần dữ liệu đổi.
  const [measured, setMeasured] = useState<Record<string, Size>>({});
  // Vị trí tạm trong lúc đang kéo; thả tay mới ghi vào bản vẽ thành một bước hoàn tác.
  const [dragging, setDragging] = useState<Record<string, XY>>({});
  const draggingRef = useRef(dragging);
  const selectionRef = useRef(selection);
  selectionRef.current = selection;

  const nodeCache = useRef(new Map<string, FlowNode>());
  const nodes = useMemo(() => {
    const next = new Map<string, FlowNode>();
    const list = def.nodes.map((n) => {
      const position = dragging[n.id] ?? def.layout?.[n.id] ?? { x: 0, y: 0 };
      const selected = selection.nodes.includes(n.id);
      const size = measured[n.id];
      const old = nodeCache.current.get(n.id);
      const same =
        old !== undefined &&
        old.data.node === n &&
        old.position.x === position.x &&
        old.position.y === position.y &&
        old.selected === selected &&
        old.measured === size &&
        old.draggable === !readOnly;
      const node: FlowNode = same
        ? old
        : {
            id: n.id,
            type: 'step',
            position,
            data: { node: n },
            selected,
            measured: size,
            draggable: !readOnly,
            deletable: !readOnly && n.type !== 'start',
            ariaLabel: fmt(t.canvas.nodeAria, { loại: nodeKindLabel(n), tên: nodeTitle(n) }),
          };
      next.set(n.id, node);
      return node;
    });
    nodeCache.current = next;
    return list;
  }, [def.nodes, def.layout, dragging, measured, readOnly, selection.nodes]);

  const edges = useMemo(() => {
    const ids = new Set(def.nodes.map((n) => n.id));
    return def.edges
      .filter((e) => ids.has(e.from) && ids.has(e.to))
      .map((e): FlowEdge => {
        const selected = selection.edges.includes(e.id);
        const level = edgeIssue(e.id)?.level;
        const stroke = selected ? EDGE_COLOR.selected : level === 'error' ? EDGE_COLOR.error : level === 'warning' ? EDGE_COLOR.warning : EDGE_COLOR.normal;
        const from = findNode(def, e.from);
        const to = findNode(def, e.to);
        return {
          id: e.id,
          type: 'link',
          source: e.from,
          target: e.to,
          sourceHandle: sourceHandleOf(def, e),
          data: { edge: e },
          selected,
          deletable: !readOnly,
          markerEnd: marker(stroke),
          ariaLabel: fmt(t.canvas.edgeAria, { từ: from ? nodeTitle(from) : e.from, đến: to ? nodeTitle(to) : e.to }),
        };
      });
  }, [def, edgeIssue, readOnly, selection.edges]);

  const applySelection = useCallback(
    (next: { nodes: readonly string[]; edges: readonly string[] }) => {
      selectionRef.current = next;
      select(next);
    },
    [select],
  );

  const onNodesChange = useCallback(
    (changes: NodeChange<FlowNode>[]) => {
      let selected: Set<string> | null = null;
      let sizes: Record<string, Size> | null = null;
      let moving: Record<string, XY> | null = null;
      let moved: Record<string, XY> | null = null;
      for (const c of changes) {
        if (c.type === 'select') {
          selected ??= new Set(selectionRef.current.nodes);
          if (c.selected) selected.add(c.id);
          else selected.delete(c.id);
        } else if (c.type === 'dimensions' && c.dimensions) {
          (sizes ??= {})[c.id] = c.dimensions;
        } else if (c.type === 'position' && c.position) {
          if (c.dragging) (moving ??= {})[c.id] = c.position;
          else (moved ??= {})[c.id] = c.position;
        }
      }
      if (sizes) {
        const added = sizes;
        setMeasured((prev) => {
          let next = prev;
          for (const [id, size] of Object.entries(added)) {
            const old = prev[id];
            if (old && old.width === size.width && old.height === size.height) continue;
            if (next === prev) next = { ...prev };
            next[id] = size;
          }
          return next;
        });
      }
      if (moving) {
        draggingRef.current = { ...draggingRef.current, ...moving };
        setDragging(draggingRef.current);
      }
      if (moved && !readOnly) {
        const final = { ...draggingRef.current, ...moved };
        draggingRef.current = {};
        setDragging({});
        change((d) => setPositions(d, final), { coalesce: `move:${Object.keys(final).sort().join(',')}` });
      }
      if (selected) applySelection({ nodes: [...selected], edges: selectionRef.current.edges });
    },
    [applySelection, change, readOnly],
  );

  const onEdgesChange = useCallback(
    (changes: EdgeChange<FlowEdge>[]) => {
      let selected: Set<string> | null = null;
      for (const c of changes) {
        if (c.type !== 'select') continue;
        selected ??= new Set(selectionRef.current.edges);
        if (c.selected) selected.add(c.id);
        else selected.delete(c.id);
      }
      if (selected) applySelection({ nodes: selectionRef.current.nodes, edges: [...selected] });
    },
    [applySelection],
  );

  const onConnect = useCallback(
    (c: Connection) => {
      change((d) => addEdge(d, c.source, c.target, c.sourceHandle ?? null).def);
    },
    [change],
  );

  const isValidConnection = useCallback<IsValidConnection<FlowEdge>>((c) => canConnect(def, c.source, c.target, c.sourceHandle ?? null), [def]);

  // Nối nhanh: kéo một đường nối ra khoảng trống thì hỏi luôn bước kế tiếp là gì.
  const onConnectEnd = useCallback(
    (event: MouseEvent | TouchEvent, state: FinalConnectionState) => {
      if (readOnly || state.isValid || !state.fromNode || state.fromHandle?.type !== 'source') return;
      const point = 'changedTouches' in event ? event.changedTouches[0] : event;
      if (!point) return;
      const under = document.elementFromPoint(point.clientX, point.clientY);
      if (!under?.classList.contains('react-flow__pane')) return;
      openQuickAdd({
        screen: { x: point.clientX, y: point.clientY },
        from: { nodeId: state.fromNode.id, handle: state.fromHandle.id ?? null },
        at: rf.screenToFlowPosition({ x: point.clientX, y: point.clientY }),
      });
    },
    [openQuickAdd, readOnly, rf],
  );

  const onBeforeDelete = useCallback<OnBeforeDelete<FlowNode, FlowEdge>>(
    async ({ nodes: toRemove }) => {
      const picked = selectionRef.current.nodes;
      if (toRemove.length === 0 && picked.some((id) => findNode(def, id)?.type === 'start')) toast.info(t.canvas.cannotDeleteStart);
      return true;
    },
    [def],
  );

  const onDelete = useCallback<OnDelete<FlowNode, FlowEdge>>(
    ({ nodes: removedNodes, edges: removedEdges }) => {
      change((d) =>
        removeElements(
          d,
          removedNodes.map((n) => n.id),
          removedEdges.map((e) => e.id),
        ),
      );
      applySelection({ nodes: [], edges: [] });
      if (removedNodes.length > 0) toast.info(t.canvas.deleted, { duration: 5_000, action: { label: t.canvas.undo, onClick: onUndo } });
    },
    [applySelection, change, onUndo],
  );

  const onDragOver = useCallback(
    (e: DragEvent) => {
      if (readOnly || !e.dataTransfer.types.includes(PALETTE_MIME)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    },
    [readOnly],
  );

  const onDrop = useCallback(
    (e: DragEvent) => {
      const kind = e.dataTransfer.getData(PALETTE_MIME);
      if (readOnly || !ADDABLE.includes(kind)) return;
      e.preventDefault();
      onDropKind(kind as AddableKind, rf.screenToFlowPosition({ x: e.clientX, y: e.clientY }));
    },
    [onDropKind, readOnly, rf],
  );

  const tidy = useCallback(() => {
    change((d) =>
      setPositions(
        d,
        autoLayout(d, (id) => {
          const node = findNode(d, id);
          return measured[id] ?? (node ? estimateSize(node) : undefined);
        }),
      ),
    );
    // Chờ React Flow nhận toạ độ mới rồi mới đưa cả sơ đồ vào khung nhìn.
    requestAnimationFrame(() => requestAnimationFrame(() => void rf.fitView({ ...FIT_OPTIONS, duration: 250 })));
  }, [change, measured, rf]);

  // Khung nhìn lúc mở: sơ đồ vừa khung ở mức còn đọc được thì hiện cả sơ đồ; rộng hơn thì neo ô Bắt đầu ở mép trái.
  const containerRef = useRef<HTMLDivElement>(null);
  const initialized = useNodesInitialized();
  const framed = useRef(false);
  useEffect(() => {
    if (!initialized || framed.current) return;
    framed.current = true;
    const box = containerRef.current?.getBoundingClientRect();
    const bounds = rf.getNodesBounds(rf.getNodes());
    if (!box || bounds.width === 0) return;
    const view = frameAll(box, bounds) ?? {
      zoom: READABLE_ZOOM,
      x: 36 - bounds.x * READABLE_ZOOM,
      y: Math.max(64 - bounds.y * READABLE_ZOOM, box.height / 2 - (bounds.y + bounds.height / 2) * READABLE_ZOOM),
    };
    void rf.setViewport(view);
  }, [initialized, rf]);

  const ariaLabelConfig = useMemo(
    () => ({
      'node.a11yDescription.default': readOnly ? t.canvas.a11yNodeLocked : t.canvas.a11yNode,
      'node.a11yDescription.keyboardDisabled': t.canvas.a11yNodeLocked,
      'node.a11yDescription.ariaLiveMessage': ({ direction, x, y }: { direction: string; x: number; y: number }) =>
        fmt(t.canvas.a11yMoved, { hướng: direction, x: Math.round(x), y: Math.round(y) }),
      'edge.a11yDescription.default': t.canvas.a11yEdge,
      'minimap.ariaLabel': t.canvas.minimap,
      'handle.ariaLabel': t.canvas.handleSource,
    }),
    [readOnly],
  );

  return (
    <div ref={containerRef} className="designer-flow relative h-full min-h-0 w-full" data-testid="designer-canvas">
      <ReactFlow<FlowNode, FlowEdge>
        nodes={nodes}
        edges={edges}
        nodeTypes={NODE_TYPES}
        edgeTypes={EDGE_TYPES}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onConnectEnd={onConnectEnd}
        isValidConnection={isValidConnection}
        onBeforeDelete={onBeforeDelete}
        onDelete={onDelete}
        onDragOver={onDragOver}
        onDrop={onDrop}
        nodesDraggable={!readOnly}
        nodesConnectable={!readOnly}
        edgesReconnectable={false}
        deleteKeyCode={readOnly ? null : DELETE_KEYS}
        minZoom={0.25}
        maxZoom={1.5}
        connectionRadius={28}
        connectionLineStyle={{ stroke: color.primary, strokeWidth: 2 }}
        zoomOnDoubleClick={false}
        attributionPosition="bottom-left"
        ariaLabelConfig={ariaLabelConfig}
      >
        <Background variant={BackgroundVariant.Dots} gap={22} size={1.4} color={color.hairline} />
        <MiniMap
          pannable
          zoomable
          position="bottom-right"
          ariaLabel={t.canvas.minimap}
          nodeColor={(n) => {
            const type = (n as FlowNode).data.node.type;
            return type === 'start' || type === 'end' ? color.primary : type === 'approval' ? color.goldTint : type === 'task' ? color.primaryTint : color.surfaceAlt;
          }}
          nodeStrokeColor={color.border}
          nodeStrokeWidth={2}
          nodeBorderRadius={8}
          maskColor="rgba(250, 246, 238, 0.7)"
          bgColor={color.surface}
          style={{ width: 148, height: 96 }}
        />

        <Panel position="top-left">
          <div role="toolbar" aria-label={t.regionToolbar} className="flex items-center gap-0.5 rounded-lg border border-line bg-surface p-0.5">
            {readOnly ? null : (
              <>
                <ToolButton label={`${t.canvas.undo} (Ctrl+Z)`} onClick={onUndo} disabled={!canUndo} testId="undo">
                  <Undo2 aria-hidden="true" />
                </ToolButton>
                <ToolButton label={`${t.canvas.redo} (Ctrl+Shift+Z)`} onClick={onRedo} disabled={!canRedo} testId="redo">
                  <Redo2 aria-hidden="true" />
                </ToolButton>
                <span aria-hidden="true" className="mx-1 h-5 w-px bg-hairline" />
              </>
            )}
            <ToolButton label={t.canvas.zoomOut} onClick={() => void rf.zoomOut({ duration: 150 })}>
              <ZoomOut aria-hidden="true" />
            </ToolButton>
            <ToolButton label={t.canvas.zoomIn} onClick={() => void rf.zoomIn({ duration: 150 })}>
              <ZoomIn aria-hidden="true" />
            </ToolButton>
            <ToolButton label={t.canvas.fitView} onClick={() => void rf.fitView({ ...FIT_OPTIONS, duration: 250 })} testId="fit-view">
              <Maximize aria-hidden="true" />
            </ToolButton>
            {readOnly ? null : (
              <>
                <span aria-hidden="true" className="mx-1 h-5 w-px bg-hairline" />
                <Button variant="ghost" size="sm" onClick={tidy} data-testid="auto-layout" className="px-2">
                  <LayoutPanelLeft aria-hidden="true" />
                  {t.canvas.autoLayout}
                </Button>
              </>
            )}
          </div>
        </Panel>

        {!readOnly && isBlank(def) ? (
          <Panel position="bottom-center" className="pointer-events-none">
            <div className="mb-2 max-w-[440px] rounded-xl border border-hairline bg-surface px-4 py-3" data-testid="blank-hint">
              <p className="text-base font-semibold">{t.canvas.emptyTitle}</p>
              <ol className="mt-1 list-decimal space-y-0.5 pl-5 text-sm text-ink-sub">
                <li>{t.canvas.emptyStep1}</li>
                <li>{t.canvas.emptyStep2}</li>
                <li>{t.canvas.emptyStep3}</li>
              </ol>
            </div>
          </Panel>
        ) : null}
      </ReactFlow>
      {children}
    </div>
  );
}
