# Dựng và phát hành hai app di động

Cập nhật 07/10/2026. Phạm vi đã chốt (docs/DECISIONS.md, mục "Hai app di động"): **chỉ VRG trước**, một máy chủ, hai app ghim vào máy chủ đó; chưa có logo hay nhận dạng thương hiệu.
Hai app: `apps/mobile-executive` (bundle `vn.mihato.dieuhanh`, scheme `mihato-exec`) và `apps/mobile-staff` (bundle `vn.mihato.viectoi`, scheme `mihato`).
Mỗi app có `app.json` (tĩnh), `app.config.ts` (chọn theo biến môi trường lúc dựng), `eas.json` (hồ sơ dựng và nộp). Các lệnh `eas` chạy **từ thư mục của từng app**, không chạy ở gốc kho.

**Tình trạng:** cấu hình đã kiểm bằng `npx expo config`, test Vitest và `expo export`. **Chưa dựng bản gốc lần nào, chưa chạy `eas`, chưa thử trên máy thật** (chưa có tài khoản Expo, Apple, Google). Mọi mục "chưa kiểm" ở cuối tài liệu này.

## 1. Ai làm gì

| Việc | Ai | Ghi chú |
| --- | --- | --- |
| Chốt pháp nhân đứng tên và mã D-U-N-S, website công khai, email theo tên miền (Q3) | Mike | Điều kiện của cả Apple và Google; chưa có thì mọi bước dưới chỉ làm được đến `expo export` |
| Đăng ký Apple Developer Program loại Organization (99 USD/năm) và Google Play Console tổ chức (25 USD) | Mike hoặc người được uỷ quyền | Thời gian xét duyệt chưa kiểm chứng |
| Chính sách quyền riêng tư công khai bằng tiếng Việt (có bản tóm tắt tiếng Anh), nêu Deepgram, Anthropic, Vbee, Expo/APNs/FCM, thời hạn lưu, cách xoá | Pháp chế cùng Mike; hạ tầng chỉ đăng trang | Địa chỉ đặt vào `MIHATO_PRIVACY_POLICY_URL` |
| Tạo máy chủ production có https, đặt `PUSH_PROVIDER=expo` và `EXPO_ACCESS_TOKEN` | Hạ tầng | Địa chỉ gốc API thành `MIHATO_API_BASE_URL` |
| Tạo tổ chức Expo, chạy `eas init` hai lần, đặt biến môi trường, tải khoá APNs và FCM lên EAS | Mike hoặc người giữ tài khoản Expo | Mục 3 và 4 |
| Tạo bản ghi app trên App Store Connect và Play Console, điền `ascAppId`, `appleTeamId`, tài khoản dịch vụ Play vào `eas.json` | Mike | Không bịa: `eas.json` đang để chuỗi mẫu `<DIEN-…>` |
| Chạy `eas build`, `eas submit`, thử trên máy thật, ghi kết quả vào docs/DECISIONS.md | Dev, có máy iPhone và Android | Mục 5 đến 8 |

## 2. Biến môi trường lúc dựng

`app.config.ts` đọc các biến sau. Loại bản dựng chọn bằng `APP_VARIANT` hoặc hồ sơ EAS (`EAS_BUILD_PROFILE`, EAS tự đặt):

| Loại | Chọn bằng | Bắt buộc | Tác dụng |
| --- | --- | --- | --- |
| `production` | `APP_VARIANT=production` hoặc hồ sơ EAS `production` | `MIHATO_API_BASE_URL` (https), `EAS_PROJECT_ID` | Ghim máy chủ; thiếu hoặc không phải https thì **không dựng được** |
| `preview` | `APP_VARIANT=preview` hoặc hồ sơ EAS `preview` | `EAS_PROJECT_ID`; `MIHATO_API_BASE_URL` tuỳ chọn (nếu có phải https) | Bản nội bộ để thử; ATS chặt như production |
| `dev` (chỉ app Chủ tịch) | `APP_VARIANT=dev` | không | Bản Xcode với Apple ID miễn phí (README, "Bản dựng thử trên iPhone"): mã gói thêm `.dev`, bỏ thông báo đẩy. **Không dùng cho EAS** |
| `local` | không đặt gì (`expo start`, Expo Go, hồ sơ EAS `development`) | không | Giữ nguyên `app.json`; cho phép http mạng nội bộ như trước |

