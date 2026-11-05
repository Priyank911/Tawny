import { describe, expect, it } from 'vitest';
import { pickConfident, rankMatches, scoreMatch } from '../src/main/pipeline/fuzzy';

describe('fuzzy name matching', () => {
  it('scores exact, plural and spacing variants as near-identical', () => {
    expect(scoreMatch('downloads', 'Downloads')).toBe(1);
    expect(scoreMatch('download', 'Downloads')).toBeGreaterThanOrEqual(0.98);
    expect(scoreMatch('power point', 'PowerPoint')).toBeGreaterThanOrEqual(0.95);
  });
  it('ignores word order and punctuation', () => {
    expect(scoreMatch('tawny project', 'project-tawny')).toBeGreaterThanOrEqual(0.95);
  });
  it('keeps unrelated names far apart', () => {
    expect(scoreMatch('downloads', 'documents')).toBeLessThan(0.6);
    expect(scoreMatch('chrome', 'notepad')).toBeLessThan(0.4);
  });
  it('penalizes a candidate that has many extra words', () => {
    expect(scoreMatch('projects', 'projects')).toBeGreaterThan(scoreMatch('projects', 'my projects backup old'));
  });
  it('tolerates a speech-to-text spelling slip', () => {
    expect(scoreMatch('visual studio cod', 'Visual Studio Code')).toBeGreaterThanOrEqual(0.8);
  });
});

describe('ranking and confidence', () => {
  const items = ['Projects', 'Projects Backup', 'Photos', 'Music'];
  it('ranks best first and drops weak candidates', () => {
    const ranked = rankMatches('projects', items, (item) => item);
    expect(ranked[0].item).toBe('Projects');
    expect(ranked.map((entry) => entry.item)).not.toContain('Music');
  });
  it('reports ambiguity when two candidates are nearly tied', () => {
    const ranked = rankMatches('report', ['Report', 'Reports'], (item) => item);
    expect(pickConfident(ranked, { minimum: 0.8, margin: 0.2 }).ambiguous).toBe(false); // exact beats the plural
    const tied = rankMatches('quarterly report', ['Quarterly Report A', 'Quarterly Report B'], (item) => item);
    expect(pickConfident(tied, { minimum: 0.8, margin: 0.06 }).ambiguous).toBe(true);
  });
  it('returns nothing below the minimum score', () => {
    expect(pickConfident(rankMatches('zzz', items, (item) => item)).best).toBeUndefined();
  });
});
