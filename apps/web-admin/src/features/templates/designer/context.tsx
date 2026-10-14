import { createContext, use, useCallback, useMemo } from 'react';
import type { DefinitionIssue, DraftDefinition } from '@mihato/domain';
import type { PersonOption } from '@/components/person-picker';
import { useApiQuery } from '@/lib/query';
import type { AddableKind, Lookups, Size } from './model';

/** Đang chọn gì trên khung vẽ. Bảng thuộc tính hiện theo đúng một nút, hoặc đúng một đường nối. */
export type Selection = { nodes: readonly string[]; edges: readonly string[] };
export const NO_SELECTION: Selection = { nodes: [], edges: [] };

export type IssueLevel = 'error' | 'warning';
export type ElementIssue = { level: IssueLevel; messages: string[] };
export type Issues = { errors: DefinitionIssue[]; warnings: DefinitionIssue[] };

/** Yêu cầu mở trình đơn "bước kế tiếp" tại một điểm trên màn hình. */
export type QuickAddRequest = {
  /** toạ độ màn hình để đặt trình đơn */
  screen: { x: number; y: number };
  /** nút nguồn và cổng ra: bước mới sẽ được nối từ đây */
  from?: { nodeId: string; handle: string | null };
  /** vị trí trên khung vẽ (toạ độ sơ đồ) nơi đặt bước mới; bỏ trống thì đặt bên phải nút nguồn */
  at?: { x: number; y: number };
};

export type DesignerContextValue = {
  def: DraftDefinition;
  readOnly: boolean;
  lookups: Lookups & { remember: (person: PersonOption) => void };
  selection: Selection;
  select: (selection: Selection) => void;
  /** ghi một thay đổi vào bản vẽ; `coalesce` gộp các lần gõ liên tiếp thành một bước hoàn tác */
  change: (fn: (def: DraftDefinition) => DraftDefinition, opts?: { coalesce?: string }) => void;
  nodeIssue: (nodeId: string) => ElementIssue | undefined;
  edgeIssue: (edgeId: string) => ElementIssue | undefined;
  /** kích thước React Flow đã đo của một nút; chưa đo thì undefined */
  sizeOf: (nodeId: string) => Size | undefined;
  openQuickAdd: (request: QuickAddRequest) => void;
  /** thêm một bước nối từ nút cho trước (bảng thuộc tính, bàn phím) rồi chọn bước mới */
  addAfter: (fromNodeId: string, handle: string | null, kind: AddableKind) => void;
};

const DesignerContext = createContext<DesignerContextValue | null>(null);
export const DesignerProvider = DesignerContext.Provider;

export function useDesigner(): DesignerContextValue {
  const value = use(DesignerContext);
  if (!value) throw new Error('useDesigner() chỉ dùng bên trong trình thiết kế quy trình');
  return value;
}

/** Gom lỗi và cảnh báo theo nút và theo đường nối; lỗi thắng cảnh báo. */
export function indexIssues(issues: Issues): { byNode: Map<string, ElementIssue>; byEdge: Map<string, ElementIssue> } {
  const byNode = new Map<string, ElementIssue>();
  const byEdge = new Map<string, ElementIssue>();
  const put = (map: Map<string, ElementIssue>, id: string, level: IssueLevel, message: string) => {
    const current = map.get(id);
    if (!current) map.set(id, { level, messages: [message] });
    else if (current.level === level) current.messages.push(message);
    else if (level === 'error') map.set(id, { level, messages: [message] });
  };
  for (const [level, list] of [
    ['error', issues.errors],
    ['warning', issues.warnings],
  ] as const) {
    for (const issue of list) {
      if (issue.nodeId) put(byNode, issue.nodeId, level, issue.message);
      // Lỗi có cả nút và đường nối (ví dụ vòng lặp) thì tô cả hai.
      if (issue.edgeId) put(byEdge, issue.edgeId, level, issue.message);
    }
  }
  return { byNode, byEdge };
}

/** Những người vừa được chọn trong phiên này: có tên ngay cả khi danh bạ tải về chưa chứa họ. */
const pickedPeople = new Map<string, PersonOption>();

/**
 * Tra tên người và đơn vị từ mã lưu trong bản vẽ. `people.search` với ô tìm trống trả tối đa 100 người đầu;
 * tổ chức lớn hơn thì người ngoài danh sách hiện là "Một người đã chọn" cho tới khi được chọn lại.
 */
export function useLookups(): DesignerContextValue['lookups'] {
  const people = useApiQuery('people.search', { query: { q: '', limit: 100 } }, { staleTime: 5 * 60_000 });
  const units = useApiQuery('units.list', {}, { staleTime: 5 * 60_000 });

  const personById = useMemo(() => new Map((people.data?.items ?? []).map((p) => [p.id, p])), [people.data]);
  const unitById = useMemo(() => new Map((units.data?.items ?? []).map((u) => [u.id, u.name])), [units.data]);

  const person = useCallback((id: string) => personById.get(id) ?? pickedPeople.get(id), [personById]);
  const unitName = useCallback((id: string) => unitById.get(id), [unitById]);
  const remember = useCallback((p: PersonOption) => {
    pickedPeople.set(p.id, p);
  }, []);

  return useMemo(() => ({ person, unitName, remember }), [person, unitName, remember]);
}
