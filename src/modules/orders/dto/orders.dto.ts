import type { OrderStatus } from 'generated/prisma/client';

// ===== Response shapes =====

export type OrderListItem = {
  id: string;
  auctionId: string;
  title: string;
  mainImage: string;
  amount: string; // "200.00" — the full price
  depositApplied: string; // "50.00" for the winner, "0.00" for a second-chance offer
  amountDue: string; // what the buyer still pays from balance
  offerRank: number; // 1 = winner, 2 = second chance
  status: OrderStatus;
  paymentDeadline: Date;
  paidAt: Date | null;
  createdAt: Date;
};

export type OrdersResponse = {
  items: OrderListItem[];
  page: number;
  limit: number;
  total: number;
};

// The counterpart's email is exposed so buyer and seller can arrange handover
// over `mailto:` — there is no in-app chat.
export type OrderDetail = OrderListItem & {
  counterpart: {
    role: 'BUYER' | 'SELLER'; // who the counterpart is, relative to the caller
    fullName: string;
    email: string;
  };
};

export type SchedulerRunResponse = {
  closed: number; // auctions closed this tick
  expired: number; // orders whose deadline lapsed this tick
  retriedPaid: number; // pending winner orders paid by the retry job
};
