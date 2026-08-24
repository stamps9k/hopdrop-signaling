import js from "@eslint/js";
import tseslint from "typescript-eslint";
import prettierConfig from "eslint-config-prettier";

export default [
  {
    files: ["**/*.mts"],
    ...js.configs.recommended,
  },
  ...tseslint.configs.recommended.map((config) => ({
    ...config,
    files: ["**/*.mts"],
  })),
  {
    files: ["**/*.mts"],
    languageOptions: { parser: tseslint.parser },
    plugins: { "@typescript-eslint": tseslint.plugin },
    rules: {
      "@typescript-eslint/naming-convention": [
        "error",
        {
          selector: "function",
          format: ["snake_case"],
          filter: { regex: "^[A-Z][a-z]", match: false },
        },
        { selector: "classMethod", format: ["snake_case"] },
        { selector: "class", format: ["PascalCase"] },
        {
          selector: "variable",
          format: ["snake_case", "UPPER_CASE"],
          filter: { regex: "^[A-Z][a-z]", match: false },
        },
        {
          selector: "variable",
          format: ["PascalCase"],
          filter: { regex: "^[A-Z][a-z]", match: true },
        },
      ],
    },
  },
  {
    files: ["**/*.mts"],
    ...prettierConfig,
  },
];