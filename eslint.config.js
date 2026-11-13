import js from "@eslint/js";
import ts from "typescript-eslint";
import prettier from "eslint-config-prettier";
import simpleImportSort from "eslint-plugin-simple-import-sort";

export default [
  {
    ignores: ["src/vendor/**", "dist/**", "temp/**"],
  },
  {
    // Plain .mjs build/CI scripts: Node globals (TS files get these via the
    // typescript-eslint no-undef overrides; JS files need them spelled out).
    files: ["scripts/**/*.mjs"],
    languageOptions: { globals: { console: "readonly", process: "readonly" } },
  },
  js.configs.recommended,
  ...ts.configs.recommended,
  prettier,
  {
    plugins: {
      "simple-import-sort": simpleImportSort,
    },
    rules: {
      "simple-import-sort/imports": "error",
      "simple-import-sort/exports": "error",
    },
  },
  { rules: { curly: ["error", "all"] } },
];
