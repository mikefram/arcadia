# Hướng dẫn: quy trình, văn thư và chỉ thị

Tài liệu cho người điều hành (Chủ tịch, Giám đốc, Văn phòng, người thiết kế quy trình). Viết theo đề cương "Báo cáo - Đề xuất xây dựng phần mềm quản lý doanh nghiệp" của VRG, mục Văn phòng số: Văn thư, văn bản đến, văn bản đi.

## 1. Một quy trình hoạt động thế nào

Một **quy trình** là bản vẽ: các bước, ai làm bước nào, hạn của từng bước, và biểu mẫu mà người khởi chạy phải điền. Quy trình **không tự chạy**. Khi có người bấm **Khởi chạy** và điền biểu mẫu, hệ thống tạo một **lượt chạy**: bản vẽ được áp xuống những người cụ thể, mỗi người nhận việc của mình ở mục **Việc của tôi** (web và app), có hạn, có nhắc việc.

Bạn chỉ cần quyết bốn điều khi vẽ một quy trình:

| Câu hỏi | Chọn ở đâu | Ví dụ |
|---|---|---|
| Ai được khởi chạy? | Cài đặt chung của quy trình, mục "Ai được khởi chạy" | Chỉ thị: chỉ Chủ tịch. Văn bản đến: chỉ Văn phòng (văn thư). Văn bản đi: mọi cán bộ |
| Ai làm từng bước? | Bảng thuộc tính của bước, mục "Người nhận" | Giám đốc; trưởng phòng của người soạn; "người được chọn ở bước trước" |
| Mỗi người điền gì và nộp gì? | Biểu mẫu của bước | Nội dung nhiều dòng, tệp đính kèm, chọn người |
| Khi nào xong? | Các đường nối giữa bước, và bước duyệt | Duyệt xong mới ban hành; chưa đồng ý thì trả về người soạn |

## 2. Ai làm gì: Chủ tịch, Giám đốc, Phó giám đốc và các chức vụ khác

Theo yêu cầu của Mike, ba tầng có việc khác nhau:

- **Chủ tịch ra chỉ thị.** Chỉ Chủ tịch khởi chạy được quy trình *Chỉ thị*. Chủ tịch cũng duyệt cuối cùng: xác nhận chỉ thị đã hoàn thành, hoặc trả lại.
- **Giám đốc nhận chỉ thị.** Việc đầu tiên của mọi chỉ thị rơi vào Giám đốc: cho ý kiến chỉ đạo và **chọn người chủ trì cùng những người phối hợp**. Giám đốc không tự làm phần việc, cũng không cần biết quy trình bên trong.
- **Phó giám đốc, trưởng phòng và nhân viên thực hiện.** Mỗi người được Giám đốc chọn nhận một việc "Thực hiện chỉ thị và gửi kết quả phần việc của mình": điền kết quả, đính tệp minh chứng, bấm **Gửi**. Người chủ trì (thường là Phó giám đốc) tổng hợp rồi báo cáo lại Chủ tịch.
- **Văn thư là Văn phòng** (vai trò Văn phòng): vào sổ và đóng dấu ĐẾN cho văn bản đến, cấp số rồi đóng dấu văn bản đi, đính bằng chứng gửi đi, lưu hồ sơ.

- **Ai thấy phần của ai ở bước góp nội dung.** Người chỉ được giao góp phần của mình thấy phần của mình; người cùng góp hiện tên và "đã gửi" hay "chưa gửi" nhưng không đọc được nội dung. Người khởi chạy, người chủ trì tổng hợp, người duyệt, người giao việc, Chủ tịch, Giám đốc, Phó giám đốc và Văn phòng thấy hết, vì họ cần đọc để làm việc.
- **Nhân viên khởi chạy quy trình** (ví dụ soạn văn bản đi) từ **Việc của tôi, Khởi chạy quy trình**, nếu quy trình cho phép mọi cán bộ khởi chạy. Nhân viên không có quyền xem trước nên khung xem trước chỉ báo vậy; quy trình vẫn chạy bình thường và việc của họ nằm ở Việc của tôi.

