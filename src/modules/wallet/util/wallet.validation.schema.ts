import { z } from 'zod';

// المبلغ: رقم موجب، بحد أقصى خانتين عشريتين (USD)
const amount = z
  .number({ message: 'amount must be a number' })
  .positive('amount must be greater than 0')
  .multipleOf(0.01, 'amount supports at most 2 decimal places');

export const topupSchema = z.object({ amount });

export const withdrawSchema = z.object({ amount });
