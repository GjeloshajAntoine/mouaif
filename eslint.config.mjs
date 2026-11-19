// Only catches names that are used but never declared or imported (the
// build treats them as globals, so they fail only at runtime).
import globals from 'globals';

// HiddenContentEditor.jsx carries a react-hooks disable comment; a stub rule
// keeps ESLint from failing on the unknown rule name.
const reactHooksStub = { rules: { 'exhaustive-deps': { create: () => ({}) } } };

export default [
  { ignores: ['frontend/dist/**', 'docs-dist/**', 'node_modules/**'] },
  {
    files: ['src/**/*.js', 'bin/**/*.js'],
    languageOptions: { ecmaVersion: 'latest', sourceType: 'commonjs', globals: { ...globals.node } },
    linterOptions: { reportUnusedDisableDirectives: 'off' },
    rules: { 'no-undef': 'error' }
  },
  {
    // Browser script served into the MCP-apps sandbox iframe; the server
    // substitutes EXPECTED_HOST_ORIGIN before sending it.
    files: ['src/mcp-apps-sandbox-proxy.js'],
    languageOptions: { sourceType: 'script', globals: { ...globals.browser, EXPECTED_HOST_ORIGIN: 'readonly' } }
  },
  {
    files: ['frontend/src/**/*.{js,jsx}'],
    plugins: { 'react-hooks': reactHooksStub },
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      parserOptions: { ecmaFeatures: { jsx: true } },
      globals: { ...globals.browser, ...globals.serviceworker }
    },
    linterOptions: { reportUnusedDisableDirectives: 'off' },
    rules: { 'no-undef': 'error' }
  }
];