Hệ thống dùng đúng sáu vai trò có sẵn; không có vai trò "văn thư" riêng. Muốn thêm hay bớt quyền của ai thì vào **Tổ chức, Phân quyền** (theo vai trò hoặc riêng từng người).

## 3. Ba quy trình mẫu

Mở **Quy trình, Tạo quy trình, Từ mẫu có sẵn** để lấy một trong ba mẫu. Hệ thống tạo bản nháp trong tổ chức của bạn; sửa tuỳ ý rồi **Xuất bản**. Mẫu chỉ dùng vai trò (Giám đốc, Chủ tịch, Văn phòng...), không dính tên người nên dùng được ở bất kỳ tổ chức nào.

### 3.1 Chỉ thị của Chủ tịch

1. **Chủ tịch ban hành**: tiêu đề, nội dung, mức khẩn (Thường, Khẩn, Hỏa tốc), hạn hoàn thành, tài liệu kèm theo. Số chỉ thị tự cấp. Chỉ thị **Khẩn** hay **Hỏa tốc** mang nhãn `[KHẨN]` hoặc `[HỎA TỐC]` ở đầu tên lượt chạy, nên thấy ngay ở danh sách việc, thông báo và sổ. **Hạn hoàn thành phải cách hôm nay ít nhất 3 ngày làm việc** (các việc tính lùi từ hạn: thực hiện trước hạn 2 ngày làm việc, tổng hợp trước 1 ngày; hạn gần hơn thì việc thực hiện đã quá hạn ngay khi tới lượt), gần hơn thì hệ thống từ chối và báo ở ô hạn, kể cả khi ra chỉ thị bằng trợ lý.
2. **Giám đốc tiếp nhận** (1 ngày làm việc): ý kiến chỉ đạo; chọn *người chủ trì* và *người phối hợp*.
3. **Mỗi người được chọn gửi phần của mình** (kết quả + tệp minh chứng). Đủ mọi người thì bước kế tiếp mới tới lượt.
4. **Người chủ trì tổng hợp** báo cáo; bấm **Xuất tệp Word và PDF** để có một báo cáo gom đủ nội dung chỉ thị, ý kiến Giám đốc, kết quả từng người, danh mục tệp (một tệp Word và một bản PDF cùng nội dung).
5. **Chủ tịch xác nhận hoàn thành**, hoặc **Chưa đồng ý** (kèm lý do): việc tổng hợp quay lại người chủ trì.

### 3.2 Văn bản đến

1. **Văn thư vào sổ**: trích yếu, nơi gửi, số ký hiệu, ngày ghi trên văn bản, ngày đến, loại văn bản, mức khẩn, mức mật, hạn xử lý, **bản scan văn bản và tài liệu kèm theo** (bắt buộc đính tệp). *Số đến* tự cấp từ sổ văn bản đến. Sau khi vào sổ, văn thư **đóng dấu ĐẾN và ghi số đến, ngày đến lên bản giấy** (nhắc ngay dưới ô Số đến). Hạn xử lý do văn thư nhập lúc vào sổ (giả định hiện tại, chờ Mike xác nhận).
2. Nếu văn bản **mật, tối mật, tuyệt mật**: **Chủ tịch xem trước** và cho ý kiến. Văn bản thường đi thẳng bước sau. Ý kiến của Chủ tịch được đưa vào Phiếu xử lý.
3. **Giám đốc cho ý kiến chỉ đạo** và chọn một trong ba hướng:
   - **Giao xử lý**: sang bước *Giám đốc phân công* để chọn người chủ trì và người phối hợp (bắt buộc có người chủ trì).
   - **Chỉ để biết, lưu**: đi thẳng tới văn thư lưu hồ sơ, không có bước xử lý (thư mời, thông báo thuần). Không phải chọn người chủ trì.
   - **Trả lại văn thư**: vào sổ nhầm hoặc không thuộc thẩm quyền. Việc về văn thư, ghi cách đã xử lý (trả cơ quan gửi, chuyển nơi khác, sửa sổ) rồi kết thúc lượt chạy.
