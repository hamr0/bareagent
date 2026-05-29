// Ambient module declarations for dependencies that ship no TypeScript types.
//
// `bareguard` is a required dependency but publishes plain JS with no .d.ts; the
// others are optional/peer deps that may not be installed in every environment
// (and aren't installed in CI). Declaring them here lets `tsc --checkJs` run
// without `npm i`-ing native modules, while keeping our own JSDoc fully checked.
// Each `require()` of these modules resolves to `any`, so our code is responsible
// for documenting the shapes it relies on via local @typedef/@param JSDoc.

declare module 'bareguard';
declare module 'better-sqlite3';
declare module 'barebrowse';
declare module 'barebrowse/bareagent';
declare module 'baremobile';
declare module 'baremobile/ios';
declare module 'cron-parser';
