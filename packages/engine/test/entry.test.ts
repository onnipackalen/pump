import { describe, expect, it } from 'vitest';

// The server and the web app import the engine by package name, straight from
// its TypeScript source. This checks that wiring, nothing more.
describe('@pump/engine package', () => {
  it('resolves its main entry by package name', async () => {
    const engine = await import('@pump/engine');
    expect(typeof engine).toBe('object');
  });

  it('resolves its fair entry by package name', async () => {
    const fair = await import('@pump/engine/fair');
    expect(typeof fair).toBe('object');
  });

  it('exports exactly the fair public API', async () => {
    const fair = await import('@pump/engine/fair');
    expect(Object.keys(fair).sort()).toEqual(
      [
        'BLOCK_BYTES',
        'MAX_BLOCKS',
        'WORDS_PER_BLOCK',
        'WORD_SPACE',
        'acceptanceLimit',
        'asciiBytes',
        'assertClientSeed',
        'assertServerSeed',
        'bytesToHex',
        'drawMessage',
        'drawRoll',
        'drawerFor',
        'hashServerSeed',
        'hmacSha256',
        'isClientSeed',
        'isServerSeed',
        'readWords',
        'rollFromWord',
        'sampleRoll',
        'verifyRound',
        'verifyServerSeedHash',
      ].sort(),
    );
  });
});
