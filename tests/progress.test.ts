import { describe, expect, it } from 'vitest';

import {
  AGENT_BUILD_PHASE_LABELS,
  BuildProgress,
  PhaseSpinner,
  TEMPLATE_BUILD_PHASE_LABELS,
  displayPhaseLabel,
  formatDuration,
} from '../src/core/progress.js';

describe('formatDuration', () => {
  it('formats seconds with one decimal', () => {
    expect(formatDuration(12.3)).toBe('12.3s');
    expect(formatDuration(51.1)).toBe('51.1s');
  });

  it('formats a minute and remaining seconds', () => {
    expect(formatDuration(82)).toBe('1m 22s');
    expect(formatDuration(125)).toBe('2m 5s');
  });

  it('treats non-finite or negative values as zero', () => {
    expect(formatDuration(-1)).toBe('0.0s');
    expect(formatDuration(Number.NaN)).toBe('0.0s');
  });
});

describe('displayPhaseLabel', () => {
  it('maps template API phases to two user stages and READY', () => {
    expect(TEMPLATE_BUILD_PHASE_LABELS['building']).toBe('BUILDING');
    expect(TEMPLATE_BUILD_PHASE_LABELS['uploading']).toBe('VERIFYING');
    expect(TEMPLATE_BUILD_PHASE_LABELS['completed']).toBe('READY');
    expect(TEMPLATE_BUILD_PHASE_LABELS['distributing']).toBe('VERIFYING');
    expect(displayPhaseLabel('building')).toBe('BUILDING');
    expect(displayPhaseLabel('unknown-phase')).toBe('UNKNOWN-PHASE');
  });

  it('uses the same stage names for agent builds', () => {
    expect(AGENT_BUILD_PHASE_LABELS['building']).toBe('BUILDING');
    expect(AGENT_BUILD_PHASE_LABELS['uploading']).toBe('VERIFYING');
  });
});

describe('PhaseSpinner', () => {
  it('writes DONE for the previous stage and READY on finish', () => {
    const chunks: string[] = [];
    const spinner = new PhaseSpinner((text) => {
      chunks.push(text);
    });
    spinner.update('BUILDING', performance.now(), 0, '');
    spinner.update('VERIFYING', performance.now(), 12.3, 'BUILDING');
    spinner.finish('VERIFYING', 30.9, 82, 'Template build successful');

    const out = chunks.join('');
    expect(out).toContain('BUILDING... DONE (12.3s)');
    expect(out).toContain('VERIFYING... DONE (30.9s)');
    expect(out).toContain('READY: Template build successful (1m 22s)');
    expect(out).not.toContain('%');
  });

  it('writes FAILED with the total timer', () => {
    const chunks: string[] = [];
    const spinner = new PhaseSpinner((text) => {
      chunks.push(text);
    });
    spinner.update('BUILDING', performance.now(), 0, '');
    spinner.fail('apt failed', 8);
    expect(chunks.join('')).toContain('FAILED: apt failed (8.0s)');
  });
});

describe('BuildProgress', () => {
  it('is a no-op when disabled so tests and CI stay quiet', () => {
    const progress = new BuildProgress(false, 'Building template demo...');
    progress.noteStage('building', TEMPLATE_BUILD_PHASE_LABELS);
    progress.noteStage('uploading', TEMPLATE_BUILD_PHASE_LABELS);
    progress.succeed('Template build successful');
    progress.stop();
  });
});
