import AVFoundation

struct DuplexOptions {
  /// Bật voice processing của AVAudioEngine: khử tiếng vọng, giảm ồn, chỉnh âm lượng tự động.
  var voiceProcessing = true
  /// true: phiên âm thanh ở chế độ `.voiceChat`; false: `.default` (vẫn khử vọng nếu `voiceProcessing`). Để so sánh trên máy thật.
  var voiceChatMode = true
  var frameMs = 50
}

struct DuplexStartInfo {
  let inputSampleRate: Double
  let inputChannels: Int
  let voiceProcessing: Bool
  let route: String
}

enum DuplexError: Error, CustomStringConvertible {
  case notStarted
  case badFile(String)
  case engine(String)
  case session(String)

  var description: String {
    switch self {
    case .notStarted: return "engine_not_started"
    case .badFile(let detail): return "bad_file: \(detail)"
    case .engine(let detail): return "engine: \(detail)"
    case .session(let detail): return "session: \(detail)"
    }
  }
}

/// MỘT AVAudioEngine vừa thu micro vừa phát tiếng trợ lý (SPEC 6.6, docs/DECISIONS.md "Ngắt lời bằng giọng nói").
///
/// Vì sao một engine: voice processing của iOS chỉ trừ ra khỏi micro những gì chính engine đó phát ra loa
/// (nút vào và nút ra của cùng một engine, WWDC19 phiên 510). Phát bằng trình phát khác (AVPlayer của expo-audio,
/// engine thứ hai) thì micro vẫn nghe lại tiếng loa, và trợ lý sẽ tự ngắt lời chính mình.
///
/// Mọi thay đổi trạng thái chạy trên một hàng đợi tuần tự. Hai khối tap (micro, bộ trộn) chạy trên luồng riêng của
/// AVAudioEngine và chỉ đọc những gì đã chụp lúc mở, không đụng trường của lớp ngoài việc khoá mức tham chiếu.
final class DuplexAudioEngine {
  /// Khung thu: khung PCM, mức tín hiệu đang phát ra loa lúc đó (dBFS), thời điểm tính bằng mili giây từ lúc mở.
  var onFrame: ((PcmFrame, Float, Double) -> Void)?
  /// `started`, `ended`, `stopped`.
  var onPlayback: ((String) -> Void)?
  /// `("stopped", lý do)` hoặc `("route", mô tả tuyến âm thanh)`.
  var onState: ((String, String) -> Void)?

