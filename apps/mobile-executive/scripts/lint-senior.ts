/**
 * Lint tự viết của app Chủ tịch (SPEC 7.8). Chạy: `pnpm --filter @mihato/mobile-executive lint:senior`.
 * Quét mã nguồn trong `app/`, `components/`, `src/` và thoát mã khác 0 khi có điểm sai, để CI đỏ.
 *
 * Luật:
 *  1. `font-size`     Cấm `fontSize` dưới 18: số viết trực tiếp, phép tính làm nhỏ chữ, hoặc lấy thẳng token của hồ sơ
 *                     `standard` thay vì đi qua `useSenior()`. Kèm kiểm token: mọi cỡ chữ của hồ sơ `senior`, ở mọi
 *                     mức Lớn, Rất lớn, Cực lớn, phải từ 18 trở lên.
 *  2. `a11y`          Cấm `Pressable`, `TouchableOpacity`… thiếu `accessibilityLabel` hoặc `accessibilityRole`.
 *  3. `no-toast`      Cấm thư viện toast, snackbar và `ToastAndroid`: kết quả phải nằm yên tới khi bấm Đã rõ.
 *  4. `no-gesture`    Cấm bộ nhận cử chỉ (pan, long press, pinch, swipe, kéo để làm mới). Chỉ cuộn được dùng vuốt.
 *  5. `no-floating`   Cấm `Modal` và `Alert`: màn hình xác nhận là màn hình đầy đủ, không phải cửa sổ nổi (SPEC 7.6).
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { fontScale, profiles } from '@mihato/ui-tokens';
import ts from 'typescript';

export type Rule = 'font-size' | 'a11y' | 'no-toast' | 'no-gesture' | 'no-floating';
export type Finding = { file: string; line: number; column: number; rule: Rule; message: string };

/** Cỡ chữ nhỏ nhất được phép ở app Chủ tịch (SPEC 7.2 điều 3: không có chữ dưới 18sp). */
export const MIN_FONT_SIZE = 18;

const TOUCHABLES = new Set(['Pressable', 'TouchableOpacity', 'TouchableHighlight', 'TouchableWithoutFeedback', 'TouchableNativeFeedback']);
const TOAST_MODULE_RE = /toast|snackbar|flash-message|react-native-notifier|burnt/i;
const GESTURE_HANDLER_ALLOWED = new Set(['ScrollView', 'FlatList', 'GestureHandlerRootView']);
const FORBIDDEN_RN_IMPORTS: Record<string, { rule: Rule; message: string }> = {
  ToastAndroid: { rule: 'no-toast', message: 'Không dùng ToastAndroid: kết quả hiện trong màn hình tới khi bấm Đã rõ (dùng ResultPanel).' },
  PanResponder: { rule: 'no-gesture', message: 'Không dùng PanResponder: mọi thao tác là một chạm, chỉ cuộn mới dùng vuốt.' },
  Modal: { rule: 'no-floating', message: 'Không dùng Modal: màn hình xác nhận là màn hình đầy đủ, không phải cửa sổ nổi.' },
  Alert: { rule: 'no-floating', message: 'Không dùng Alert: báo tin bằng Notice hoặc ResultPanel ngay trong màn hình.' },
  RefreshControl: { rule: 'no-gesture', message: 'Không dùng kéo để làm mới: dùng nút chữ "Tải lại".' },
};
const GESTURE_PROP_RE = /^(onLongPress|delayLongPress|onSwipe.*|onPanResponder.*|onResponderMove|onTouchMove|onMoveShouldSetResponder(Capture)?|onDoubleTap|onPinch.*|onGestureEvent|onHandlerStateChange|pagingEnabled|refreshControl|onRefresh)$/;

function propName(name: ts.PropertyName | ts.JsxAttributeName): string | null {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text;
  return null;
}

