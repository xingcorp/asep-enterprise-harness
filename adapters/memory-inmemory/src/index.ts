import type { MemoryCandidate, MemoryProvider, MemoryRecordInput } from '@asep/ports';

interface Stored { id: string; input: MemoryRecordInput; expired: boolean; }

export class InMemoryMemoryProvider implements MemoryProvider {
  private readonly records: Stored[] = [];

  async append(input: MemoryRecordInput): Promise<string> {
    const id = `mem-${this.records.length + 1}`;
    this.records.push({ id, input, expired: false });
    return id;
  }

  async search(input: { tenantId: string; projectId: string; query: string; limit: number }): Promise<readonly MemoryCandidate[]> {
    const q = input.query.toLowerCase();
    return this.records
      .filter(r => !r.expired && r.input.tenantId === input.tenantId && r.input.projectId === input.projectId)
      .filter(r => r.input.text.toLowerCase().includes(q))
      .slice(0, input.limit)
      .map(r => ({ id: r.id, text: r.input.text, score: 1, provenanceArtifactIds: r.input.provenanceArtifactIds, humanVerified: false }));
  }

  async expire(id: string): Promise<void> {
    const record = this.records.find(r => r.id === id);
    if (record) record.expired = true;
  }
}
