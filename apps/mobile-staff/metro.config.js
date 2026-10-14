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

module.exports = config;