/** Biểu thức có làm chữ nhỏ đi không: nhân với số dưới 1, chia, hoặc trừ. */
function shrinks(node: ts.Expression): boolean {
  let found = false;
  const visit = (n: ts.Node) => {
    if (ts.isBinaryExpression(n)) {
      const op = n.operatorToken.kind;
      if (op === ts.SyntaxKind.MinusToken || op === ts.SyntaxKind.SlashToken) found = true;
      if (op === ts.SyntaxKind.AsteriskToken) {
        for (const side of [n.left, n.right]) if (ts.isNumericLiteral(side) && Number(side.text) < 1) found = true;
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return found;
}

function checkFontSize(value: ts.Expression, report: (node: ts.Node, rule: Rule, message: string) => void): void {
  let expr = value;
  while (ts.isParenthesizedExpression(expr) || ts.isAsExpression(expr)) expr = expr.expression;
  if (ts.isNumericLiteral(expr)) {
    if (Number(expr.text) < MIN_FONT_SIZE) report(expr, 'font-size', `fontSize ${expr.text} nhỏ hơn ${MIN_FONT_SIZE}. Dùng cỡ chữ từ useSenior() hoặc SeniorText.`);
    return;
  }
  if (ts.isPrefixUnaryExpression(expr)) {
    report(expr, 'font-size', 'fontSize phải là số dương từ 18 trở lên.');
    return;
  }
  const text = expr.getText();
  if (/profiles\s*\.\s*standard\b|profiles\s*\[\s*['"]standard['"]\s*\]/.test(text)) {
    report(expr, 'font-size', 'Không lấy thẳng cỡ chữ của hồ sơ standard (dưới 18). Dùng cỡ chữ từ useSenior() để theo hồ sơ đang chọn.');
  }
  if (shrinks(expr)) report(expr, 'font-size', 'Không làm chữ nhỏ đi bằng phép tính (nhân với số dưới 1, chia, trừ).');
}

/** Kiểm một tệp nguồn. Hàm thuần: nhận tên và nội dung tệp, trả danh sách điểm sai. */
export function lintSource(file: string, text: string): Finding[] {
  const findings: Finding[] = [];
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const report = (node: ts.Node, rule: Rule, message: string) => {
    const { line, character } = source.getLineAndCharacterOfPosition(node.getStart(source));
    findings.push({ file, line: line + 1, column: character + 1, rule, message });
  };

  const visit = (node: ts.Node) => {
    // ── nhập thư viện ──
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const module = node.moduleSpecifier.text;
      const named = node.importClause?.namedBindings && ts.isNamedImports(node.importClause.namedBindings) ? node.importClause.namedBindings.elements : [];
      if (TOAST_MODULE_RE.test(module)) report(node, 'no-toast', `Không dùng thư viện toast hoặc snackbar ("${module}"): không có gì tự biến mất.`);
      if (module === 'react-native') {
        for (const el of named) {
          const name = (el.propertyName ?? el.name).text;
          const hit = FORBIDDEN_RN_IMPORTS[name];
          if (hit) report(el, hit.rule, hit.message);
        }
      }
      if (module === 'react-native-gesture-handler' || module.startsWith('react-native-gesture-handler/')) {
        if (named.length === 0) report(node, 'no-gesture', 'Không nhập cả thư viện cử chỉ: chỉ ScrollView, FlatList và GestureHandlerRootView được dùng.');
        for (const el of named) {
          const name = (el.propertyName ?? el.name).text;
          if (!GESTURE_HANDLER_ALLOWED.has(name)) report(el, 'no-gesture', `Không dùng bộ nhận cử chỉ "${name}": mọi thao tác là một chạm, chỉ cuộn mới dùng vuốt.`);
        }
      }
    }

    // ── fontSize trong đối tượng kiểu ──
    if (ts.isPropertyAssignment(node) && propName(node.name) === 'fontSize') checkFontSize(node.initializer, report);

    // ── thẻ JSX ──
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const tag = node.tagName.getText(source);
      const attrs = new Map<string, ts.JsxAttribute>();
      for (const attr of node.attributes.properties) {
        if (!ts.isJsxAttribute(attr)) continue;
        const name = propName(attr.name);
        if (name) attrs.set(name, attr);
      }
      if (TOUCHABLES.has(tag.split('.').pop() ?? tag)) {
        // Thuộc tính trải ({...props}) không được tính: nhãn và vai trò phải viết rõ ngay tại thẻ.
        if (!attrs.has('accessibilityLabel')) report(node, 'a11y', `<${tag}> thiếu accessibilityLabel: mọi nút phải có nhãn đọc được cho VoiceOver và TalkBack.`);
        if (!attrs.has('accessibilityRole')) report(node, 'a11y', `<${tag}> thiếu accessibilityRole.`);
      }
      for (const [name, attr] of attrs) {
        if (GESTURE_PROP_RE.test(name)) report(attr, 'no-gesture', `Không dùng "${name}": không vuốt, kéo, nhấn giữ, chạm đúp hay hai ngón để làm một việc.`);
        if (name === 'fontSize' && attr.initializer && ts.isJsxExpression(attr.initializer) && attr.initializer.expression) checkFontSize(attr.initializer.expression, report);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return findings;
}

/** Kiểm token: hồ sơ `senior` không có cỡ chữ nào dưới 18 ở bất kỳ mức cỡ chữ nào người dùng chọn được. */
export function lintTokens(): Finding[] {
  const findings: Finding[] = [];
  const smallestScale = Math.min(...Object.values(fontScale));
  const font = profiles.senior.font;
  for (const key of ['body', 'caption', 'screenTitle', 'cardTitle', 'button'] as const) {
    const size = font[key] * smallestScale;
    if (size < MIN_FONT_SIZE) {
      findings.push({ file: '@mihato/ui-tokens', line: 0, column: 0, rule: 'font-size', message: `profiles.senior.font.${key} = ${size} nhỏ hơn ${MIN_FONT_SIZE}.` });
    }
  }
  if (font.lineHeight < 1.5) findings.push({ file: '@mihato/ui-tokens', line: 0, column: 0, rule: 'font-size', message: `profiles.senior.font.lineHeight = ${font.lineHeight} nhỏ hơn 1.5: dấu tiếng Việt sẽ bị cắt.` });
  return findings;
}

const SOURCE_DIRS = ['app', 'components', 'src'];

export function collectFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules' || entry.startsWith('.')) continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.tsx?$/.test(entry) && !entry.endsWith('.d.ts')) out.push(full);
    }
  };
  for (const dir of SOURCE_DIRS) {
    try {
      walk(join(root, dir));
    } catch {
      // thư mục chưa có thì bỏ qua
    }
  }
  return out.sort();
}

export function lintProject(root: string): { files: number; findings: Finding[] } {
  const files = collectFiles(root);
  const findings = [...lintTokens()];
  for (const file of files) findings.push(...lintSource(relative(root, file), readFileSync(file, 'utf8')));
  return { files: files.length, findings };
}

function main(): void {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const { files, findings } = lintProject(root);
  if (findings.length === 0) {
    console.log(`lint:senior đạt: ${files} tệp, không có chữ dưới ${MIN_FONT_SIZE}, không nút thiếu nhãn, không toast, không cử chỉ ngoài cuộn.`);
    return;
  }
  console.error(`lint:senior có ${findings.length} điểm chưa đạt:`);
  for (const f of findings) console.error(`  ${f.file}:${f.line}:${f.column}  [${f.rule}]  ${f.message}`);
  process.exitCode = 1;
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) main();
