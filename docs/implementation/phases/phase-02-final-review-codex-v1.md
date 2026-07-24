VERDICT: REQUEST_CHANGES confidence 0.99

Không có finding CRITICAL. Có 9 HIGH. `pnpm verify:all` xanh là sự thật, nhưng gate hiện tại không kiểm chứng nhiều MUST quan trọng.

- ID: P2-FINAL-HIGH-001
  - Severity: HIGH — K4/HIGH-009 là “skip trá hình”, không phải integration gate thật
  - File:line:
    - `scripts/verify-all.sh:53-64` chỉ chạy test/scanner, không provision hay health-check PostgreSQL, MinIO hoặc Docker.
    - `.github/workflows/ci.yml:16-45` không khai báo service/container hoặc bước khởi tạo hạ tầng.
    - `compose.yaml:5`, `compose.yaml:39` dùng image tag, không digest; MinIO cũng không có healthcheck.
    - `scripts/lib/canonical-tests.mjs:106-130` chỉ kiểm tra marker xuất hiện, không kiểm tra backend thật.
  - Vấn đề: K4 bắt buộc provision digest-pinned PG + object store + sandbox và phải đỏ khi thiếu. Gate vẫn xanh khi cả ba không tồn tại, đúng failure mode HIGH-009 cấm.
  - Sửa: Thêm integration job bắt buộc, provision digest-pinned services, chờ health, chạy suite bằng backend thật và có negative test chứng minh từng backend vắng làm job đỏ.

- ID: P2-FINAL-HIGH-002
  - Severity: HIGH — Sandbox chỉ dựng argv; cả verification runner và agent vẫn chạy trực tiếp trên host
  - File:line:
    - `adapters/command-runner/src/command-runner.ts:38-55` bỏ qua tham số `_sandbox` và gọi `spawn()` trực tiếp trên host.
    - `adapters/command-runner/src/sandbox.ts:80-100` chỉ trả về `dockerRunPrefix`, không khởi chạy hay thực thi command trong container.
    - `adapters/agent-claude/src/claude-provider.ts:54-68`, `adapters/agent-claude/src/claude-provider.ts:96-100` truyền host `HOME/PATH` và spawn agent trực tiếp, không qua `SandboxProvider`.
    - `adapters/command-runner/src/command-runner.test.ts:229-251` bắt `SandboxUnavailableError` rồi coi đó là kết quả test hợp lệ.
    - `apps/control-plane-api/src/vertical-integration.test.ts:234-236` dùng `LocalUnsandboxedProvider`.
  - Vấn đề: Vi phạm E8, F4, F5, G3, G5 và K1. Không có OS-enforced no-network, read-only Git metadata hay containment; test Docker là always-green khi Docker vắng.
  - Sửa: Runner và Claude adapter phải thực thi bên trong sandbox thật; chỉ mount working tree writable, Git metadata read-only/omitted; chạy network canary và corruption test thật.

- ID: P2-FINAL-HIGH-003
  - Severity: HIGH — Risk admission có thể bị gọi sau khi workspace đã được tạo
  - File:line:
    - `packages/application/src/execute-task.ts:143-148` nhận sẵn `WorkspaceCapability`; use case không sở hữu bước tạo workspace.
    - `packages/application/src/execute-task.ts:160-172` admission chỉ đứng trước agent trong use case rút gọn.
    - `apps/control-plane-api/src/vertical-integration.test.ts:183-199` acquire lease và tạo worktree trước admission.
    - `apps/control-plane-api/src/vertical-integration.test.ts:211-213` admission chỉ chạy sau các side effect đó.
    - `packages/application/src/execute-task.test.ts:113-125` chỉ chứng minh agent không được gọi, không chứng minh workspace/push không xảy ra.
  - Vấn đề: Vi phạm BR1, BR2 và I4: unsupported risk phải dừng trước workspace creation, agent invocation và push.
  - Sửa: Top-level execution use case phải nhận task identity, chạy admission trước mọi lease/workspace; test R0–R4 bằng spy trên workspace, agent và forge.

