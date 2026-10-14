import '@xyflow/react/dist/style.css';
import './designer.css';
import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';
import { Link, useBlocker, useNavigate, useRouter } from '@tanstack/react-router';
import { ReactFlowProvider, useReactFlow } from '@xyflow/react';
import { ArrowLeft, CircleCheck, Ellipsis, FlaskConical, GitCompareArrows, Play, Rocket, Save, ShieldCheck } from 'lucide-react';
import { TEMPLATE_DRAFT_ACTIONS, VALIDATION_CODES, type DefinitionIssue, type DraftDefinition, type TemplateCategory, type TemplateDetail } from '@mihato/domain';
import { fmt, formatDate, formatTime, vi } from '@mihato/i18n';
import { validate } from '@mihato/workflow-engine';
import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import { Callout } from '@/components/ui/callout';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Dialog, DialogBody, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, useAfterMenuClose } from '@/components/ui/dropdown-menu';
import { Select } from '@/features/templates/field-select';
import { toast } from '@/components/ui/toast';
import { Tooltip } from '@/components/ui/tooltip';
import { useCan } from '@/lib/auth';
import { cn } from '@/lib/cn';
import { errorMessage, isApiError } from '@/lib/errors';
import { useApiMutation } from '@/lib/query';
import { Canvas } from './canvas';
import { DesignerProvider, indexIssues, NO_SELECTION, useLookups, type DesignerContextValue, type Issues, type QuickAddRequest, type Selection } from './context';
import { DiffDialog } from './diff-dialog';
import type { FlowEdge } from './flow-edge';
import type { FlowNode } from './flow-node';
import { IssuesBar } from './issues-bar';
import { ensureLayout } from './layout';
import { addEdge, addNodeAt, createNode, estimateSize, findNode, frameAll, freeSpot, graphBounds, isBlank, isContribute, positionOf, spotAfter, type AddableKind, type Size, type XY } from './model';
import { Palette } from './palette';
import { PropertiesPanel } from './panel';
import { QuickAddMenu, type QuickAddChoice } from './quick-add';
import { SimulateDialog } from './simulate-dialog';
import { useHistory } from './use-history';

const t = vi.admin.designer.editor;

/** Tự lưu nháp mỗi 5 giây khi có thay đổi (SPEC 9.3). */
const AUTOSAVE_MS = 5_000;
/** Kiểm tra trực tiếp chạy sau khi ngừng sửa một nhịp, để không kiểm lại ở từng phím gõ. */
const VALIDATE_DELAY_MS = 300;
const NO_ISSUES: Issues = { errors: [], warnings: [] };

/** Bản vẽ kèm mô tả và nhóm của mẫu: cùng lưu trong một lần `templates.saveDraft`, cùng hoàn tác được. */
type Doc = { definition: DraftDefinition; description: string; category: TemplateCategory };

export type DesignerInit =
  /** người vẽ sửa bản đang làm: nháp nếu có, không thì bản xuất bản mới nhất (lần lưu đầu sẽ tạo nháp mới) */
  | { mode: 'edit'; definition: DraftDefinition; rev: number; draftVersion: number | null; savedAt: string | null }
  /** người chỉ có quyền xuất bản (không sửa): xem bản nháp, không sửa được, để duyệt rồi xuất bản */
  | { mode: 'review'; definition: DraftDefinition; rev: number; draftVersion: number; savedAt: string | null }
  /** xem một phiên bản đã xuất bản, không sửa được */
  | { mode: 'view'; definition: DraftDefinition; version: number };

export type DesignerProps = {
  template: TemplateDetail;
  init: DesignerInit;
  /** tải lại bản mới nhất từ máy chủ và dựng lại trình thiết kế (sau khi người khác sửa) */
  onReload: () => void;
};

/**
 * Câu của engine gọi ô kết thúc là “Kết thúc”, còn trên sơ đồ ô này mang nhãn “Hoàn tất” (vi.common.nodeKind.end).
 * Đổi cho khớp để người vẽ không phải đoán hai tên là một.
 */
function wording(issue: DefinitionIssue): DefinitionIssue {
  const message = issue.message.replaceAll('ô “Kết thúc”', `ô “${vi.common.nodeKind.end}”`);
  return message === issue.message ? issue : { ...issue, message };
}

function runValidate(def: DraftDefinition): Issues {
  try {
    const result = validate(def);
    return { errors: result.errors.map(wording), warnings: result.warnings.map(wording) };
  } catch {
    return { errors: [{ code: VALIDATION_CODES.schema, message: t.issues.byCode.schema_invalid }], warnings: [] };
  }
}

/**
 * Lỗi nào được tô lên nút. Danh sách kiểm tra luôn đủ mọi lỗi; riêng hai lỗi "chưa nối từ Bắt đầu" và
 * "chưa có đường tới Hoàn tất" lan ra cả chuỗi bước, nên trên sơ đồ chỉ tô ở đúng chỗ cần sửa:
 * bước chưa có đường nối tới (đầu chuỗi mồ côi) và bước chưa có đường nối đi (cuối chuỗi cụt).
 * Nhờ vậy lúc đang vẽ dở, các bước đã làm xong không bị viền đậm oan.
 */
