import { defineConfig } from 'vite';

export default defineConfig({
  // A relative base: no URL starts with a slash, so one build serves a domain root, a subpath
  // and an app origin such as Capacitor's.
  base: './',
  // Vite's own bundles go to dist/bundle/, so dist/assets/ holds exactly the published assets.
  build: { assetsDir: 'bundle' },
});
