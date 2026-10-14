/**
 * Thư viện thành phần của app Chủ tịch (SPEC 7.8). Không dùng thư viện UI có sẵn: mọi số đo lấy từ
 * @mihato/ui-tokens (hồ sơ `senior` hoặc `standard`), mọi chữ đi qua `SeniorText`.
 */
export { BigMic, type BigMicProps } from './BigMic';
export { ChoiceGroup, type Choice } from './ChoiceGroup';
export { ConfirmList, type ConfirmItem, type ConfirmListProps } from './ConfirmList';
export { Glyph, type GlyphName } from './Glyph';
export { LoadingText, SLOW_AFTER_MS } from './Loading';
export { Notice, SectionTitle } from './Notice';
export { PIN_LENGTH, PinDots, PinPad, type PinPadProps } from './PinPad';
export { ProgressBar } from './ProgressBar';
export { ResultPanel, type ResultPanelProps } from './ResultPanel';
export { ScreenFrame, type NavTab, type ScreenFrameProps } from './ScreenFrame';
export { SeniorButton, type SeniorButtonProps } from './SeniorButton';
export { SeniorCard, type CardTone, type SeniorCardProps } from './SeniorCard';
export { SeniorInput, type SeniorInputProps } from './SeniorInput';
export { SeniorText, type SeniorTextProps, type TextTone } from './SeniorText';
export { StatusChip, type StatusKind } from './StatusChip';
export { UndoActions, UndoBanner, type UndoActionsProps, type UndoBannerProps } from './UndoBanner';
export { VoiceMeter, type VoiceMeterProps } from './VoiceMeter';
export { successFeedback, tapFeedback } from './haptics';
export { FONT_SCALE_NAMES, lineHeightFor, metricsFor, type ProfileName, type SeniorMetrics, type TextVariant } from './metrics';
export { FONT_FILES, SeniorThemeProvider, color, fontStyle, setCustomFontsReady, useSenior, type FontWeightName } from './theme';
