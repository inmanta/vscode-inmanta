import typescriptEslint from "@typescript-eslint/eslint-plugin";
import tsParser from "@typescript-eslint/parser";

export default [{
    plugins: {
        "@typescript-eslint": typescriptEslint,
    },

    files: ["src/**/*.ts"],

    languageOptions: {
        parser: tsParser,
        ecmaVersion: 6,
        sourceType: "module",
    },

    ignores: ["node_modules/"],

    rules: {
        "prefer-const": ["error", { "ignoreReadBeforeAssign": true }],
        curly: "warn",
        eqeqeq: "warn",
        "no-throw-literal": "warn",
        semi: "off",
        "no-unused-vars": "off",

        "@typescript-eslint/no-unused-vars": ["warn", {
            argsIgnorePattern: "^_",
            varsIgnorePattern: "^_",
            caughtErrorsIgnorePattern: "^_",
        }],
    },
}];
