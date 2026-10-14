/**
 * @mihato/ai-tools: định nghĩa tool, prompt, chốt chặn số liệu và bộ đánh giá của AI Scribe (SPEC 6, 13.5).
 * Vòng lặp tác tử (agent.ts) dùng chung cho dịch vụ scribe và bộ đánh giá.
 * Phần thực thi tool nằm ở máy chủ (packages/backend/src/services/tools.ts), vì scribe không truy cập CSDL.
 */
export * from './tools';
export * from './prompt';
export * from './guard';
export * from './agent';
