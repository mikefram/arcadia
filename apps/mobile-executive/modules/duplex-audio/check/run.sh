#!/usr/bin/env bash
# Kiểm phần Swift của mô-đun mà KHÔNG cần Xcode hay iPhone: chỉ cần Command Line Tools trên Mac.
#   1. kiểu: engine thu và phát biên dịch được (phần chỉ có ở iOS nằm trong #if os(iOS) nên chưa được kiểm ở đây)
#   2. chạy: bộ đổi tần số và cắt khung cho kết quả đúng với tín hiệu tổng hợp
# Không kiểm được bằng cách này: khử tiếng vọng thật, phiên âm thanh iOS, lớp nối Expo (DuplexAudioModule.swift).
# Ba thứ đó chỉ biết được khi dựng bằng Xcode và thử trên iPhone.
set -euo pipefail
cd "$(dirname "$0")"
IOS=../ios
OUT="${TMPDIR:-/tmp}/duplex-audio-check"
mkdir -p "$OUT"

echo "1/2 kiểm kiểu engine thu và phát"
swiftc -swift-version 5 -typecheck "$IOS/PcmFramePipeline.swift" "$IOS/DuplexAudioEngine.swift"

echo "2/2 chạy thử bộ đổi tần số và cắt khung"
swiftc -swift-version 5 -O "$IOS/PcmFramePipeline.swift" main.swift -o "$OUT/pipeline-check"
"$OUT/pipeline-check"
