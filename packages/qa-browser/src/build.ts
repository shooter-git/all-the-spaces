import { execFile } from 'node:child_process';
import { readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { sdkPaths } from '@ats/qa';
import { isBundlePath, typeOf } from '@ats/shared';

export interface Problem {
  title: string;
  detail?: string;
  fix?: string;
}

/**
 * Rewrites package.json so installing can only fetch published packages from the npm registry:
 * dependencies must be version ranges (no git, files, links or URLs), the SDK comes from the
 * platform, and development tools are left out (the platform builds with its own Vite).
 */
export async function prepareDependencies(dir: string): Promise<Problem[]> {
  const problems: Problem[] = [];
  let pkg: { dependencies?: Record<string, unknown> };
  try {
    pkg = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'));
  } catch {
    return [{ title: 'package.json is missing or not valid JSON' }];
  }
  const sdk = sdkPaths();
  const deps: Record<string, string> = {};
  for (const [name, spec] of Object.entries(pkg.dependencies ?? {})) {
    if (name in sdk) continue;
    if (!/^(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/.test(name) || typeof spec !== 'string') {
      problems.push({ title: `The dependency "${name}" isn't a valid package name` });
    } else if (
      spec.includes(':') ||
      spec.includes('/') ||
      spec.startsWith('.') ||
      spec.length > 64
    ) {
      problems.push({
        title: `The dependency "${name}" isn't a version range (${spec.slice(0, 64)})`,
        fix: 'Depend on published npm packages by version, e.g. "three": "0.186.1". Git, file, link and URL dependencies are not allowed.',
      });
    } else {
      deps[name] = spec;
    }
  }
  if ('@allthespaces/portal' in (pkg.dependencies ?? {})) {
    deps['@allthespaces/portal'] = `link:${sdk['@allthespaces/portal']}`;
    deps['@allthespaces/bridge-protocol'] = `link:${sdk['@allthespaces/bridge-protocol']}`;
  }
  await writeFile(
    join(dir, 'package.json'),
    JSON.stringify(
      { name: 'creation', private: true, type: 'module', dependencies: deps },
      null,
      2,
    ),
  );
  // Nothing that could change how installing behaves.
  for (const f of ['.npmrc', '.pnpmfile.cjs', 'pnpm-workspace.yaml', '.yarnrc.yml', 'bunfig.toml'])
    await rm(join(dir, f), { force: true });
  await writeFile(join(dir, 'tsconfig.json'), JSON.stringify(await buildTsconfig(dir), null, 2));
  return problems;
}

/**
 * The TypeScript settings used for building: fixed, apart from the few that change how code is
 * compiled (JSX and decorators). The project's own tsconfig may extend files that don't exist
 * outside the author's machine; it's replaced for the build.
 */
async function buildTsconfig(dir: string) {
  const compilerOptions: Record<string, unknown> = {
    target: 'ES2022',
    module: 'ESNext',
    moduleResolution: 'Bundler',
    useDefineForClassFields: true,
    verbatimModuleSyntax: false,
  };
  try {
    const text = await readFile(join(dir, 'tsconfig.json'), 'utf8');
    // tsconfig allows comments and trailing commas.
    const own = JSON.parse(
      text.replace(/\/\*[\s\S]*?\*\/|^\s*\/\/.*$/gm, '').replace(/,(\s*[}\]])/g, '$1'),
    );
    const o = own?.compilerOptions ?? {};
    if (['react-jsx', 'react-jsxdev', 'preserve', 'react'].includes(o.jsx))
      compilerOptions.jsx = o.jsx;
    if (typeof o.jsxImportSource === 'string' && /^[\w@/.-]{1,64}$/.test(o.jsxImportSource))
      compilerOptions.jsxImportSource = o.jsxImportSource;
    if (typeof o.experimentalDecorators === 'boolean')
      compilerOptions.experimentalDecorators = o.experimentalDecorators;
    if (typeof o.useDefineForClassFields === 'boolean')
      compilerOptions.useDefineForClassFields = o.useDefineForClassFields;
  } catch {}
  return { compilerOptions };
}

