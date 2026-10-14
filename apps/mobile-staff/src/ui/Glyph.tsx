import { View, type ViewStyle } from 'react-native';
import { color } from './theme';

/**
 * Hình nhỏ vẽ bằng View (không cần thư viện biểu tượng). Hình chỉ là phần phụ: trạng thái luôn có chữ đi kèm
 * (SPEC 7.3), nên mọi hình đều ẩn với trình đọc màn hình.
 */
const hidden = { accessibilityElementsHidden: true, importantForAccessibility: 'no-hide-descendants' } as const;

export type GlyphName = 'check' | 'alert' | 'clock' | 'back' | 'forward' | 'work' | 'bell' | 'group' | 'person' | 'send' | 'lock' | 'chat';

export function Glyph({ name, size = 16, tint = color.text }: { name: GlyphName; size?: number; tint?: string }) {
  const box: ViewStyle = { width: size, height: size, alignItems: 'center', justifyContent: 'center' };
  const line = Math.max(2, Math.round(size / 8));

  switch (name) {
    case 'check':
      return (
        <View {...hidden} style={box}>
          <View
            style={{
              width: size * 0.36,
              height: size * 0.66,
              borderRightWidth: line,
              borderBottomWidth: line,
              borderColor: tint,
              transform: [{ rotate: '45deg' }, { translateY: -size * 0.06 }],
            }}
          />
        </View>
      );
    case 'alert':
      // dấu chấm than trong vòng tròn: báo quá hạn
      return (
        <View {...hidden} style={[box, { borderRadius: size / 2, borderWidth: line, borderColor: tint }]}>
          <View style={{ width: line, height: size * 0.3, backgroundColor: tint, borderRadius: line / 2 }} />
          <View style={{ width: line, height: line, backgroundColor: tint, borderRadius: line / 2, marginTop: Math.max(1, size * 0.06) }} />
        </View>
      );
    case 'clock':
      return (
        <View {...hidden} style={[box, { borderRadius: size / 2, borderWidth: line, borderColor: tint }]}>
          <View style={{ position: 'absolute', width: line, height: size * 0.3, backgroundColor: tint, top: size * 0.16 }} />
          <View style={{ position: 'absolute', width: size * 0.24, height: line, backgroundColor: tint, left: size * 0.5 - line / 2 - line / 2, top: size * 0.5 - line }} />
        </View>
      );
    case 'back':
    case 'forward':
      return (
        <View {...hidden} style={box}>
          <View
            style={{
              width: size * 0.5,
              height: size * 0.5,
              borderLeftWidth: line,
              borderBottomWidth: line,
              borderColor: tint,
              transform: [{ rotate: name === 'back' ? '45deg' : '225deg' }, { translateX: name === 'back' ? size * 0.1 : size * 0.1 }],
            }}
          />
        </View>
      );
    case 'work':
      // ba dòng việc, mỗi dòng một ô đánh dấu
      return (
        <View {...hidden} style={[box, { justifyContent: 'space-between', paddingVertical: size * 0.12 }]}>
          {[0, 1, 2].map((i) => (
            <View key={i} style={{ flexDirection: 'row', alignItems: 'center', width: size }}>
              <View style={{ width: line * 1.6, height: line * 1.6, borderRadius: line / 2, backgroundColor: tint }} />
              <View style={{ flex: 1, height: line, marginLeft: line, backgroundColor: tint, borderRadius: line / 2 }} />
            </View>
          ))}
        </View>
      );
    case 'bell':
      return (
        <View {...hidden} style={box}>
          <View
            style={{
              width: size * 0.62,
              height: size * 0.6,
              borderTopLeftRadius: size * 0.31,
              borderTopRightRadius: size * 0.31,
              borderWidth: line,
              borderBottomWidth: 0,
              borderColor: tint,
            }}
          />
          <View style={{ width: size * 0.86, height: line, backgroundColor: tint, borderRadius: line / 2 }} />
          <View style={{ width: line * 1.6, height: line * 1.4, backgroundColor: tint, borderBottomLeftRadius: line, borderBottomRightRadius: line, marginTop: 1 }} />
        </View>
      );
    case 'person':
      return (
        <View {...hidden} style={box}>
          <View style={{ width: size * 0.38, height: size * 0.38, borderRadius: size * 0.19, borderWidth: line, borderColor: tint }} />
          <View
            style={{
              width: size * 0.78,
              height: size * 0.4,
              marginTop: 1,
              borderTopLeftRadius: size * 0.39,
              borderTopRightRadius: size * 0.39,
              borderWidth: line,
              borderBottomWidth: 0,
              borderColor: tint,
            }}
          />
        </View>
      );
    case 'group':
      return (
        <View {...hidden} style={[box, { flexDirection: 'row', alignItems: 'flex-end' }]}>
          {[0, 1].map((i) => (
            <View key={i} style={{ alignItems: 'center', marginLeft: i === 0 ? 0 : -size * 0.08 }}>
              <View style={{ width: size * 0.3, height: size * 0.3, borderRadius: size * 0.15, borderWidth: line, borderColor: tint }} />
              <View
                style={{
                  width: size * 0.5,
                  height: size * 0.34,
                  marginTop: 1,
                  borderTopLeftRadius: size * 0.25,
                  borderTopRightRadius: size * 0.25,
                  borderWidth: line,
                  borderBottomWidth: 0,
                  borderColor: tint,
                }}
              />
            </View>
          ))}
        </View>
      );
    case 'lock':
      // khoá: quai ở trên, thân đặc ở dưới (văn bản mật)
      return (
        <View {...hidden} style={box}>
          <View
            style={{
              width: size * 0.5,
              height: size * 0.36,
              borderTopLeftRadius: size * 0.25,
              borderTopRightRadius: size * 0.25,
              borderWidth: line,
              borderBottomWidth: 0,
              borderColor: tint,
            }}
          />
          <View style={{ width: size * 0.78, height: size * 0.46, borderRadius: line, backgroundColor: tint }} />
        </View>
      );
    case 'chat':
      // khung thoại có hai dòng chữ: bình luận
      return (
        <View {...hidden} style={box}>
          <View style={{ width: size * 0.9, height: size * 0.62, borderRadius: size * 0.14, borderWidth: line, borderColor: tint, justifyContent: 'center', alignItems: 'flex-start', paddingLeft: size * 0.14, gap: line }}>
            <View style={{ width: size * 0.5, height: line * 0.8, borderRadius: line / 2, backgroundColor: tint }} />
            <View style={{ width: size * 0.34, height: line * 0.8, borderRadius: line / 2, backgroundColor: tint }} />
          </View>
        </View>
      );
    case 'send':
      // mũi tên đi lên: thao tác đang chờ gửi
      return (
        <View {...hidden} style={box}>
          <View
            style={{
              width: size * 0.42,
              height: size * 0.42,
              borderLeftWidth: line,
              borderTopWidth: line,
              borderColor: tint,
              transform: [{ rotate: '45deg' }, { translateX: size * 0.1 }, { translateY: size * 0.1 }],
            }}
          />
          <View style={{ position: 'absolute', width: line, height: size * 0.7, backgroundColor: tint, top: size * 0.18 }} />
        </View>
      );
  }
}
