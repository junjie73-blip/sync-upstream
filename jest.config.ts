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
  // json-summary 是给 CI 读的数字，text/lcov/clover 给人和工具看。
  coverageReporters: ['text', 'lcov', 'clover', 'json-summary'],
  collectCoverageFrom: ['src/**/*.ts', '!src/**/index.ts', '!src/**/types.ts'],
  // 覆盖率下限：低于这个值就说明有整块功能没被测到，CI 直接红。
  // 这是"地板"而不是目标，每加一批测试就把它抬到实测值附近，避免悄悄回退。
  // 0.3.0 实测：lines 87.9 / statements 87.4 / functions 84.3 / branches 79.1。
  coverageThreshold: {
    global: {
      lines: 86,
      statements: 86,
      functions: 83,
      branches: 78,
    },
  },
  // Fixture suites shell out to real git; on Windows a single `git` spawn is slow enough that
  // a whole doctor/status run can pass 30s when several suites compete for the CPU.
  testTimeout: 120000,
}

export default config