4. **Các đơn vị xử lý**: mỗi người gửi kết quả xử lý phần của mình.
5. **Người chủ trì tổng hợp** và xuất **Phiếu xử lý văn bản đến** (Word và PDF). Phải xuất phiếu thì mới báo xong được.
6. **Văn thư lưu hồ sơ**: ghi nơi lưu.

### 3.3 Văn bản đi

1. **Người soạn** (bất kỳ cán bộ nào) nêu trích yếu, nơi nhận, mức khẩn, mức mật, **chọn các đơn vị phối hợp**, hạn trình duyệt, đính tài liệu tham khảo, và chọn **Trình Chủ tịch duyệt cuối: Có hoặc Không**.
2. **Các đơn vị phối hợp góp nội dung**: mỗi người một phần, có thể kèm tệp.
3. **Người soạn tổng hợp dự thảo** và bấm **Xuất tệp Word và PDF**: hệ thống dựng **một tệp cuối** theo khổ công văn (quốc hiệu, tiêu ngữ, số, trích yếu, nơi nhận, khối chữ ký), gom nội dung của tất cả đơn vị, thành một tệp Word (để người ký còn sửa được) và một bản PDF cùng nội dung (để đọc trên mọi máy, kể cả điện thoại). Chưa xuất tệp thì chưa báo xong được. Tệp trình duyệt chưa có số (số cấp sau khi duyệt).
4. **Trưởng đơn vị của người soạn soát xét**, rồi **Giám đốc duyệt**.
5. **Chủ tịch duyệt cuối** khi văn bản là mật, tối mật, tuyệt mật, **hoặc** người soạn chọn "Trình Chủ tịch duyệt cuối: Có". Chủ tịch **luôn là người duyệt cuối**, sau Giám đốc và ngay trước văn thư (quyết định 07/10/2026; hệ thống chặn xuất bản mẫu nếu sau Chủ tịch còn một bước duyệt khác). Bất kỳ ai *Chưa đồng ý* (kể cả Chủ tịch) thì dự thảo trở về người soạn, người soạn sửa và **xuất tệp mới**, rồi đi lại từ soát xét.
6. **Văn thư cấp số và ghi ngày ban hành** (việc thứ nhất): số văn bản đi tự cấp lúc văn thư bấm báo xong, **trước khi đóng dấu**, để ghi số lên bản chính. Văn thư ghi **ngày ban hành**, **người ký ban hành** (Chủ tịch, Giám đốc, Phó giám đốc, người khác được ủy quyền) và **số lượng bản**. Dòng sổ văn bản đi có ngay sau bước này.
7. **Văn thư đóng dấu và lưu** (việc thứ hai): đính **bản chính đã ký, đóng dấu** (bản scan, bắt buộc) và **bằng chứng gửi đi** (không bắt buộc: thư, phiếu gửi, biên nhận; hệ thống không gửi văn bản ra ngoài), ghi nơi lưu bản gốc. Văn thư có thể bấm **Xuất tệp Word và PDF** để có tệp cuối **in số và ngày ban hành** (ô "Số" và dòng "ngày … tháng … năm …" lấy từ việc cấp số).

Người duyệt nhìn thấy tệp Word và bản PDF ngay ở đầu hộp duyệt, tải về xem trước khi quyết.

## 4. Tệp đính kèm