- ID: P2-FINAL-HIGH-004
  - Severity: HIGH — `TenantScope` do client tự khai, không phải authenticated server state
  - File:line:
    - `apps/control-plane-api/src/auth.ts:35-57` lấy trực tiếp organization/project ID từ request headers, không xác minh chữ ký hay principal.
    - `apps/control-plane-api/src/app.ts:87-92` cho tạo organization không cần authentication.
    - `apps/control-plane-api/src/control-plane.test.ts:127-131` “owner access” chỉ đơn giản gửi ID của owner trong header.
  - Vấn đề: Kẻ biết tenant IDs có thể tự đặt headers tương ứng và truy cập như tenant đó. DB row filtering không ngăn được scope spoofing. Vi phạm C2/HIGH-003 và invariant IDOR.
  - Sửa: Dùng authenticated principal/hook; scope phải được lấy từ credential đã xác minh, không từ public headers. Thêm test attacker đặt đúng ID của tenant khác vẫn bị từ chối.

- ID: P2-FINAL-HIGH-005
  - Severity: HIGH — Hierarchy và artifact attachment không được DB-enforce như C2b/D6 yêu cầu
  - File:line:
    - `adapters/persistence/src/migrations.ts:81-98` `tasks.repository_binding_id` không có composite FK tới binding.
    - `adapters/persistence/src/migrations.ts:100-123` `attempts.repository_binding_id` cũng không có FK tương ứng.
    - `adapters/persistence/src/migrations.ts:203-225` `evidence_bundle_ref` vẫn là JSONB, không phải scoped artifact FK.
    - `adapters/persistence/src/migrations.ts:245-260` side-effect `scope` là text và `result_ref` là JSONB tùy ý.
    - `adapters/persistence/src/repositories.ts:248-260` nhận trực tiếp binding ID khi tạo task.
    - `adapters/persistence/src/artifact-store.ts:112-123` không so sánh `ArtifactRef.sha256/kind` do caller cung cấp với metadata authoritative.
  - Vấn đề: Có thể tạo task/attempt mang repository binding không nhất quán; authoritative references không mang scoped FK + expected checksum. Vi phạm C2b, D6 và traceability K3.
  - Sửa: Thêm composite FK cho mọi binding/parent; thay JSONB authoritative refs bằng scoped columns/FKs `(artifact_id, org, project)` cùng expected checksum và kiểm tra checksum của ref.

- ID: P2-FINAL-HIGH-006
  - Severity: HIGH — Side-effect protocol không crash-safe và commit hoàn toàn không được bảo vệ
  - File:line:
    - `packages/application/src/pipeline-steps.ts:531-545` commit xảy ra trực tiếp, không `SideEffectLog.begin/complete`.
    - `packages/application/src/pipeline-steps.ts:337-363` existing `PENDING` push bị gọi lại; chỉ `COMPLETED` mới được adopt.
    - `packages/application/src/pipeline-steps.ts:397-429` PR có cùng lỗi, không reconcile remote cho `PENDING`.
    - `packages/application/src/pipeline-steps.ts:531-559` mỗi rerun preallocate evidence ID mới rồi commit mới.
    - `adapters/persistence/src/side-effect-log.test.ts:49-189` không có kill/fault injection trước-sau external call và DB write.
  - Vấn đề: Crash sau commit/push/PR nhưng trước DB completion có thể replay. Không có remote-reconciliation API hay commit natural-key adoption. Vi phạm C7, D8 và HIGH-005.
  - Sửa: Bao cả commit trong protocol; persist evidence ID/step state; reconcile `PENDING` bằng commit trailer, remote ref và PR head trước khi gọi lại; thêm fault matrix tại mọi boundary.

