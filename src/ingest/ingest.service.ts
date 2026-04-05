import { Injectable } from '@nestjs/common';
import { IngestCdrDto } from './dto/ingest-cdr.dto';
import { normalizeCdr, NormalizedCdr } from './cdr-normalizer';

@Injectable()
export class IngestService {
  private readonly processedSessions = new Set<string>();

  ingestCdr(dto: IngestCdrDto) {
    if (this.processedSessions.has(dto.SessionID)) {
      return {
        status: 'duplicate',
        SessionID: dto.SessionID,
        ProviderID: dto.ProviderID,
      };
    }

    this.processedSessions.add(dto.SessionID);

    // Normalize the CDR into canonical format
    const normalized: NormalizedCdr = normalizeCdr(dto);
    // TODO: evaluate reward conditions, issue SPARKZ tokens on-chain, store transaction
    console.log('Normalized CDR:', normalized);

    return {
      status: 'accepted',
      SessionID: dto.SessionID,
      ProviderID: dto.ProviderID,
    };
  }
}
