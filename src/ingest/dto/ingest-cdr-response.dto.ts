import { ApiProperty } from '@nestjs/swagger';

export class IngestCdrAcceptedResponseDto {
  @ApiProperty({ example: 'accepted' })
  status: string;

  @ApiProperty({ example: 'a1b09f5b-b75d-4c9e-aef2-4f0c74cc7623' })
  SessionID: string;

  @ApiProperty({ example: 'DE-NWQ' })
  ProviderID: string;
}

export class IngestCdrDuplicateResponseDto {
  @ApiProperty({ example: 'duplicate' })
  status: string;

  @ApiProperty({ example: 'a1b09f5b-b75d-4c9e-aef2-4f0c74cc7623' })
  SessionID: string;

  @ApiProperty({ example: 'DE-NWQ' })
  ProviderID: string;
}

export class IngestHealthResponseDto {
  @ApiProperty({ example: 'ok' })
  status: string;
}
