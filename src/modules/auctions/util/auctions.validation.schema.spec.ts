import {
  createAuctionBodySchema,
  updateAuctionSchema,
  MAX_CUSTOM_FIELDS,
} from './auctions.validation.schema';

// جسم إنشاء صالح بأدنى الحقول — كما يصل من multipart (كل شيء نصوص)
const baseBody = {
  category: 'ART',
  title: 'Antique Vase',
  startingPrice: '1000',
  durationDays: '7',
};

const parseCreate = (extra: Record<string, unknown> = {}) =>
  createAuctionBodySchema.safeParse({ ...baseBody, ...extra });

const firstMessage = (result: { success: false; error: { issues: { message: string }[] } }) =>
  result.error.issues.map((i) => i.message).join(' | ');

describe('createAuctionBodySchema', () => {
  describe('minBidIncrement (fixed at $10 — no longer a seller input)', () => {
    it('strips minBidIncrement instead of accepting it', () => {
      const result = parseCreate({ minBidIncrement: '999' });

      expect(result.success).toBe(true);
      expect(result.success && result.data).not.toHaveProperty('minBidIncrement');
    });

    it('does not require it', () => {
      expect(parseCreate().success).toBe(true);
    });
  });

  describe('customFields', () => {
    it('parses a JSON string (how multipart sends it)', () => {
      const result = parseCreate({
        customFields: '[{"label":"Artist","value":"Van Gogh"}]',
      });

      expect(result.success).toBe(true);
      expect(result.success && result.data.customFields).toEqual([
        { label: 'Artist', value: 'Van Gogh' },
      ]);
    });

    it('accepts an already-parsed array', () => {
      const result = parseCreate({
        customFields: [{ label: 'Artist', value: 'Van Gogh' }],
      });

      expect(result.success).toBe(true);
      expect(result.success && result.data.customFields).toHaveLength(1);
    });

    it('is optional — absent means the DB default []', () => {
      const result = parseCreate();

      expect(result.success).toBe(true);
      expect(result.success && result.data.customFields).toBeUndefined();
    });

    it('treats an empty string as absent (multipart sends empty optional fields)', () => {
      const result = parseCreate({ customFields: '' });

      expect(result.success).toBe(true);
      expect(result.success && result.data.customFields).toBeUndefined();
    });

    it('accepts an empty JSON array', () => {
      const result = parseCreate({ customFields: '[]' });

      expect(result.success).toBe(true);
      expect(result.success && result.data.customFields).toEqual([]);
    });

    it('trims whitespace around label and value', () => {
      const result = parseCreate({
        customFields: '[{"label":"  Artist  ","value":"  Van Gogh  "}]',
      });

      expect(result.success && result.data.customFields).toEqual([
        { label: 'Artist', value: 'Van Gogh' },
      ]);
    });

    it('rejects malformed JSON with a clear message', () => {
      const result = parseCreate({ customFields: '[{label: Artist}' });

      expect(result.success).toBe(false);
      expect(!result.success && firstMessage(result as never)).toContain(
        'customFields must be a valid JSON array',
      );
    });

    it('rejects a JSON value that is not an array', () => {
      expect(parseCreate({ customFields: '{"label":"Artist"}' }).success).toBe(false);
    });

    it(`rejects more than ${MAX_CUSTOM_FIELDS} fields`, () => {
      const tooMany = Array.from({ length: MAX_CUSTOM_FIELDS + 1 }, (_, i) => ({
        label: `Field ${i}`,
        value: 'x',
      }));

      const result = parseCreate({ customFields: JSON.stringify(tooMany) });

      expect(result.success).toBe(false);
      expect(!result.success && firstMessage(result as never)).toContain('at most');
    });

    it(`accepts exactly ${MAX_CUSTOM_FIELDS} fields`, () => {
      const exact = Array.from({ length: MAX_CUSTOM_FIELDS }, (_, i) => ({
        label: `Field ${i}`,
        value: 'x',
      }));

      expect(parseCreate({ customFields: JSON.stringify(exact) }).success).toBe(true);
    });

    it('rejects duplicate labels regardless of letter case', () => {
      const result = parseCreate({
        customFields: '[{"label":"Artist","value":"a"},{"label":"ARTIST","value":"b"}]',
      });

      expect(result.success).toBe(false);
      expect(!result.success && firstMessage(result as never)).toContain('unique');
    });

    it('rejects an empty label', () => {
      expect(parseCreate({ customFields: '[{"label":"  ","value":"a"}]' }).success).toBe(
        false,
      );
    });

    it('rejects an empty value', () => {
      expect(parseCreate({ customFields: '[{"label":"Artist","value":""}]' }).success).toBe(
        false,
      );
    });

    it('rejects a label longer than 30 characters', () => {
      const customFields = JSON.stringify([{ label: 'x'.repeat(31), value: 'a' }]);

      expect(parseCreate({ customFields }).success).toBe(false);
    });

    it('rejects a value longer than 120 characters', () => {
      const customFields = JSON.stringify([{ label: 'Artist', value: 'x'.repeat(121) }]);

      expect(parseCreate({ customFields }).success).toBe(false);
    });
  });
});

describe('updateAuctionSchema', () => {
  it('strips minBidIncrement — it cannot be changed after creation', () => {
    const result = updateAuctionSchema.safeParse({ minBidIncrement: 999 });

    expect(result.success).toBe(true);
    expect(result.success && result.data).not.toHaveProperty('minBidIncrement');
  });

  it('accepts a customFields array (JSON body)', () => {
    const result = updateAuctionSchema.safeParse({
      customFields: [{ label: 'Signature', value: 'Bottom right' }],
    });

    expect(result.success).toBe(true);
    expect(result.success && result.data.customFields).toHaveLength(1);
  });

  it('accepts an empty array to clear the fields', () => {
    const result = updateAuctionSchema.safeParse({ customFields: [] });

    expect(result.success).toBe(true);
    expect(result.success && result.data.customFields).toEqual([]);
  });

  it('enforces the same limits as creation', () => {
    const tooMany = Array.from({ length: MAX_CUSTOM_FIELDS + 1 }, (_, i) => ({
      label: `Field ${i}`,
      value: 'x',
    }));

    expect(updateAuctionSchema.safeParse({ customFields: tooMany }).success).toBe(false);
  });
});
