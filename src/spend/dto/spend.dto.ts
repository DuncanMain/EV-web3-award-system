import { IsString } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class SpendDto {
  @ApiProperty({ example: '0475804AA47330' })
  @IsString()
  uid: string;

  @ApiProperty({ example: 'a1b09f5b-b75d-4c9e-aef2-4f0c74cc7623' })
  @IsString()
  sessionId: string;

  @ApiProperty({ example: 'DE-NWQ' })
  @IsString()
  providerId: string;

  @ApiProperty({ example: '25.00' })
  @IsString()
  amount: string;

  @ApiProperty({ example: 'Discounted charging' })
  @IsString()
  label: string;
}
