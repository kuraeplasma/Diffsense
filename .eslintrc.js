// ESLint configuration (Phase 1: security sentinel, warn-only for legacy code)
// Purpose:
//   - Automatically flag unsafe patterns (innerHTML, eval, new Function, document.write)
//   - Run via `npm run lint` and husky pre-commit
//   - Does NOT block existing legacy files from committing (see .eslintignore).
module.exports = {
    root: true,
    env: {
        browser: true,
        es2022: true,
        node: true,
    },
    parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
    },
    plugins: ['security'],
    extends: ['plugin:security/recommended-legacy'],
    rules: {
        // Explicit dangerous-pattern detection required by project rules.
        'no-eval': 'error',
        'no-implied-eval': 'error',
        'no-new-func': 'error',
        'no-restricted-syntax': [
            'error',
            {
                selector: "CallExpression[callee.object.name='document'][callee.property.name='write']",
                message: 'document.write is forbidden (XSS risk).',
            },
            {
                selector: "MemberExpression[property.name='innerHTML']",
                message: 'Avoid innerHTML (XSS risk). Use textContent / DOM APIs / sanitizer.',
            },
        ],
        // Security plugin defaults can be noisy; keep object-injection as warn.
        'security/detect-object-injection': 'warn',
    },
};