- Đính ở ô "Tệp" của biểu mẫu: kéo thả hoặc chọn tệp. Tối đa 20 MB mỗi tệp; nhận PDF, Word, Excel, PowerPoint, ảnh, nén, văn bản thuần. Tệp chạy được (.exe...) và tệp đổi đuôi giả bị từ chối.
- Tệp chỉ những người **thấy được lượt chạy đó** mới tải được. Người ngoài không thấy, kể cả biết đường dẫn.
- Tệp tải lên mà không gửi đi sẽ tự dọn sau 24 giờ.
- **Xem ngay trên web, không cần tải về**: ở mọi danh sách tệp (hồ sơ đính kèm của lượt chạy, hộp duyệt, chi tiết việc, Sổ văn bản) bấm **Xem**. Xem được: **PDF** (cuộn, phóng to, thu nhỏ, hiện số trang), **Word (.docx)**, **bảng tính Excel (.xlsx)** (mỗi trang tính một thẻ), **CSV**, **văn bản thuần (.txt)** và **ảnh** (PNG, JPG, GIF). Tệp Word do hệ thống xuất ra thì **Xem mở bản PDF** dựng cùng lúc, đúng như bản sẽ in và ký. Loại chưa xem trực tiếp được (Word cũ .doc, Excel cũ .xls, PowerPoint, .odt, .ods, .rtf, .zip) vẫn **tải xuống** để mở bằng phần mềm trên máy. Bảng tính chỉ hiện tối đa 1.000 dòng đầu và 40 cột, PDF tối đa 100 trang đầu; muốn xem đủ thì tải xuống.
- **Thêm tài liệu sau khi khởi chạy**: ở mục **Hồ sơ đính kèm** của lượt chạy (và ở Sổ văn bản, nút **Tài liệu**), bấm **Thêm tài liệu**, chọn hoặc kéo thả tệp rồi bấm **Đính vào lượt chạy**. Thêm được khi lượt chạy còn đang chạy; người thêm được: người khởi chạy, người từng giữ một việc trong lượt, và người có quyền ghi chú vào lượt (Văn phòng, lãnh đạo). Tài liệu thêm hiện ở nhóm riêng **Tài liệu thêm sau khi khởi chạy**.
- App nhân viên đính được tệp ở ô tệp (báo hoàn thành, gửi phần của mình ở bước đóng góp): bấm **Chọn tệp trong máy**, tệp tải lên ngay và hiện trạng thái; tệp lỗi mạng thì bấm **Thử lại**, tệp không muốn đính thì **Bỏ tệp này**. Ô tệp bắt buộc thì phải có ít nhất một tệp tải xong mới gửi được.
- Ở chi tiết việc, mục **Tệp đính kèm** liệt kê tệp của việc, tài liệu đính kèm lúc khởi chạy lượt và tệp ở các việc khác trong lượt (chỉ những tệp người này được xem). Chạm một tệp để mở bằng ứng dụng khác của máy; mở lần đầu cần có mạng; tệp đã mở có thể đọc lại khi mất mạng (máy tự dọn khi thiếu chỗ), và đăng xuất thì xoá hết tệp đã tải về máy.

## 5. Sổ văn bản và đánh số

Vào **Sổ văn bản** để xem mọi văn bản đến, văn bản đi, chỉ thị đã được cấp số: số, ngày cấp, trích yếu, người tạo, tình trạng xử lý, và các cột của sổ. Cột **Tài liệu** có nút mở ngay tài liệu của văn bản đó: xem trên web, tải xuống, thêm tài liệu. Gõ vào ô tìm theo số hoặc trích yếu; lọc theo năm.

