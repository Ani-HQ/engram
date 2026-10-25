import { describe, expect, test } from 'bun:test';
process.env.ENGRAM_DB_URL_TEMPLATE ??= 'postgresql://postgres:postgres@localhost:1/__DB__';
const { jevPricing, parseJevBudget, usd } = await import('../gateway/src/jev');

describe('Jev exact currency and approved pricing', () => {
  test('keeps dollars as precise integer nanodollars', () => {
    expect(parseJevBudget('1.23')).toBe(1_230_000_000n);
    expect(usd(42n)).toBe('0.000000042');
    expect(usd(1_230_000_000n)).toBe('1.23');
    expect(usd(0n)).toBe('0.00');
    for (const invalid of [1, null, '-1', '1e2', '0.001', '10000.01', '01.00', 'NaN']) expect(() => parseJevBudget(invalid)).toThrow();
  });
  test('does not infer approval or markup from a configured provider key', () => {
    for (const env of [{}, { JEV_API_KEY: 'test' }, { ENGRAM_JEV_MARKUP_BPS: '0', ENGRAM_JEV_BILLING_ENABLED: '0' }, { ENGRAM_JEV_BILLING_ENABLED: '1' }, { ENGRAM_JEV_BILLING_ENABLED: '1', ENGRAM_JEV_MARKUP_BPS: '-1' }]) expect(jevPricing(env).rateVersion).toBeNull();
    expect(jevPricing({ ENGRAM_JEV_BILLING_ENABLED: '1', ENGRAM_JEV_MARKUP_BPS: '0' }).inputPerMillionUsd).toBe('0.042');
    expect(jevPricing({ ENGRAM_JEV_BILLING_ENABLED: '1', ENGRAM_JEV_MARKUP_BPS: '1000' }).inputPerMillionUsd).toBe('0.0462');
    expect(jevPricing({ ENGRAM_JEV_BILLING_ENABLED: '1', ENGRAM_JEV_MARKUP_BPS: '10000' }).inputPerMillionUsd).toBe('0.084');
  });
});
