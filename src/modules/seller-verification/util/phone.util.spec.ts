import { normalizePalestinianPhone } from './phone.util';

describe('normalizePalestinianPhone', () => {
  it.each([
    ['+970599123456', '970599123456'],
    ['+972599123456', '972599123456'],
    ['00970599123456', '970599123456'],
    ['0599123456', '970599123456'],
    ['599123456', '970599123456'],
    ['970-599-123-456', '970599123456'],
    ['+970 56 912 3456', '970569123456'],
  ])('normalizes %s to %s', (input, expected) => {
    expect(normalizePalestinianPhone(input)).toBe(expected);
  });

  it.each([
    ['+972501234567', 'wrong prefix (Israeli mobile, not PS mobile 59/56)'],
    ['12345', 'too short'],
    ['+970551234567', 'wrong PS mobile prefix (55 instead of 59/56)'],
    ['not-a-phone', 'not numeric at all'],
    ['', 'empty string'],
  ])('rejects %s (%s)', (input) => {
    expect(normalizePalestinianPhone(input)).toBeNull();
  });
});
