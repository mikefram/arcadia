// Cấu hình Metro cho monorepo pnpm (nodeLinker: hoisted, xem pnpm-workspace.yaml).
const path = require('node:path');
const { getDefaultConfig } = require('expo/metro-config');

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, '../..');

const config = getDefaultConfig(projectRoot);

// Gói nội bộ @mihato/* xuất thẳng TypeScript từ `src` (exports trỏ vào src/index.ts, không có bước build).
// Metro phải thấy cả repo để theo dõi và biên dịch các tệp đó bằng babel-preset-expo.
// Expo tự nhận monorepo từ SDK 52; ghi rõ ở đây để không phụ thuộc vào việc tự dò.
config.watchFolders = [workspaceRoot];

// node_modules phẳng ở gốc repo; thư mục node_modules của app chỉ chứa liên kết tới gói @mihato/*.
config.resolver.nodeModulesPaths = [path.resolve(projectRoot, 'node_modules'), path.resolve(workspaceRoot, 'node_modules')];

// Không theo dõi phần repo mà app không dùng. Metro sập khi công cụ hay app khác trong repo cài lại node_modules
// (lỗi "tracked as a non-empty directory" của metro-file-map), nên máy chủ phát triển không được phụ thuộc vào chúng.
const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const unused = ['tools', 'e2e', 'db', 'docs', 'apps/web-admin', 'apps/mobile-staff', 'apps/api', 'apps/worker', 'apps/scribe'];
config.resolver.blockList = [].concat(
  config.resolver.blockList ?? [],
  unused.map((dir) => new RegExp(`^${escapeRegExp(path.join(workspaceRoot, dir))}/.*`)),
);

module.exports = config;
