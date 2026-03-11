import { describe, expect, test } from 'bun:test';
import { encodeCwd } from '../agent';

describe('encodeCwd', () => {
  test('replaces slashes and dots', () => {
    expect(encodeCwd('/Users/geminiwen/Code/openautory')).toBe('-Users-geminiwen-Code-openautory');
  });

  test('replaces underscores', () => {
    expect(encodeCwd('/Users/cosmos_pro/.autory')).toBe('-Users-cosmos-pro--autory');
  });

  test('replaces spaces', () => {
    expect(encodeCwd('/Users/my user/project')).toBe('-Users-my-user-project');
  });

  test('preserves alphanumeric characters', () => {
    expect(encodeCwd('abc123')).toBe('abc123');
  });

  test('replaces all special characters', () => {
    expect(encodeCwd('/home/user@host:~/my-project (v2)')).toBe('-home-user-host---my-project--v2-');
  });

  test('handles home directory path', () => {
    expect(encodeCwd('/Users/cosmos_pro/.autory')).toBe('-Users-cosmos-pro--autory');
  });
});
