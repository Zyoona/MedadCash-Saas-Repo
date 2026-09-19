import type { Config } from 'jest';

const config: Config = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: ['**/*.spec.ts'],
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
    '^@medad/shared-types$': '<rootDir>/../../packages/shared-types/src/index.ts',
    '^@medad/shared-types/(.*)\\.js$': '<rootDir>/../../packages/shared-types/src/$1.ts',
    '^@medad/shared-types/(.*)$': '<rootDir>/../../packages/shared-types/src/$1',
  },
};

export default config;