- ID: P2-FINAL-HIGH-007
  - Severity: HIGH — Agent-created commit không bị phát hiện
  - File:line:
    - `adapters/git-worktree/src/worktree-manager.ts:151-174` đọc `headSha` nhưng chỉ tính created refs.
    - `packages/application/src/execute-task.ts:124-133` chỉ dừng khi `touchedGitDir` hoặc `createdRefs.length > 0`; không kiểm tra `headSha == pinned baseSha`.
    - `adapters/git-worktree/src/git-worktree.test.ts:247-269` chỉ mô phỏng agent tạo branch, không tạo detached commit.
    - `adapters/agent-claude/src/agent-claude.test.ts:271-283` “attempted commit/push” chỉ là prose agent tự khai.
  - Vấn đề: Agent có thể commit trên detached HEAD mà không tạo ref; inspection sẽ chấp nhận. Kết hợp với sandbox không tồn tại, invariant “harness owns commit” bị thủng. Vi phạm E3/E5/G5.
  - Sửa: Snapshot pinned base HEAD và toàn bộ Git metadata trước agent; reject mọi HEAD change/object/ref mutation. Thêm executable test thật gọi `git commit`.

- ID: P2-FINAL-HIGH-008
  - Severity: HIGH — Không có runnable governed vertical slice dùng các adapter thật
  - File:line:
    - `packages/application/src/execute-task.ts:160-198` “executeTask” kết thúc ở inspect; không verify/commit/evidence/push/PR/persist review state.
    - `apps/control-plane-api/src/cli-main.ts:8-31` CLI runnable dùng mock agent và null inspector.
    - `packages/ports/src/index.ts:259-272` `ForgeProvider` nhận scope + binding + commit SHA.
    - `adapters/github-app/src/forge-provider.ts:129-164` GitHub provider có chữ ký khác, không implement port trên.
    - `apps/control-plane-api/src/vertical-integration.test.ts:95-140` thay GitHub adapter bằng class fake riêng.
    - `apps/control-plane-api/src/vertical-integration.test.ts:306-321` PR ở memory; test không persist PR→evidence link hay task review state.
  - Vấn đề: K1 test tự ghép các step bằng một đường riêng; production composition root không thể chạy task-to-PR. I1 và K3 chỉ được khẳng định trên object tạm, không trên authoritative persistence.
  - Sửa: Tạo một application driver đầy đủ, production composition root wire đúng các port; persist attempt/task/PR/evidence transitions; integration test gọi đúng driver đó.

- ID: P2-FINAL-HIGH-009
  - Severity: HIGH — Pilot manifest verifier có thể chấp nhận dữ liệu hoàn toàn tự khai
  - File:line:
    - `scripts/pilot/verify-pilot-manifest.mjs:92-110` trace IDs chỉ cần là string không rỗng.
    - `scripts/pilot/verify-pilot-manifest.mjs:168-176` “real provider” chỉ dựa vào prefix tên.
    - `scripts/pilot/verify-pilot-manifest.mjs:186-191` chỉ kiểm tra `trace.taskId`.
    - `scripts/pilot/verify-pilot-manifest.test.ts:22-69` fixture tổng hợp tự khai được gọi là “genuine” và được accept.
    - Không có pilot manifest thực tế trong repository; `artifacts/` chỉ chứa Phase 1 key.
  - Vấn đề: Một manifest giả với `providerId: claude:...`, URL/checksum/trace bịa sẽ vượt gate COMPLETE. Verifier không resolve DB, object bytes, PR, task state, human authorization hoặc sandbox provenance. Vi phạm K5 và PR2-08.
  - Sửa: Verifier phải đối chiếu authoritative persistence/object store/forge và signed human authorization; không chấp nhận proof chỉ từ chính manifest.

- ID: P2-FINAL-MED-001
  - Severity: MEDIUM — PGlite không chứng minh concurrency/advisory-lock semantics của PostgreSQL nhiều connection
  - File:line:
    - `adapters/persistence/src/pglite-client.ts:33-35` xác nhận single connection.
    - `adapters/persistence/src/migrator.ts:57-73` dùng local JavaScript mutex để bù cho advisory lock re-entrant.
    - `adapters/persistence/src/persistence.test.ts:90-97` hai migrator dùng cùng một client.
    - `adapters/persistence/src/persistence.test.ts:194-207` lease acquisition chạy tuần tự, không concurrent trên hai connection.
    - `adapters/persistence/package.json:12-19` chỉ có PGlite; không có `pg` implementation.
  - Vấn đề: C3/C5 chưa chứng minh race/locking dưới nhiều sessions và pool thật. PGlite là seam dev hợp lệ, nhưng không phải evidence đủ cho các MUST này.
  - Sửa: Chạy cùng contract suite với ít nhất hai `pg.Pool` clients trên PostgreSQL thật; dùng `Promise.all` và barrier để tạo race thật.

