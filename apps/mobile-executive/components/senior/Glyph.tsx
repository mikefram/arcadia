import { View, type ViewStyle } from 'react-native';
import { color } from './theme';

/**
 * Hình nhỏ vẽ bằng View (không cần thư viện biểu tượng). Hình chỉ là phần phụ: mọi hình đều có chữ đi kèm
 * (SPEC 7.2 điều 4), nên hình ẩn với trình đọc màn hình.
 */
const hidden = { accessibilityElementsHidden: true, importantForAccessibility: 'no-hide-descendants' } as const;

export type GlyphName =
  | 'check'
  | 'alert'
  | 'back'
  | 'forward'
  | 'mic'
  | 'stop'
  | 'home'
  | 'progress'
  | 'phone'
  | 'speaker'
  | 'keyboard'
  | 'person'
  | 'pen'
  | 'decide';

export function Glyph({ name, size = 24, tint = color.text }: { name: GlyphName; size?: number; tint?: string }) {
  const box: ViewStyle = { width: size, height: size, alignItems: 'center', justifyContent: 'center' };
  const line = Math.max(2, Math.round(size / 9));

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
      // dấu chấm than trong vòng tròn: chỉ đi cùng chữ "Quá hạn"
      return (
        <View {...hidden} style={[box, { borderRadius: size / 2, borderWidth: line, borderColor: tint }]}>
          <View style={{ width: line, height: size * 0.3, backgroundColor: tint, borderRadius: line / 2 }} />
          <View style={{ width: line, height: line, backgroundColor: tint, borderRadius: line / 2, marginTop: Math.max(1, size * 0.07) }} />
        </View>
      );
    case 'back':
    case 'forward':
      return (
        <View {...hidden} style={box}>
          <View
            style={{
              width: size * 0.46,
              height: size * 0.46,
              borderLeftWidth: line,
              borderBottomWidth: line,
              borderColor: tint,
              transform: [{ rotate: name === 'back' ? '45deg' : '225deg' }, { translateX: size * 0.08 }, { translateY: name === 'back' ? -size * 0.08 : size * 0.08 }],
            }}
          />
        </View>
      );
    case 'mic':
      // thân micro ở trên, giá đỡ chữ U ôm nửa dưới, chân và đế ở dưới
      return (
        <View {...hidden} style={box}>
          <View style={{ position: 'absolute', top: 0, width: size * 0.36, height: size * 0.6, borderRadius: size * 0.18, backgroundColor: tint }} />
          <View
            style={{
              position: 'absolute',
              top: size * 0.34,
              width: size * 0.7,
              height: size * 0.42,
              borderBottomLeftRadius: size * 0.35,
              borderBottomRightRadius: size * 0.35,
              borderWidth: line,
              borderTopWidth: 0,
              borderColor: tint,
            }}
          />
          <View style={{ position: 'absolute', top: size * 0.74, width: line, height: size * 0.18, backgroundColor: tint }} />
          <View style={{ position: 'absolute', top: size * 0.9, width: size * 0.4, height: line, borderRadius: line / 2, backgroundColor: tint }} />
        </View>
      );
    case 'stop':
      return (
        <View {...hidden} style={box}>
          <View style={{ width: size * 0.6, height: size * 0.6, borderRadius: Math.max(2, size * 0.1), backgroundColor: tint }} />
        </View>
      );
    case 'home':
      return (
        <View {...hidden} style={box}>
          <View
            style={{
              width: 0,
              height: 0,
              borderLeftWidth: size * 0.46,
              borderRightWidth: size * 0.46,
              borderBottomWidth: size * 0.4,
              borderLeftColor: 'transparent',
              borderRightColor: 'transparent',
              borderBottomColor: tint,
            }}
          />
          <View style={{ width: size * 0.62, height: size * 0.42, backgroundColor: tint, alignItems: 'center', justifyContent: 'flex-end' }}>
            <View style={{ width: size * 0.2, height: size * 0.26, backgroundColor: color.surface, borderTopLeftRadius: 2, borderTopRightRadius: 2 }} />
          </View>
        </View>
      );
    case 'progress':
      // ba vạch dài ngắn khác nhau: tiến độ của các lượt
      return (
        <View {...hidden} style={[box, { alignItems: 'flex-start', justifyContent: 'space-between', paddingVertical: size * 0.14 }]}>
          {[1, 0.66, 0.84].map((w, i) => (
            <View key={i} style={{ width: size * w, height: Math.max(3, size * 0.16), borderRadius: size * 0.08, backgroundColor: tint }} />
          ))}
        </View>
      );
    case 'phone':
      return (
        <View {...hidden} style={box}>
          <View
            style={{
              width: size * 0.56,
              height: size * 0.92,
              borderRadius: size * 0.14,
              borderWidth: line,
              borderColor: tint,
              alignItems: 'center',
              justifyContent: 'flex-end',
              paddingBottom: size * 0.07,
            }}
          >
            <View style={{ width: size * 0.2, height: line, borderRadius: line / 2, backgroundColor: tint }} />
          </View>
        </View>
      );
    case 'speaker':
      return (
        <View {...hidden} style={[box, { flexDirection: 'row' }]}>
          <View style={{ width: size * 0.22, height: size * 0.34, backgroundColor: tint }} />
          <View
            style={{
              width: 0,
              height: 0,
              marginLeft: -size * 0.04,
              borderTopWidth: size * 0.36,
              borderBottomWidth: size * 0.36,
              borderRightWidth: size * 0.34,
              borderTopColor: 'transparent',
              borderBottomColor: 'transparent',
              borderRightColor: tint,
            }}
          />
          <View
            style={{
              width: size * 0.2,
              height: size * 0.5,
              marginLeft: size * 0.06,
              borderRightWidth: line,
              borderColor: tint,
              borderTopRightRadius: size * 0.25,
              borderBottomRightRadius: size * 0.25,
            }}
          />
        </View>
      );
    case 'keyboard':
      return (
        <View {...hidden} style={box}>
          <View
            style={{
              width: size,
              height: size * 0.68,
              borderRadius: size * 0.12,
              borderWidth: line,
              borderColor: tint,
              alignItems: 'center',
              justifyContent: 'space-evenly',
            }}
          >
            <View style={{ flexDirection: 'row', gap: size * 0.1 }}>
              {[0, 1, 2].map((i) => (
                <View key={i} style={{ width: line * 1.2, height: line * 1.2, borderRadius: line * 0.3, backgroundColor: tint }} />
              ))}
            </View>
            <View style={{ width: size * 0.5, height: line, borderRadius: line / 2, backgroundColor: tint }} />
          </View>
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
    case 'pen':
      return (
        <View {...hidden} style={box}>
          <View style={{ width: line * 1.6, height: size * 0.72, backgroundColor: tint, borderRadius: line * 0.4, transform: [{ rotate: '40deg' }] }} />
          <View style={{ position: 'absolute', bottom: size * 0.06, width: size * 0.8, height: line, borderRadius: line / 2, backgroundColor: tint }} />
        </View>
      );
    case 'decide':
      // tờ trình có dấu tích: việc chờ quyết
      return (
        <View {...hidden} style={box}>
          <View
            style={{
              width: size * 0.74,
              height: size * 0.94,
              borderRadius: size * 0.1,
              borderWidth: line,
              borderColor: tint,
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <View
              style={{
                width: size * 0.22,
                height: size * 0.4,
                borderRightWidth: line,
                borderBottomWidth: line,
                borderColor: tint,
                transform: [{ rotate: '45deg' }, { translateY: -size * 0.04 }],
              }}
            />
          </View>
        </View>
      );
  }
}
