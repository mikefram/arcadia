import ExpoModulesCore

struct DuplexStartOptions: Record {
  @Field var voiceProcessing: Bool = true
  @Field var voiceChatMode: Bool = true
  @Field var frameMs: Int = 50
  /// false: chỉ gửi mức âm, không gửi PCM (màn đo khử vọng không cần nghe lại tiếng).
  @Field var emitPcm: Bool = true
}

internal final class DuplexAudioException: GenericException<String>, @unchecked Sendable {
  override var reason: String {
    "DuplexAudio: \(param)"
  }
}

/// Mô-đun Expo nội bộ: thu micro và phát tiếng trợ lý trong MỘT engine có khử tiếng vọng. Giao diện JS ở src/duplex/types.ts.
/// Không chạy trong Expo Go (Expo Go không nạp mô-đun gốc của app); phía JS nhận ra bằng `requireOptionalNativeModule`.
public final class DuplexAudioModule: Module {
  private let engine = DuplexAudioEngine()
  private var emitPcm = true

  public func definition() -> ModuleDefinition {
    Name("DuplexAudio")

    Events("onFrame", "onPlayback", "onState")

    OnCreate {
      self.engine.onFrame = { [weak self] frame, referenceDb, atMs in
        guard let self else { return }
        var body: [String: Any?] = [
          "micDb": Double(frame.rmsDb),
          "peakDb": Double(frame.peakDb),
          "refDb": Double(referenceDb),
          "t": atMs,
        ]
        if self.emitPcm { body["pcm"] = frame.pcm.base64EncodedString() }
        self.sendEvent("onFrame", body)
      }
      self.engine.onPlayback = { [weak self] state in
        self?.sendEvent("onPlayback", ["state": state])
      }
      self.engine.onState = { [weak self] state, detail in
        self?.sendEvent("onState", ["state": state, "detail": detail])
      }
    }

    OnDestroy {
      self.engine.stop()
    }

    AsyncFunction("start") { (options: DuplexStartOptions) -> [String: Any] in
      self.emitPcm = options.emitPcm
      do {
        let info = try self.engine.start(
          DuplexOptions(voiceProcessing: options.voiceProcessing, voiceChatMode: options.voiceChatMode, frameMs: options.frameMs)
        )
        return [
          "inputSampleRate": info.inputSampleRate,
          "inputChannels": info.inputChannels,
          "voiceProcessing": info.voiceProcessing,
          "route": info.route,
        ]
      } catch {
        throw DuplexAudioException(String(describing: error))
      }
    }

    AsyncFunction("stop") { () -> Void in
      self.engine.stop()
    }

    AsyncFunction("playFile") { (uri: String) -> Void in
      do {
        try self.engine.playFile(uri)
      } catch {
        throw DuplexAudioException(String(describing: error))
      }
    }

    AsyncFunction("stopPlayback") { () -> Void in
      self.engine.stopPlayback()
    }

    Function("getRoute") { () -> String in
      DuplexAudioEngine.routeDescription()
    }
  }
}
