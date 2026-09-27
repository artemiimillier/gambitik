// The e2e program pulls in apps/web/src/devHook.ts (types of the dev hook), which reads `import.meta.env.DEV`.
interface ImportMetaEnv {
  readonly DEV: boolean;
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}
