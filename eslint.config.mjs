import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";

// 只开几条高价值规则：hooks 用法、没 await 的 Promise、新写的 any。
// 存量警告记在 scripts/lint-baseline.json，`pnpm lint` 只拦新增（见 scripts/lint-baseline.mjs）。
export default tseslint.config(
  {
    ignores: [
      "dist/**",
      "client/dist/**",
      "node_modules/**",
      ".claude/**",
      "docs/**",
      "android/**",
      "ios/**",
      "agent/**",
      "forwardx-fxp/**",
      "plugins/**",
      "gost-runtime/**",
      "**/*.d.ts",
    ],
  },
  {
    files: ["client/src/**/*.{ts,tsx}", "server/**/*.ts", "shared/**/*.ts", "drizzle/**/*.ts", "scripts/**/*.ts"],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    linterOptions: {
      // 存量代码里可能有给别的工具写的 disable 注释，不报「没用上」
      reportUnusedDisableDirectives: "off",
    },
    plugins: {
      "@typescript-eslint": tseslint.plugin,
    },
    rules: {
      "@typescript-eslint/no-floating-promises": "warn",
      "@typescript-eslint/no-explicit-any": "warn",
    },
  },
  {
    // hooks 规则只对前端有意义：服务端有 useXxx 命名的普通函数
    files: ["client/src/**/*.{ts,tsx}"],
    plugins: {
      "react-hooks": reactHooks,
    },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
    },
  },
  {
    // node:test 的 test() 本身返回 Promise，不 await 是惯用写法；测试里的 any 也不拦
    files: ["**/*.test.{ts,tsx}"],
    rules: {
      "@typescript-eslint/no-floating-promises": "off",
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
);
