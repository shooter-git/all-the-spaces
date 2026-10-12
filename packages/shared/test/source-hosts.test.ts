import { describe, expect, it } from 'vitest';
import {
  GIT_REF,
  matchRepository,
  parseSourceHostDefinition,
  REPO_PATH,
  repositoryAccess,
  SourceHostDefinitionError,
  SourcePatterns,
  StudioSources,
  studioSourcesOf,
} from '../src/source-hosts.ts';

const github = {
  id: 'github',
  displayName: 'GitHub',
  kind: 'github',
  tokenEnv: 'ATS_SOURCE_GITHUB_TOKEN',
  repositories: ['lanternfield-club/*', 'someone/one-game'],
};

/** Whether a host (from its file alone, without a token) allows a repository at all. */
const allows = (repositories: string[], repository: string) =>
  repositoryAccess({ repositories, token: false }, repository) !== null;

describe('repository host definitions', () => {
  it('reads one, with GitHub defaults', () => {
    const def = parseSourceHostDefinition(github);
    expect(def.apiUrl).toBe('https://api.github.com');
    expect(def.archiveHosts).toEqual(['codeload.github.com']);
    expect(def.maxArchiveMb).toBe(150);
  });

  it('takes "*", and an empty list (kept in the Studio instead)', () => {
    expect(parseSourceHostDefinition({ ...github, repositories: ['*'] }).repositories).toEqual([
      '*',
    ]);
    expect(parseSourceHostDefinition({ ...github, repositories: [] }).repositories).toEqual([]);
    const { repositories: _, ...none } = github;
    expect(parseSourceHostDefinition(none).repositories).toEqual([]);
  });

  it('refuses what it should', () => {
    for (const bad of [
      { ...github, id: 'Git Hub' },
      { ...github, kind: 'gitlab' },
      { ...github, apiUrl: 'http://api.github.com' },
      { ...github, tokenEnv: 'GITHUB_TOKEN' },
      { ...github, repositories: ['*/*'] },
      { ...github, repositories: ['*/game'] },
      { ...github, repositories: ['owner'] },
      { ...github, repositories: ['**'] },
      { ...github, repositories: ['owner/na*'] },
      { ...github, token: 'ghp_secret' },
    ])
      expect(() => parseSourceHostDefinition(bad), JSON.stringify(bad)).toThrow(
        SourceHostDefinitionError,
      );
  });

  it('allows only the repositories it names', () => {
    const list = parseSourceHostDefinition(github).repositories;
    expect(allows(list, 'lanternfield-club/lending-desk')).toBe(true);
    expect(allows(list, 'Lanternfield-Club/Lending-Desk')).toBe(true);
    expect(allows(list, 'someone/one-game')).toBe(true);
    expect(allows(list, 'someone/other-game')).toBe(false);
    expect(allows(list, 'lanternfield-club')).toBe(false);
    expect(allows(list, 'lanternfield-club/../x')).toBe(false);
  });

  it('never takes a name that is only dots, which would climb out of the API address', () => {
    const list = ['lanternfield-club/*', '*'];
    for (const bad of ['lanternfield-club/..', 'lanternfield-club/.', '../..', './x', '.../x'])
      expect(allows(list, bad), bad).toBe(false);
    // Dots inside a name are fine (GitHub has plenty).
    expect(allows(list, 'lanternfield-club/.github')).toBe(true);
    expect(allows(list, 'lanternfield-club/game.js')).toBe(true);
    for (const bad of ['../*', './*', 'x/..'])
      expect(() => parseSourceHostDefinition({ ...github, repositories: [bad] }), bad).toThrow(
        SourceHostDefinitionError,
      );
  });

  it('knows a safe folder and ref when it sees one', () => {
    for (const ok of ['creation', 'integrations/all/creation', 'a_b-c.d'])
      expect(REPO_PATH.test(ok)).toBe(true);
    for (const bad of ['', '/abs', 'a/../b', '..', 'a//b', 'a/', '.hidden', 'a/./b'])
      expect(REPO_PATH.test(bad)).toBe(false);
    for (const ok of ['main', 'release/1.2', 'v1.2.0']) expect(GIT_REF.test(ok)).toBe(true);
    for (const bad of ['', '.', '..', 'a..b', '/main', 'main/', 'a b', 'a//b', '.x', 'a/.', 'a/.b'])
      expect(GIT_REF.test(bad)).toBe(false);
  });
});