| Biến | Thành | Ghi chú |
| --- | --- | --- |
| `MIHATO_API_BASE_URL` | `extra.apiBaseUrl` | Chỉ địa chỉ gốc, không kèm đường dẫn `/v1`, tài khoản hay tham số. **Khi đã ghim, app bỏ qua `api=` trong đường dẫn kích hoạt và mã QR**, và từ chối nếu bản phân phối thiếu địa chỉ ghim (`resolveApiBaseUrl`) |
| `EAS_PROJECT_ID` | `extra.eas.projectId` | UUID do `eas init` cấp. Không có mã này thì không lấy được Expo push token. Giá trị không phải UUID bị từ chối. **Không bịa mã** |
| `MIHATO_PRIVACY_POLICY_URL` | `extra.privacyPolicyUrl` | https, tuỳ chọn. Có thì hai app hiện nút "Xem chính sách quyền riêng tư" ở màn yêu cầu xoá dữ liệu. **Phải có trước khi nộp App Store hoặc mở Play ngoài nhóm nội bộ** |
| `EXPO_OWNER` | `owner` | Tên tổ chức Expo, tuỳ chọn |
| `APPLE_TEAM_ID` | `ios.appleTeamId` | Chỉ cho `APP_VARIANT=dev` |

Cách đặt trên EAS (mỗi môi trường `preview` và `production` một lần; giá trị không phải bí mật nên dùng `plaintext`):

```bash
cd apps/mobile-executive   # rồi lặp lại ở apps/mobile-staff, riêng EAS_PROJECT_ID khác nhau giữa hai app
eas env:create --environment production --name MIHATO_API_BASE_URL --value https://<địa-chỉ-api> --visibility plaintext
eas env:create --environment production --name EAS_PROJECT_ID --value <uuid-từ-eas-init> --visibility plaintext
eas env:create --environment production --name MIHATO_PRIVACY_POLICY_URL --value https://<địa-chỉ-chính-sách> --visibility plaintext
```

Muốn kiểm trước khi gửi lên EAS: `APP_VARIANT=production MIHATO_API_BASE_URL=https://… EAS_PROJECT_ID=… npx expo config --type public` (in `extra`), hoặc `--type introspect` (in Info.plist sẽ sinh).

## 3. Tài khoản và dự án Expo (`eas init`)

1. Tạo tổ chức Expo của pháp nhân trên expo.dev; thêm người dựng vào tổ chức. Mọi chứng chỉ và khoá ký nằm ở đây, không để trên máy cá nhân.
2. `npm i -g eas-cli` (đã thử cú pháp với eas-cli 24; `eas.json` yêu cầu `>= 18.0.0`), `eas login`.
3. Trong **từng** thư mục app: `eas init`. Vì cấu hình là `app.config.ts` (động), lệnh này không tự ghi vào tệp: nó in `projectId`; ghi mã đó vào biến `EAS_PROJECT_ID` (mục 2). Hai app là hai dự án EAS riêng (slug `mihato-dieu-hanh` và `mihato-viec-cua-toi`), nên hai mã khác nhau.

## 4. Thông báo đẩy: APNs và FCM

- **iOS (APNs):** App ID phải bật Push Notifications. Chạy `eas credentials --platform ios` rồi chọn tạo hoặc tải khoá APNs `.p8` lên EAS; một khoá dùng chung được cho cả hai bundle id trong cùng đội. Entitlement `aps-environment` trong cấu hình là `development`: đúng, EAS đổi sang `production` khi ký bằng hồ sơ App Store.
- **Android (FCM v1):** tạo dự án Firebase của pháp nhân với hai app Android (`vn.mihato.dieuhanh`, `vn.mihato.viectoi`). Tải khoá tài khoản dịch vụ FCM lên EAS: `eas credentials --platform android` → Google Service Account → FCM V1. Rồi khai `android.googleServicesFile` (tệp `google-services.json` của từng app, chỉ chứa định danh công khai) trong `app.json`; chưa khai vì chưa có tệp.
- **Máy chủ:** `PUSH_PROVIDER=expo` và `EXPO_ACCESS_TOKEN` (README, "Cấu hình khi triển khai"; việc của hạ tầng, chưa làm: docs/RA-SOAT-2026-10-07.md, android-release-10).
- **Kiểm:** kích hoạt trên một iPhone và một Android thật bằng bản `preview`, tạo việc để sinh thông báo, chạm thông báo phải mở đúng màn. Nếu bước "Cho phép thông báo" hiện câu "chưa được cấu hình để nhận thông báo" thì thiếu `EAS_PROJECT_ID` trong bản dựng; "chưa đăng ký được" thì xem mạng, khoá APNs, FCM.

