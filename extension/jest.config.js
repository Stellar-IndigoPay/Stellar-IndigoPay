/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'jsdom',
  roots: ['<rootDir>/src'],
  testMatch: ['**/__tests__/**/*.test.ts', '**/*.test.ts'],
  moduleFileExtensions: ['ts', 'js'],
  setupFiles: ['<rootDir>/jest.setup.ts'],
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: { target: 'ES2022', module: 'CommonJS', esModuleInterop: true, strict: false } }],
  },
  testPathIgnorePatterns: ['/node_modules/', '/dist/', '/dist-firefox/'],
};