/** Installs the dependencies: published packages only, with install scripts switched off. */
export function installDependencies(
  dir: string,
  opts: { storeDir: string; registry?: string },
): Promise<{ ok: boolean; log: string }> {
  return new Promise((resolve) => {
    execFile(
      'pnpm',
      [
        'install',
        '--prod',
        '--ignore-scripts',
        '--ignore-pnpmfile',
        '--ignore-workspace',
        '--no-frozen-lockfile',
        '--prefer-offline',
        '--reporter=append-only',
        `--store-dir=${opts.storeDir}`,
        `--config.registry=${opts.registry ?? 'https://registry.npmjs.org/'}`,
        '--config.confirmModulesPurge=false',
      ],
      {
        cwd: dir,
        timeout: 5 * 60_000,
        maxBuffer: 16 * 1024 * 1024,
        env: cleanEnv({ CI: '1' }),
      },
      (err, stdout, stderr) => resolve({ ok: !err, log: `${stdout}\n${stderr}`.slice(-8000) }),
    );
  });
}

/**
 * Builds the creation with the platform's own Vite and a fixed configuration. The project's own
 * config files (vite, PostCSS, .env) are ignored, so no code from the project or its packages
 * runs while building: it is only read and bundled.
 */
export async function cleanBuild(dir: string, outDir: string) {
  const { build } = await import('vite');
  await build({
    root: dir,
    configFile: false,
    envDir: false,
    logLevel: 'warn',
    base: './',
    publicDir: join(dir, 'public'),
    css: { postcss: {} },
    resolve: {
      dedupe: ['three', '@allthespaces/portal', '@allthespaces/bridge-protocol'],
    },
    worker: { format: 'es' },
    build: {
      outDir,
      emptyOutDir: true,
      target: 'es2022',
      modulePreload: { polyfill: false },
      assetsInlineLimit: 0,
      chunkSizeWarningLimit: 8000,
      reportCompressedSize: false,
    },
  });
}

export interface BundleFile {
  path: string;
  bytes: number;
}

export async function listFiles(dir: string): Promise<BundleFile[]> {
  const out: BundleFile[] = [];
  const walk = async (d: string) => {
    for (const e of (await readdir(d, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const full = join(d, e.name);
      if (e.isDirectory()) await walk(full);
      else if (e.isFile())
        out.push({
          path: relative(dir, full).split(sep).join('/'),
          bytes: (await stat(full)).size,
        });
    }
  };
  await walk(dir);
  return out;
}

/** Things about a built bundle that would stop it working on the play origin. */
export async function checkBundle(dir: string, files: BundleFile[]): Promise<Problem[]> {
  const problems: Problem[] = [];
  if (!files.some((f) => f.path === 'index.html'))
    problems.push({ title: 'The build has no index.html' });
  for (const f of files) {
    if (!isBundlePath(f.path))
      problems.push({
        title: `A file name can't be served: ${f.path}`,
        fix: 'Use letters, digits, dashes, dots and underscores in file names.',
      });
    else if (!typeOf(f.path))
      problems.push({
        title: `This kind of file can't be served: ${f.path}`,
        fix: 'Creations can contain web pages, scripts, styles, images, models, sound, video, fonts and data (JSON, binary).',
      });
  }
  for (const f of files.filter((x) => x.path.endsWith('.html'))) {
    const html = await readFile(join(dir, f.path), 'utf8');
    if (/<script\b(?![^>]*\bsrc=)[^>]*>\s*\S/i.test(html))
      problems.push({
        title: `${f.path} has a script written inside the page`,
        fix: 'Creations may only run scripts from their own files: move it into a .ts or .js file and import it.',
      });
    if (/\son[a-z]+\s*=\s*["']/i.test(html))
      problems.push({
        title: `${f.path} has an inline event handler (like onclick="…")`,
        fix: 'Add event listeners from your script instead.',
      });
    if (/\s(?:src|href)\s*=\s*["'](?:https?:)?\/\//i.test(html))
      problems.push({
        title: `${f.path} links to something on the internet`,
        fix: 'Creations have no internet: ship every file (fonts, images, scripts) inside the creation.',
      });
  }
  return problems;
}

/** An environment with nothing secret in it, for the steps that handle a creation's code. */
export function cleanEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const keep = [
    'PATH',
    'HOME',
    'LANG',
    'TMPDIR',
    'PLAYWRIGHT_BROWSERS_PATH',
    'SystemRoot',
    // Where the internet is (in a sandbox, only through the egress proxy). Not secret.
    'HTTPS_PROXY',
    'HTTP_PROXY',
    'NO_PROXY',
    'https_proxy',
    'http_proxy',
    'no_proxy',
    'NODE_USE_ENV_PROXY',
  ];
  return {
    ...Object.fromEntries(keep.flatMap((k) => (process.env[k] ? [[k, process.env[k]]] : []))),
    NODE_ENV: 'production',
    ...extra,
  };
}
