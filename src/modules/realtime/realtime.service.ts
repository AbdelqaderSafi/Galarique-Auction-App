import { Injectable, MessageEvent } from '@nestjs/common';
import { Observable, Subject, interval, merge } from 'rxjs';
import { map } from 'rxjs/operators';
import type { AuctionEvent, BidEvent, UserEvent } from './realtime.types';

const KEEPALIVE_MS = 25_000; // نبض يمنع البروكسي (Railway) من قطع الاتصال الخامل

// قناة واحدة لكل مفتاح + عدّاد مشتركين للتنظيف عند آخر انفصال
interface Channel<T> {
  subject: Subject<T>;
  count: number;
}

@Injectable()
export class RealtimeService {
  private readonly auctions = new Map<string, Channel<AuctionEvent>>();
  private readonly users = new Map<string, Channel<UserEvent>>();

  // ===== النشر (كله no-throw وآمن للاستدعاء بـ void) =====

  publishToAuction(auctionId: string, event: AuctionEvent): void {
    this.auctions.get(auctionId)?.subject.next(event);
  }

  publishBid(auctionId: string, event: BidEvent): void {
    this.publishToAuction(auctionId, event);
  }

  publishToUser(userId: string, event: UserEvent): void {
    this.users.get(userId)?.subject.next(event);
  }

  // ===== التدفقات (Observable<MessageEvent> لـ @Sse) =====

  auctionStream(auctionId: string): Observable<MessageEvent> {
    return this.stream(this.auctions, auctionId);
  }

  userStream(userId: string): Observable<MessageEvent> {
    return this.stream(this.users, userId);
  }

  auctionSubscriberCount(auctionId: string): number {
    return this.auctions.get(auctionId)?.count ?? 0;
  }

  // ===== الداخلية =====

  private stream<T>(
    map_: Map<string, Channel<T>>,
    key: string,
  ): Observable<MessageEvent> {
    return new Observable<MessageEvent>((subscriber) => {
      const channel = this.acquire(map_, key);
      const events$ = channel.subject
        .asObservable()
        .pipe(map((data) => ({ data }) as MessageEvent));
      // نبض keepalive — الكلاينت يتجاهل type:'ping'
      const ping$ = interval(KEEPALIVE_MS).pipe(
        map(() => ({ data: { type: 'ping' } }) as MessageEvent),
      );
      const sub = merge(events$, ping$).subscribe(subscriber);
      return () => {
        sub.unsubscribe();
        this.release(map_, key);
      };
    });
  }

  private acquire<T>(map_: Map<string, Channel<T>>, key: string): Channel<T> {
    let channel = map_.get(key);
    if (!channel) {
      channel = { subject: new Subject<T>(), count: 0 };
      map_.set(key, channel);
    }
    channel.count++;
    return channel;
  }

  private release<T>(map_: Map<string, Channel<T>>, key: string): void {
    const channel = map_.get(key);
    if (!channel) return;
    channel.count--;
    if (channel.count <= 0) {
      channel.subject.complete();
      map_.delete(key); // ما نخلّي تسريب ذاكرة
    }
  }
}