function forNodes(issues: Issues, def: DraftDefinition): Issues {
  const hasIn = new Set(def.edges.map((e) => e.to));
  const hasOut = new Set(def.edges.map((e) => e.from));
  const actionable = (i: DefinitionIssue): boolean => {
    if (!i.nodeId) return true;
    if (i.code === VALIDATION_CODES.unreachable) return !hasIn.has(i.nodeId);
    if (i.code === VALIDATION_CODES.deadEnd) return !hasOut.has(i.nodeId);
    return true;
  };
  let errors = issues.errors.filter(actionable);
  // Chuỗi khép thành vòng thì không có đầu, không có cuối: khi đó giữ nguyên để lỗi vẫn hiện trên nút.
  for (const code of [VALIDATION_CODES.unreachable, VALIDATION_CODES.deadEnd]) {
    if (issues.errors.some((i) => i.code === code) && !errors.some((i) => i.code === code)) errors = [...errors, ...issues.errors.filter((i) => i.code === code)];
  }
  return errors.length === issues.errors.length ? issues : { errors, warnings: issues.warnings };
}

function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT';
}

/** Trình thiết kế quy trình (SPEC 9.3): thanh trên, khối nút bên trái, khung vẽ ở giữa, bảng thuộc tính bên phải. */
export function Designer(props: DesignerProps) {
  return (
    <ReactFlowProvider>
      <DesignerBody {...props} />
    </ReactFlowProvider>
  );
}

