import tseslint from 'typescript-eslint';

const nodeBuiltins = [
  'fs',
  'path',
  'os',
  'child_process',
  'crypto',
  'buffer',
  'util',
  'url',
  'process',
];

export default tseslint.config(
  { ignores: ['dist/**', 'out/**', 'node_modules/**', '.vscode-test*/**', 'src/sim/**'] },
  ...tseslint.configs.recommended,
  {
    files: ['src/extension/**/*.ts', 'src/shared/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: nodeBuiltins.map((name) => ({
            name,
            message: 'Node built-ins are not available in the web extension host.',
          })),
          patterns: [
            {
              group: ['node:*'],
              message: 'Node built-ins are not available in the web extension host.',
            },
          ],
        },
      ],
      'no-restricted-globals': [
        'error',
        ...['Buffer', 'process', '__dirname', '__filename', 'require'].map((name) => ({
          name,
          message: 'Node globals are not available in the web extension host.',
        })),
      ],
    },
  },
);