- ID: P2-FINAL-MED-002
  - Severity: MEDIUM — GitHub token expiry/revocation/rotation chỉ có helper, không có recovery path
  - File:line:
    - `adapters/github-app/src/credential-provider.ts:87-93` định nghĩa `isExpired`.
    - `adapters/github-app/src/forge-provider.ts:136-159`, `adapters/github-app/src/forge-provider.ts:164-210` mint một lần rồi gọi operation; không catch auth expiry để re-mint/reconcile.
    - `adapters/github-app/src/github-app.test.ts:62-72` chỉ test pure helper, không test expiry trong push/PR, revocation hay rotation.
  - Vấn đề: Không thỏa H2/MED-005.
  - Sửa: Thêm bounded re-mint + remote reconciliation; fake-clock transport tests cho expiry trước/trong operation, revocation và key rotation.

- ID: P2-FINAL-MED-003
  - Severity: MEDIUM — Observability/audit mới chỉ là vocabulary test, chưa được pipeline phát ra
  - File:line:
    - `packages/observability/src/spans.ts:22-33` chỉ khai báo span names.
    - `packages/observability/src/index.ts:1-9` `CorrelationContext` không có `organizationId` hoặc `repositoryBindingId`.
    - `packages/observability/src/audit.ts:54-58` chỉ khai báo `AuditSink`.
    - `packages/observability/src/index.ts:68-70` nói PostgreSQL sink tồn tại, nhưng adapter persistence không có implementation tương ứng.
  - Vấn đề: Không có application/adapter call site dùng `SpanTracer` hoặc ghi audit DB. J1, J2 và J4 không được thỏa bằng runtime behavior.
  - Sửa: Instrument từng step/adapter, thêm correlation fields thật, PostgreSQL AuditSink và integration assertion trên emitted spans/audit rows.

- ID: P2-FINAL-MED-004
  - Severity: MEDIUM — Composition-root fitness test yếu hơn định nghĩa khóa
  - File:line:
    - `apps/control-plane-api/src/app.ts:87-161` handlers gọi concrete persistence repositories trực tiếp.
    - `scripts/forbidden-imports.test.ts:241-265` detector chỉ xem raw SQL, Git spawn, SDK instantiation và direct policy call.
  - Vấn đề: B2/B5 cấm persistence query/provider call trong handler và yêu cầu handler gọi application use case. Detector không bắt repository calls, nên test xanh dù handlers bỏ qua application layer.
  - Sửa: Route handlers chỉ gọi application use cases; mutation test phải reject direct adapter/repository imports và calls.

- ID: P2-FINAL-MED-005
  - Severity: MEDIUM — Report khai báo PGlite nhưng đồng thời claim các gate backend thật đã đạt
  - File:line:
    - `docs/implementation/phases/phase-02-report.md:76-81`, `docs/implementation/phases/phase-02-report.md:170-173` có công khai PGlite limitation.
    - `docs/implementation/phases/phase-02-report.md:116-120` lại claim K1 dùng real PG và K4 fail khi backend thiếu.
    - `docs/implementation/phases/phase-02-report.md:33-41` `head_sha` là `bound-by-git-rev-parse-HEAD`, không bằng SHA thực.
  - Vấn đề: Report không che giấu hoàn toàn seam, nhưng kết luận từ seam là materially misleading. L1 cũng không đạt vì report không chứa HEAD `2e61f244...`.
  - Sửa: Đổi K1/K4/C3/C5 thành unmet/partial; ghi SHA thực theo completion protocol và rerun sentinel sau repair.

