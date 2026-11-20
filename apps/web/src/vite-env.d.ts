// Adds this app's build settings to Vite's import.meta.env type.

interface ImportMetaEnv {
  /** Which market's rules to build for; see src/market.ts. */
  readonly VITE_MARKET?: string;
}
