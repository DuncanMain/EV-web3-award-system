import { ApiProperty } from '@nestjs/swagger';

export class WalletHistoryItemDto {
  @ApiProperty({ example: 'award', enum: ['award', 'spend'] })
  type: string;

  @ApiProperty({ example: 'Charging session reward' })
  label: string;

  @ApiProperty({ example: '100.00' })
  amount: string;

  @ApiProperty({ example: '0x9a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d' })
  txHash: string;

  @ApiProperty({ example: '2026-02-16T06:18:32.260Z' })
  timestamp: string;
}

export class WalletResponseDto {
  @ApiProperty({ example: '0475804AA47330' })
  uid: string;

  @ApiProperty({ example: '0x1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d' })
  address: string;

  @ApiProperty({ example: '150.00' })
  balance: string;

  @ApiProperty({ type: [WalletHistoryItemDto] })
  history: WalletHistoryItemDto[];
}