function DesignerBody({ template, init, onReload }: DesignerProps) {
  const editable = init.mode === 'edit';
  /** xem bản nháp để xuất bản: không sửa được nhưng có kiểm tra tại chỗ, chạy thử bản nháp và nút Xuất bản */
  const reviewing = init.mode === 'review';
  const checks = editable || reviewing;
  const can = useCan();
  const canSeeDraft = can(TEMPLATE_DRAFT_ACTIONS);
  const canPublish = can('template.publish');
  const mayStart = can('run.start') && template.archivedAt === null;
  const canStart = mayStart && template.latestPublishedVersion !== null;
  const canSimulate = can('template.simulate');
  const rf = useReactFlow<FlowNode, FlowEdge>();
  const router = useRouter();
  const navigate = useNavigate();
  const lookups = useLookups();
  const canvasRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const templateRef = useRef(template);
  templateRef.current = template;

  // Trình thiết kế phủ lên thanh bên và thanh trên của khung. Các liên kết nằm dưới lớp phủ không được nhận focus
  // (người dùng bàn phím sẽ Tab vào chỗ không nhìn thấy), nên đặt `inert` cho chúng trong lúc trình thiết kế đang mở.
  useEffect(() => {
    const root = rootRef.current;
    const main = root?.closest('main');
    if (!root || !main) return;
    const hidden: Element[] = [...main.children].filter((child) => child !== root && !child.contains(root));
    const header = main.previousElementSibling;
    if (header?.tagName === 'HEADER') hidden.push(header);
    const aside = main.parentElement?.previousElementSibling;
    if (aside?.tagName === 'ASIDE') hidden.push(aside);
    const skip = document.querySelector(`a[href="#${main.id}"]`);
    if (main.id && skip) hidden.push(skip);
    const changed = hidden.filter((el) => !el.hasAttribute('inert'));
    for (const el of changed) el.setAttribute('inert', '');
    return () => {
      for (const el of changed) el.removeAttribute('inert');
    };
  }, []);

  // ───── Bản vẽ, hoàn tác và làm lại ─────
  const history = useHistory<Doc>(() => ({ definition: init.definition, description: template.description ?? '', category: template.category }));
  const { get: getDoc, commit, undo, redo } = history;
  const doc = history.value;
  /** bản vẽ đúng như đã lưu: dùng để kiểm tra và để biết đã đổi hay chưa */
  const rawDef = doc.definition;
  /** bản vẽ để hiển thị: nút thiếu toạ độ được xếp tạm; lần sửa đầu tiên sẽ ghi các toạ độ này vào bản vẽ */
  const def = useMemo(() => ensureLayout(rawDef), [rawDef]);

  const change = useCallback<DesignerContextValue['change']>(
    (fn, opts) => {
      if (!editable) return;
      commit((current) => {
        const base = ensureLayout(current.definition);
        const next = fn(base);
        return next === base ? current : { ...current, definition: next };
      }, opts);
    },
    [commit, editable],
  );

  // ───── Lưu nháp ─────
  const [saved, setSaved] = useState(() => ({
    doc,
    at: init.mode !== 'view' ? init.savedAt : null,
    rev: init.mode !== 'view' ? init.rev : 0,
    draftVersion: init.mode !== 'view' ? init.draftVersion : null,
  }));
  const savedRef = useRef(saved);
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'error'>('idle');
  const [conflict, setConflict] = useState(false);
  const conflictRef = useRef(false);
  const inflight = useRef<Promise<boolean> | null>(null);
  const dirty = editable && doc !== saved.doc;

  const saveDraft = useApiMutation('templates.saveDraft', {
    toastError: false,
    // If-Match = rev của lần lưu gần nhất: người khác đã lưu trước thì máy chủ trả 412, không ghi đè âm thầm.
    callOptions: () => ({ ifMatch: savedRef.current.rev }),
  });
  const { mutateAsync: sendDraft } = saveDraft;

  const save = useCallback(async (): Promise<boolean> => {
    if (!editable) return true;
    if (inflight.current) await inflight.current;
    const current = getDoc();
    if (current === savedRef.current.doc) return true;
    if (conflictRef.current) return false;
    setSaveState('saving');
    const run = (async () => {
      try {
        const name = current.definition.name.trim().slice(0, 200);
        const description = current.description.trim().slice(0, 2000);
        const res = await sendDraft({
          params: { id: templateRef.current.id },
          body: { ...(name ? { name } : {}), description: description || null, category: current.category, definition: current.definition },
        });
        const next = {
          doc: current,
          at: res.updatedAt,
          rev: res.rev,
          draftVersion: savedRef.current.draftVersion ?? (templateRef.current.latestPublishedVersion ?? 0) + 1,
        };
        savedRef.current = next;
        setSaved(next);
        setSaveState('idle');
        return true;
      } catch (err) {
        if (isApiError(err, 'precondition_failed')) {
          conflictRef.current = true;
          setConflict(true);
        }
        setSaveState('error');
        return false;
      } finally {
        inflight.current = null;
      }
    })();
    inflight.current = run;
    return run;
  }, [editable, getDoc, sendDraft]);

  useEffect(() => {
    if (!editable) return;
    const timer = setInterval(() => {
      if (getDoc() !== savedRef.current.doc && !inflight.current && !conflictRef.current) void save();
    }, AUTOSAVE_MS);
    // Chuyển sang thẻ khác hoặc sắp đóng thẻ: lưu ngay, không chờ tới nhịp tự lưu.
    const onHide = () => {
      if (document.visibilityState === 'hidden') void save();
    };
    document.addEventListener('visibilitychange', onHide);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onHide);
    };
  }, [editable, getDoc, save]);

  // Người khác vừa lưu nháp (SSE làm mới `templates.get`): rev trên máy chủ đã vượt rev của màn hình này.
  const remoteRev = template.draft?.rev;
  const remoteAhead = checks && remoteRev !== undefined && remoteRev > saved.rev && saveState !== 'saving';
  useEffect(() => {
    if (!remoteAhead || conflictRef.current) return;
    if (getDoc() === savedRef.current.doc) {
      // Chưa sửa gì ở đây: lặng lẽ nhận bản mới.
      onReload();
    } else {
      conflictRef.current = true;
      setConflict(true);
    }
  }, [getDoc, onReload, remoteAhead]);

  // Rời trang khi còn thay đổi chưa lưu: lưu trước rồi mới đi. Lưu không được thì hỏi lại.
  const shouldBlockFn = useCallback(async () => {
    if (!editable || getDoc() === savedRef.current.doc) return false;
    if (conflictRef.current) return true;
    return !(await save());
  }, [editable, getDoc, save]);
  const blocker = useBlocker({ shouldBlockFn, enableBeforeUnload: () => editable && getDoc() !== savedRef.current.doc, withResolver: true });

  // ───── Kiểm tra trực tiếp ─────
  const [localIssues, setLocalIssues] = useState<Issues>(() => (checks ? runValidate(init.definition) : NO_ISSUES));
  const [serverIssues, setServerIssues] = useState<{ def: DraftDefinition; issues: Issues } | null>(null);
  const [issuesOpen, setIssuesOpen] = useState(false);
  const [checking, setChecking] = useState(false);
  useEffect(() => {
    if (!checks) return;
    const timer = setTimeout(() => setLocalIssues(runValidate(rawDef)), VALIDATE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [rawDef, checks]);

  const blank = isBlank(def);
  const rawIssues = serverIssues && serverIssues.def === rawDef ? serverIssues.issues : localIssues;
  const issues = checks && !blank ? rawIssues : NO_ISSUES;
  const issueIndex = useMemo(() => indexIssues(forNodes(issues, def)), [def, issues]);
  const nodeIssue = useCallback((id: string) => issueIndex.byNode.get(id), [issueIndex]);
  const edgeIssue = useCallback((id: string) => issueIndex.byEdge.get(id), [issueIndex]);

  // ───── Đang chọn gì ─────
  const [rawSelection, setSelection] = useState<Selection>(NO_SELECTION);
  const selection = useMemo<Selection>(() => {
    const nodes = rawSelection.nodes.filter((id) => def.nodes.some((n) => n.id === id));
    const edges = rawSelection.edges.filter((id) => def.edges.some((e) => e.id === id));
    return nodes.length === rawSelection.nodes.length && edges.length === rawSelection.edges.length ? rawSelection : { nodes, edges };
  }, [def.edges, def.nodes, rawSelection]);
  const [focusToken, setFocusToken] = useState(0);
  const [quickAdd, setQuickAdd] = useState<QuickAddRequest | null>(null);

  const sizeOf = useCallback(
    (id: string): Size | undefined => {
      const m = rf.getInternalNode(id)?.measured;
      return m?.width && m.height ? { width: m.width, height: m.height } : undefined;
    },
    [rf],
  );

  /**
   * Đưa bước vừa thêm vào khung nhìn nếu nó rơi ra ngoài. Ưu tiên hiện trọn cả sơ đồ (để các bước trước vẫn bấm được);
   * sơ đồ đã quá rộng thì chỉ đưa bước mới vào giữa, giữ nguyên mức thu phóng.
   */
  const reveal = useCallback(
    (next: DraftDefinition, position: XY, size: Size) => {
      requestAnimationFrame(() => {
        const rect = canvasRef.current?.getBoundingClientRect();
        if (!rect) return;
        const topLeft = rf.screenToFlowPosition({ x: rect.left + 16, y: rect.top + 60 });
        const bottomRight = rf.screenToFlowPosition({ x: rect.right - 64, y: rect.bottom - 110 });
        const inside = position.x >= topLeft.x && position.y >= topLeft.y && position.x + size.width <= bottomRight.x && position.y + size.height <= bottomRight.y;
        if (inside) return;
        const bounds = graphBounds(next, sizeOf);
        const view = bounds ? frameAll(rect, bounds) : null;
        if (view) void rf.setViewport(view, { duration: 200 });
        else void rf.setCenter(position.x + size.width / 2, position.y + size.height / 2, { zoom: rf.getZoom(), duration: 200 });
      });
    },
    [rf, sizeOf],
  );

  /**
   * Thêm một bước rồi chọn nó và mở thuộc tính (con trỏ vào ô tên).
   * `at` + 'center': thả từ cột trái, tâm nút nằm ở con trỏ. `at` + 'left': kéo đường nối ra khoảng trống,
   * cổng vào của nút nằm ở con trỏ. Không có `at`: đặt bên phải nút nguồn, hoặc giữa khung nhìn.
   */
  const addStep = useCallback(
    (kind: AddableKind, where: { at?: XY; align?: 'center' | 'left'; from?: { nodeId: string; handle: string | null } }) => {
      if (!editable) return;
      const current = ensureLayout(getDoc().definition);
      const size = estimateSize(createNode(current, kind));
      // Bước mới thường còn thiếu thông tin nên hiện thêm dải báo lỗi: chừa chỗ để không đè lên nút bên dưới.
      if (kind !== 'end') size.height += 48;
      let position: XY;
      if (where.at) {
        position = { x: where.align === 'left' ? where.at.x : where.at.x - size.width / 2, y: where.at.y - size.height / 2 };
      } else if (where.from) {
        position = spotAfter(current, where.from.nodeId, kind, sizeOf);
      } else {
        const rect = canvasRef.current?.getBoundingClientRect();
        const center = rect ? rf.screenToFlowPosition({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }) : { x: 0, y: 0 };
        position = freeSpot(current, { x: center.x - size.width / 2, y: center.y - size.height / 2 }, size, sizeOf);
      }
      const added = addNodeAt(current, kind, position, where.from);
      change(() => added.def);
      setSelection({ nodes: [added.nodeId], edges: [] });
      setFocusToken((n) => n + 1);
      reveal(added.def, positionOf(added.def, added.nodeId), size);
    },
    [change, editable, getDoc, reveal, rf, sizeOf],
  );

  const addAfter = useCallback((fromNodeId: string, handle: string | null, kind: AddableKind) => addStep(kind, { from: { nodeId: fromNodeId, handle } }), [addStep]);

  const onQuickPick = useCallback(
    (choice: QuickAddChoice) => {
      const request = quickAdd;
      setQuickAdd(null);
      if (!request) return;
      if ('connectTo' in choice) {
        const from = request.from;
        if (from) change((d) => addEdge(d, from.nodeId, choice.connectTo, from.handle).def);
        return;
      }
      addStep(choice.kind, { at: request.at, align: 'left', from: request.from });
    },
    [addStep, change, quickAdd],
  );

  const goTo = useCallback(
    (target: { nodeId?: string; edgeId?: string }) => {
      if (target.nodeId) {
        setSelection({ nodes: [target.nodeId], edges: [] });
        void rf.fitView({ nodes: [{ id: target.nodeId }], maxZoom: 1, minZoom: 0.6, padding: 0.6, duration: 250 });
      } else if (target.edgeId) {
        const edge = getDoc().definition.edges.find((e) => e.id === target.edgeId);
        setSelection({ nodes: [], edges: [target.edgeId] });
        if (edge) void rf.fitView({ nodes: [{ id: edge.from }, { id: edge.to }], maxZoom: 1, padding: 0.3, duration: 250 });
      }
    },
    [getDoc, rf],
  );

  /** Người dùng bàn phím nhảy từ khối nút sang bảng thuộc tính, khỏi phải Tab qua mọi bước và đường nối trên khung vẽ. */
  const focusPanel = useCallback(() => {
    const panel = panelRef.current;
    const field = panel?.querySelector<HTMLElement>('[data-autofocus], input:not([disabled]), textarea:not([disabled]), button[role="combobox"]:not([disabled])');
    (field ?? panel)?.focus();
  }, []);

  // ───── Phím tắt: hoàn tác, làm lại, lưu ─────
  useEffect(() => {
    if (!editable) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      const key = e.key.toLowerCase();
      if (key === 's') {
        e.preventDefault();
        void save();
        return;
      }
      // Trong ô nhập, để trình duyệt tự hoàn tác chữ đang gõ. Trong hộp thoại thì không đụng tới bản vẽ.
      if (isTyping(e.target) || (e.target instanceof Element && e.target.closest('[role="dialog"], [role="alertdialog"]'))) return;
      if (key === 'z') {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
      } else if (key === 'y') {
        e.preventDefault();
        redo();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [editable, redo, save, undo]);

  // ───── Thanh trên: kiểm tra, chạy thử, xuất bản ─────
  const [simulateOpen, setSimulateOpen] = useState(false);
  const [publishOpen, setPublishOpen] = useState(false);
  const [publishedVersion, setPublishedVersion] = useState<number | null>(null);
  const [lastPublished, setLastPublished] = useState(0);
  const [rejected, setRejected] = useState(false);
  const [diffOpen, setDiffOpen] = useState(false);
  const afterMenu = useAfterMenuClose();

  const validateRemote = useApiMutation('templates.validate', { toastError: false });
  const publish = useApiMutation('templates.publish', { toastError: false, invalidate: ['templates.list', 'templates.get', 'templates.version'] });
  const { mutateAsync: sendValidate } = validateRemote;
  const { mutateAsync: sendPublish } = publish;

  const announce = (result: Issues) => {
    if (result.errors.length > 0) toast.error(fmt(t.issues.checkedErrors, { n: result.errors.length }));
    else if (result.warnings.length > 0) toast.info(fmt(t.issues.checkedOkWarnings, { n: result.warnings.length }));
    else toast.success(t.issues.checkedOk, { duration: 3_000 });
  };

  /** "Kiểm tra": lưu nháp rồi nhờ máy chủ chạy validate() với lịch làm việc và đồng hồ thật; mất mạng thì dùng kết quả tại chỗ. */
  const check = async () => {
    setChecking(true);
    const local = runValidate(getDoc().definition);
    setLocalIssues(local);
    let result = local;
    if (!isBlank(getDoc().definition) && (await save())) {
      try {
        const remote = await sendValidate({ params: { id: template.id } });
        result = { errors: remote.errors.map(wording), warnings: remote.warnings.map(wording) };
        setServerIssues({ def: getDoc().definition, issues: result });
      } catch {
        // giữ kết quả kiểm tại chỗ
      }
    }
    setChecking(false);
    setIssuesOpen(result.errors.length + result.warnings.length > 0);
    if (isBlank(getDoc().definition)) toast.info(t.issues.emptyDraft);
    else announce(result);
  };

  // Phiên bản xuất bản mới nhất mà màn hình này biết: của máy chủ, hoặc bản vừa xuất bản ở đây (dữ liệu máy chủ về chậm một nhịp).
  const latestPublished = Math.max(template.latestPublishedVersion ?? 0, lastPublished) || null;
  const publishVersion = saved.draftVersion ?? (latestPublished ?? 0) + 1;
  const blocked = conflict || remoteAhead;
  let publishBlock: string | null = null;
  if (blocked) publishBlock = t.topbar.publishBlockedConflict;
  else if (blank) publishBlock = t.topbar.publishBlockedEmpty;
  else if (issues.errors.length > 0) publishBlock = fmt(t.topbar.publishBlockedErrors, { n: issues.errors.length });
  else if (saved.draftVersion === null && !dirty) publishBlock = fmt(t.topbar.publishBlockedNoChange, { n: latestPublished ?? 0 });
  const simulateBlock = checks && (blank || issues.errors.length > 0) ? t.topbar.simulateBlockedErrors : null;

  const doPublish = async () => {
    // Người chỉ xuất bản không sửa gì nên không có gì để lưu; người sửa thì lưu nháp trước rồi mới xuất bản.
    if (editable && !(await save())) {
      setPublishOpen(false);
      return;
    }
    try {
      const res = await sendPublish({ params: { id: template.id } });
      const next = { ...savedRef.current, draftVersion: null };
      savedRef.current = next;
      setSaved(next);
      setPublishOpen(false);
      setLastPublished(res.version);
      setPublishedVersion(res.version);
    } catch (err) {
      setPublishOpen(false);
      if (isApiError(err, 'template_invalid')) {
        // Máy chủ chỉ trả mã lỗi và nút; câu giải thích lấy từ kết quả kiểm tại chỗ, thiếu thì dùng câu theo mã.
        const current = getDoc().definition;
        const local = runValidate(current);
        const byCode: Record<string, string> = t.issues.byCode;
        const errors: DefinitionIssue[] = (err.extra.errors ?? []).map((item) => {
          const node = findNode(current, item.path);
          const edge = node ? undefined : current.edges.find((e) => e.id === item.path);
          const known = local.errors.find((i) => i.code === item.code && (i.nodeId ?? i.edgeId ?? 'definition') === item.path);
          return { code: item.code, message: known?.message ?? byCode[item.code] ?? t.issues.byCode.other, nodeId: node?.id, edgeId: edge?.id };
        });
        setServerIssues({ def: current, issues: { errors, warnings: local.warnings } });
        setIssuesOpen(true);
        setRejected(true);
      } else if (isApiError(err, 'state_conflict')) {
        toast.error(t.publish.conflict);
        onReload();
      } else {
        toast.error(errorMessage(err));
      }
    }
  };

  const explainBlock = (reason: string) => {
    toast.info(reason);
    if (issues.errors.length > 0) setIssuesOpen(true);
  };

  const startHref = `/luot-chay/moi?templateId=${encodeURIComponent(template.id)}`;
  const goStart = (e: ReactMouseEvent) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    router.history.push(startHref);
  };

  const published = template.versions.filter((v) => v.status === 'published').sort((a, b) => b.version - a.version);
  const versionOptions = [
    ...(canSeeDraft ? [{ value: 'working', label: saved.draftVersion !== null || template.hasDraft ? t.topbar.draftOption : t.topbar.workingOption }] : []),
    ...published.map((v) => ({ value: String(v.version), label: fmt(t.topbar.versionOption, { n: v.version, ngày: v.publishedAt ? formatDate(v.publishedAt) : '' }) })),
  ];
  const viewing = init.mode === 'view' ? String(init.version) : 'working';
  const switchVersion = (value: string | null) => {
    if (value === null || value === viewing) return;
    void navigate({ to: '/quy-trinh/$templateId', params: { templateId: template.id }, search: value === 'working' ? {} : { phienBan: Number(value) } });
  };

  let saveLabel: string;
  if (!editable) saveLabel = reviewing ? t.save.review : t.save.readOnly;
  else if (saveState === 'saving') saveLabel = t.save.saving;
  else if (dirty) saveLabel = saveState === 'error' && !conflict ? t.save.failed : t.save.unsaved;
  else if (saved.draftVersion === null && latestPublished !== null) saveLabel = fmt(t.save.published, { n: latestPublished });
  else if (saved.at) saveLabel = fmt(t.save.saved, { giờ: formatTime(saved.at) });
  else saveLabel = t.save.savedNothing;

  const context = useMemo<DesignerContextValue>(
    () => ({ def, readOnly: !editable, lookups, selection, select: setSelection, change, nodeIssue, edgeIssue, sizeOf, openQuickAdd: setQuickAdd, addAfter }),
    [addAfter, change, def, edgeIssue, editable, lookups, nodeIssue, selection, sizeOf],
  );

  const name = def.name.trim() || template.name || t.untitled;
  const contributeIds = useMemo(() => new Set(def.nodes.filter(isContribute).map((n) => n.id)), [def.nodes]);

  return (
    <DesignerProvider value={context}>
      {/*
        Trình thiết kế phủ toàn cửa sổ, che thanh bên và thanh trên của khung: khung vẽ cần mọi điểm ảnh
        (sơ đồ "Đón đoàn" rộng năm cột). Nút "Quy trình" ở góc trái đưa về danh sách.
      */}
      <div ref={rootRef} className="fixed inset-0 z-[35] flex flex-col bg-canvas" data-testid="designer" data-mode={init.mode}>
        {/* Thanh trên */}
        <header className="flex h-[60px] shrink-0 items-center gap-3 border-b border-hairline bg-surface px-3">
          <Link to="/quy-trinh" className={cn(buttonVariants({ variant: 'ghost', size: 'sm' }), 'px-2')} data-testid="back-to-list">
            <ArrowLeft aria-hidden="true" />
            <span className="max-xl:sr-only">{vi.admin.designer.list.title}</span>
          </Link>
          <span aria-hidden="true" className="h-7 w-px shrink-0 bg-hairline" />
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-lg leading-tight font-semibold" title={name} data-testid="designer-name">
              {name}
            </h1>
            <p role="status" aria-live="polite" className={cn('truncate text-sm', dirty || saveState === 'error' ? 'font-medium text-ink' : 'text-ink-sub')} data-testid="save-status" data-dirty={dirty}>
              {saveLabel}
            </p>
          </div>
          {template.archivedAt ? <Badge tone="muted">{vi.admin.designer.list.archived}</Badge> : null}
          {versionOptions.length > 1 || init.mode === 'view' ? (
            <Select aria-label={t.topbar.viewing} value={viewing} options={versionOptions} onValueChange={switchVersion} className="h-8 w-auto max-w-[17rem] shrink-0 gap-1.5 px-2.5 text-sm" />
          ) : null}

          <div className="flex shrink-0 items-center gap-2">
            {editable ? (
              <>
                <Button size="sm" onClick={() => void save().then((ok) => ok && toast.success(t.save.savedToast))} disabled={!dirty || blocked} loading={saveState === 'saving'} data-testid="save-draft">
                  <Save aria-hidden="true" />
                  {t.topbar.saveDraft}
                </Button>
                <Button size="sm" onClick={() => void check()} loading={checking} data-testid="validate">
                  <ShieldCheck aria-hidden="true" />
                  {t.topbar.validate}
                </Button>
              </>
            ) : null}
            {canSimulate ? (
              <Tooltip content={simulateBlock ?? t.simulate.title}>
                <Button size="sm" aria-disabled={simulateBlock ? true : undefined} onClick={() => (simulateBlock ? explainBlock(simulateBlock) : setSimulateOpen(true))} data-testid="simulate">
                  <FlaskConical aria-hidden="true" />
                  {t.topbar.simulate}
                </Button>
              </Tooltip>
            ) : null}
            {checks && canPublish ? (
              <Tooltip content={publishBlock ?? fmt(t.publish.confirm, { n: publishVersion })}>
                <Button
                  size="sm"
                  variant="primary"
                  aria-disabled={publishBlock ? true : undefined}
                  onClick={() => (publishBlock ? explainBlock(publishBlock) : setPublishOpen(true))}
                  data-testid="publish"
                  data-blocked={publishBlock ? 'true' : 'false'}
                >
                  <Rocket aria-hidden="true" />
                  {t.topbar.publish}
                </Button>
              </Tooltip>
            ) : editable ? (
              <span className="text-sm text-ink-sub" data-testid="no-publish">
                {t.topbar.cannotPublish}
              </span>
            ) : canStart ? (
              <a href={startHref} onClick={goStart} className={cn(buttonVariants({ variant: 'primary', size: 'sm' }))} data-testid="start-run">
                <Play aria-hidden="true" />
                {t.topbar.start}
              </a>
            ) : null}
            {canSeeDraft && template.versions.length > 1 ? (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon-sm" aria-label={t.topbar.more} data-testid="more">
                    <Ellipsis aria-hidden="true" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent onCloseAutoFocus={afterMenu.flush}>
                  <DropdownMenuItem onSelect={() => afterMenu.run(() => setDiffOpen(true))} data-testid="compare">
                    <GitCompareArrows aria-hidden="true" />
                    {t.topbar.compare}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            ) : null}
          </div>
        </header>

        {/* Lời báo dưới thanh trên */}
        {blocked ? (
          <Callout
            tone="error"
            title={t.conflict.title}
            className="mx-3 mt-2"
            action={
              <Button size="sm" variant="primary" onClick={onReload} data-testid="conflict-reload">
                {t.conflict.reload}
              </Button>
            }
          >
            {t.conflict.body}
          </Callout>
        ) : null}
        {editable && saveState === 'error' && !blocked ? (
          <Callout tone="error" title={t.save.failed} className="mx-3 mt-2">
            {t.save.failedBody}
          </Callout>
        ) : null}
        {rejected ? (
          <Callout
            tone="error"
            title={t.publish.rejectedTitle}
            className="mx-3 mt-2"
            action={
              <Button size="sm" onClick={() => setRejected(false)}>
                {vi.admin.shell.ui.close}
              </Button>
            }
          >
            {t.publish.rejectedBody}
          </Callout>
        ) : null}
        {reviewing ? (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-hairline bg-surface-alt px-4 py-2 text-sm" data-testid="review-note">
            <span>{t.readOnly.reviewNote}</span>
          </div>
        ) : null}
        {init.mode === 'view' ? (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-hairline bg-surface-alt px-4 py-2 text-sm" data-testid="readonly-note">
            <span>
              {canSeeDraft ? `${fmt(t.readOnly.versionTitle, { n: init.version })}. ${t.readOnly.versionBody}` : fmt(t.readOnly.readerNote, { n: init.version })}
              {template.archivedAt ? ` ${t.readOnly.archivedNote}` : ''}
            </span>
            {canSeeDraft ? (
              <Button variant="link" className="text-sm" onClick={() => switchVersion('working')}>
                {t.readOnly.toDraft}
              </Button>
            ) : null}
          </div>
        ) : null}

        {/* Ba cột */}
        <div className="flex min-h-0 flex-1">
          {editable ? <Palette onAdd={(kind) => addStep(kind, {})} /> : null}
          <div className="relative flex min-w-0 flex-1 flex-col">
            {/* Chỉ hiện khi nhận focus bàn phím; Tab từ khối nút tới đây trước khi vào khung vẽ. */}
            <button
              type="button"
              onClick={focusPanel}
              className="sr-only focus-visible:not-sr-only focus-visible:absolute focus-visible:top-3 focus-visible:left-3 focus-visible:z-30 focus-visible:rounded-lg focus-visible:bg-primary focus-visible:px-3 focus-visible:py-2 focus-visible:text-base focus-visible:font-semibold focus-visible:text-on-primary"
              data-testid="skip-to-panel"
            >
              {t.skipToPanel}
            </button>
            <div ref={canvasRef} role="region" aria-label={t.regionCanvas} className="min-h-0 flex-1">
              <Canvas canUndo={history.canUndo} canRedo={history.canRedo} onUndo={undo} onRedo={redo} onDropKind={(kind, at) => addStep(kind, { at, align: 'center' })}>
                <QuickAddMenu request={quickAdd} onClose={() => setQuickAdd(null)} onPick={onQuickPick} />
              </Canvas>
            </div>
            {checks ? <IssuesBar def={def} issues={issues} blank={blank} open={issuesOpen} onOpenChange={setIssuesOpen} onGoTo={goTo} /> : null}
          </div>
          <aside ref={panelRef} tabIndex={-1} aria-label={t.regionPanel} className="w-[336px] shrink-0 border-l border-hairline bg-surface outline-none xl:w-[352px]">
            <PropertiesPanel
              description={doc.description}
              onDescriptionChange={(description) => editable && commit((current) => ({ ...current, description }), { coalesce: 'process:description' })}
              category={doc.category}
              onCategoryChange={(category) => editable && commit((current) => (current.category === category ? current : { ...current, category }))}
              focusToken={focusToken}
            />
          </aside>
        </div>
      </div>

      {/* Hộp thoại */}
      {canSimulate ? (
        <SimulateDialog
          open={simulateOpen}
          onOpenChange={setSimulateOpen}
          templateId={template.id}
          inputs={def.inputs}
          targetField={def.targetField}
          target={init.mode === 'view' ? { version: init.version } : { draft: true }}
          beforeRun={editable ? save : undefined}
          contributeIds={contributeIds}
        />
      ) : null}

      <ConfirmDialog
        open={publishOpen}
        onOpenChange={setPublishOpen}
        title={fmt(t.publish.title, { n: publishVersion })}
        description={t.publish.body}
        confirmLabel={fmt(t.publish.confirm, { n: publishVersion })}
        loading={publish.isPending || saveState === 'saving'}
        onConfirm={() => void doPublish()}
      >
        <div className="flex flex-col gap-2">
          <Callout tone="info">{t.publish.keepOld}</Callout>
          {issues.warnings.length > 0 ? <Callout tone="warn">{fmt(t.publish.warnings, { n: issues.warnings.length })}</Callout> : null}
        </div>
      </ConfirmDialog>

      <Dialog open={publishedVersion !== null} onOpenChange={(open) => !open && setPublishedVersion(null)}>
        <DialogContent size="sm" data-testid="published-dialog">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <CircleCheck aria-hidden="true" className="size-5 shrink-0 text-primary" />
              {fmt(t.publish.doneTitle, { n: publishedVersion ?? 0 })}
            </DialogTitle>
            <DialogDescription>{mayStart ? t.publish.doneBody : t.publish.doneBodyNoStart}</DialogDescription>
          </DialogHeader>
          <DialogBody>
            <p className="text-sm text-ink-sub">{t.publish.keepOld}</p>
          </DialogBody>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant={mayStart ? 'secondary' : 'primary'}>{mayStart ? t.publish.continue : vi.admin.shell.ui.close}</Button>
            </DialogClose>
            {mayStart ? (
              <a href={startHref} onClick={goStart} className={cn(buttonVariants({ variant: 'primary' }))} data-testid="published-start">
                <Play aria-hidden="true" />
                {t.publish.start}
              </a>
            ) : null}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {canSeeDraft ? <DiffDialog open={diffOpen} onOpenChange={setDiffOpen} template={template} current={def} /> : null}

      <ConfirmDialog
        open={blocker.status === 'blocked'}
        onOpenChange={(open) => !open && blocker.reset?.()}
        title={t.leave.title}
        description={t.leave.body}
        confirmLabel={t.leave.leave}
        dismissLabel={t.leave.stay}
        tone="danger"
        onConfirm={() => blocker.proceed?.()}
      />
    </DesignerProvider>
  );
}
