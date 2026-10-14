import AVFoundation
import Foundation

// Kiểm bộ đổi tần số và cắt khung của PcmFramePipeline bằng tín hiệu tổng hợp.
// Không cần Xcode, micro, loa hay iPhone: chỉ cần trình biên dịch Swift của Command Line Tools. Chạy bằng check/run.sh.

var failures = 0
var checks = 0

func expect(_ condition: @autoclosure () -> Bool, _ message: @autoclosure () -> String) {
  checks += 1
  if condition() { return }
  failures += 1
  print("HỎNG: \(message())")
}

func sine(rate: Double, seconds: Double, frequency: Double, amplitude: Float) -> [Float] {
  (0..<Int(rate * seconds)).map { amplitude * Float(sin(2 * Double.pi * frequency * Double($0) / rate)) }
}

func feed(_ pipeline: PcmFramePipeline, _ input: [Float], rate: Double, chunk: Int) -> [PcmFrame] {
  var frames: [PcmFrame] = []
  var offset = 0
  while offset < input.count {
    let count = min(chunk, input.count - offset)
    input.withUnsafeBufferPointer { pointer in
      frames += pipeline.push(pointer.baseAddress! + offset, count: count, sampleRate: rate)
    }
    offset += count
  }
  return frames
}

func samples(of frames: [PcmFrame]) -> [Int16] {
  var all: [Int16] = []
  for frame in frames {
    frame.pcm.withUnsafeBytes { raw in all += Array(raw.bindMemory(to: Int16.self)) }
  }
  return all
}

/// Tần số ước lượng bằng số lần tín hiệu đổi dấu qua 0.
func frequency(of pcm: [Int16], rate: Double) -> Double {
  var crossings = 0
  for index in 1..<pcm.count where (pcm[index - 1] < 0) != (pcm[index] < 0) { crossings += 1 }
  return Double(crossings) / 2 / (Double(pcm.count) / rate)
}

// 1. Sóng sin 440 Hz biên độ 0,5 đi qua mọi tần số micro thường gặp và mọi cỡ khối.
//    RMS phải là -9,03 dBFS, đỉnh -6,02 dBFS, tần số giữ nguyên, mỗi khung đúng 50 ms (800 mẫu, 1600 byte).
let cases: [(rate: Double, chunk: Int)] = [(48_000, 1024), (48_000, 4800), (44_100, 441), (24_000, 1024), (16_000, 1600), (16_000, 333)]
for item in cases {
  let name = "\(Int(item.rate)) Hz, khối \(item.chunk)"
  guard let pipeline = PcmFramePipeline(frameMs: 50) else {
    expect(false, "\(name): không tạo được pipeline")
    continue
  }
  let frames = feed(pipeline, sine(rate: item.rate, seconds: 2, frequency: 440, amplitude: 0.5), rate: item.rate, chunk: item.chunk)
  // 2 giây = 40 khung; bộ đổi tần số giữ lại vài mẫu nên chấp nhận thiếu tối đa 2 khung.
  expect(frames.count >= 38 && frames.count <= 40, "\(name): số khung \(frames.count), cần 38 đến 40")
  expect(frames.allSatisfy { $0.pcm.count == 1600 }, "\(name): mỗi khung phải 1600 byte")
  for frame in frames.dropFirst(2) {
    expect(abs(frame.rmsDb - (-9.03)) < 0.6, "\(name): RMS \(frame.rmsDb) dBFS, cần -9,03")
    expect(abs(frame.peakDb - (-6.02)) < 0.8, "\(name): đỉnh \(frame.peakDb) dBFS, cần -6,02")
  }
  let measured = frequency(of: samples(of: frames), rate: 16_000)
  expect(abs(measured - 440) < 10, "\(name): tần số \(measured) Hz, cần 440")
}

// 2. Im lặng: mọi khung đúng -120 dBFS, không ra vô cực hay NaN.
if let pipeline = PcmFramePipeline(frameMs: 50) {
  let frames = feed(pipeline, [Float](repeating: 0, count: 48_000), rate: 48_000, chunk: 1024)
  expect(frames.count >= 18, "im lặng: số khung \(frames.count)")
  expect(frames.allSatisfy { $0.rmsDb == -120 && $0.peakDb == -120 }, "im lặng: mức phải là -120 dBFS")
}

// 3. Quá toàn thang (biên độ 1,5): bị cắt ở toàn thang, không tràn số, không sập.
if let pipeline = PcmFramePipeline(frameMs: 50) {
  let frames = feed(pipeline, sine(rate: 48_000, seconds: 1, frequency: 300, amplitude: 1.5), rate: 48_000, chunk: 1024)
  expect(frames.count >= 18, "quá toàn thang: số khung \(frames.count)")
  expect(frames.dropFirst(2).allSatisfy { $0.peakDb > -0.5 && $0.peakDb <= 0 }, "quá toàn thang: đỉnh phải chạm toàn thang")
}

// 4. Đổi tần số giữa chừng (cắm tai nghe Bluetooth: 48 kHz sang 16 kHz) vẫn ra khung đều, không sập.
if let pipeline = PcmFramePipeline(frameMs: 50) {
  var frames = feed(pipeline, sine(rate: 48_000, seconds: 1, frequency: 440, amplitude: 0.5), rate: 48_000, chunk: 1024)
  frames += feed(pipeline, sine(rate: 16_000, seconds: 1, frequency: 440, amplitude: 0.5), rate: 16_000, chunk: 512)
  expect(frames.count >= 36 && frames.count <= 40, "đổi tần số: số khung \(frames.count)")
  expect(frames.suffix(10).allSatisfy { abs($0.rmsDb - (-9.03)) < 0.6 }, "đổi tần số: sau khi đổi, mức phải đúng")
}

// 5. Khối rất nhỏ (7 mẫu mỗi lần) không làm mất mẫu.
if let pipeline = PcmFramePipeline(frameMs: 50) {
  let frames = feed(pipeline, sine(rate: 48_000, seconds: 2, frequency: 440, amplitude: 0.5), rate: 48_000, chunk: 7)
  expect(frames.count >= 36 && frames.count <= 40, "khối 7 mẫu: số khung \(frames.count)")
}

// 6. Tham số sai thì không tạo pipeline; khung 20 ms ra 640 byte.
expect(PcmFramePipeline(frameMs: 5) == nil, "khung 5 ms phải bị từ chối")
expect(PcmFramePipeline(frameMs: 300) == nil, "khung 300 ms phải bị từ chối")
if let pipeline = PcmFramePipeline(frameMs: 20) {
  let frames = feed(pipeline, sine(rate: 16_000, seconds: 1, frequency: 440, amplitude: 0.5), rate: 16_000, chunk: 1600)
  expect(frames.allSatisfy { $0.pcm.count == 640 }, "khung 20 ms phải 640 byte")
}

// 7. Hàm đổi dB.
expect(PcmFramePipeline.db(1.0) == 0, "db(1) phải là 0")
expect(PcmFramePipeline.db(0) == -120, "db(0) phải là -120")
expect(abs(PcmFramePipeline.db(0.1) - (-20)) < 0.01, "db(0,1) phải là -20")
let constant = [Float](repeating: 0.1, count: 480)
expect(constant.withUnsafeBufferPointer { abs(PcmFramePipeline.rmsDb($0.baseAddress!, count: 480) - (-20)) < 0.01 }, "rmsDb của hằng 0,1 phải là -20")

print("\(checks - failures)/\(checks) phép kiểm đạt")
exit(failures == 0 ? 0 : 1)
