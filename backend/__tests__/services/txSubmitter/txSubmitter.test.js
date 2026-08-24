"use strict";

const { submitTransaction, classifyError, isRetryable, getCachedResult, setCachedResult } = require('../../../src/services/txSubmitter');

// Mock dependencies
jest.mock('@stellar/stellar-sdk');
jest.mock('../../../src/logger');
jest.mock('../../../src/services/circuitBreaker');
jest.mock('../../../src/services/metrics');

describe('txSubmitter', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('classifyError', () => {
    it('classifies ECONNRESET as retryable', () => {
      const err = new Error('ECONNRESET');
      expect(classifyError(err).type).toBe('retryable');
    });

    it('classifies ETIMEDOUT as retryable', () => {
      const err = new Error('ETIMEDOUT');
      expect(classifyError(err).type).toBe('retryable');
    });

    it('classifies "bad sequence" as terminal', () => {
      const err = new Error('bad sequence');
      expect(classifyError(err).type).toBe('terminal');
    });

    it('classifies "tx_bad_seq" as terminal', () => {
      const err = new Error('tx_bad_seq');
      expect(classifyError(err).type).toBe('terminal');
    });

    it('classifies "insufficient fee" as terminal', () => {
      const err = new Error('insufficient fee');
      expect(classifyError(err).type).toBe('terminal');
    });

    it('classifies "insufficient balance" as terminal', () => {
      const err = new Error('insufficient balance');
      expect(classifyError(err).type).toBe('terminal');
    });

    it('classifies 429 as retryable', () => {
      const err = new Error('429 Too Many Requests');
      expect(classifyError(err).type).toBe('retryable');
    });

    it('classifies unknown as "unknown"', () => {
      const err = new Error('some unknown error');
      expect(classifyError(err).type).toBe('unknown');
    });
  });

  describe('isRetryable', () => {
    it('returns true for retryable errors', () => {
      const err = new Error('ECONNRESET');
      expect(isRetryable(err)).toBe(true);
    });

    it('returns false for terminal errors', () => {
      const err = new Error('bad sequence');
      expect(isRetryable(err)).toBe(false);
    });
  });

  describe('cache', () => {
    it('stores and retrieves cached results', () => {
      const hash = 'testhash123';
      const result = { success: true, txHash: hash };
      setCachedResult(hash, result);
      expect(getCachedResult(hash)).toEqual(result);
    });

    it('returns null for missing cache entries', () => {
      expect(getCachedResult('nonexistent')).toBeNull();
    });
  });

  describe('submitTransaction', () => {
    it('requires signedXdr', async () => {
      await expect(submitTransaction({})).rejects.toThrow('signedXdr is required');
    });

    // More tests would go here with mocked dependencies
    // For full testing, we'd need to mock the RPC client
  });
});
