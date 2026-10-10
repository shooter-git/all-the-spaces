// better-auth lists its test helpers' and CLI's tools (vitest, drizzle-kit) as optional peer
// dependencies. pnpm links optional peers to any copy in the workspace, and a production install
// then brings them, with vite, esbuild and happy-dom, into the app image. The server uses
// neither through better-auth, so they aren't its peers here.
module.exports = {
  hooks: {
    readPackage(pkg) {
      if (pkg.name === 'better-auth' && pkg.peerDependencies) {
        for (const name of ['drizzle-kit', 'vitest']) {
          delete pkg.peerDependencies[name];
          if (pkg.peerDependenciesMeta) delete pkg.peerDependenciesMeta[name];
        }
      }
      return pkg;
    },
  },
};
