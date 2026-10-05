/*
 * @FileDescription:
 * @Author       : zoujunjie
 * @Date         : 2025-08-07 20:37:02
 * @LastEditors  : zoujunjie
 * @LastEditTime : 2025-08-07 20:41:40
 */
import type { Config } from 'jest'

const config: Config = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  moduleFileExtensions: ['ts', 'js'],
  testMatch: ['**/__tests__/**/*.test.ts', '**/?(*.)+(spec|test).ts'],
  transform: {
    '^.+\.ts$': 'ts-jest',
  },
  collectCoverage: true,
  coverageDirectory: './coverage',
  coverageReporters: ['text', 'lcov', 'clover'],
  collectCoverageFrom: ['src/**/*.ts', '!src/**/index.ts', '!src/**/types.ts'],
  // Fixture suites shell out to real git; the 5s default only holds when suites run serially.
  testTimeout: 30000,
}

export default config