  /// Định dạng nút phát: 24 kHz đơn kênh, bằng tần số mặc định của TTS. Bộ trộn tự đổi sang tần số của loa.
  static let playerFormat = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 24_000, channels: 1, interleaved: false)!

  private let queue = DispatchQueue(label: "vn.mihato.duplex-audio")
  private var engine: AVAudioEngine?
  private var player: AVAudioPlayerNode?
  private var playerToken: UInt64 = 0
  private var playing = false
  private var observers: [NSObjectProtocol] = []

  private let referenceLock = NSLock()
  private var referenceDb: Float = PcmFramePipeline.silenceDb

  // MARK: - Thu

  func start(_ options: DuplexOptions) throws -> DuplexStartInfo {
    try queue.sync { try startLocked(options) }
  }

  func stop() {
    queue.sync { stopLocked(reason: nil) }
  }

  private func startLocked(_ options: DuplexOptions) throws -> DuplexStartInfo {
    stopLocked(reason: nil)
    try activateSession(options)

    let engine = AVAudioEngine()
    let input = engine.inputNode
    if options.voiceProcessing {
      do {
        try input.setVoiceProcessingEnabled(true)
      } catch {
        deactivateSession()
        throw DuplexError.engine("voice_processing: \(error.localizedDescription)")
      }
    }

    // Nối nút phát SAU khi đã bật voice processing: bật sau thì định dạng của nút ra đổi và các nối cũ hỏng.
    let player = AVAudioPlayerNode()
    engine.attach(player)
    engine.connect(player, to: engine.mainMixerNode, format: Self.playerFormat)

    guard let pipeline = PcmFramePipeline(frameMs: options.frameMs) else {
      deactivateSession()
      throw DuplexError.engine("bad_frame_ms")
    }
    let began = DispatchTime.now().uptimeNanoseconds
    let frameMs = Double(options.frameMs)

    // `format: nil`: lấy đúng định dạng của nút lúc chạy. Truyền định dạng đọc trước khi mở engine có thể lệch
    // định dạng phần cứng và AVAudioEngine ném ngoại lệ Objective-C, mà Swift không bắt được.
    input.installTap(onBus: 0, bufferSize: 1024, format: nil) { [weak self] buffer, _ in
      guard let self, let channels = buffer.floatChannelData else { return }
      let frames = pipeline.push(channels[0], count: Int(buffer.frameLength), sampleRate: buffer.format.sampleRate)
      guard !frames.isEmpty else { return }
      let now = Double(DispatchTime.now().uptimeNanoseconds - began) / 1_000_000
      let reference = self.currentReference()
      for (index, frame) in frames.enumerated() {
        self.onFrame?(frame, reference, now - Double(frames.count - 1 - index) * frameMs)
      }
    }
    // Mức tín hiệu thật sự đi ra loa (sau bộ trộn), để so với mức micro nghe lại: đó là độ khử vọng.
    engine.mainMixerNode.installTap(onBus: 0, bufferSize: 1024, format: nil) { [weak self] buffer, _ in
      guard let self, let channels = buffer.floatChannelData else { return }
      self.setReference(PcmFramePipeline.rmsDb(channels[0], count: Int(buffer.frameLength)))
    }

    engine.prepare()
    do {
      try engine.start()
    } catch {
      input.removeTap(onBus: 0)
      engine.mainMixerNode.removeTap(onBus: 0)
      deactivateSession()
      throw DuplexError.engine("start: \(error.localizedDescription)")
    }

    self.engine = engine
    self.player = player
    observe(engine)

    let format = input.outputFormat(forBus: 0)
    return DuplexStartInfo(
      inputSampleRate: format.sampleRate,
      inputChannels: Int(format.channelCount),
      voiceProcessing: input.isVoiceProcessingEnabled,
      route: Self.routeDescription()
    )
  }

  private func stopLocked(reason: String?) {
    guard let engine else { return }
    for token in observers { NotificationCenter.default.removeObserver(token) }
    observers.removeAll()

    playerToken &+= 1
    let wasPlaying = playing
    playing = false
    player?.stop()
    engine.inputNode.removeTap(onBus: 0)
    engine.mainMixerNode.removeTap(onBus: 0)
    engine.stop()
    self.engine = nil
    self.player = nil
    setReference(PcmFramePipeline.silenceDb)
    deactivateSession()

    if wasPlaying { onPlayback?("stopped") }
    if let reason { onState?("stopped", reason) }
  }

  // MARK: - Phát

  func playFile(_ uri: String) throws {
    let url = uri.hasPrefix("file://") ? (URL(string: uri) ?? URL(fileURLWithPath: uri)) : URL(fileURLWithPath: uri)
    try queue.sync { try playLocked(url) }
  }

  func stopPlayback() {
    queue.sync {
      playerToken &+= 1
      player?.stop()
      if playing {
        playing = false
        onPlayback?("stopped")
      }
    }
  }

  private func playLocked(_ url: URL) throws {
    guard let engine, let player, engine.isRunning else { throw DuplexError.notStarted }
    let file: AVAudioFile
    do {
      file = try AVAudioFile(forReading: url)
    } catch {
      throw DuplexError.badFile(error.localizedDescription)
    }
    let buffer = try Self.decode(file)

    // Đổi số thứ tự trước: khối hoàn tất của đoạn đang phát dở (bị `stop()` gọi ra) thấy số cũ thì bỏ qua.
    playerToken &+= 1
    let token = playerToken
    player.stop()
    playing = true
    player.scheduleBuffer(buffer, at: nil, options: [], completionCallbackType: .dataPlayedBack) { [weak self] _ in
      self?.queue.async {
        guard let self, self.playerToken == token, self.playing else { return }
        self.playing = false
        self.onPlayback?("ended")
      }
    }
    player.play()
    onPlayback?("started")
  }

  /// Đọc cả tệp (wav, mp3, m4a…), xuống đơn kênh, đổi sang 24 kHz số thực. Đoạn đọc của trợ lý ngắn (dưới một phút).
  private static func decode(_ file: AVAudioFile) throws -> AVAudioPCMBuffer {
    let length = AVAudioFrameCount(file.length)
    guard length > 0, let input = AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: length) else {
      throw DuplexError.badFile("empty")
    }
    do {
      try file.read(into: input)
    } catch {
      throw DuplexError.badFile(error.localizedDescription)
    }
    guard let mono = monoBuffer(from: input), let converter = AVAudioConverter(from: mono.format, to: playerFormat) else {
      throw DuplexError.badFile("convert")
    }
    converter.primeMethod = .none
    let capacity = AVAudioFrameCount((Double(mono.frameLength) * playerFormat.sampleRate / mono.format.sampleRate).rounded(.up)) + 256
    guard let output = AVAudioPCMBuffer(pcmFormat: playerFormat, frameCapacity: capacity) else {
      throw DuplexError.badFile("alloc")
    }
    var supplied = false
    var error: NSError?
    let status = converter.convert(to: output, error: &error) { _, inputStatus in
      if supplied {
        inputStatus.pointee = .endOfStream
        return nil
      }
      supplied = true
      inputStatus.pointee = .haveData
      return mono
    }
    if status == .error || error != nil { throw DuplexError.badFile(error?.localizedDescription ?? "convert") }
    return output
  }

  private static func monoBuffer(from buffer: AVAudioPCMBuffer) -> AVAudioPCMBuffer? {
    let channels = Int(buffer.format.channelCount)
    if channels == 1 { return buffer }
    guard let data = buffer.floatChannelData,
          let format = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: buffer.format.sampleRate, channels: 1, interleaved: false),
          let mono = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: buffer.frameLength),
          let target = mono.floatChannelData
    else { return nil }
    mono.frameLength = buffer.frameLength
    for index in 0..<Int(buffer.frameLength) {
      var sum: Float = 0
      for channel in 0..<channels { sum += data[channel][index] }
      target[0][index] = sum / Float(channels)
    }
    return mono
  }

  // MARK: - Phiên âm thanh và thông báo của hệ điều hành

  private func activateSession(_ options: DuplexOptions) throws {
#if os(iOS)
    let session = AVAudioSession.sharedInstance()
    do {
      try session.setCategory(
        .playAndRecord,
        mode: options.voiceChatMode ? .voiceChat : .default,
        options: [.defaultToSpeaker, .allowBluetooth]
      )
      try session.setActive(true)
      // Chế độ voiceChat mặc định ra loa trong (nghe điện thoại). Chỉ chuyển sang loa ngoài khi đang ở loa trong:
      // có tai nghe hay Bluetooth thì giữ nguyên.
      if session.currentRoute.outputs.contains(where: { $0.portType == .builtInReceiver }) {
        try session.overrideOutputAudioPort(.speaker)
      }
    } catch {
      throw DuplexError.session(error.localizedDescription)
    }
#endif
  }

  private func deactivateSession() {
#if os(iOS)
    try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
#endif
  }

  private func observe(_ engine: AVAudioEngine) {
    let center = NotificationCenter.default
    // Đổi tuyến (cắm tai nghe, Bluetooth), hay hệ điều hành dừng engine: dừng hẳn và báo, để phía JS quyết có mở lại không.
    observers.append(center.addObserver(forName: .AVAudioEngineConfigurationChange, object: engine, queue: nil) { [weak self] _ in
      self?.queue.async { self?.stopLocked(reason: "config_change") }
    })
#if os(iOS)
    observers.append(center.addObserver(forName: AVAudioSession.interruptionNotification, object: nil, queue: nil) { [weak self] note in
      guard let raw = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
            AVAudioSession.InterruptionType(rawValue: raw) == .began
      else { return }
      self?.queue.async { self?.stopLocked(reason: "interruption") }
    })
    observers.append(center.addObserver(forName: AVAudioSession.routeChangeNotification, object: nil, queue: nil) { [weak self] _ in
      self?.onState?("route", Self.routeDescription())
    })
#endif
  }

  static func routeDescription() -> String {
#if os(iOS)
    let route = AVAudioSession.sharedInstance().currentRoute
    let outputs = route.outputs.map { $0.portType.rawValue }.joined(separator: "+")
    let inputs = route.inputs.map { $0.portType.rawValue }.joined(separator: "+")
    return "\(outputs.isEmpty ? "-" : outputs) / \(inputs.isEmpty ? "-" : inputs)"
#else
    return "macOS"
#endif
  }

  // MARK: - Mức tham chiếu

  private func currentReference() -> Float {
    referenceLock.lock()
    defer { referenceLock.unlock() }
    return referenceDb
  }

  private func setReference(_ value: Float) {
    referenceLock.lock()
    referenceDb = value
    referenceLock.unlock()
  }
}
