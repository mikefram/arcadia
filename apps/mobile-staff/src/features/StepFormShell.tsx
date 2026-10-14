import type { StepDetail } from '@mihato/domain';
import { vi } from '@mihato/i18n';
import { router } from 'expo-router';
import type { ReactNode } from 'react';
import { View } from 'react-native';
import { errorMessage } from '../api/errors';
import { useStep } from '../data/queries';
import { AppText } from '../ui/AppText';
import { Banner } from '../ui/Banner';
import { EmptyState, ErrorState, LoadingState } from '../ui/Blocks';
import { Screen } from '../ui/Screen';
import { space } from '../ui/theme';
import { OfflineBanner } from './StatusNotices';
import { runLine } from './steps';

/** Quay về màn chi tiết việc sau khi gửi xong. */
export function backToStep(stepId: string): void {
  if (router.canGoBack()) router.back();
  else router.replace({ pathname: '/step/[id]', params: { id: stepId } });
}

type ShellProps = {
  stepId: string | undefined;
  /** tiêu đề màn; dạng hàm thì chọn theo việc đã tải (chưa tải xong thì nhận undefined) */
  title: string | ((step: StepDetail | undefined) => string);
  /** lý do máy chủ không nhận thao tác vừa gửi; ô nhập vẫn giữ nguyên nội dung */
  problem: string | null;
  /** thanh nút đáy, dựng từ việc đã tải */
  footer: (step: StepDetail) => ReactNode;
  children: (step: StepDetail) => ReactNode;
  /** cuộn tới vị trí này khi mở (ví dụ mục Thảo luận từ thông báo bình luận) */
  scrollToY?: number | null;
  testID: string;
};

/**
 * Khung chung của các màn nhập trên một việc (S3, S4, S5, S6, đổi người nhận): tải việc, nhắc tên việc ở đầu,
 * dải mất mạng, và chỗ báo lý do khi máy chủ không nhận, ngay trên ô nhập để ghi chú không bị mất.
 */
export function StepFormShell({ stepId, title, problem, footer, children, scrollToY, testID }: ShellProps) {
  const query = useStep(stepId);
  const step = query.data;
  const heading = typeof title === 'function' ? title(step) : title;

  if (!step) {
    return (
      <Screen title={heading} back testID={testID}>
        {query.isError ? <ErrorState message={errorMessage(query.error)} onRetry={() => void query.refetch()} /> : query.fetchStatus === 'paused' ? <EmptyState text={vi.staff.feedback.offlineNoData} /> : <LoadingState />}
      </Screen>
    );
  }

  return (
    <Screen title={heading} back keyboard footer={footer(step)} scrollToY={scrollToY} testID={testID}>
      <OfflineBanner updatedAt={query.dataUpdatedAt || undefined} />
      <View style={{ gap: space.xs }}>
        <AppText variant="cardTitle">{step.title}</AppText>
        <AppText variant="caption" tone="sub">
          {runLine(step)}
        </AppText>
      </View>
      {problem ? (
        <Banner tone="info" title={vi.staff.offline.rejectedTitle} live testID="form-problem">
          <AppText>{problem}</AppText>
          <AppText variant="caption" tone="sub">
            {vi.staff.offline.noteKept}
          </AppText>
        </Banner>
      ) : null}
      {children(step)}
    </Screen>
  );
}
