import { describe, expect, it } from 'vitest';
import {
  allowsRepository,
  GIT_REF,
  parseSourceHostDefinition,
  REPO_PATH,
  SourceHostDefinitionError,
} from '../src/source-hosts.ts';

const github = {
  id: 'github',
  displayName: 'GitHub',
  kind: 'github',
  tokenEnv: 'ATS_SOURCE_GITHUB_TOKEN',
  repositories: ['lanternfield-club/*', 'someone/one-game'],
};

describe('repository host definitions', () => {
  it('reads one, with GitHub defaults', () => {
    const def = parseSourceHostDefinition(github);
    expect(def.apiUrl).toBe('https://api.github.com');
    expect(def.archiveHosts).toEqual(['codeload.github.com']);
    expect(def.maxArchiveMb).toBe(150);
  });

  it('refuses what it should', () => {
    for (const bad of [
      { ...github, id: 'Git Hub' },
      { ...github, kind: 'gitlab' },
      { ...github, apiUrl: 'http://api.github.com' },
      { ...github, tokenEnv: 'GITHUB_TOKEN' },
      { ...github, repositories: [] },
      { ...github, repositories: ['*/*'] },
      { ...github, token: 'ghp_secret' },
    ])
      expect(() => parseSourceHostDefinition(bad)).toThrow(SourceHostDefinitionError);
  });

  it('allows only the repositories it names', () => {
    const def = parseSourceHostDefinition(github);
    expect(allowsRepository(def, 'lanternfield-club/lending-desk')).toBe(true);
    expect(allowsRepository(def, 'Lanternfield-Club/Lending-Desk')).toBe(true);
    expect(allowsRepository(def, 'someone/one-game')).toBe(true);
    expect(allowsRepository(def, 'someone/other-game')).toBe(false);
    expect(allowsRepository(def, 'lanternfield-club')).toBe(false);
    expect(allowsRepository(def, 'lanternfield-club/../x')).toBe(false);
  });

  it('knows a safe folder and ref when it sees one', () => {
    for (const ok of ['creation', 'integrations/all/creation', 'a_b-c.d'])
      expect(REPO_PATH.test(ok)).toBe(true);
    for (const bad of ['', '/abs', 'a/../b', '..', 'a//b', 'a/', '.hidden', 'a/./b'])
      expect(REPO_PATH.test(bad)).toBe(false);
    for (const ok of ['main', 'release/1.2', 'v1.2.0']) expect(GIT_REF.test(ok)).toBe(true);
    for (const bad of ['', '..', 'a..b', '/main', 'main/', 'a b'])
      expect(GIT_REF.test(bad)).toBe(false);
  });
});
