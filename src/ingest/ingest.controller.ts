import { Body, Controller, Get, Post } from '@nestjs/common';
import { ApiExtraModels, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { Public } from '../auth/decorators/isPublic.decorator';
import { IngestCdrDto } from './dto/ingest-cdr.dto';
import {
  IngestCdrAcceptedResponseDto,
  IngestCdrDuplicateResponseDto,
  IngestHealthResponseDto,
} from './dto/ingest-cdr-response.dto';
import { IngestService } from './ingest.service';

@ApiTags('Ingest')
@ApiExtraModels(IngestCdrAcceptedResponseDto, IngestCdrDuplicateResponseDto)
@Controller('ingest')
export class IngestController {
  constructor(private readonly ingestService: IngestService) {}

  @Public()
  @Post('cdr')
  @ApiOkResponse({
    description: 'CDR accepted or duplicate',
    schema: {
      oneOf: [
        { $ref: `#/components/schemas/${IngestCdrAcceptedResponseDto.name}` },
        { $ref: `#/components/schemas/${IngestCdrDuplicateResponseDto.name}` },
      ],
    },
  })
  ingestCdr(@Body() dto: IngestCdrDto) {
    return this.ingestService.ingestCdr(dto);
  }

  @Public()
  @Get('health')
  @ApiOkResponse({ type: IngestHealthResponseDto, description: 'Service health status' })
  health() {
    return { status: 'ok' };
  }
}
