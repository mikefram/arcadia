import type { StepView } from '@mihato/domain';
import { fmt, vi } from '@mihato/i18n';
import { Pressable, StyleSheet, View } from 'react-native';
import { useCachedRunConfidentiality } from '../data/queries';
import { AppText } from '../ui/AppText';
import { Chip } from '../ui/Chip';
import { color, profile, space } from '../ui/theme';
import { stepBadges } from './comments';
import { dateTimeText, dueText, giverOf, personName, runLine, stepA11yLabel, stepChips } from './steps';

const t = vi.staff.myWork.card;

type StepCardProps = {
  step: StepView;
  now: number;
  /** có thao tác của việc này đang chờ gửi */
  queued: boolean;
  /** S8 Nhóm của tôi: hiện người nhận thay cho người giao */
  showAssignee?: boolean;
  /** đã gửi phần của mình, việc còn mở vì người khác chưa gửi */
  awaitingOthers?: boolean;
  onPress: () => void;
};

/**
 * Thẻ việc (SPEC 8.2 S1): tên việc, tên lượt chạy, hạn, người giao, chip trạng thái.
 * Việc quá hạn có nền nâu đỏ nhạt và chip "Quá hạn n ngày làm việc"; việc xong có nền xanh nhạt và dấu tích.
 */
export function StepCard({ step, now, queued, showAssignee = false, awaitingOthers = false, onPress }: StepCardProps) {
  const done = step.state === 'done';
  const giverInfo = giverOf(step);
  const giver = personName(giverInfo.person);
  const assignee = personName(step.assignee);
  const onBehalfOf = personName(step.onBehalfOf);
  // Số bình luận có sẵn trong `StepView`; "Mật" chỉ hiện khi lượt đã được tải sẵn (không gọi mạng thêm ở danh sách).
  const badges = stepBadges(step, useCachedRunConfidentiality(step.runId, step.adhoc));

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={[stepA11yLabel(step, now, queued, awaitingOthers), ...badges.map((b) => b.a11y)].join('. ')}
      onPress={onPress}
      style={({ pressed }) => [styles.card, step.isOverdue && styles.late, done && styles.done, pressed && styles.pressed]}
      testID={`step-card-${step.id}`}
    >
      <AppText variant="cardTitle">{step.title}</AppText>
      <AppText variant="caption" tone="sub">
        {runLine(step)}
      </AppText>
      <View style={styles.meta}>
        {done && step.completedAt ? (
          <AppText>{fmt(t.completedAt, { giờ: dateTimeText(step.completedAt) })}</AppText>
        ) : (
          <AppText weight="medium" tone={step.isOverdue ? 'late' : 'text'}>
            {step.dueAt ? fmt(t.due, { hạn: dueText(step.dueAt, now) }) : t.noDue}
          </AppText>
        )}
        {showAssignee && assignee ? <AppText tone="sub">{fmt(vi.staff.team.assigneeLine, { người: assignee })}</AppText> : null}
        {!showAssignee && giver ? <AppText tone="sub">{fmt(giverInfo.label === 'requestedBy' ? vi.staff.approval.requester : t.assignedBy, { người: giver })}</AppText> : null}
        {onBehalfOf ? (
          <AppText variant="caption" tone="sub">
            {fmt(t.onBehalfOf, { người: onBehalfOf })}
          </AppText>
        ) : null}
      </View>
      <View style={styles.chips}>
        {stepChips(step, { queued, awaitingOthers }).map((chip) => (
          <Chip key={chip.key} label={chip.label} tone={chip.tone} glyph={chip.glyph} testID={`chip-${chip.key}`} />
        ))}
        {badges.map((b) => (
          <Chip key={b.key} label={b.label} tone="neutral" glyph={b.key === 'restricted' ? 'lock' : 'chat'} testID={`chip-${b.key}`} />
        ))}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    minHeight: profile.touch.min,
    backgroundColor: color.surface,
    borderWidth: profile.borderWidth,
    borderColor: color.border,
    borderRadius: profile.radius,
    padding: profile.space.cardPadding,
    gap: space.xs,
  },
  late: { backgroundColor: color.lateBg, borderColor: color.lateText },
  done: { backgroundColor: color.primaryTint, borderColor: color.primary },
  pressed: { opacity: 0.8 },
  meta: { marginTop: space.xs, gap: 2 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm, marginTop: space.sm },
});