## 5. Bản preview (nội bộ, để thử)

```bash
cd apps/mobile-executive            # và apps/mobile-staff
eas build --profile preview --platform android   # .apk, cài thẳng
eas build --profile preview --platform ios       # cần đăng ký UDID từng máy: eas device:create
```

Bản preview phân phối nội bộ iOS dùng hồ sơ ad-hoc (tối đa 100 máy mỗi năm thành viên). Muốn thử rộng hơn thì dùng TestFlight (mục 6).

## 6. TestFlight và Unlisted App Distribution (iOS)

Khuyến nghị đã nêu ở docs/RA-SOAT-2026-10-07.md: **Unlisted App Distribution** cho phân phối thật; TestFlight chỉ để thử (bản dựng hết hạn sau 90 ngày, nội bộ tối đa 100 người). Không nộp công khai: app dành cho một tổ chức nên có rủi ro bị từ chối theo mục 3.2. Enterprise Program không dùng được cho VRG. Custom Apps cần mỗi tổ chức nhận có tài khoản Apple Business và D-U-N-S (chưa xác nhận được cho tổ chức Việt Nam). Kênh iOS **chưa được Mike chốt (Q20)**.

1. Tạo bản ghi app trên App Store Connect cho từng bundle id, loại **Public** (không chọn Private: Private không đổi sang Unlisted được). Lấy `ascAppId` (App Information → General) và `appleTeamId` điền vào `eas.json`, mục `submit.production.ios`.
2. Dựng và nộp: `eas build --profile production --platform ios --auto-submit` (hoặc `eas submit --profile production --platform ios`). Xác thực bằng khoá App Store Connect API (vai trò App Manager) tải lên EAS qua `eas credentials`; không dùng Apple ID cá nhân, không commit `.p8`.
3. Khai trong App Store Connect: Privacy Policy URL; App Privacy (nhãn quyền riêng tư) theo docs/compliance/data-flows.md (Audio Data của app Chủ tịch, Name, User ID, Device ID, Other User Content; không theo dõi). **`ios.privacyManifests.NSPrivacyCollectedDataTypes` trong `app.json` là bản nháp** khớp danh sách này; pháp chế duyệt rồi mới coi là chốt.
4. Bản đầu cho TestFlight ngoài và mọi lần nộp App Review cần **tài khoản demo đủ thời hạn**: mã kích hoạt hiện hết hạn sau 72 giờ và dùng một lần nên không đủ (docs/RA-SOAT, ios-7). Cần máy chủ demo công khai https với tổ chức demo và hai tài khoản (một Chủ tịch, một nhân viên); chưa làm.
5. Trong Review Notes ghi rõ: app nội bộ của VRG, đăng nhập bằng mã do Văn phòng cấp, không đăng ký tự do, yêu cầu phân phối Unlisted. Sau khi qua App Review, gửi form Unlisted tại trang Apple "Unlisted App Distribution".
6. Sau lần tải lên đầu, xem email của Apple trong vài phút: cảnh báo thiếu lý do API (ITMS-91053) nghĩa là `privacyManifests` thiếu; chạy "Generate Privacy Report" trong Xcode Organizer.
7. TestFlight hết hạn bản dựng sau 90 ngày: lịch dựng lại mỗi 60 ngày và cảnh báo CI còn dưới 21 ngày theo SPEC 12.5 điều 1 **chưa làm**.

**Apple 5.1.1(v) (xoá tài khoản):** app không tạo tài khoản (tài khoản do Văn phòng cấp), nên chữ nghĩa của điều này không bắt buộc nút xoá, nhưng Apple không công bố ngoại lệ. Cả hai app có màn "Yêu cầu xoá dữ liệu hoặc thu hồi thiết bị" (app nhân viên: Tôi; app Chủ tịch: Cài đặt → Dữ liệu của tôi): đăng xuất xoá dữ liệu trên máy và thu hồi thiết bị; dữ liệu trên máy chủ xoá qua Văn phòng; có nút chính sách khi bản dựng có `MIHATO_PRIVACY_POLICY_URL`. Nên nêu trong Review Notes. Công cụ xuất và xoá dữ liệu một người là Giai đoạn 4 (SPEC 11.7); đầu mối `dataContact` (Q24) chưa có.

