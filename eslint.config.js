// @ts-check
import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["**/dist/**", "**/node_modules/**", "**/*.tsbuildinfo", "rust/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Node scripts under scripts/, the runnable examples/, plus the one-command
    // entry point at the root. TypeScript sources get their globals from
    // @types/node, but these are plain ESM and eslint has to be told.
    files: ["scripts/**/*.mjs", "examples/**/*.mjs", "demo.mjs"],
    languageOptions: {
      globals: {
        Buffer: "readonly",
        console: "readonly",
        process: "readonly",
        URL: "readonly",
      },
    },
  },
  {
    rules: {
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", ignoreRestSiblings: true },
      ],
    },
  },
);
