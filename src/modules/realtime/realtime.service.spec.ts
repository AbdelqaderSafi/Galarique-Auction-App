import { firstValueFrom } from 'rxjs';
import { filter, take } from 'rxjs/operators';
import { RealtimeService } from './realtime.service';
import type { BidEvent } from './realtime.types';

const sampleBid: BidEvent = {
  type: 'bid',
  bidId: 'b1',
  amount: '1500.00',
  bidderName: 'Ahmad K.',
  currentPrice: '1500.00',
  minBidIncrement: '50.00', // شريحة ما فوق 1000
  endTime: '2026-07-21T18:30:00.000Z',
  createdAt: '2026-07-21T18:29:12.000Z',
};

describe('RealtimeService', () => {
  let service: RealtimeService;
  beforeEach(() => {
    service = new RealtimeService();
  });

  it('delivers a published bid to an auction subscriber (ignoring pings)', async () => {
    const received = firstValueFrom(
      service
        .auctionStream('a1')
        .pipe(filter((m) => (m.data as { type?: string }).type === 'bid'), take(1)),
    );
    // publish on next tick so the subscription is active first
    setImmediate(() => service.publishBid('a1', sampleBid));
    const msg = await received;
    expect((msg.data as BidEvent).amount).toBe('1500.00');
    expect((msg.data as BidEvent).bidderName).toBe('Ahmad K.');
  });

  it('does not throw when publishing to an auction with no subscribers', () => {
    expect(() => service.publishBid('nobody', sampleBid)).not.toThrow();
  });

  it('cleans up the auction subject after the last subscriber unsubscribes', () => {
    const sub = service.auctionStream('a2').subscribe();
    expect(service.auctionSubscriberCount('a2')).toBe(1);
    sub.unsubscribe();
    expect(service.auctionSubscriberCount('a2')).toBe(0);
  });
});
