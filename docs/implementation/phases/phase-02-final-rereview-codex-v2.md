VERDICT: REQUEST_CHANGES  confidence 0.99

| ID | verdict | file:line bằng chứng | Ghi chú ngắn |
|---|---|---|---|
| P2-FINAL-HIGH-001 | RESOLVED | `.github/workflows/ci.yml:65-100`; `scripts/integration/run-integration.mjs:96-205`; `scripts/integration/gate-fail-closed.itest.ts:83-138` | Integration là job CI bắt buộc, provision/health-check backend digest-pinned và có negative tests kiểm exit non-zero khi thiếu Docker/PG/MinIO. Không có skip/soft-fail. |
| P2-FINAL-HIGH-002 | PARTIAL | `adapters/command-runner/src/command-runner.ts:52-65`; `adapters/agent-claude/src/claude-provider.ts:120-141`; `adapters/command-runner/src/sandbox.ts:103-106`; `apps/control-plane-api/src/vertical-slice.ts:364-376` | Runner/Claude đã có đường chạy Docker thật. Nhưng mount cả `wtPath` dạng `rw` làm file `.git` indirection bên trong cũng writable; assertion `command-runner.test.ts:268-277` chỉ tìm mount có chữ `.git:rw`, không thử sửa `.git` qua parent mount. Claude sandbox vẫn optional và thiếu production wiring bắt buộc. E8 chưa được chứng minh fail-closed. |
| P2-FINAL-HIGH-003 | RESOLVED | `packages/application/src/governed-execution.ts:169-207`; `packages/application/src/governed-execution.test.ts:166-180` | Admission chạy trước lease/workspace/agent. R2–R4 có spies xác nhận mọi downstream port bằng 0. Shared slice gọi use case này tại `vertical-slice.ts:313-348`. |
| P2-FINAL-HIGH-004 | PARTIAL | `apps/control-plane-api/src/auth.ts:79-105`; `apps/control-plane-api/src/principal-resolver.ts:30-50`; `apps/control-plane-api/src/control-plane.test.ts:160-194`; `apps/control-plane-api/src/app.ts:92-101` | Tenant spoof bằng organization header đã đóng: org lấy từ bearer token và project được kiểm membership. Tuy nhiên `POST /v1/organizations` vẫn hoàn toàn unauthenticated, trái ngay comment “caller must still be authenticated” và C2 yêu cầu `AuthContext` cho mọi use case. |
| P2-FINAL-HIGH-005 | PARTIAL | `adapters/persistence/src/migrations.ts:275-316`; `adapters/persistence/src/migrations.ts:245-260`; `packages/application/src/registration.ts:112-125`; `adapters/persistence/src/repositories.ts:433-440` | Composite FK và evidence FK đã được thêm. Nhưng `side_effect_records.scope/result_ref` vẫn là text/JSONB, không FK repository/artifact. Task/attempt vẫn có thể chọn binding khác parent trong cùng project. `attachEvidence` lưu checksum caller đưa mà không đối chiếu metadata. Các authoritative refs khác vẫn còn JSONB/bare artifact IDs. |
| P2-FINAL-HIGH-006 | PARTIAL | `packages/application/src/pipeline-steps.ts:260-300`; `packages/application/src/pipeline-steps.ts:394-420`; `packages/application/src/pipeline-steps.ts:454-486`; `adapters/persistence/src/side-effect-log.test.ts:215-235` | Commit đã được wrap và `COMPLETED` được adopt. Nhưng record tồn tại ở trạng thái `PENDING` vẫn rơi thẳng xuống gọi lại commit/push/PR; không có API reconcile Git/remote/PR. Test “B2” chỉ tự gọi `complete()` sau PENDING, không chạy pipeline hoặc kiểm ngoại tác đã tồn tại, nên không chứng minh crash-after-call. |
| P2-FINAL-HIGH-007 | RESOLVED | `adapters/git-worktree/src/worktree-manager.ts:128-134`; `adapters/git-worktree/src/worktree-manager.ts:183-220`; `packages/application/src/execute-task.ts:124-138`; `adapters/git-worktree/src/git-worktree.test.ts:282-317` | Base HEAD được snapshot; detached commit thật làm `headMovedFromBase=true` và pipeline dừng. Test thực sự gọi `git commit`, không dựa vào prose. |
| P2-FINAL-HIGH-008 | PARTIAL | `apps/control-plane-api/src/vertical-slice.ts:76-147`; `apps/control-plane-api/src/vertical-slice.ts:280-281`; `apps/control-plane-api/src/vertical-slice.ts:407-425`; `adapters/github-app/src/port-adapter.ts:60-112`; `apps/control-plane-api/src/cli-main.ts:8-32` | Persisted K1 và GitHub port adapter là cải thiện thật. Nhưng shared driver hard-code `FileWritingAgent` và `LocalBareForgeProvider`; không inject real Claude/GitHub adapter. CLI vẫn dùng mock/null. Vì vậy thêm credentials chưa đủ để chạy live task-to-PR: production composition root vẫn chưa tồn tại. |
| P2-FINAL-HIGH-009 | PARTIAL | `scripts/pilot/verify-pilot-manifest.mjs:228-356`; `scripts/pilot/verify-pilot-manifest.mjs:359-385`; `scripts/pilot/verify-pilot-manifest.test.ts:223-316` | Có hàm authority cross-check nhưng CLI thật vẫn gọi `verifyManifestFile() → verifyManifest()` thuần dữ liệu tự khai. Tôi đã pipe một manifest COMPLETE gồm 10 task hoàn toàn bịa vào CLI; nó exit `0` và in `pilot manifest OK`. Không có resolver production. |
| P2-FINAL-MED-001 | RESOLVED | `adapters/persistence/src/concurrency.itest.ts:59-91`; `adapters/persistence/src/concurrency.itest.ts:98-150`; `adapters/persistence/src/concurrency.itest.ts:156-183` | Hai pool/connection thật chạy concurrent migration, lease race và optimistic concurrency trên PostgreSQL thật. |
| P2-FINAL-MED-002 | PARTIAL | `adapters/github-app/src/credential-provider.ts:87-93`; `adapters/github-app/src/forge-provider.ts:66-76`; `adapters/github-app/src/forge-provider.ts:191-276`; `adapters/github-app/src/github-app.test.ts:289-370` | Bounded re-mint cho push/PR đã có. Nhưng `isExpired()` không được dùng; token vừa mint nhưng đã hết hạn vẫn được đem dùng. Mọi HTTP 403 bị coi là auth expiry, kể cả rate limit/permission. Recovery “không replay completed side effect” còn phụ thuộc HIGH-006 chưa đóng. |
| P2-FINAL-MED-003 | PARTIAL | `packages/observability/src/spans.ts:22-33`; `packages/application/src/governed-execution.ts:151-167`; `packages/application/src/governed-execution.ts:180-221`; `apps/control-plane-api/src/vertical-slice.itest.ts:163-198` | Có SQL audit sink và emission thật, nhưng chỉ emit ba boundary: lease, workspace, agent. J1 bắt buộc 10 spans; `task.execute`, `context.build`, `command.execute`, `artifact.put`, `git.commit`, `forge.push`, `forge.pull_request` chưa có runtime call site/audit proof. |
| P2-FINAL-MED-004 | REGRESSED | `apps/control-plane-api/src/app.ts:96-172`; `apps/control-plane-api/src/vertical-slice.ts:212-425`; `scripts/forbidden-imports.test.ts:261-274` | HTTP handlers đã chuyển qua application use cases. Tuy nhiên repair thêm `vertical-slice.ts` trong `apps/*` chứa trực tiếp repository operations và toàn bộ workflow sequencing. Scanner chỉ bắt mẫu `repos.x.y()`, nên bỏ lọt các biến `runs.create()`, `tasks.create()` và orchestration này. |
| P2-FINAL-MED-005 | PARTIAL | `docs/implementation/phases/phase-02-report.md:19-39`; `docs/implementation/phases/phase-02-report.md:47-67`; `.phase-02-implementation-complete:3,8`; HEAD `061ec236...` | Report đã sửa tiền đề Docker/PGlite. Nhưng vẫn overclaim “only K2/K6 pending” và “9 HIGH + 6 MED resolved”. `implementation_head_sha=2fb8889...` không bằng HEAD `061ec23...`; sentinel đúng SHA không thay thế yêu cầu literal của L1 rằng SHA phải nằm trong report. |
| P2-FINAL-MED-006 | PARTIAL | `adapters/persistence/src/pilot-rehearsal.test.ts:12-14`; `adapters/persistence/src/pilot-rehearsal.test.ts:51-73`; `docs/implementation/phases/phase-02-pilot-rehearsal.md:3-9`; `adapters/agent-claude/src/claude-provider.ts:90-169` | Đã thêm executable tests cho một số mechanism, nhưng không có Fault 1 executable; Claude provider vẫn không có wall-clock timeout timer. “DB restart” dùng cùng PGlite client, không restart. PENDING chỉ được đọc lại, không reconcile remote. Tài liệu vẫn tự gọi là tabletop/paper rehearsal. |