describe('which repositories a list takes in', () => {
  it('by name or owner, only through "*", or not at all', () => {
    const list = ['someone/one-game', 'club/*', '*'];
    expect(matchRepository(list, 'someone/one-game')).toBe('named');
    expect(matchRepository(list, 'CLUB/anything')).toBe('named');
    expect(matchRepository(list, 'stranger/game')).toBe('any');
    expect(matchRepository(['someone/one-game'], 'stranger/game')).toBeNull();
    expect(matchRepository(['*'], 'not a repository')).toBeNull();
    expect(matchRepository([], 'someone/one-game')).toBeNull();
  });
});

describe('how a repository may be read: with the token, public only, or not at all', () => {
  const host = (repositories: string[], token: boolean, added: string[] = []) => ({
    repositories,
    added,
    token,
  });

  it('uses the token only for what the file names, on a host that has one', () => {
    const h = host(['club/*', 'someone/one-game'], true);
    expect(repositoryAccess(h, 'club/private-game')).toBe('token');
    expect(repositoryAccess(h, 'someone/one-game')).toBe('token');
    expect(repositoryAccess(h, 'someone/other-game')).toBeNull();
  });

  it('never uses the token for "*": anything else is public only', () => {
    const h = host(['club/*', '*'], true);
    expect(repositoryAccess(h, 'club/private-game')).toBe('token');
    expect(repositoryAccess(h, 'stranger/game')).toBe('public');
    expect(repositoryAccess(host(['*'], true), 'club/private-game')).toBe('public');
  });

  it('never uses the token for what was added in the Studio, even by name', () => {
    const h = host(['club/*'], true, ['someone/one-game', 'other-club/*', '*']);
    expect(repositoryAccess(h, 'someone/one-game')).toBe('public');
    expect(repositoryAccess(h, 'other-club/x')).toBe('public');
    expect(repositoryAccess(h, 'stranger/x')).toBe('public');
    // The file's own names still use it.
    expect(repositoryAccess(h, 'club/x')).toBe('token');
  });

  it('reads publicly whatever a host without a token allows', () => {
    const h = host(['club/*'], false, ['someone/one-game']);
    expect(repositoryAccess(h, 'club/x')).toBe('public');
    expect(repositoryAccess(h, 'someone/one-game')).toBe('public');
    expect(repositoryAccess(h, 'someone/other')).toBeNull();
  });

  it('allows nothing it should not', () => {
    expect(repositoryAccess(host([], true), 'club/x')).toBeNull();
    expect(repositoryAccess(host([], false, []), 'club/x')).toBeNull();
    expect(repositoryAccess(host(['*'], true, ['*']), 'club/..')).toBeNull();
    expect(repositoryAccess(host(['*'], true), 'club')).toBeNull();
  });
});

describe('what the owner chose in the Studio', () => {
  it('starts with nothing allowed, and the built-in GitHub off', () => {
    expect(studioSourcesOf(null)).toEqual({ github: { on: false, repositories: [] }, added: {} });
    expect(studioSourcesOf(undefined)).toEqual(studioSourcesOf({}));
  });

  it('reads what was saved, each pattern once', () => {
    expect(
      StudioSources.parse({
        github: { on: true, repositories: [' * ', 'Club/*', 'club/*', 'someone/game'] },
        added: { 'our-gitea': ['someone/game'] },
      }),
    ).toEqual({
      github: { on: true, repositories: ['*', 'Club/*', 'someone/game'] },
      added: { 'our-gitea': ['someone/game'] },
    });
  });

  it('allows nothing when what is stored is not valid', () => {
    for (const bad of [
      { github: { on: true, repositories: ['x/..'] } },
      { github: { on: 'yes' } },
      { added: { 'Not An Id': ['club/*'] } },
      { github: { on: true, repositories: Array.from({ length: 101 }, (_, i) => `o/r${i}`) } },
    ])
      expect(studioSourcesOf(bad), JSON.stringify(bad)).toEqual(studioSourcesOf({}));
  });

  it('checks every pattern', () => {
    expect(SourcePatterns.safeParse(['owner/name', 'owner/*', '*']).success).toBe(true);
    for (const bad of [['owner'], ['*/*'], ['owner/**'], ['a b/c'], ['../x'], ['']])
      expect(SourcePatterns.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
  });
});
