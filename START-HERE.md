# START HERE — Cách dùng bộ starter này

## 1. Mục tiêu 30 ngày đầu

Không cố xây toàn bộ platform ngay lập tức. Hãy chứng minh một vertical slice:

```text
GitHub issue / ProductSpec
→ WorkOrder
→ isolated worktree
→ one coding agent
→ mandatory verification
→ independent reviewer
→ evidence bundle
→ pull request
```

**Điều kiện thành công:** workflow có thể bị kill rồi resume; commit truy ngược được tới task/attempt/evidence; agent không được merge; failure có taxonomy; cost và false-completion được đo.

## 2. Trình tự đọc

1. `docs/architecture/01-system-overview.md`
2. `docs/architecture/02-bounded-contexts.md`
3. `docs/architecture/03-domain-model.md`
4. `docs/platform/agent-coordination.md`
5. `docs/platform/verification-and-review.md`
6. `docs/platform/measurement-and-evaluation.md`
7. `docs/engineering/greenfield-onboarding.md` hoặc `brownfield-onboarding.md`
8. `docs/implementation/90-day-plan.md`
9. ADRs.

## 3. Những thứ cần khóa trước khi code production

- Một repository pilot thật và 30–50 task lịch sử.
- ProductSpec schema và Definition of Done.
- Risk taxonomy R0–R4.
- Mandatory verification matrix.
- Agent provider đầu tiên và reviewer khác family.
- Policy về internet, secret và side effects.
- Artifact retention và audit requirements.
- SLO của workflow recovery và duplicate side effect.

## 4. Stack đề xuất cho pilot

- Node.js 24, TypeScript.
- Control-plane modular monolith.
- Temporal cho durable orchestration.
- PostgreSQL cho operational state/projections.
- S3/MinIO cho immutable artifacts.
- Git worktree cho isolation.
- Claude Code hoặc Codex làm implementer; provider khác làm reviewer.
- Rootless container trước; gVisor/microVM khi multi-tenant.
- OpenTelemetry + Prometheus/Grafana + trace backend.

## 5. Không làm trong pilot

- Swarm tự do.
- Auto-merge cho auth/payment/migration.
- Mem0 làm workflow state.
- Graph database làm canonical code index.
- RTK/Caveman trên verification path.
- Nhiều agent sửa cùng worktree.
- Big-bang rewrite legacy.
- Cài skill public trực tiếp từ internet.
