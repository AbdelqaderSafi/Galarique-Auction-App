import { mockDeep, mockReset, type DeepMockProxy } from 'jest-mock-extended';
import type { DatabaseService } from '../modules/database/database.service';

export type MockDatabaseService = DeepMockProxy<DatabaseService>;

/**
 * Deep-mocked DatabaseService (Prisma) for unit tests.
 *
 * `$transaction` is wired so that:
 *  - the array form (`prisma.$transaction([...])`) resolves each promise as-is
 *  - the interactive form (`prisma.$transaction(async (tx) => ...)`) invokes the
 *    callback with the SAME mock instance as `tx`, so tests can set expectations
 *    on `mock.auction.findUnique(...)` etc. regardless of whether the real code
 *    calls it via `this.prisma` or via the `tx` handle inside a transaction.
 */
export function createMockDatabaseService(): MockDatabaseService {
  const mock = mockDeep<DatabaseService>();

  mock.$transaction.mockImplementation(((arg: unknown) => {
    if (Array.isArray(arg)) {
      return Promise.all(arg);
    }
    if (typeof arg === 'function') {
      return (arg as (tx: MockDatabaseService) => unknown)(mock);
    }
    return Promise.resolve(arg);
  }) as MockDatabaseService['$transaction']);

  return mock;
}

export function resetMockDatabaseService(mock: MockDatabaseService): void {
  mockReset(mock);
  mock.$transaction.mockImplementation(((arg: unknown) => {
    if (Array.isArray(arg)) {
      return Promise.all(arg);
    }
    if (typeof arg === 'function') {
      return (arg as (tx: MockDatabaseService) => unknown)(mock);
    }
    return Promise.resolve(arg);
  }) as MockDatabaseService['$transaction']);
}