- **Trích yếu** của dòng sổ lấy từ ô *Trích yếu* (hoặc *Tiêu đề* của chỉ thị) trong biểu mẫu, nên văn thư chỉ gõ một lần. Ở màn Khởi chạy, **để trống ô Tên lượt chạy** thì hệ thống lấy luôn trích yếu hoặc tiêu đề làm tên lượt chạy.
- **Cột mặc định.** Văn bản đến: nơi gửi, số ký hiệu, ngày văn bản, loại văn bản, mức khẩn, mức mật, hạn xử lý, người chủ trì (có sau khi Giám đốc phân công). Văn bản đi: nơi nhận, loại văn bản, mức khẩn, mức mật, người ký, số lượng bản, ngày ban hành (có sau khi văn thư cấp số). Chỉ thị: tiêu đề, mức khẩn, hạn hoàn thành. Người có quyền *Đổi cài đặt tổ chức* đổi cột ở **Cấu hình sổ**.
- Ô chọn hiện **nhãn** ("Khẩn", "Công văn", "Giám đốc"), không hiện mã thô. Nhãn được chụp lúc ghi vào sổ; giá trị gốc vẫn được giữ để lọc.
- **Lọc theo cột:** nơi gửi hoặc nơi nhận (gõ một phần tên), loại văn bản, mức khẩn, mức mật, khoảng ngày cấp số (từ ngày, đến ngày). Các lựa chọn lấy từ những văn bản đã tải.
- **Xuất CSV:** nút **Xuất CSV** ở đầu bảng xuất mọi văn bản của sổ theo năm, từ khoá và bộ lọc đang chọn (không chỉ các dòng đã hiện, tối đa 5.000 dòng). Tệp UTF-8 có BOM nên Excel mở đúng dấu tiếng Việt; ô bắt đầu bằng `=`, `+`, `-`, `@` được đặt dấu nháy đơn đứng đầu để Excel không hiểu là công thức. Màn **Lượt chạy** cũng có nút **Xuất CSV** (theo bộ lọc đang chọn: trạng thái, quy trình, đơn vị, chỉ lượt chậm, tìm theo tên).

Mỗi sổ có **mẫu số** do tổ chức đặt, ví dụ `{seq}/VRG-VP` cho văn bản đi (ra `12/VRG-VP`), `{seq:4}` cho văn bản đến (ra `0007`). `{seq:4}` đệm số 0 cho đủ 4 chữ số; `{yyyy}` là năm. Mặc định đánh lại từ 1 mỗi năm. Số do máy chủ cấp lúc gửi: không ai nhập tay, không trùng, và gửi lại một yêu cầu không làm hụt hay thừa số. Người có quyền *Đổi cài đặt tổ chức* chỉnh mẫu số ở **Sổ văn bản, Cấu hình sổ**.

## 6. Tự tạo và quản lý quy trình

- **Tạo**: Quy trình, Tạo quy trình: *Quy trình trống* hoặc *Từ mẫu có sẵn*; chọn nhóm (Chỉ thị, Văn bản đến, Văn bản đi, Kinh doanh, Tài chính - Kế toán, Nhân sự, Vận hành, Khác).
- **Vẽ**: kéo các bước vào khung vẽ. Hai loại bước nhiều người: *Duyệt* (Đồng ý hoặc Chưa đồng ý) và *Góp nội dung* (mỗi người gửi phần của mình). Người nhận có thể là một người, một vai trò, trưởng đơn vị, cấp trên của người khởi chạy, hoặc **người được chọn ở bước trước** (Giám đốc chọn người chủ trì ở bước tiếp nhận thì bước sau giao đúng người đó).
- **Xuất tệp Word và PDF**: ở bước tổng hợp, bật "Xuất tệp Word và PDF tổng hợp", chọn kiểu *Công văn* hay *Báo cáo*, và liệt kê các mục lấy dữ liệu từ đâu (biểu mẫu khởi chạy, kết quả bước, phần của từng người). Mỗi lần xuất ra hai tệp; xuất lại thì giữ cả các lần trước.
- **Kiểm tra, chạy thử, xuất bản**: hệ thống chặn xuất bản khi còn lỗi (thiếu người nhận, bước không tới được, ô cấp số chưa chọn sổ...). Lượt chạy đang chạy giữ phiên bản cũ khi bạn sửa tiếp.
- **Phân quyền**: *Tạo và sửa*, *Xuất bản*, *Lưu trữ* là ba quyền riêng; mặc định Chủ tịch và Nhà thiết kế quy trình có đủ.

## 7. Tài khoản dùng thử

Chạy `pnpm db:seed` rồi đăng nhập web (mật khẩu chung in ra khi chạy seed):

