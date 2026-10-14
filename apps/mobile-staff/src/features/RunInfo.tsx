import type { PersonRef, RunDetail, StepView } from '@mihato/domain';
import { fmt, vi } from '@mihato/i18n';
import { useMemo } from 'react';
import { StyleSheet, View } from 'react-native';
import { AppText } from '../ui/AppText';
import { Card, InfoList, InfoRow, SectionHeading } from '../ui/Blocks';
import { Button } from '../ui/Button';
import { Chip } from '../ui/Chip';
import { space } from '../ui/theme';
import { buildRunContext, myPartRows, peopleOfRun, type ValueRow } from './run-context';
import { personName } from './steps';

const t = vi.staff.stepDetail;

function Rows({ rows }: { rows: readonly ValueRow[] }) {
  return (
    <InfoList>
      {rows.map((row) => (
        <InfoRow key={row.key} label={row.label}>
          {row.text}
        </InfoRow>
      ))}
    </InfoList>
  );
}

type RunInfoProps = {
  stepId: string;
  /** lượt chạy đã tải; undefined khi đang tải hoặc tải lỗi */
  run: RunDetail | undefined;
  loading: boolean;
  failed: boolean;
  onRetry: () => void;
};

/**
 * "Thông tin của lượt": người khởi chạy, dữ liệu họ đã điền khi khởi chạy (nội dung chỉ thị, hạn, mức khẩn…), rồi kết quả các việc
 * đã xong trước đó (ý kiến chỉ đạo, người chủ trì, phần của từng người ở bước đóng góp). Đó là điều người nhận việc cần để làm.
 * Tệp đính kèm không nằm ở đây mà ở mục "Tệp đính kèm", để mở được. Việc giao riêng không có lượt nên không dùng mục này.
 */
export function RunInfo({ stepId, run, loading, failed, onRetry }: RunInfoProps) {
  const context = useMemo(() => (run ? buildRunContext(run, stepId) : null), [run, stepId]);
  return (
    <View style={styles.section} testID="run-info">
      <SectionHeading title={t.runInfo} />
      {context ? (
        <>
          {context.startedBy || context.inputs.length > 0 ? (
            <Card style={styles.flush}>
              <InfoList>
                {context.startedBy ? <InfoRow label={t.startedBy}>{context.startedBy}</InfoRow> : null}
                {context.inputs.map((row) => (
                  <InfoRow key={row.key} label={row.label}>
                    {row.text}
                  </InfoRow>
                ))}
              </InfoList>
            </Card>
          ) : (
            <AppText tone="sub">{t.runInfoEmpty}</AppText>
          )}
          {context.previous.length > 0 ? (
            <View style={styles.section}>
              <AppText variant="caption" weight="semibold" tone="sub" accessibilityRole="header">
                {t.previousResults}
              </AppText>
              {context.previous.map((group) => (
                <Card key={group.key} style={styles.flush} testID={`previous-${group.key}`}>
                  <AppText weight="semibold" style={styles.groupTitle}>
                    {group.title}
                  </AppText>
                  <Rows rows={group.rows} />
                </Card>
              ))}
            </View>
          ) : null}
        </>
      ) : failed ? (
        <View style={styles.section}>
          <AppText tone="sub" accessibilityRole="alert">
            {t.runInfoFailed}
          </AppText>
          <Button variant="secondary" label={vi.common.actions.retry} onPress={onRetry} testID="run-info-retry" />
        </View>
      ) : loading ? (
        <AppText tone="sub">{t.runInfoLoading}</AppText>
      ) : null}
    </View>
  );
}

/**
 * Bước đóng góp: ai cùng gửi phần và ai đã gửi, cùng phần mà chính người xem đã gửi. Chỉ có tên và "Đã gửi, Chưa gửi";
 * nội dung phần của người khác không hiện ở đây.
 */
export function ContributionInfo({ step, myId, run }: { step: StepView; myId: string | null; run: RunDetail | undefined }) {
  const people = useMemo(() => (run ? peopleOfRun(run) : new Map<string, PersonRef>()), [run]);
  const mine = useMemo(() => myPartRows(step, myId, { people }), [step, myId, people]);
  const participants = step.participants ?? [];
  if (step.action !== 'contribute') return null;
  return (
    <>
      {participants.length > 1 ? (
        <View style={styles.section} testID="participants">
          <SectionHeading title={t.participants} />
          <Card style={styles.flush}>
            <InfoList>
              {participants.map((p) => {
                const sent = p.decision === 'approved';
                const name = personName(p.person) ?? t.unknownPerson;
                return (
                  <View key={p.person.id} style={styles.person} accessibilityLabel={fmt(t.participantLine, { người: name, 'trạng thái': sent ? t.participantSent : t.participantWaiting })}>
                    <AppText style={styles.personName}>{name}</AppText>
                    <Chip label={sent ? t.participantSent : t.participantWaiting} tone={sent ? 'done' : 'neutral'} />
                  </View>
                );
              })}
            </InfoList>
          </Card>
        </View>
      ) : null}
      {mine && mine.length > 0 ? (
        <View style={styles.section} testID="my-part">
          <SectionHeading title={t.myPart} />
          <Card style={styles.flush}>
            <Rows rows={mine} />
          </Card>
        </View>
      ) : null}
    </>
  );
}

const styles = StyleSheet.create({
  section: { gap: space.sm },
  flush: { paddingVertical: space.xs, gap: 0 },
  groupTitle: { paddingTop: space.sm, paddingBottom: space.xs },
  person: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: space.md, paddingVertical: space.sm },
  personName: { flex: 1 },
});