## Regression check

Có một regression kiến trúc rõ ràng: repair HIGH-008 thêm `apps/control-plane-api/src/vertical-slice.ts`, nhưng file này trực tiếp tạo/call repositories, Git adapter và sequence toàn pipeline. Điều đó vi phạm B2/B5, trong khi fitness test không phát hiện vì matcher quá hẹp. Vì vậy MED-004 được đánh `REGRESSED`.

Không thấy test Phase 1 bị xóa, đổi thành `.skip/.todo/.only`, hoặc policy/contracts bị nới để lấy màu xanh. Negative integration tests cũng không có skip trá hình.

Tôi đã thử chạy lại `pnpm verify:all`, nhưng sandbox read-only của phiên re-review chặn mọi `mkdtemp` với `EPERM`; đây là giới hạn môi trường kiểm toán, không phải regression repository. Tree vẫn sạch. Kết quả PASS độc lập của controller không bị phản bác; vấn đề ở đây là test xanh không kiểm đúng các invariant nêu trên.

## Finding mới

- `P2-REREVIEW-MED-NEW-001` — MinIO là backend liveness-only, chưa được dùng bởi artifact path.

  - Bằng chứng: `scripts/integration/run-integration.mjs:158-179` chỉ health-check và truyền `ASEP_S3_*`; không file test/runtime nào đọc các biến này. `adapters/persistence/src/object-store.ts:31-44` chỉ có `ObjectStore` seam và `FilesystemObjectStore`; K1 cũng dùng filesystem tại `vertical-slice.ts:249-253`.
  - Hệ quả: gate vẫn xanh nếu MinIO health endpoint hoạt động nhưng PUT/GET/create-only/checksum semantics hỏng.
  - Sửa: thêm S3-compatible `ObjectStore`, chạy artifact/evidence contract suite trực tiếp trên MinIO và register marker bắt buộc.

