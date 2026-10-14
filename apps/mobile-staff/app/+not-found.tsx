import { Redirect } from 'expo-router';

/** Đường dẫn lạ (liên kết sâu cũ hoặc gõ sai): về màn đầu. Lớp gốc tự đưa tới màn kích hoạt nếu máy chưa kích hoạt. */
export default function NotFound() {
  return <Redirect href="/" />;
}
