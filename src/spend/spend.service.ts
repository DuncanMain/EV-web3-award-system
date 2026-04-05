import { Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { SpendDto } from './dto/spend.dto';

@Injectable()
export class SpendService {
  spend(dto: SpendDto) {
    return {
      status: 'success',
      uid: dto.uid,
      sessionId: dto.sessionId,
      providerId: dto.providerId,
      tokensSpent: dto.amount,
      txHash: `0x${randomUUID().replace(/-/g, '')}`,
      timestamp: new Date().toISOString(),
    };
  }
}
