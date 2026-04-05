import { ApiProperty } from '@nestjs/swagger';

export class SpendResponseDto {
  @ApiProperty({ example: 'success' })
  status: string;

  @ApiProperty({ example: '0475804AA47330' })
  uid: string;

  @ApiProperty({ example: 'a1b09f5b-b75d-4c9e-aef2-4f0c74cc7623' })
  sessionId: string;

  @ApiProperty({ example: 'DE-NWQ' })
  providerId: string;

  @ApiProperty({ example: '25.00' })
  tokensSpent: string;

  @ApiProperty({ example: '0x9a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d' })
  txHash: string;

  @ApiProperty({ example: '2026-02-16T06:18:32.260Z' })
  timestamp: string;
}
