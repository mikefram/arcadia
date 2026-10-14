/**
 * Nhà cung cấp ngoài nằm sau giao diện (SPEC 3.1 ràng buộc 4, 6.9): STT, LLM, TTS, push, thư điện tử.
 * Mỗi giao diện có bản giả để chạy kịch bản vàng không cần mạng; CI không gọi nhà cung cấp trả phí.
 */
export * from './push';
export * from './email';
export * from './stt';
export * from './llm';
export * from './tts';
export * from './factory';
