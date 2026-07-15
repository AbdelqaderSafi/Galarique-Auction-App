import { z } from 'zod';

// مبلغ المزايدة: رقم موجب بحد أقصى خانتين عشريتين (USD)
export const placeBidSchema = z.object({
  amount: z
    .number({ message: 'amount must be a number' })
    .positive('amount must be greater than 0')
    .multipleOf(0.01, 'amount supports at most 2 decimal places'),
});
