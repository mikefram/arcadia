import type { Expr, Operand } from '@mihato/domain';

/**
 * Tính biểu thức điều kiện của nút rẽ nhánh (SPEC 4.2). Biểu thức là cây JSON an toàn;
 * ở đây chỉ có phép so sánh và and/or/not trên giá trị nguyên thuỷ. Tuyệt đối không eval.
 */
export type ExprScope = {
  inputs: Record<string, unknown>;
  /** kết quả lần thử mới nhất của một nút, hoặc null khi nút chưa có kết quả */
  stepResult: (nodeId: string) => Record<string, unknown> | null;
};

type Primitive = string | number | boolean;

function own(obj: Record<string, unknown> | null, key: string): unknown {
  if (obj === null || !Object.prototype.hasOwnProperty.call(obj, key)) return undefined;
  return obj[key];
}

function primitive(v: unknown): Primitive | undefined {
  return typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' ? v : undefined;
}

/** Tách tham chiếu: 'inputs.<key>' hoặc 'steps.<nodeId>.result.<key>'. Trả null khi sai dạng. */
export function parseRef(ref: string): { kind: 'input'; key: string } | { kind: 'step'; nodeId: string; key: string } | null {
  const parts = ref.split('.');
  if (parts.length === 2 && parts[0] === 'inputs' && parts[1]) return { kind: 'input', key: parts[1] };
  if (parts.length === 4 && parts[0] === 'steps' && parts[2] === 'result' && parts[1] && parts[3]) {
    return { kind: 'step', nodeId: parts[1], key: parts[3] };
  }
  return null;
}

function operandValue(op: Operand, scope: ExprScope): Primitive | undefined {
  if ('value' in op) return op.value;
  const ref = parseRef(op.ref);
  if (ref === null) return undefined;
  if (ref.kind === 'input') return primitive(own(scope.inputs, ref.key));
  return primitive(own(scope.stepResult(ref.nodeId), ref.key));
}

/** Đưa hai vế về cùng kiểu khi một vế là số và vế kia là chuỗi số (biểu mẫu có thể gửi số dạng chuỗi). */
function align(a: Primitive, b: Primitive): [Primitive, Primitive] | null {
  if (typeof a === typeof b) return [a, b];
  const num = (v: Primitive): number | null => {
    if (typeof v === 'number') return v;
    if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
    return null;
  };
  if (typeof a === 'boolean' || typeof b === 'boolean') return null;
  const na = num(a);
  const nb = num(b);
  return na !== null && nb !== null ? [na, nb] : null;
}

function compare(op: 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte', left: Primitive | undefined, right: Primitive | undefined): boolean {
  const pair = left === undefined || right === undefined ? null : align(left, right);
  // Thiếu giá trị hoặc khác kiểu: chỉ 'ne' là đúng.
  if (pair === null) return op === 'ne';
  const [a, b] = pair;
  switch (op) {
    case 'eq':
      return a === b;
    case 'ne':
      return a !== b;
    case 'gt':
      return typeof a !== 'boolean' && a > b;
    case 'gte':
      return typeof a !== 'boolean' && a >= b;
    case 'lt':
      return typeof a !== 'boolean' && a < b;
    case 'lte':
      return typeof a !== 'boolean' && a <= b;
  }
}

export function evalExpr(expr: Expr, scope: ExprScope): boolean {
  switch (expr.op) {
    case 'and':
      return expr.args.every((a) => evalExpr(a, scope));
    case 'or':
      return expr.args.some((a) => evalExpr(a, scope));
    case 'not':
      return !evalExpr(expr.arg, scope);
    default:
      return compare(expr.op, operandValue(expr.left, scope), operandValue(expr.right, scope));
  }
}

/** Mọi tham chiếu trong một biểu thức (để validate() kiểm và simulate() biết có phụ thuộc kết quả việc trước không). */
export function exprRefs(expr: Expr): string[] {
  switch (expr.op) {
    case 'and':
    case 'or':
      return expr.args.flatMap(exprRefs);
    case 'not':
      return exprRefs(expr.arg);
    default: {
      const refs: string[] = [];
      if ('ref' in expr.left) refs.push(expr.left.ref);
      if ('ref' in expr.right) refs.push(expr.right.ref);
      return refs;
    }
  }
}