- ID: P2-FINAL-MED-006
  - Severity: MEDIUM — M3 là tabletop prose và mô tả các recovery mechanism chưa tồn tại
  - File:line:
    - `docs/implementation/phases/phase-02-pilot-rehearsal.md:3-9` tự xác nhận đây là paper rehearsal.
    - `docs/implementation/phases/phase-02-pilot-rehearsal.md:19-26` claim provider timeout dù Claude adapter không có timeout timer.
    - `docs/implementation/phases/phase-02-pilot-rehearsal.md:37-52` claim remote reconciliation dù code replay `PENDING`.
    - `docs/implementation/phases/phase-02-pilot-rehearsal.md:87-99` claim expiry/revocation/rotation tests không tồn tại.
  - Vấn đề: Không phải preserved injected-fault rehearsal theo M3 và chứng cứ dựa trên behavior chưa được implement.
  - Sửa: Chạy executable rehearsal/fault tests trên backend thật; lưu output/artifact và decision trace.

PGLITE SEAM — phán quyết dứt khoát:

- (a) PGlite là seam hợp lệ cho fast/local tests nếu được ghi nhãn đúng. Nó không thể thay K4. Vì `verify:all` và CI không provision backend thật mà vẫn xanh, đây là “skip trá hình” và vi phạm HIGH-009.
- (b) C3/C5 hiện không chứng minh multi-connection PostgreSQL concurrency. C3 chạy tuần tự; C5 dùng cùng connection cộng JavaScript mutex. Độc lập đây là MEDIUM evidence gap; trong tổng thể K4 nó góp phần vào HIGH finding.
- (c) Report có công khai PGlite, nên không phải che giấu hoàn toàn. Tuy nhiên việc đồng thời claim “real PG” và “required CI gate fails when unavailable” là không trung thực về kết luận kỹ thuật.

Giới hạn môi trường không phải defect tự thân:

- K2/K6 chưa chạy vì thiếu real Claude/GitHub credentials và Docker được khai báo đúng với verdict `IMPLEMENTATION_COMPLETE_PILOT_PENDING`.
- F6 label `PILOT-ONLY-NO-ISOLATION` là trung thực.
- Nhưng các giới hạn này không cho phép claim F4/F5/K1/K4 hoặc các invariant sandbox đã PASS.

| Nhóm | Trạng thái | Tóm tắt |
|---|---|---|
| A | PASS | A1–A4 được controller xác nhận: frozen install, compat, full gate và clean tree đều xanh. |
| B | FAIL | B1/B3 cơ bản đạt; B2/B5 handlers gọi persistence trực tiếp, B4 steps không thật sự idempotent/resumable. |
| B′ | FAIL | BR3 đạt; BR1/BR2 không đảm bảo admission trước workspace và R1 review chỉ là flag, chưa được recorded. |
| C | FAIL | C4/C6 phần lớn đạt; C1/C3/C5 chỉ PGlite, C2/C2b và C7 có defect thật. |
| D | FAIL | D1–D5 có implementation đáng kể; D6 scoped FKs/expected checksum và D8 crash recovery không đạt; D7 chưa có MinIO/S3 gate. |
| E | FAIL | E1/E2/E5/E7 có test thật; E3 không chặn detached commit, E8 không có sandbox, E9 thiếu hostile real-transport proof. |
| F | FAIL | F1–F3 và F6 đạt; F4/F5 không được thực thi, sandbox handle bị bỏ qua. |
| G | FAIL | G2 parsing khá tốt; G1/G3/G5/G6 thiếu version/live enforcement, timeout và sandbox/real commit-attempt proof. |
| H | FAIL | H1/H5/H6/H8 đạt phần lớn; H2 thiếu expiry recovery, H3 live ruleset pending và adapter chưa wire được vào application port. |
| I | FAIL | I2/I3 đạt; I1 chỉ trả aggregate không persist, I4 bị admission-order bypass. |
| J | FAIL | J5 contract đạt; J1/J2/J4 chỉ có vocabulary/unit tests, không có runtime emission/persistence. |
| K | FAIL | K2/K6 pending hợp lệ; K1 không dùng real PG/sandbox, K3 không có persisted trace, K4 không tồn tại, K5 forgeable. |
| L | FAIL | L3/L4 phù hợp pending verdict; L1 không bind HEAD và L2 không thể đạt vì còn HIGH findings. |
| M | FAIL | M1 có runbook; M2 dựa trên mechanism chưa tồn tại, M3 chỉ là tabletop prose. |
