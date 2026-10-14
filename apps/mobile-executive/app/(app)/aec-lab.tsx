import { fmtExecutive, vi } from '@mihato/i18n';
import { Asset } from 'expo-asset';
import { requestRecordingPermissionsAsync } from 'expo-audio';
import { Redirect } from 'expo-router';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { View } from 'react-native';
import { ChoiceGroup } from '@senior/ChoiceGroup';
import { Notice, SectionTitle } from '@senior/Notice';
import { SeniorButton } from '@senior/SeniorButton';
import { SeniorCard } from '@senior/SeniorCard';
import { SeniorText } from '@senior/SeniorText';
import { useSenior } from '@senior/theme';
import { AecLabRunner, type LabConfig, type LabReport, type LabState } from '@/duplex/lab';
import { duplexAudio } from '@/duplex/native';
import { configurePlaybackAudioMode } from '@/scribe/audio-mode';
import { AppScreen } from '@/ui/AppScreen';

const t = vi.executive.aecLab;

const IDLE: LabState = { phase: 'idle', prompt: false, micDb: null, refDb: null, frames: 0, stepMs: 0, route: null, error: null, reports: [] };
const subscribeNothing = () => () => undefined;
const idleState = () => IDLE;

let runner: AecLabRunner | null = null;

/** Một bộ điều phối cho cả phiên dùng app, để các báo cáo còn lại khi rời màn hình rồi quay lại. Null khi bản dựng không có mô-đun âm thanh gốc. */
function getRunner(): AecLabRunner | null {
  const native = duplexAudio();
  if (!native) return null;
  runner ??= new AecLabRunner({
    native,
    clipUri: async () => {
      // Chỉ bản thử nạp đoạn mẫu: ở bản phát hành `__DEV__` là false, Metro bỏ cả khối này nên tệp 870 KB không vào gói.
      if (__DEV__) {
        // Metro chỉ nhận tệp tĩnh qua `require` (như assets/tinh.wav ở src/features/sound.ts), `import` động không đưa tệp vào gói.
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const asset = Asset.fromModule(require('../../assets/aec-lab/tro-ly-doc.wav') as number);
        await asset.downloadAsync();
        const uri = asset.localUri ?? asset.uri;
        if (uri) return uri;
      }
      throw new Error('clip_missing');
    },
    requestPermission: async () => (await requestRecordingPermissionsAsync()).granted,
    restorePlayback: configurePlaybackAudioMode,
  });
  return runner;
}

/** Số thập phân kiểu Việt Nam (dấu phẩy). */
const num = (value: number | null, digits = 1): string => (value === null || !Number.isFinite(value) ? t.none : value.toFixed(digits).replace('.', ','));

const RUNNING = new Set<LabState['phase']>(['starting', 'silence', 'echo', 'talk']);

function Row({ label, value }: { label: string; value: string }) {
  const m = useSenior();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: m.space.md }}>
      <View style={{ flex: 1 }}>
        <SeniorText tone="sub">{label}</SeniorText>
      </View>
      <SeniorText variant="emphasis">{value}</SeniorText>
    </View>
  );
}

function configText(config: LabConfig): string {
  return `${config.voiceProcessing ? t.config.vpOn : t.config.vpOff}, ${config.voiceChatMode ? t.config.voiceChat : t.config.normal}`;
}

function ReportCard({ report }: { report: LabReport }) {
  const m = useSenior();
  const r = t.rows;
  return (
    <SeniorCard tone={report.verdict === 'pass' ? 'done' : 'plain'} testID={`aec-report-${report.verdict}`}>
      <View style={{ gap: m.space.sm }}>
        <SeniorText variant="cardTitle">{configText(report.config)}</SeniorText>
        <Row label={t.live.route} value={report.start.route} />
        <Row label={r.format} value={`${num(report.start.inputSampleRate, 0)}, ${report.start.inputChannels}`} />
        <Row label={r.cadence} value={num(report.cadenceHz)} />
        <Row label={r.silenceMid} value={num(report.silence?.p50 ?? null)} />
        <Row label={r.silenceHigh} value={num(report.silence?.p95 ?? null)} />
        <Row label={r.echoMid} value={num(report.echo?.p50 ?? null)} />
        <Row label={r.echoHigh} value={num(report.echo?.p95 ?? null)} />
        <Row label={r.echoPeak} value={num(report.echo?.max ?? null)} />
        <Row label={r.speaker} value={num(report.referenceP50)} />
        <Row label={r.reduction} value={num(report.echoLossDb)} />
        <Row label={r.speech} value={num(report.speechP90)} />
        <Row label={r.margin} value={num(report.marginDb)} />
        <Row label={r.threshold} value={num(report.thresholdDb)} />
        <Row label={r.delay} value={num(report.triggerDelayMs, 0)} />
        <Row label={r.falseTriggers} value={String(report.falseTriggers)} />
        <SeniorText variant="emphasis" testID="aec-verdict">
          {t.verdict[report.verdict]}
        </SeniorText>
      </View>
    </SeniorCard>
  );
}

