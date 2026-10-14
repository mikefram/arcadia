import AVFoundation

/// Một khung âm thanh đã đổi về PCM 16-bit, đơn kênh, 16 kHz, kèm mức âm đo trên chính khung đó.
struct PcmFrame {
  let pcm: Data
  /// Căn bậc hai của trung bình bình phương, tính theo dBFS (0 là toàn thang, -120 là im lặng).
  let rmsDb: Float
  /// Mẫu lớn nhất trong khung, tính theo dBFS.
  let peakDb: Float
}

/// Đổi luồng mẫu số thực của micro (tần số nào cũng được) về PCM 16-bit, 16 kHz, đơn kênh rồi cắt thành khung đều nhau.
/// Lớp này không biết gì về phiên âm thanh hay engine, nên chạy thử được trên Mac bằng tín hiệu tổng hợp
/// (xem ../check/). Chỉ một luồng gọi `push` tại một thời điểm (luồng thu của engine).
final class PcmFramePipeline {
  static let silenceDb: Float = -120

  let targetRate: Double
  let frameSamples: Int

  private let outFormat: AVAudioFormat
  private var converter: AVAudioConverter?
  private var inputRate: Double = 0
  private var monoFormat: AVAudioFormat?
  private var monoBuffer: AVAudioPCMBuffer?
  private var pending: [Int16] = []

  init?(targetRate: Double = 16_000, frameMs: Int = 50) {
    guard (10...200).contains(frameMs),
          let format = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: targetRate, channels: 1, interleaved: true)
    else { return nil }
    self.targetRate = targetRate
    self.frameSamples = Int(targetRate) * frameMs / 1000
    self.outFormat = format
    self.pending.reserveCapacity(frameSamples * 4)
  }

  /// Bỏ mọi mẫu lẻ còn lại (bắt đầu phiên mới).
  func reset() {
    pending.removeAll(keepingCapacity: true)
    converter?.reset()
  }

  /// `samples` là kênh đầu của một khối micro (số thực, -1...1) ở tần số `sampleRate`. Trả về các khung đã đầy.
  /// Chỉ lấy kênh đầu: có máy trả nhiều kênh khi bật voice processing, và bộ đổi kênh của hệ điều hành
  /// không xuống đơn kênh được với mọi bố cục kênh.
  func push(_ samples: UnsafePointer<Float>, count: Int, sampleRate: Double) -> [PcmFrame] {
    guard count > 0, sampleRate > 0 else { return [] }
    if converter == nil || inputRate != sampleRate { configure(inputRate: sampleRate) }
    guard let converter, let mono = mono(capacity: count), let monoData = mono.floatChannelData else { return [] }

    mono.frameLength = AVAudioFrameCount(count)
    memcpy(monoData[0], samples, count * MemoryLayout<Float>.size)

    let capacity = AVAudioFrameCount((Double(count) * targetRate / sampleRate).rounded(.up)) + 32
    guard let out = AVAudioPCMBuffer(pcmFormat: outFormat, frameCapacity: capacity) else { return [] }

    var supplied = false
    var error: NSError?
    let status = converter.convert(to: out, error: &error) { _, inputStatus in
      if supplied {
        inputStatus.pointee = .noDataNow
        return nil
      }
      supplied = true
      inputStatus.pointee = .haveData
      return mono
    }
    if status == .error || error != nil { return [] }

    guard out.frameLength > 0, let channel = out.int16ChannelData else { return [] }
    pending.append(contentsOf: UnsafeBufferPointer(start: channel[0], count: Int(out.frameLength)))

    var frames: [PcmFrame] = []
    while pending.count >= frameSamples {
      let slice = Array(pending.prefix(frameSamples))
      pending.removeFirst(frameSamples)
      frames.append(Self.frame(from: slice))
    }
    return frames
  }

  private func configure(inputRate rate: Double) {
    inputRate = rate
    pending.removeAll(keepingCapacity: true)
    monoBuffer = nil
    guard let format = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: rate, channels: 1, interleaved: false),
          let made = AVAudioConverter(from: format, to: outFormat)
    else {
      converter = nil
      monoFormat = nil
      return
    }
    // Không mồi đầu: luồng thu liên tục, không cần chèn mẫu đệm ở đầu như khi đổi một tệp.
    made.primeMethod = .none
    monoFormat = format
    converter = made
  }

  private func mono(capacity: Int) -> AVAudioPCMBuffer? {
    if let buffer = monoBuffer, Int(buffer.frameCapacity) >= capacity { return buffer }
    guard let format = monoFormat else { return nil }
    monoBuffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(max(capacity, 4096)))
    return monoBuffer
  }

  private static func frame(from samples: [Int16]) -> PcmFrame {
    var sum = 0.0
    var peak: Int32 = 0
    for sample in samples {
      let value = Double(sample) / 32768.0
      sum += value * value
      peak = max(peak, abs(Int32(sample)))
    }
    let rms = (sum / Double(samples.count)).squareRoot()
    let data = samples.withUnsafeBufferPointer { Data(buffer: $0) }
    return PcmFrame(pcm: data, rmsDb: db(rms), peakDb: db(Double(peak) / 32768.0))
  }

  /// Biên độ tuyến tính (0...1) sang dBFS; dưới 1e-6 coi là im lặng để không ra vô cực.
  static func db(_ linear: Double) -> Float {
    guard linear > 1e-6 else { return silenceDb }
    return max(silenceDb, Float(20 * log10(linear)))
  }

  /// Mức RMS của một khối mẫu số thực, dBFS. Dùng cho tín hiệu đang phát ra loa (tham chiếu của bộ khử vọng).
  static func rmsDb(_ samples: UnsafePointer<Float>, count: Int) -> Float {
    guard count > 0 else { return silenceDb }
    var sum = 0.0
    for i in 0..<count {
      let value = Double(samples[i])
      sum += value * value
    }
    return db((sum / Double(count)).squareRoot())
  }
}