| Tài khoản | Vai trò | Dùng để |
|---|---|---|
| chutich@demo.mihato.local | Chủ tịch | Ra chỉ thị, xác nhận hoàn thành |
| giamdoc@demo.mihato.local | Giám đốc | Nhận chỉ thị, phân công, duyệt văn bản đi |
| huy@, phuoc@demo.mihato.local | Phó giám đốc | Chủ trì, thực hiện chỉ thị; soát xét |
| lan@, ngocanh@, tuan@, phuong@, khai@, huong@... | Trưởng phòng, nhân viên | Gửi phần của mình, soạn văn bản đi |
| vanphong@demo.mihato.local | Văn phòng (văn thư) | Vào sổ văn bản đến, ban hành văn bản đi |
| thietke@demo.mihato.local | Nhà thiết kế quy trình | Vẽ, xuất bản quy trình |
| it@demo.mihato.local | Quản trị hệ thống | Phân quyền, cấu hình sổ văn bản |

Dữ liệu mẫu có sẵn bảy lượt chạy ở nhiều trạng thái: chỉ thị khẩn đang thực hiện (nhãn `[KHẨN]` ở tên), chỉ thị mới ra chờ Giám đốc, chỉ thị đã hoàn tất, văn bản đến đang xử lý (Giám đốc đã giao xử lý và phân công), văn bản đến mật chờ Chủ tịch, văn bản đi chờ Giám đốc duyệt (người soạn đã chọn trình Chủ tịch duyệt cuối; đã có tệp Word và PDF), văn bản đi đã ban hành (đã cấp số, đóng dấu, có bản chính đã ký và bằng chứng gửi đi). Dữ liệu mẫu nạp từ trước ngày thêm PDF chỉ có tệp Word ở các lần xuất cũ; tệp xuất từ nay về sau luôn có cả hai.

## 8. Giới hạn đã chốt

- Tệp cuối có hai định dạng: Word (để người ký còn sửa) và PDF (để đọc). PDF chưa có chữ ký số; ký số chưa làm.
- **Không có bước gửi đi** (email, chuyển phát, liên thông văn bản điện tử) — Mike đã chốt ngày 07/10/2026. Văn thư chỉ đính bản chính đã ký (PDF hoặc ảnh quét) và, nếu có, văn bản đã gửi làm **bằng chứng gửi đi** (ô không bắt buộc ở việc đóng dấu); hệ thống không gửi gì ra ngoài.
- Văn bản mật mới chỉ rẽ nhánh duyệt (Chủ tịch duyệt cuối); việc hạn chế người xem theo mức mật làm riêng (quyết định 07/10/2026, chia sẻ kiểu Google Drive).
- Chưa có bước kiểm tra thể thức và kỹ thuật trình bày của Văn phòng trước khi trình ký; người soát xét (trưởng đơn vị) đảm nhiệm. Người soạn không có cấp trên (Giám đốc, Chủ tịch tự soạn) thì việc soát xét về "Cần giao người" để Văn phòng giao.
- Hạn xử lý văn bản đến do văn thư nhập lúc vào sổ; ai ấn định hạn (văn thư hay lãnh đạo khi bút phê) còn chờ Mike.
- Sổ văn bản đi dùng một mẫu số chung cho mọi loại văn bản; ký hiệu theo loại và đơn vị soạn thảo (ví dụ `12/TTr-VRG`) chưa làm.
- App Chủ tịch không có màn riêng để ra chỉ thị, và không cần: Chủ tịch ra chỉ thị bằng giọng nói hoặc gõ với trợ lý ("ra chỉ thị..."). Tệp đính kèm không đính được bằng giọng nói; chỉ thị cần tệp thì ra trên web.
- App nhân viên chưa chọn nhiều người và chưa xuất tệp tổng hợp: việc có ô chọn nhiều người bắt buộc, hoặc việc tổng hợp phải xuất tệp trước khi báo xong, làm trên web. App cũng chưa chụp ảnh để đính, chỉ chọn tệp có sẵn trong máy.
- Tệp lưu trên đĩa của máy chủ (đã chốt), chưa quét vi-rút.
- Các nghiệp vụ khác trong đề cương (hợp đồng, báo giá, lịch thanh toán, kho, tài sản, chấm công...) không làm ở giai đoạn này.
