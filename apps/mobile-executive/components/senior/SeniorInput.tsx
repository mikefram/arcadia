import { vi } from '@mihato/i18n';
import { TextInput, View } from 'react-native';
import { lineHeightFor } from './metrics';
import { SeniorButton } from './SeniorButton';
import { SeniorText } from './SeniorText';
import { color, fontStyle, useSenior, webFontScale } from './theme';

export type SeniorInputProps = {
  value: string;
  onChangeText: (text: string) => void;
  /** nhãn hiện phía trên ô; cũng là nhãn đọc cho VoiceOver và TalkBack */
  label: string;
  placeholder?: string;
  /** Nút "Nói" luôn nằm cạnh ô nhập (SPEC 7.6): đọc thay vì gõ. */
  onSpeak: () => void;
  /** đang nghe: nút đổi thành "Dừng nói" */
  speaking?: boolean;
  speakDisabled?: boolean;
  autoFocus?: boolean;
  maxLength?: number;
  testID?: string;
};

/** Ô nhập lớn của app Chủ tịch. Nhập chữ chỉ khi không còn cách khác; cạnh ô luôn có nút Nói. */
export function SeniorInput({ value, onChangeText, label, placeholder, onSpeak, speaking = false, speakDisabled = false, autoFocus = false, maxLength = 1000, testID }: SeniorInputProps) {
  const m = useSenior();
  const size = m.font.body * webFontScale(m.maxFontSizeMultiplier);
  return (
    <View style={{ gap: m.space.sm }}>
      <SeniorText variant="emphasis" tone="sub" nativeID={testID ? `${testID}-label` : undefined}>
        {label}
      </SeniorText>
      <TextInput
        accessibilityLabel={label}
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        // `border` (#6F6657) đạt 5.25:1 trên nền trắng: nhạt hơn chữ thật nhưng vẫn đọc được.
        placeholderTextColor={color.border}
        maxFontSizeMultiplier={m.maxFontSizeMultiplier}
        multiline
        autoFocus={autoFocus}
        maxLength={maxLength}
        textAlignVertical="top"
        style={[
          {
            minHeight: m.touch.input * 1.75,
            borderRadius: m.radius,
            borderWidth: m.borderWidth,
            borderColor: color.border,
            backgroundColor: color.surface,
            paddingHorizontal: m.space.cardPadding,
            paddingVertical: m.space.md,
            fontSize: size,
            lineHeight: lineHeightFor(size, m.tokens),
            color: color.text,
          },
          fontStyle('regular'),
        ]}
        testID={testID}
      />
      <SeniorButton
        variant="secondary"
        icon={speaking ? 'stop' : 'mic'}
        label={speaking ? vi.executive.assistant.speakStop : vi.executive.assistant.speakInstead}
        onPress={onSpeak}
        disabled={speakDisabled}
        style={{ alignSelf: 'flex-start', minWidth: 140 }}
        testID={testID ? `${testID}-speak` : undefined}
      />
    </View>
  );
}