- `P2-REREVIEW-MED-NEW-002` — K1 real-backend suite chưa được đăng ký bắt buộc.

  - Bằng chứng: `vertical-slice.itest.ts:43` phát `asep-suite:vertical-slice-real`, nhưng `scripts/integration/lib.mjs:31-39` chỉ bắt buộc bốn marker khác.
  - Hệ quả: xóa/đổi tên toàn bộ K1 suite vẫn có thể để integration gate xanh.
  - Sửa: thêm `asep-suite:vertical-slice-real` vào `REQUIRED_ITEST_SUITES` và mutation test xóa marker/file phải làm gate đỏ.

## Tính trung thực của verdict

`IMPLEMENTATION_COMPLETE_PILOT_PENDING` hiện không trung thực. Không chỉ K2/K6 đang pending. Các MUST non-live còn chưa đạt gồm ít nhất:

- B2/B5: application driver đặt sai layer và fitness bỏ lọt.
- C2/C2b/D6: org creation không auth; hierarchy/artifact refs chưa DB-enforce đầy đủ.
- C7/D8: crash tại `PENDING` vẫn replay, đặc biệt commit.
- E8: `.git` vẫn writable qua parent worktree mount; agent sandbox không bắt buộc trong production path.
- G3/H2: agent không có timeout thực; token expiry handling chưa đầy đủ.
- J1/J4: mới emit một phần boundary.
- K5: CLI COMPLETE gate vẫn chấp nhận manifest tự khai.
- L1: report SHA không bind HEAD.
- M3: rehearsal chưa thực sự inject đủ năm fault/recovery.

Kiểm điểm L1: có, đây vẫn là vi phạm. Sentinel tại `.phase-02-implementation-complete` khớp HEAD nhưng locked criterion ghi rõ `phase-02-report.md` phải chứa SHA bằng `git rev-parse HEAD`. Muốn dùng sentinel thay thế thì phải sửa chính exit criterion, không thể tự diễn giải lại trong report.

## Kết luận

Phase 2 chưa thể phase-acceptance. Các blocker HIGH còn lại chính xác là HIGH-002, HIGH-004, HIGH-005, HIGH-006, HIGH-008 và HIGH-009 ở trạng thái sửa dở. Đặc biệt, pilot COMPLETE gate hiện vẫn forgeable bằng CLI thật, crash recovery chưa reconcile `PENDING`, và chưa có production composition root chạy real Claude + GitHub chỉ bằng việc cấp credentials.
