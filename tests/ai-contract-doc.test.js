// Unit tests for the Phase 3 AI contract doc builder (src/ai/ai-contract-doc.js).
// Pure / no I/O — runs in plain Node.
import { describe, it, expect } from 'vitest';
import {
  buildAiContractDoc,
  AI_CONTRACT_DOC_NAME,
  AI_CONTRACT_VERSION,
} from '../src/ai/ai-contract-doc.js';

describe('ai-contract-doc', () => {
  it('exposes the managed file name and version constant', () => {
    expect(AI_CONTRACT_DOC_NAME).toBe('README-for-AI.md');
    expect(AI_CONTRACT_VERSION).toBe(1);
  });

  it('first line is the version marker for the current version', () => {
    const doc = buildAiContractDoc();
    const firstLine = doc.split('\n', 1)[0];
    expect(firstLine).toBe(`<!-- wren-ai-contract v${AI_CONTRACT_VERSION} -->`);
  });

  it('substitutes a valid ISO-8601 generatedAt', () => {
    const doc = buildAiContractDoc();
    const m = doc.match(/^Generated: (.+)$/m);
    expect(m).not.toBeNull();
    expect(() => new Date(m[1]).toISOString()).not.toThrow();
    expect(new Date(m[1]).toISOString()).toBe(m[1]);
  });

  it('documents every .wren-index.json notes[] field name', () => {
    const doc = buildAiContractDoc();
    for (const field of [
      'wrenId', 'storageId', 'path', 'file', 'title', 'summary',
      'due', 'tags', 'color', 'created', 'updated', 'contentHash',
    ]) {
      expect(doc).toContain(`\`${field}\``);
    }
  });

  it('documents the top-level index fields and reserved files', () => {
    const doc = buildAiContractDoc();
    for (const field of ['schemaVersion', 'generatedAt', 'backend', 'count', 'notes']) {
      expect(doc).toContain(`\`${field}\``);
    }
    expect(doc).toContain('`.wren-index.json`');
    expect(doc).toContain('`_index.md`');
    expect(doc).toContain('`README-for-AI.md`');
    expect(doc).toContain('`tasks.md`');
  });

  it('has no unsubstituted template tokens', () => {
    const doc = buildAiContractDoc();
    expect(doc).not.toContain('<AI_CONTRACT_VERSION>');
    expect(doc).not.toContain('<GENERATED_AT>');
  });
});
