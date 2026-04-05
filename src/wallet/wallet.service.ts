import { Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';

@Injectable()
export class WalletService {
  getWallet(uid: string) {
    return {
      uid,
      address: `0x${randomUUID().replace(/-/g, '')}`,
      balance: '150.00',
      history: [
        {
          type: 'award',
          label: 'Charging session reward',
          amount: '100.00',
          txHash: `0x${randomUUID().replace(/-/g, '')}`,
          timestamp: '2026-02-16T06:18:32.260Z',
        },
        {
          type: 'award',
          label: 'Bonus reward',
          amount: '75.00',
          txHash: `0x${randomUUID().replace(/-/g, '')}`,
          timestamp: '2026-02-17T10:30:00.000Z',
        },
        {
          type: 'spend',
          label: 'Discounted charging',
          amount: '25.00',
          txHash: `0x${randomUUID().replace(/-/g, '')}`,
          timestamp: '2026-02-18T14:00:00.000Z',
        },
      ],
    };
  }
}