/** Khử vọng giảm thêm bao nhiêu: mức tiếng vọng lúc tắt trừ lúc bật, lấy hai lần đo mới nhất cùng chế độ âm thanh. */
function reduction(reports: readonly LabReport[]): number | null {
  for (const on of reports) {
    if (!on.config.voiceProcessing || !on.echo) continue;
    const off = reports.find((r) => !r.config.voiceProcessing && r.config.voiceChatMode === on.config.voiceChatMode && r.echo);
    if (off?.echo) return off.echo.p50 - on.echo.p50;
  }
  return null;
}

function errorText(error: NonNullable<LabState['error']>): string {
  const template = error.code === 'unavailable' ? t.unavailable : t.errors[error.code];
  return fmtExecutive(template, { 'lý do': error.detail });
}

/**
 * Màn đo khử tiếng vọng: chỉ có ở bản thử (`__DEV__`) và cần bản dựng có mô-đun âm thanh gốc (không chạy trong Expo Go).
 * Trả lời câu hỏi nền của việc ngắt lời trợ lý bằng giọng nói (docs/DECISIONS.md): tiếng loa vọng lại micro nhỏ hơn giọng nói
 * chen vào đủ nhiều chưa. Mọi tính toán nằm ở src/duplex/lab.ts; màn hình chỉ hiện trạng thái và kết quả.
 */
export default function AecLabScreen() {
  if (!__DEV__) return <Redirect href="/" />;
  return <AecLab />;
}

function AecLab() {
  const m = useSenior();
  const lab = getRunner();
  const state = useSyncExternalStore(lab?.subscribe ?? subscribeNothing, lab?.getState ?? idleState);
  const [config, setConfig] = useState<LabConfig>({ voiceProcessing: true, voiceChatMode: true });
  const running = RUNNING.has(state.phase);

  // Rời màn hình thì dừng đo: không để micro và loa mở khi không ai nhìn.
  useEffect(() => () => void lab?.abort(), [lab]);

  const phaseText = state.prompt ? t.phase.talkPrompt : state.phase === 'idle' || state.phase === 'error' ? null : t.phase[state.phase];
  const compared = reduction(state.reports);

  return (
    <AppScreen
      title={t.title}
      back
      footer={
        lab ? (
          running ? (
            <SeniorButton variant="secondary" label={t.stop} onPress={() => void lab.abort()} testID="aec-stop" />
          ) : (
            <SeniorButton label={t.start} onPress={() => void lab.start(config)} testID="aec-start" />
          )
        ) : undefined
      }
      testID="screen-aec-lab"
    >
      {!lab ? (
        <Notice testID="aec-unavailable">{t.unavailable}</Notice>
      ) : (
        <>
          <SeniorText tone="sub">{t.intro}</SeniorText>

          <View style={{ gap: m.space.md }}>
            <SectionTitle>{t.echoCancel.title}</SectionTitle>
            <ChoiceGroup
              label={t.echoCancel.title}
              options={[
                { value: 'on', label: t.echoCancel.on },
                { value: 'off', label: t.echoCancel.off },
              ]}
              value={config.voiceProcessing ? 'on' : 'off'}
              onChange={(v) => !running && setConfig({ ...config, voiceProcessing: v === 'on' })}
              testID="aec-vp"
            />
          </View>

          <View style={{ gap: m.space.md }}>
            <SectionTitle>{t.mode.title}</SectionTitle>
            <ChoiceGroup
              label={t.mode.title}
              options={[
                { value: 'voiceChat', label: t.mode.voiceChat },
                { value: 'normal', label: t.mode.normal },
              ]}
              value={config.voiceChatMode ? 'voiceChat' : 'normal'}
              onChange={(v) => !running && setConfig({ ...config, voiceChatMode: v === 'voiceChat' })}
              testID="aec-mode"
            />
          </View>

          {phaseText ? (
            <SeniorCard tone={state.prompt ? 'gold' : 'quiet'} testID="aec-phase">
              <View style={{ gap: m.space.sm }}>
                <SeniorText variant="emphasis">{phaseText}</SeniorText>
                {state.phase !== 'starting' ? (
                  <>
                    <Row label={t.live.mic} value={num(state.micDb)} />
                    <Row label={t.live.speaker} value={num(state.refDb)} />
                    <Row label={t.live.step} value={num(state.stepMs, 0)} />
                    <Row label={t.live.frames} value={String(state.frames)} />
                    <Row label={t.live.route} value={state.route ?? t.none} />
                  </>
                ) : null}
              </View>
            </SeniorCard>
          ) : null}

          {state.error ? (
            <Notice live testID="aec-error">
              {errorText(state.error)}
            </Notice>
          ) : null}

          {state.reports.length > 0 ? (
            <View style={{ gap: m.space.md }}>
              <SectionTitle>{t.resultTitle}</SectionTitle>
              {compared !== null ? <Row label={t.compare} value={num(compared)} /> : null}
              {state.reports.map((report, index) => (
                <ReportCard key={`${index}-${report.verdict}-${report.counts.echo}`} report={report} />
              ))}
            </View>
          ) : null}
        </>
      )}
    </AppScreen>
  );
}
