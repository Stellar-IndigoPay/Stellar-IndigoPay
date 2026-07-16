/**
 * @jest-environment jsdom
 *
 * Tests for the GF-024 address detection regex used by content-script.ts.
 * The regex is the contract that the inline donate overlay (§GF-026)
 * depends on — if it doesn't fire on a real Stellar address, nothing else
 * works.
 */

describe('GF-024 Stellar address detection', () => {
  const STELLAR_ADDRESS_REGEX = /\bG[A-Z2-7]{55}\b/g;

  // 56-character Stellar ed25519 public keys (1 G + 55 base32 chars).
  const VALID1 = 'G' + 'A'.repeat(55);
  const VALID2 = 'G' + 'B'.repeat(55);
  const VALID3 = 'G' + 'C'.repeat(55);

  beforeEach(() => {
    // The regex is a shared `/g` instance; reset lastIndex between tests.
    STELLAR_ADDRESS_REGEX.lastIndex = 0;
  });

  it('matches a known-valid Stellar public key (56 chars)', () => {
    const matches = VALID1.match(STELLAR_ADDRESS_REGEX);
    expect(matches).toEqual([VALID1]);
  });

  it('matches several addresses on the same page', () => {
    const text = [VALID1, VALID2, VALID3].join(' and ');
    const matches = text.match(STELLAR_ADDRESS_REGEX);
    expect(matches).toHaveLength(3);
  });

  it('does NOT match a Stellar *secret* key (S…)', () => {
    const text = 'S' + 'A'.repeat(55);
    const matches = text.match(STELLAR_ADDRESS_REGEX);
    expect(matches).toBeNull();
  });

  it('does NOT match a normal word that starts with G', () => {
    expect('Goodbye world'.match(STELLAR_ADDRESS_REGEX)).toBeNull();
  });

  it('does NOT match an address with a non-base32 character in the body', () => {
    // '0' is not in the base32 alphabet (A-Z + 2-7) and the character class
    // excludes it.
    const text = 'G' + '0'.repeat(55);
    expect(text.match(STELLAR_ADDRESS_REGEX)).toBeNull();
  });

  it('does NOT produce spurious matches in a contiguous run of G characters', () => {
    // 60 G's in a row has no inner word boundaries; the trailing \b cannot
    // match between word chars, so the regex refuses to match anywhere.
    const text = 'G'.repeat(60);
    const matches = text.match(STELLAR_ADDRESS_REGEX);
    expect(matches).toBeNull();
  });

  it('matches a real-format Stellar address embedded in prose', () => {
    const addr = 'GBQK5KW4EUTXSVK3EM6LELFDLHFCDCQXI3U5I3ZQ3NQ7Q5X6PTSPEZ4P';
    expect(addr).toHaveLength(56);
    const text = `Send your tip to the team at ${addr} — thanks!`;
    const matches = text.match(STELLAR_ADDRESS_REGEX);
    expect(matches).toEqual([addr]);
  });
});
