const { FusesPlugin } = require('@electron-forge/plugin-fuses');
const { FuseV1Options, FuseVersion } = require('@electron/fuses');
const pkg = require('./package.json');

// These are already bundled by Vite into dist/ — no need to ship in node_modules
const frontendOnlyDeps = [
  'react', 'react-dom', 'react-router-dom', 'react-router', 'framer-motion', 'lucide-react'
];

// Collect all devDependency package names
const devDepNames = Object.keys(pkg.devDependencies || {});

module.exports = {
  packagerConfig: {
    asar: true,
    icon: './build/icon',
    name: 'FoodFactoryPOS',
    executableName: 'FoodFactoryPOS',
    prune: true,
    ignore: (filePath) => {
      // Root is always included
      if (!filePath) return false;

      // ── Include these runtime files ──
      if (/^\/(main\.cjs|db\.cjs|sync\.cjs|package\.json|\.env)$/.test(filePath)) return false;

      // ── Include compiled frontend ──
      if (filePath.startsWith('/dist')) return false;

      // ── Include build/icon files (for window icon) ──
      if (filePath.startsWith('/build')) return false;

      // ── node_modules filtering ──
      if (filePath.startsWith('/node_modules')) {
        // Extract the package name (handles scoped packages like @scope/pkg)
        const remaining = filePath.slice('/node_modules/'.length);
        const parts = remaining.split('/');
        const pkgName = parts[0].startsWith('@') ? `${parts[0]}/${parts[1]}` : parts[0];

        // Exclude devDependencies
        if (devDepNames.includes(pkgName)) return true;

        // Exclude frontend-only deps (already in dist/)
        if (frontendOnlyDeps.includes(pkgName)) return true;

        // Include everything else (production deps + their transitive deps)
        return false;
      }

      // ── Exclude everything else (src, configs, tests, etc.) ──
      return true;
    },
  },
  rebuildConfig: {},
  makers: [
    {
      name: '@electron-forge/maker-squirrel',
      config: {
        name: 'food_factory_pos',
        authors: 'sajeel',
        setupIcon: './build/icon.ico',
      },
    },
    {
      name: '@electron-forge/maker-zip',
      platforms: ['darwin'],
    },
    {
      name: '@electron-forge/maker-deb',
      config: {},
    },
    {
      name: '@electron-forge/maker-rpm',
      config: {},
    },
  ],
  plugins: [
    {
      name: '@electron-forge/plugin-auto-unpack-natives',
      config: {},
    },
    // Fuses are used to enable/disable various Electron functionality
    // at package time, before code signing the application
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
    }),
  ],
};
