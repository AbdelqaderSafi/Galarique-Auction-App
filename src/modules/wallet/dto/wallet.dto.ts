import { ApiProperty } from '@nestjs/swagger';
import type { WalletTxnType, WithdrawalStatus } from 'generated/prisma/client';

// ===== Request DTOs =====

export class TopUpDto {
  @ApiProperty({
    example: 50,
    description: 'Amount in USD to add to the wallet (> 0, up to 2 decimals)',
  })
  amount!: number;
}

export class WithdrawDto {
  @ApiProperty({
    example: 25,
    description:
      'Amount in USD to withdraw (> 0, ≤ available balance, up to 2 decimals)',
  })
  amount!: number;
}

// ===== Response shapes =====

export type WalletResponse = {
  balance: string; // Decimal serialized (e.g. "150.00")
  lockedBalance: string;
  currency: 'USD';
};

export type WalletTransactionResponse = {
  id: string;
  type: WalletTxnType;
  amount: string;
  refId: string | null;
  note: string | null;
  createdAt: Date;
};

export type TransactionsResponse = {
  items: WalletTransactionResponse[];
  page: number;
  limit: number;
  total: number;
};

export type CheckoutResponse = { checkoutUrl: string };

export type TopUpStatusResponse = {
  paid: boolean; // الدفع تمّ فعلاً عند Stripe
  credited: boolean; // اتشحن بالمحفظة (الـ webhook عالج الحدث)
  amount: string | null; // المبلغ بالدولار (إن توفّر)
};

export type ConnectLinkResponse = { url: string };

export type ConnectStatusResponse = {
  detailsSubmitted: boolean;
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
};

export type WithdrawResponse = {
  withdrawalId: string;
  status: WithdrawalStatus;
};

export type WebhookResponse = { received: boolean };
