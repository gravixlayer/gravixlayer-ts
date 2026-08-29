import { describe, expect, it } from 'vitest';

import {
  GravixLayerBadRequestError,
  GravixLayerError,
  GravixLayerRateLimitError,
  codeFromBody,
  errorFromStatus,
  formatErrorMessage,
} from '../src/core/errors.js';

describe('formatErrorMessage', () => {
  it('prefers message over error', () => {
    expect(
      formatErrorMessage('{}', {
        error: 'Runtime quota exceeded',
        message: 'CPU quota exceeded. Reduce running runtimes or upgrade your tier.',
      }),
    ).toBe('CPU quota exceeded. Reduce running runtimes or upgrade your tier.');
  });

  it('falls back to error, then raw text', () => {
    expect(formatErrorMessage('', { error: 'Runtime not found' })).toBe('Runtime not found');
    expect(formatErrorMessage('upstream exploded', undefined)).toBe('upstream exploded');
    expect(formatErrorMessage('  ', {})).toBe('Request failed.');
  });

  it('reads a nested error.message', () => {
    expect(formatErrorMessage('', { error: { message: 'invalid template' } })).toBe(
      'invalid template',
    );
  });
});

describe('codeFromBody', () => {
  it('reads a string code only', () => {
    expect(codeFromBody({ code: 'quota_exceeded' })).toBe('quota_exceeded');
    expect(codeFromBody({ code: 7 })).toBeUndefined();
    expect(codeFromBody(null)).toBeUndefined();
  });
});

describe('errorFromStatus', () => {
  it('attaches status, code, and a clean message', () => {
    const error = errorFromStatus(403, 'CPU quota exceeded. Reduce running runtimes or upgrade your tier.', {
      body: {
        error: 'Runtime quota exceeded',
        code: 'quota_exceeded',
        message: 'CPU quota exceeded. Reduce running runtimes or upgrade your tier.',
        exceeded: ['vcpu'],
      },
    });
    expect(error).toBeInstanceOf(GravixLayerBadRequestError);
    expect(error).toBeInstanceOf(GravixLayerError);
    expect(error.status).toBe(403);
    expect(error.code).toBe('quota_exceeded');
    expect(error.message).toBe(
      'CPU quota exceeded. Reduce running runtimes or upgrade your tier.',
    );
    expect(String(error)).toBe(error.message);
  });

  it('maps 429 to a rate-limit error', () => {
    const error = errorFromStatus(429, 'Rate limit exceeded. Retry after the window resets.', {
      body: { error: 'Rate limit exceeded. Retry after the window resets.', code: 'rate_limited' },
      headers: { 'retry-after': '1' },
    });
    expect(error).toBeInstanceOf(GravixLayerRateLimitError);
    expect(error.code).toBe('rate_limited');
    expect((error as GravixLayerRateLimitError).retryAfterSeconds).toBe(1);
  });

  it('never echoes a 401 body', () => {
    const error = errorFromStatus(401, 'key sk-secret-value is invalid', {
      body: { error: 'key sk-secret-value is invalid' },
    });
    expect(error.message).toBe('Authentication failed.');
    expect(error.message).not.toContain('sk-secret');
  });
});
