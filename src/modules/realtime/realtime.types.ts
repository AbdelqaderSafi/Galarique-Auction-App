// أحداث تدفق المزاد (يشوفها كل الفاتحين للشاشة)
export type BidEvent = {
  type: 'bid';
  bidId: string;
  amount: string;
  bidderName: string;
  currentPrice: string;
  endTime: string | null;
  createdAt: string;
};

export type ClosedEvent = {
  type: 'closed';
  status: 'ENDED' | 'UNSOLD';
  currentPrice: string;
  winnerName: string | null;
};

// أحداث التدفق الشخصي (كل مستخدم يشوف تبعه فقط)
export type OutbidEvent = {
  type: 'outbid';
  auctionId: string;
  auctionTitle: string;
  newPrice: string;
};

export type WonEvent = {
  type: 'won';
  auctionId: string;
  orderId: string;
  amountDue: string;
  paymentDeadline: string;
};

export type AuctionEvent = BidEvent | ClosedEvent;
export type UserEvent = OutbidEvent | WonEvent;
