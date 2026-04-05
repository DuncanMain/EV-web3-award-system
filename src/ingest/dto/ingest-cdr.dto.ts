import { IsOptional, IsString } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class IngestCdrDto {
  @ApiProperty({ example: '5d484707-41a3-4377-be79-67cad6040d8a' })
  @IsString()
  ProcessID: string;

  @ApiProperty({ example: 'a1b09f5b-b75d-4c9e-aef2-4f0c74cc7623' })
  @IsString()
  SessionID: string;

  @ApiProperty({ example: '2026-02-16T06:18:32.260Z' })
  @IsString()
  'Time of Request': string;

  @ApiProperty({ example: '2026-02-16T06:18:32.750633219Z' })
  @IsString()
  'Time of Response': string;

  @ApiPropertyOptional({ example: null, nullable: true })
  @IsOptional()
  @IsString()
  CPOPartnerSessionID: string | null;

  @ApiPropertyOptional({ example: null, nullable: true })
  @IsOptional()
  @IsString()
  EMPPartnerSessionID: string | null;

  @ApiProperty({ example: 'DE-NWQ' })
  @IsString()
  ProviderID: string;

  @ApiProperty({ example: 'DE*GUC' })
  @IsString()
  OperatorID: string;

  @ApiProperty({ example: 'DV8BB' })
  @IsString()
  'Partner ProductID': string;

  @ApiProperty({ example: 'DE*GUC*E*EZO*0877' })
  @IsString()
  EVSEID: string;

  @ApiProperty({ example: '0475804AA47330' })
  @IsString()
  UID: string;

  @ApiPropertyOptional({ example: null, nullable: true })
  @IsOptional()
  @IsString()
  EVCOID: string | null;

  @ApiPropertyOptional({ example: null, nullable: true })
  @IsOptional()
  @IsString()
  'Hub Operator ID': string | null;

  @ApiPropertyOptional({ example: null, nullable: true })
  @IsOptional()
  @IsString()
  'Hub Provider ID': string | null;

  @ApiProperty({ example: '2026-02-16T05:35:31Z' })
  @IsString()
  'Charging Start': string;

  @ApiProperty({ example: '2026-02-16T06:18:31Z' })
  @IsString()
  'Charging End': string;

  @ApiProperty({ example: '2026-02-16T05:35:16.75512Z' })
  @IsString()
  'Session Start': string;

  @ApiProperty({ example: '2026-02-16T06:18:31Z' })
  @IsString()
  'Session End': string;

  @ApiProperty({ example: '10993.89' })
  @IsString()
  'Meter Value Start': string;

  @ApiProperty({ example: '11.040.483' })
  @IsString()
  'Meter Value End': string;

  @ApiProperty({ example: '46.593' })
  @IsString()
  'Consumed Energy': string;

  @ApiProperty({ example: 'Success' })
  @IsString()
  'Operation Status': string;

  @ApiProperty({ example: 'SUCCESS' })
  @IsString()
  'Forwarding Status': string;

  @ApiPropertyOptional({ example: null, nullable: true })
  @IsOptional()
  @IsString()
  'Connection Error': string | null;

  @ApiProperty({ example: '0' })
  @IsString()
  'Response Status Code': string;

  @ApiProperty({ example: 'SUCCESS' })
  @IsString()
  'Response Status Description': string;

  @ApiProperty({ example: '291' })
  @IsString()
  'HBS System Runtime': string;

  @ApiProperty({ example: '199' })
  @IsString()
  'Partner System Runtime': string;

  @ApiProperty({ example: '490' })
  @IsString()
  'Request Runtime': string;
}
