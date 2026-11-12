// version.js — when does a fetched version.json count as "a newer build is live"?
import { describe, it, expect } from 'vitest';
import { isDifferentBuild, versionLabel, VERSION } from '../src/version.js';

describe('isDifferentBuild', () => {
  it('is true only for a well-formed, different build id', () => {
    expect(isDifferentBuild({ version: '0.1.0', build: 'abc1234' }, '5151e47')).toBe(true);
    expect(isDifferentBuild({ version: '0.1.0', build: '5151e47' }, '5151e47')).toBe(false);
  });
  it('never fires in local dev', () => {
    expect(isDifferentBuild({ build: 'abc1234' }, 'dev')).toBe(false);
  });
  it('ignores anything malformed — a login page, an error object, a dev build on the server', () => {
    for (const junk of [null, undefined, '<html>', 42, [], {}, { build: 7 }, { build: '' }, { build: 'dev' }, { build: '<script>' }]) {
      expect(isDifferentBuild(junk, '5151e47')).toBe(false);
    }
  });
});

describe('versionLabel', () => {
  it('names the version and the build', () => {
    expect(versionLabel).toBe(`v${VERSION} · dev`);   // under the test runner nothing is baked in
  });
});