## 7. Google Play

1. Tạo hai app trên Play Console (`vn.mihato.dieuhanh`, `vn.mihato.viectoi`), bật **Play App Signing**. Để EAS giữ upload keystore (`eas credentials`); tải bản sao keystore và mật khẩu về két mật khẩu của IT, không để trên máy cá nhân. Chưa có quyết định chính thức về người giữ khoá ký (docs/RA-SOAT, android-release-5).
2. Tạo tài khoản dịch vụ Google (Cloud) có quyền Release manager trên cả hai app; tải khoá JSON về `apps/<app>/secrets/google-play-service-account.json` (thư mục `secrets/` đã bị `.gitignore`) hoặc tải lên EAS.
3. `eas build --profile production --platform android` (ra `.aab`), rồi `eas submit --profile production --platform android`: mặc định vào track **internal testing** ở dạng nháp (`releaseStatus: draft`). Internal testing cho nhóm lãnh đạo; closed testing cho toàn bộ nhân viên; không mở production công khai. Phải điền xong Store listing, Data safety, Content rating thì bản mới rời trạng thái nháp.
4. Quyền Android: `app.json` chặn `READ_MEDIA_IMAGES`, `READ_EXTERNAL_STORAGE`, `WRITE_EXTERNAL_STORAGE` mà `expo-screen-capture` và `expo-file-system` kéo theo (hai app không đọc thư viện ảnh). Sau lần dựng đầu, đọc manifest đã gộp (`aapt dump permissions` hoặc báo cáo của Play Console) và đối chiếu với tờ khai.
5. targetSdk 36 do SDK 57 mặc định; không hạ.
6. App Chủ tịch trên Android **chưa có ngắt lời bằng giọng nói** (mô-đun `duplex-audio` chỉ có iOS) và chưa dựng Android lần nào. Nếu 1.0 của app Chủ tịch chỉ cho iOS thì chỉ nộp Play cho app nhân viên (câu hỏi cho Mike).

## 8. Số phiên bản

`eas.json` đặt `appVersionSource: remote` và `autoIncrement: true` cho hồ sơ `production`: EAS tự tăng `buildNumber` (iOS) và `versionCode` (Android); `app.json` chỉ giữ giá trị khởi tạo (`"1"` và `1`) và `version` theo semver. Đổi `version` (ví dụ 1.0.1) khi phát hành bản mới, ghi tag git `mobile-staff/vX.Y.Z` hoặc `mobile-exec/vX.Y.Z`. Máy chủ so `X-App-Version` với `minAppVersion` của tổ chức (426 `app_update_required`); hiện **một** `minAppVersion` dùng chung cho cả hai app và app chưa có màn "cần cập nhật" (docs/RA-SOAT, android-release-14).

## 9. Điều đã quyết trong cấu hình (và lý do)

- **Không OTA:** `updates.enabled=false`, `runtimeVersion` theo `appVersion`; `expo-updates` không cài. Mỗi sửa đổi là một bản dựng mới (Q21). `channel` trong `eas.json` có mặt cho đủ ba hồ sơ nhưng chỉ có tác dụng khi sau này cài `expo-updates`.
- **`ios.config.usesNonExemptEncryption=false`** (khoá `ITSAppUsesNonExemptEncryption`): app chỉ dùng TLS của hệ điều hành. `@noble/curves` chỉ dùng để **ký** thử thách nâng quyền (ECDSA P-256) và băm SHA-256 cho mã PIN, không mã hoá dữ liệu; kho an toàn dùng Keychain và Keystore của hệ điều hành. Đây là phân tích của người viết cấu hình, **cần Mike hoặc pháp chế xác nhận**; Apple lưu ý có thể vẫn phải nộp báo cáo tự phân loại mã hoá hằng năm.
- **ATS chặt ở `preview` và `production`:** `NSAllowsArbitraryLoads=false` và `NSAllowsLocalNetworking=false`, nên bản phân phối chỉ nói chuyện với máy chủ https. Muốn thử với máy trong mạng nội bộ thì dùng bản `dev` hoặc `local`.
- **Không khai `UIBackgroundModes`:** `expo-audio` đã đặt `enableBackgroundRecording` và `enableBackgroundPlayback` là false; micro không bao giờ mở khi app ở nền.
- **Khoá dò máy phát triển (`NSBonjourServices`, câu xin quyền mạng nội bộ tiếng Anh của expo-dev-launcher):** bản phân phối gỡ ở Info.plist nguồn (mod trong `app.config.ts`), và dev-launcher còn một bước dựng gỡ khỏi bản không phải Debug. Bản `dev` của app Chủ tịch có câu tiếng Việt.
- **`ios.privacyManifests`:** khai bốn nhóm API cần lý do (UserDefaults `CA92.1`, FileTimestamp `C617.1`, SystemBootTime `35F9.1`, DiskSpace `E174.1`) và `NSPrivacyTracking=false`. Danh sách theo tra cứu Expo SDK 57; phải kiểm lại bằng lần tải lên đầu tiên (mục 6, bước 6).
- **Câu quyền bằng tiếng Việt giữ nguyên.** Hai plugin Face ID của app Chủ tịch dùng cùng một câu. App nhân viên không thu âm: plugin máy ảnh tắt micro (`microphonePermission=false`, `recordAudioAndroid=false`), không có `NSMicrophoneUsageDescription` hay `RECORD_AUDIO`.
- **Tên hiển thị:** "MIHATO Điều hành" (16 ký tự) và "MIHATO Việc của tôi" (19 ký tự) có thể bị cắt dưới biểu tượng; chưa đổi `CFBundleDisplayName` (chọn tên là việc của Mike).

