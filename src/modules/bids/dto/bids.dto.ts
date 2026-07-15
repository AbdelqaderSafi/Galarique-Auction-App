import { ApiProperty } from '@nestjs/swagger';
import type { AuctionStatus } from 'generated/prisma/client';

// ===== Request DTO =====

export class PlaceBidDto {
  @ApiProperty({
    example: 250,
    description:
      'Bid amount in USD (> 0, up to 2 decimals). Must be ≥ current price + min increment, or ≥ starting price for the first bid.',
  })
  amount!: number;
}

// ===== Response shapes =====

export type PlaceBidResponse = {
  bidId: string;
  amount: string; // "250.00"
  currentPrice: string;
  endTime: Date | null; // reflects any anti-snipe extension
  isHighest: true;
  depositHeld: boolean; // true if a $50 deposit was newly held on this call
};

export type AuctionBidItem = {
  id: string;
  amount: string;
  bidderName: string; // full name (no anonymization)
  createdAt: Date;
};

export type AuctionBidsResponse = {
  items: AuctionBidItem[];
  page: number;
  limit: number;
  total: number;
};

export type MyBidItem = {
  bidId: string;
  auctionId: string;
  title: string;
  mainImage: string;
  status: AuctionStatus;
  currentPrice: string;
  myAmount: string;
  isWinning: boolean;
  createdAt: Date;
};

export type MyBidsResponse = {
  items: MyBidItem[];
  page: number;
  limit: number;
  total: number;
};
