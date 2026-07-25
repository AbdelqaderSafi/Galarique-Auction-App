import { Category } from 'generated/prisma/client';
import { CategoriesService } from './categories.service';

describe('CategoriesService', () => {
  const service = new CategoriesService();

  it('returns one { value, label } entry per Category enum value', () => {
    const result = service.list();

    expect(result).toHaveLength(Object.values(Category).length);
    expect(result.map((c) => c.value).sort()).toEqual(Object.values(Category).sort());
  });

  it('title-cases the label from the raw enum value', () => {
    const result = service.list();
    const art = result.find((c) => c.value === Category.ART);
    expect(art?.label).toBe('Art');
    const jewelry = result.find((c) => c.value === Category.JEWELRY);
    expect(jewelry?.label).toBe('Jewelry');
  });
});