## 10. Biểu tượng và màn khởi động tạm

Theo quyết định 07/10/2026 chưa có logo hay nhận dạng, nên `assets/` của mỗi app chứa **bản tạm trung tính** do `apps/mobile-executive/scripts/gen-placeholder-assets.mjs` sinh bằng Node thuần: nền xanh lá đậm `#1D5B43`, chữ "M" trắng, thanh nhấn màu vàng (app Chủ tịch) hoặc xanh nhạt (app nhân viên). **Đây không phải logo.** Thay khi có nhận dạng: đặt tệp mới trùng tên (icon 1024x1024 **không alpha**; `adaptive-icon.png` 1024 có alpha, hình nằm trong vùng an toàn 66%; `adaptive-icon-mono.png`; `splash-icon.png`; `favicon.png`), hoặc sửa script rồi chạy `node apps/mobile-executive/scripts/gen-placeholder-assets.mjs`. Màu nền adaptive icon nằm ở `android.adaptiveIcon.backgroundColor` trong `app.json`. Play Console còn cần icon 512x512, feature graphic 1024x500 và ảnh chụp màn hình: chưa làm.

## 11. Chưa kiểm được

- Chưa có `eas build`, `eas submit`, `eas init`, `eas env:create` nào chạy; chưa có tài khoản. `cli.version`, `node: 22.14.0`, `pnpm: 12.4.2` trong `eas.json` là suy từ tài liệu, phải kiểm ở lần dựng đầu (nhất là pnpm trong monorepo `nodeLinker: hoisted`).
- EAS có đọc biến môi trường của `environment` khi eas-cli đánh giá `app.config.ts` ở máy hay không: chưa kiểm. Nếu không đọc, đặt `EAS_PROJECT_ID` và `MIHATO_API_BASE_URL` trong khối `env` của hồ sơ trong `eas.json`.
- Chưa dựng bản Release iOS (README, "Điều chưa được kiểm chứng"), chưa dựng Android lần nào; mô-đun Swift `duplex-audio` biên dịch vào cả bản phát hành dù chỉ dùng ở màn thử (docs/RA-SOAT, ios-12).
- Chưa thử trên máy thật: thông báo đẩy (APNs, FCM), chặn chụp màn hình và che ảnh thu nhỏ ở màn đa nhiệm (FLAG_SECURE toàn app Chủ tịch trên Android; tấm che React và `enableAppSwitcherProtectionAsync` trên iOS), chặn chụp ở màn Duyệt có số tiền của app nhân viên, kho an toàn khi mất khoá, chọn và tải tệp khi đã chặn `READ_EXTERNAL_STORAGE`, `expo-screen-capture` trong app nhân viên.
- Chưa chạy `expo-doctor` và `expo prebuild` cho hai app (prebuild sẽ ghi đè thư mục `ios/` đang có của app Chủ tịch; chạy ở bản sao). Chưa thử hồ sơ `preview` iOS (cần UDID).
- Chưa đo kích thước bản dựng và thời gian khởi động (SPEC 7.8: ≤ 3 giây).
- CI chưa có job kiểm cấu hình di động (`expo-doctor`, prebuild).
